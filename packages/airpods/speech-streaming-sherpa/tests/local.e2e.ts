/** Opt-in real recognition process: duplex streaming through the registry, batch replay, and process reuse. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import SpeechStreaming, { type StreamEvent } from '@lmk1010/speech-streaming'
import { expect, it, vi } from 'vitest'
import * as Sherpa from '../src/index.ts'

const modelDirectory = process.env.DSH_STREAMING_MODEL_DIR

it.skipIf(!modelDirectory)('streams real-time audio through the recognition process and serves batch replay', { timeout: 120_000, retry: 0 }, async () => {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(SpeechToText, { defaultProvider: 'paraformer-streaming-local', language: 'auto' })
  await ctx.plugin(SpeechStreaming, { defaultProvider: 'paraformer-streaming-local' })
  const spawn = vi.spyOn(ctx.get('subprocess')!, 'spawn')
  await ctx.plugin(Sherpa, { dataRoot: '/tmp/dsh-streaming-e2e', modelDirectory: modelDirectory! })
  try {
    const streaming = ctx.get('speechStreaming')!, batch = ctx.get('speechToText')!
    const provider = batch.snapshot().providers[0]!
    await vi.waitFor(() => { expect(batch.snapshot().providers[0]!.preparation.phase).toBe('standby') })
    const warmStarted = performance.now()
    streaming.warm()
    await vi.waitFor(() => { expect(batch.snapshot().providers[0]!.preparation).toEqual({ phase: 'ready' }) }, { timeout: 30_000 })
    const warmMs = performance.now() - warmStarted

    const wave = await readFile(join(modelDirectory!, 'test_wavs', '0.wav'))
    const pcm = new Int16Array(wave.buffer.slice(wave.byteOffset + 44, wave.byteOffset + wave.byteLength))
    const session = await streaming.open(streaming.resolve(), new AbortController().signal)
    const started = performance.now(), events: (StreamEvent & { at: number })[] = []
    const reading = (async () => { for await (const event of session.events) events.push({ ...event, at: performance.now() - started }) })()
    for (let offset = 0; offset < pcm.length; offset += 1600) {
      session.write(pcm.subarray(offset, offset + 1600))
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const finishedAt = performance.now() - started
    session.finish()
    await reading
    const end = events.at(-1)!
    expect(end).toMatchObject({ type: 'end' })
    expect(end.type === 'end' && end.text).toMatch(/monday.*星期三$/)
    const partials = events.filter(event => event.type === 'partial')
    expect(partials.length).toBeGreaterThan(5)
    // Partials must arrive while audio is still being written, not after finish.
    expect(partials[0]!.at).toBeLessThan(finishedAt / 2)

    const replay = await batch.transcribe(batch.resolve({ audio: wave }), new AbortController().signal)
    expect(replay.text).toBe(end.type === 'end' ? end.text : '')
    expect(spawn).toHaveBeenCalledOnce()
    console.info('streaming e2e', { provider: provider.id, warmMs: Math.round(warmMs), firstPartialMs: Math.round(partials[0]!.at),
      finishToEndMs: Math.round(end.at - finishedAt), replaySeconds: replay.inferenceSeconds })
  } finally {
    await ctx.fiber.dispose()
    spawn.mockRestore()
  }
})
