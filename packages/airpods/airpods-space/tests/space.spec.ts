/** Helper events become snapshots; a press runs one streaming turn and delivers exactly one final transcript. */
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import SpeechStreaming, { Channel, type StreamEvent } from '@dshub/speech-streaming'
import { afterEach, expect, it, vi } from 'vitest'
import AirpodsSpace from '../src/index.ts'
import type { AirpodsUpdate } from '../src/types.ts'

const executable = fileURLToPath(new URL('fixtures/fake-helper.mjs', import.meta.url))
const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => root.fiber.dispose())) })

const contexts = new WeakMap<AirpodsSpace, Context>()
const ctxOf = (space: AirpodsSpace): Context => contexts.get(space)!

/** @param spoken - final text the echo provider reports; defaults to the sample count. */
async function setup(spoken?: string) {
  const ctx = new Context(); roots.push(ctx)
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(SpeechToText, { defaultProvider: 'echo', language: 'auto' })
  await ctx.plugin(SpeechStreaming, { defaultProvider: 'echo' })
  const received: number[] = []
  ctx.get('speechStreaming')!.register({
    info: { id: 'echo' as SpeechProviderId, name: 'echo', location: 'host-local', languages: ['auto'] },
    open: async () => {
      const events = new Channel<StreamEvent>()
      let samples = 0
      return {
        write: (pcm) => { samples += pcm.length; received.push(pcm.length); events.push({ type: 'partial', segment: 0, text: `听到 ${samples}` }) },
        finish: () => { events.push({ type: 'end', text: spoken ?? `你好 ${samples}`, audioSeconds: samples / 16000 }); events.close() },
        events,
      }
    },
  })
  const space = new AirpodsSpace(ctx, AirpodsSpace.Config({ executable, assets: '/tmp', autoPrepare: false, provider: 'echo' }))
  contexts.set(space, ctx)
  return { space, received }
}

async function collect(space: AirpodsSpace, until: (updates: AirpodsUpdate[]) => boolean): Promise<AirpodsUpdate[]> {
  const lifetime = new AbortController(), updates: AirpodsUpdate[] = []
  for await (const update of space.follow(lifetime.signal)) {
    updates.push(update)
    if (until(updates)) { lifetime.abort(); break }
  }
  return updates
}

it.skipIf(process.platform !== 'darwin')('reports the helper state, then turns a press into one final transcript', { timeout: 20_000 }, async () => {
  const { space, received } = await setup()
  const ready = await collect(space, updates => updates.some(update => update.type === 'snapshot' && update.snapshot.ownsPress))
  const snapshot = ready.filter(update => update.type === 'snapshot').at(-1)!
  expect(snapshot.type === 'snapshot' && snapshot.snapshot).toMatchObject({
    helper: 'running', ownsPress: true, permissions: { microphone: 'granted' },
    pods: { model: 'airpods-2', connected: true, batteries: { left: 99, right: 98, case: 8 } },
  })

  const turn = collect(space, updates => updates.some(update => update.type === 'transcript' && update.transcript.phase === 'final'))
  await vi.waitFor(() => { space.press() })
  const updates = await turn
  const transcripts = updates.flatMap(update => update.type === 'transcript' ? [update.transcript] : [])
  expect(transcripts.filter(item => item.phase === 'final')).toEqual([expect.objectContaining({ turn: 1, text: '你好 4800' })])
  expect(transcripts.some(item => item.phase === 'partial')).toBe(true)
  expect(received).toEqual([1600, 1600, 1600])
})

it.skipIf(process.platform !== 'darwin')('names the app that took the headphone press', { timeout: 20_000 }, async () => {
  const { space } = await setup()
  await collect(space, updates => updates.some(update => update.type === 'snapshot' && update.snapshot.helper === 'running'))
  const lost = collect(space, updates => updates.some(update => update.type === 'snapshot' && update.snapshot.competitors.length > 0))
  space.setClaim(true)
  const last = (await lost).at(-1)!
  expect(last.type === 'snapshot' && last.snapshot).toMatchObject({ ownsPress: false, competitors: [{ app: 'Friday', kind: 'now-playing' }] })
})

it.skipIf(process.platform !== 'darwin')('falls back to the local provider when the cloud provider cannot open', { timeout: 20_000 }, async () => {
  const { space } = await setup()
  ctxOf(space).get('speechStreaming')!.register({
    info: { id: 'aliyun-realtime' as SpeechProviderId, name: 'cloud', location: 'cloud', languages: ['auto'] },
    open: async () => { throw new Error('network down') },
  })
  await collect(space, updates => updates.some(update => update.type === 'snapshot' && update.snapshot.helper === 'running'))
  space.setPreferences({ sendMode: 'pause', pauseSeconds: 1, popupCard: true, nearbyUnpaired: true, doneSound: false, earcons: false, readApproval: false, progress: false, nextAction: 'send', previousAction: 'interrupt', headGestures: true, quickInterrupt: true, quickInsert: true, voiceCommands: true, autoRead: false, asrSource: 'cloud', onboarded: true })
  const turn = collect(space, updates => updates.some(update => update.type === 'transcript' && update.transcript.phase !== 'partial'))
  space.press()
  const final = (await turn).flatMap(update => update.type === 'transcript' ? [update.transcript] : []).at(-1)
  expect(final).toMatchObject({ phase: 'final', text: '你好 4800' })
})

it.skipIf(process.platform !== 'darwin')('runs a spoken command instead of sending it', { timeout: 20_000 }, async () => {
  const { space } = await setup('发送')
  await collect(space, updates => updates.some(update => update.type === 'snapshot' && update.snapshot.helper === 'running'))
  const turn = collect(space, updates => updates.some(update => update.type === 'command'))
  space.press()
  const updates = await turn
  expect(updates.find(update => update.type === 'command')).toMatchObject({ command: 'send', turn: 1 })
  expect(updates.flatMap(update => update.type === 'transcript' && update.transcript.phase === 'final' ? [update.transcript.text] : [])).toEqual([''])
})

it.skipIf(process.platform !== 'darwin')('survives a helper that keeps exiting while commands are sent', { timeout: 20_000 }, async () => {
  const ctx = new Context(); roots.push(ctx)
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(SpeechToText, { defaultProvider: 'echo', language: 'auto' })
  await ctx.plugin(SpeechStreaming, { defaultProvider: 'echo' })
  const unhandled: unknown[] = []
  const record = (error: unknown): void => { unhandled.push(error) }
  process.on('uncaughtException', record)
  try {
    const space = new AirpodsSpace(ctx, AirpodsSpace.Config({ executable: '/usr/bin/true', assets: '/tmp', restartDelaysMs: [50, 50, 50] }))
    for (let i = 0; i < 40; i++) {
      space.setPreferences({ sendMode: 'pause', pauseSeconds: 1, popupCard: true, nearbyUnpaired: true, doneSound: false, earcons: false, readApproval: false, progress: false, nextAction: 'send', previousAction: 'interrupt', headGestures: true, quickInterrupt: true, quickInsert: true, voiceCommands: true, autoRead: false, asrSource: 'local', onboarded: true })
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(unhandled).toEqual([])
  } finally { process.off('uncaughtException', record) }
})
