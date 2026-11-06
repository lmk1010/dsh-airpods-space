/** AirPods Remote observation and the composer dock registration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AirpodsSnapshot, AirpodsUpdate, CommandKind, Preferences, TranscriptUpdate } from '@dshub/airpods-space/types'
import type {} from '@dshub/airpods-space/remote'
import { createAirpodsButton } from './AirpodsButton.tsx'
import { NS, de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

export const inject = ['remote', 'slots', 'locale']

/** Host state plus the latest transcript update; `connected` is false while the stream reconnects. */
export interface AirpodsView {
  readonly snapshot: AirpodsSnapshot | null
  readonly transcript: TranscriptUpdate | null
  /** Latest command with a sequence number so repeats are distinct. */
  readonly command: { readonly kind: CommandKind; readonly seq: number } | null
  readonly connected: boolean
}

const PREFERENCES_KEY = 'dsh.airpods-space.preferences.v2'
/** Before v2 the send mode defaulted to sending after a pause; only the other choices carry over. */
const PREFERENCES_KEY_V1 = 'dsh.airpods-space.preferences'
const DEFAULT_PREFERENCES: Preferences = { sendMode: 'voice', pauseSeconds: 1, autoRead: true, asrSource: 'apple',
  popupCard: true, doneSound: true, earcons: true, readApproval: true,
  progress: false, quickInterrupt: true, quickInsert: true, voiceCommands: true,
  nextAction: 'send', previousAction: 'interrupt',
  onboarded: globalThis.localStorage?.getItem('dsh.airpods-space.onboarded') !== null }

/** Preferences persisted in this browser profile. */
export function loadPreferences(): Preferences {
  try {
    const raw = globalThis.localStorage?.getItem(PREFERENCES_KEY)
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Omit<Preferences, 'sendMode'>> & { sendMode?: string }
      // `press` (send on the next headset press) was retired: a press only talks; sending is by voice or pause.
      return { ...DEFAULT_PREFERENCES, ...stored, sendMode: stored.sendMode === 'pause' ? 'pause' : 'voice' }
    }
    const v1 = globalThis.localStorage?.getItem(PREFERENCES_KEY_V1)
    if (!v1) return DEFAULT_PREFERENCES
    const { sendMode: _sendMode, ...rest } = JSON.parse(v1) as Partial<Preferences>
    return { ...DEFAULT_PREFERENCES, ...rest }
  } catch (_corrupt) {
    // A corrupt entry falls back to defaults and is overwritten on the next change.
    return DEFAULT_PREFERENCES
  }
}

function observe(ctx: Context): { view: SnapshotStore<AirpodsView>; dispose: () => Promise<void> } {
  const view = createSnapshotStore<AirpodsView>({ snapshot: null, transcript: null, command: null, connected: false })
  let seq = 0
  let disposed = false
  const stream = ctx.remote.$stream<AirpodsUpdate>({
    name: 'AirPods space', open: signal => ctx.remote.airpods.follow(signal),
    ended: () => new RemoteStreamCarrierError('AirPods stream ended'),
    carrierFailed: () => { view.set({ ...view.getSnapshot(), connected: false }) },
  })
  const observing = (async () => {
    try {
      for await (const item of stream) {
        const update = item.value
        const current = view.getSnapshot()
        view.set(update.type === 'snapshot' ? { ...current, snapshot: update.snapshot, connected: true }
          : update.type === 'transcript' ? { ...current, transcript: update.transcript, connected: true }
            : { ...current, command: { kind: update.command, seq: ++seq }, connected: true })
        item.accept()
      }
    } catch (error) {
      if (!disposed) ctx.logger.warn('AirPods stream stopped', error)
    }
  })()
  return { view, dispose: async () => { disposed = true; await stream.dispose(); await observing } }
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }))
  const observed = observe(ctx)
  ctx.effect(() => observed.dispose)
  const call = async (run: () => Promise<{ ok: boolean; error?: unknown }>): Promise<void> => {
    const result = await run()
    if (!result.ok) ctx.logger.warn('AirPods command failed', result.error)
  }
  const AirpodsButton = createAirpodsButton({
    airpods: observed.view,
    press: () => { void call(() => ctx.remote.airpods.press()) },
    takeButton: () => { void call(() => ctx.remote.airpods.setClaim(true)) },
    connectDevice: (address) => { void call(() => ctx.remote.airpods.connectDevice(address)) },
    speak: (text) => { void call(() => ctx.remote.airpods.speak(text)) },
    stopSpeaking: () => { void call(() => ctx.remote.airpods.stopSpeaking()) },
    setHeadGestures: (on) => { void call(() => ctx.remote.airpods.setHeadGestures(on)) },
    showGuide: () => { void call(() => ctx.remote.airpods.showGuide()) },
    setPreferences: (preferences) => {
      globalThis.localStorage?.setItem(PREFERENCES_KEY, JSON.stringify(preferences))
      void call(() => ctx.remote.airpods.setPreferences(preferences))
    },
    saveCloudKey: async (apiKey) => {
      const result = await ctx.remote.airpods.saveCloudKey(apiKey)
      return result.ok && result.value
    },
    prepareModel: () => { void call(() => ctx.remote.airpods.prepareModel()) },
    modelInfo: async () => {
      const result = await ctx.remote.airpods.modelInfo()
      return result.ok ? result.value : { dir: '', bytes: 0 }
    },
    deleteModel: async () => { await call(() => ctx.remote.airpods.deleteModel()) },
    revealModel: () => { void call(() => ctx.remote.airpods.revealModel()) },
    cloudKeyStatus: async () => {
      const result = await ctx.remote.airpods.cloudKeyStatus()
      return result.ok ? result.value : { saved: false, hint: '' }
    },
    deleteCloudKey: async () => { await call(() => ctx.remote.airpods.deleteCloudKey()) },
    testCloud: async () => {
      const result = await ctx.remote.airpods.testCloud()
      return result.ok ? result.value : { ok: false, ms: 0, message: String(result.error) }
    },
    setBusy: (on) => { void call(() => ctx.remote.airpods.setBusy(on)) },
    chime: (name) => { void call(() => ctx.remote.airpods.chime(name)) },
    openLink: (target) => { void call(() => ctx.remote.airpods.openLink(target)) },
    deviceImage: async (model, variant) => {
      const result = await ctx.remote.airpods.deviceImage(model, variant ?? 'case')
      return result.ok ? result.value : ''
    },
    cancelModelDownload: () => { void call(() => ctx.remote.airpods.cancelModelDownload()) },
    cancelSession: (sessionId) => { void call(() => ctx.remote.session.cancel({ sessionId })) },
    openBluetoothSettings: () => { void call(() => ctx.remote.airpods.openBluetoothSettings()) },
    openBluetoothPairing: () => { void call(() => ctx.remote.airpods.openBluetoothPairing()) },
    // The helper captures audio as its own TCC client, so it asks; the answer arrives as a snapshot.
    requestMicrophone: async () => { await call(() => ctx.remote.airpods.requestMicrophone()) },
    openMicrophoneSettings: () => { void call(() => ctx.remote.airpods.openMicrophoneSettings()) },
  })
  // The Host starts with defaults; push the stored preferences once the Remote is ready.
  void call(() => ctx.remote.airpods.setPreferences(loadPreferences()))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'airpods-space', locale: NS,
  }, AirpodsButton))
}

/**
 * Mount the `airpods` Remote and the composer dock.
 * @param ctx - Client runtime owning the Remote, dictionaries and slots.
 * @param contribution - generated `airpods` Remote definitions.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function mountAirpodsSpace(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.airpods', 'slots', 'locale'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
