/** Streaming recognizers with partial results; each registration also serves the batch `speechToText` registry. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechProvider, SpeechProviderId, Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { Channel, decodeWave, encodeWave, SAMPLE_RATE } from './pcm.ts'
import type { StreamEvent, StreamingProvider, StreamingSession, StreamRequest } from './types.ts'

export type * from './types.ts'
export { Channel, decodeWave, encodeWave, SAMPLE_RATE, toFloat } from './pcm.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Streaming speech recognition registry. */
    speechStreaming: SpeechStreaming
  }
}

/** Selection applied when a stream request omits a field. */
export interface Config {
  /** Streaming provider used when the request names none. */
  defaultProvider: string
  /** Batch provider that re-recognizes the complete utterance; empty disables the second pass. */
  refineProvider: string
  /** Language hint used when the request names none. */
  language: string
  /** Hotwords applied when the request names none. */
  hotwords: string[]
  /** Samples written per chunk when a batch request is replayed through a streaming provider. */
  replayChunkSamples: number
}

/** Fully resolved stream inputs. */
export interface StreamSpec {
  readonly provider: StreamingProvider
  readonly language: string
  readonly hotwords: readonly string[]
  /** Batch provider for the second pass, absent when disabled or unregistered. */
  readonly refine?: SpeechProviderId
}

/** Registry shared by streaming consumers in one Host composition. */
export default class SpeechStreaming extends Service {
  static inject = ['speechToText']
  static Config: z<Partial<Config>, Config> = z.object({
    defaultProvider: z.string().min(1).required(),
    refineProvider: z.string().default(''),
    language: z.string().min(1).default('auto'),
    hotwords: z.array(z.string().min(1)).default([]),
    replayChunkSamples: z.natural().min(160).default(1600),
  })

  private readonly providers = new Map<SpeechProviderId, StreamingProvider>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'speechStreaming')
  }

  /**
   * Register a streaming provider and expose it to batch consumers under the same id.
   * @param provider - recognizer owned by the contributing fiber.
   * @returns disposer that removes both registrations.
   */
  register(provider: StreamingProvider): () => Promise<void> {
    const id = provider.info.id
    if (this.providers.has(id)) throw new Error(`Streaming speech provider already registered: ${id}`)
    const unregisterBatch = this.ctx.speechToText.register(this.batchAdapter(provider))
    this.providers.set(id, provider)
    return async () => {
      if (this.providers.get(id) === provider) this.providers.delete(id)
      await unregisterBatch()
    }
  }

  /**
   * List registered streaming provider ids.
   * @returns ids in registration order.
   */
  list(): readonly SpeechProviderId[] { return [...this.providers.keys()] }

  /**
   * Fill omitted request fields from configuration; unknown providers fail here.
   * @param request - caller choices.
   * @returns resolved stream inputs.
   */
  resolve(request: StreamRequest = {}): StreamSpec {
    const id = request.providerId ?? this.config.defaultProvider as SpeechProviderId
    const provider = this.providers.get(id)
    if (provider === undefined) throw new Error(`Streaming speech provider is not registered: ${id}`)
    const language = request.language ?? this.config.language
    if (!provider.info.languages.includes(language)) throw new Error(`${id} does not support language ${language}`)
    const refine = request.refine ?? (this.config.refineProvider === '' ? false : this.config.refineProvider as SpeechProviderId)
    const refineRegistered = refine !== false && this.ctx.speechToText.listProviders().some(info => info.id === refine)
    return { provider, language, hotwords: request.hotwords ?? this.config.hotwords, ...refineRegistered ? { refine } : {} }
  }

  /**
   * Preload the resolved provider without opening a stream.
   * @param request - caller choices.
   */
  warm(request?: StreamRequest): void { this.resolve(request).provider.warm?.() }

  /**
   * Open a stream; when a second pass is resolved, its `refined` event follows `end`.
   * A failed second pass ends the stream after `end` without an error, because `end` already holds usable text.
   * @param spec - resolved inputs from `resolve`.
   * @param signal - aborts recognition and the second pass.
   * @returns live session.
   */
  async open(spec: StreamSpec, signal: AbortSignal): Promise<StreamingSession> {
    const inner = await spec.provider.open({ language: spec.language, hotwords: spec.hotwords }, signal)
    if (spec.refine === undefined) return inner
    const refine = spec.refine, recorded: Int16Array[] = [], events = new Channel<StreamEvent>()
    let ended = false
    void (async () => {
      try {
        for await (const event of inner.events) {
          events.push(event)
          if (event.type !== 'end' || event.text === '') continue
          ended = true
          const audio = encodeWave(recorded)
          const transcript = await this.ctx.speechToText.transcribe(
            this.ctx.speechToText.resolve({ audio, providerId: refine, language: spec.language }), signal)
          events.push({ type: 'refined', text: transcript.text, providerId: refine, inferenceSeconds: transcript.inferenceSeconds })
        }
        events.close()
      } catch (error) {
        // The first pass already delivered `end`; a second-pass failure only withholds the refinement.
        if (ended && !signal.aborted) events.close(); else events.fail(error)
      }
    })()
    return {
      write: (pcm) => { recorded.push(pcm.slice()); inner.write(pcm) },
      finish: () => { inner.finish() },
      events,
    }
  }

  private batchAdapter(provider: StreamingProvider): SpeechProvider {
    return {
      info: provider.info,
      ...provider.preparation === undefined ? {} : { preparation: provider.preparation },
      transcribe: async (input, signal): Promise<Transcript> => {
        const started = performance.now()
        const session = await provider.open({ language: input.language, hotwords: this.config.hotwords }, signal)
        const pcm = decodeWave(input.audio)
        for (let offset = 0; offset < pcm.length; offset += this.config.replayChunkSamples) {
          session.write(pcm.subarray(offset, offset + this.config.replayChunkSamples))
        }
        session.finish()
        for await (const event of session.events) {
          if (event.type === 'end') {
            return { text: event.text, audioSeconds: pcm.length / SAMPLE_RATE, inferenceSeconds: (performance.now() - started) / 1000 }
          }
        }
        throw new Error(`${provider.info.id} ended without a transcript`)
      },
    }
  }
}
