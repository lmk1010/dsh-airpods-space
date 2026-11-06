/** Opt-in live Aliyun recognition (needs a key in DASHSCOPE_API_KEY or the macOS Keychain and DSH_ALIYUN_E2E_WAV). */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import type { StreamEvent } from '@dshub/speech-streaming'
import { AliyunRealtime, Config } from '../src/index.ts'

const wav = process.env.DSH_ALIYUN_E2E_WAV

it.skipIf(!wav)('recognizes real-time audio twice over one reused connection', { timeout: 60_000 }, async () => {
  const provider = new AliyunRealtime(Config({}))
  const pcm = new Int16Array(readFileSync(wav!).buffer.slice(44))
  const turn = async () => {
    const started = performance.now()
    const session = await provider.open({ language: 'auto' }, new AbortController().signal)
    const events: (StreamEvent & { at: number })[] = []
    const reading = (async () => { for await (const event of session.events) events.push({ ...event, at: performance.now() - started }) })()
    for (let offset = 0; offset < pcm.length; offset += 1600) {
      session.write(pcm.subarray(offset, offset + 1600))
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const finishedAt = performance.now() - started
    session.finish()
    await reading
    const end = events.at(-1)!
    return { text: end.type === 'end' ? end.text : '', firstMs: Math.round(events[0]!.at), tailMs: Math.round(end.at - finishedAt) }
  }
  const first = await turn()
  const second = await turn()
  provider.dispose()
  console.info('aliyun e2e', { first, second })
  expect(first.text).toMatch(/Monday/i)
  expect(second.text).toBe(first.text)
})
