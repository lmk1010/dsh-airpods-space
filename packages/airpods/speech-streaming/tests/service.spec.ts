/** Streaming registry routing, second-pass refinement, batch replay and registration lifetimes. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import SpeechToText from '../../../experimental/speech-to-text/src/index.ts'
import type { SpeechProviderId, Transcript } from '../../../experimental/speech-to-text/src/types.ts'
import SpeechStreaming, { type Config } from '../src/index.ts'
import { Channel, encodeWave } from '../src/pcm.ts'
import type { StreamEvent, StreamingProvider } from '../src/types.ts'

const id = (value: string): SpeechProviderId => value as SpeechProviderId

/** Echo provider: each write becomes a partial of the running sample count; finish ends with that count. */
function echo(name: string, written: number[] = []): StreamingProvider {
  return {
    info: { id: id(name), name, location: 'host-local', languages: ['auto', 'zh'] },
    open: async () => {
      const events = new Channel<StreamEvent>()
      let samples = 0
      return {
        write: (pcm) => { samples += pcm.length; written.push(pcm.length); events.push({ type: 'partial', segment: 0, text: `${samples}` }) },
        finish: () => { events.push({ type: 'end', text: `${samples}`, audioSeconds: samples / 16000 }); events.close() },
        events,
      }
    },
  }
}

async function setup(config: Partial<Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(SpeechToText, { defaultProvider: 'stream', language: 'auto' })
  await ctx.plugin(SpeechStreaming, { defaultProvider: 'stream', ...config })
  return { ctx, streaming: ctx.get('speechStreaming')!, batch: ctx.get('speechToText')! }
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

it('streams partial and end events through the configured provider', async () => {
  const { ctx, streaming } = await setup()
  ctx.effect(() => streaming.register(echo('stream')))
  const session = await streaming.open(streaming.resolve(), new AbortController().signal)
  session.write(new Int16Array(160)); session.write(new Int16Array(320)); session.finish()
  expect(await collect(session.events)).toEqual([
    { type: 'partial', segment: 0, text: '160' }, { type: 'partial', segment: 0, text: '480' },
    { type: 'end', text: '480', audioSeconds: 0.03 },
  ])
  await ctx.fiber.dispose()
})

it('rejects unknown providers and unsupported languages at resolve', async () => {
  const { ctx, streaming } = await setup()
  ctx.effect(() => streaming.register(echo('stream')))
  expect(() => streaming.resolve({ providerId: id('missing') })).toThrow(/not registered/)
  expect(() => streaming.resolve({ language: 'ja' })).toThrow(/does not support/)
  expect(() => streaming.register(echo('stream'))).toThrow(/already registered/)
  await ctx.fiber.dispose()
})

it('appends a refined event from the batch second pass over the recorded audio', async () => {
  const { ctx, streaming, batch } = await setup({ refineProvider: 'sensevoice' })
  ctx.effect(() => streaming.register(echo('stream')))
  let received: Uint8Array | undefined
  ctx.effect(() => batch.register({ info: { id: id('sensevoice'), name: 's', location: 'host-local', languages: ['auto'] },
    transcribe: async (input): Promise<Transcript> => { received = input.audio; return { text: '精确', audioSeconds: 0.01, inferenceSeconds: 0.2 } } }))
  const spec = streaming.resolve()
  expect(spec.refine).toBe('sensevoice')
  const session = await streaming.open(spec, new AbortController().signal)
  session.write(new Int16Array([1, 2])); session.finish()
  const events = await collect(session.events)
  expect(events.at(-1)).toEqual({ type: 'refined', text: '精确', providerId: 'sensevoice', inferenceSeconds: 0.2 })
  expect(received).toEqual(encodeWave([new Int16Array([1, 2])]))
  expect(streaming.resolve({ refine: false }).refine).toBeUndefined()
  await ctx.fiber.dispose()
})

it('keeps the first-pass result when the second pass fails', async () => {
  const { ctx, streaming, batch } = await setup({ refineProvider: 'broken' })
  ctx.effect(() => streaming.register(echo('stream')))
  ctx.effect(() => batch.register({ info: { id: id('broken'), name: 'b', location: 'cloud', languages: ['auto'] },
    transcribe: async () => { throw new Error('offline') } }))
  const session = await streaming.open(streaming.resolve(), new AbortController().signal)
  session.write(new Int16Array(16)); session.finish()
  expect((await collect(session.events)).map(event => event.type)).toEqual(['partial', 'end'])
  await ctx.fiber.dispose()
})

it('serves batch transcription by replaying the recording in configured chunks', async () => {
  const { ctx, streaming, batch } = await setup({ replayChunkSamples: 1600 })
  const written: number[] = []
  ctx.effect(() => streaming.register(echo('stream', written)))
  const audio = encodeWave([new Int16Array(4000)])
  const transcript = await batch.transcribe(batch.resolve({ audio }), new AbortController().signal)
  expect(transcript).toMatchObject({ text: '4000', audioSeconds: 0.25 })
  expect(written).toEqual([1600, 1600, 800])
  await ctx.fiber.dispose()
})

it('removes both registrations when the contributing fiber is disposed', async () => {
  const { ctx, streaming, batch } = await setup()
  const fiber = ctx.plugin((inner: Context) => { inner.effect(() => streaming.register(echo('stream'))) })
  await fiber
  expect(streaming.list()).toEqual(['stream'])
  expect(batch.listProviders().map(info => info.id)).toEqual(['stream'])
  await fiber.dispose()
  expect(streaming.list()).toEqual([])
  expect(batch.listProviders()).toEqual([])
  await ctx.fiber.dispose()
})
