/** sherpa-onnx streaming Paraformer decoding, confined to the recognition process. */
import { createRequire } from 'node:module'
import type { StreamEvent } from '@lmk1010/speech-streaming/types'
import type { Config, ModelPaths } from './config.ts'

interface OnlineStream {
  acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void
  inputFinished(): void
}
interface OnlineRecognizer {
  createStream(): OnlineStream
  isReady(stream: OnlineStream): boolean
  decode(stream: OnlineStream): void
  isEndpoint(stream: OnlineStream): boolean
  reset(stream: OnlineStream): void
  getResult(stream: OnlineStream): { text: string }
}

/** Incremental decoder for one utterance. */
export class EngineStream {
  private readonly stream: OnlineStream
  private segment = 0
  private current = ''
  private readonly finals: string[] = []
  private samples = 0

  constructor(private readonly recognizer: OnlineRecognizer, private readonly tailSamples: number) {
    this.stream = recognizer.createStream()
  }

  /**
   * Decode newly available audio.
   * @param samples - 16 kHz float samples.
   * @returns partial updates and segment finals produced by this chunk.
   */
  accept(samples: Float32Array): StreamEvent[] {
    this.samples += samples.length
    this.stream.acceptWaveform({ samples, sampleRate: 16000 })
    return this.drain(true)
  }

  /**
   * Flush the tail and close the utterance.
   * @returns remaining updates followed by `end`.
   */
  finish(): StreamEvent[] {
    this.stream.acceptWaveform({ samples: new Float32Array(this.tailSamples), sampleRate: 16000 })
    this.stream.inputFinished()
    const events = this.drain(false)
    if (this.current !== '') { events.push({ type: 'final', segment: this.segment, text: this.current }); this.finals.push(this.current) }
    events.push({ type: 'end', text: this.finals.join(' '), audioSeconds: this.samples / 16000 })
    return events
  }

  /** Total accepted audio in seconds, excluding tail padding. */
  get seconds(): number { return this.samples / 16000 }

  private drain(endpoints: boolean): StreamEvent[] {
    const events: StreamEvent[] = []
    while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream)
    const text = this.recognizer.getResult(this.stream).text.trim()
    if (text !== this.current) { this.current = text; events.push({ type: 'partial', segment: this.segment, text }) }
    if (endpoints && this.recognizer.isEndpoint(this.stream)) {
      if (text !== '') { events.push({ type: 'final', segment: this.segment, text }); this.finals.push(text); this.segment++ }
      this.recognizer.reset(this.stream)
      this.current = ''
    }
    return events
  }
}

/**
 * Load the model once; streams share the recognizer.
 * @param paths - verified model files.
 * @param config - threads, endpoint rules and tail padding.
 * @returns factory for per-utterance streams.
 */
export function createEngine(paths: ModelPaths, config: Config): { open(): EngineStream } {
  // sherpa-onnx-node publishes a CommonJS Node-API binding without declarations.
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as { OnlineRecognizer: new (config: object) => OnlineRecognizer }
  const recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { paraformer: { encoder: paths.encoder, decoder: paths.decoder }, tokens: paths.tokens,
      numThreads: config.threads, provider: 'cpu', debug: 0 },
    decodingMethod: 'greedy_search',
    enableEndpoint: config.segmentOnEndpoint,
    rule1MinTrailingSilence: config.endpointSilenceSeconds,
    rule2MinTrailingSilence: config.endpointSilenceAfterTextSeconds,
    rule3MinUtteranceLength: config.endpointMaxSegmentSeconds,
  })
  const tail = Math.round(config.tailPaddingSeconds * 16000)
  return { open: () => new EngineStream(recognizer, tail) }
}

/**
 * Convert PCM16LE bytes to float samples, carrying an odd trailing byte into the next chunk.
 * @param carry - byte left over from the previous chunk.
 * @param chunk - newly received bytes.
 * @returns samples and the new leftover byte.
 */
export function pcmChunk(carry: Buffer, chunk: Buffer): { samples: Float32Array; carry: Buffer } {
  const bytes = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])
  const usable = bytes.length - bytes.length % 2
  const samples = new Float32Array(usable / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2) / 32768
  return { samples, carry: Buffer.from(bytes.subarray(usable)) }
}
