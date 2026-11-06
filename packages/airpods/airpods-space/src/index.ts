/** Press your AirPods to talk to DSH: owns the native helper, turns each press into a streaming recognition turn. */
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import { Channel, type StreamingSession, type SpeechProviderId } from '@dshub/speech-streaming'
import { helperAssets, helperExecutable } from '@dshub/airpods-helper'
import { HelperProcess, type HelperEvent } from './helper.ts'
import { parseCommand, trailingInsert, trailingSend } from './commands.ts'
import type { AirpodsSnapshot, AirpodsUpdate, CommandKind, Competitor, DeviceInfo, ModelState, PodsState, Preferences, TalkPhase, TranscriptUpdate } from './types.ts'

export type * from './types.ts'
export { parseCommand } from './commands.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** AirPods press-to-talk controller and `airpods` Remote namespace. */
    airpodsSpace: AirpodsSpace
  }
}

export interface Config {
  /** Helper executable; defaults to the binary shipped in `@dshub/airpods-helper`. */
  executable?: string
  /** Directory of product renders for the connect card; defaults to the helper package's `assets`. */
  assets?: string
  /** Directory holding the local streaming model's files, shown and removable from settings; empty hides them. */
  modelDir: string
  /** Show the native connect card when the case opens or the buds are put on. */
  popup: boolean
  /** Take the system Now Playing target when AirPods become the output and nothing else plays. */
  claimNowPlaying: boolean
  /** Streaming provider for the `local` source; empty uses the registry default. */
  provider: string
  /** Streaming provider for the `cloud` source. */
  cloudProvider: string
  /** Language hint; empty uses the registry default. */
  language: string
  /** Download the local model as soon as the plugin starts; off by default, the download starts when the user picks the local source. */
  autoPrepare: boolean
  /** End the turn once recognized text has not changed for this long; `0` waits for a second press. */
  autoEndSilenceMs: number
  /** End the turn when nothing was recognized for this long after the press. */
  noSpeechTimeoutMs: number
  maxLineBytes: number
  restartDelaysMs: number[]
  graceMs: number
  maxLogBytes: number
}

interface Turn {
  readonly number: number
  readonly pressAt: number
  readonly abort: AbortController
  session?: StreamingSession
  pending: Int16Array[]
  finished: boolean
  /** Latest recognized text and when it last changed, for pause detection. */
  heard: string
  changedAt: number
  delivered: boolean
}

/** Host controller; Remote calls never submit to a Session, the Client decides what to do with transcripts. */
export default class AirpodsSpace extends TypertRemoteService {
  static inject = ['speechStreaming', 'speechToText', 'subprocess', 'typert']
  static Config: z<Partial<Config>, Config> = z.object({
    executable: z.string().min(1),
    assets: z.string().min(1),
    popup: z.boolean().default(true),
    claimNowPlaying: z.boolean().default(true),
    provider: z.string().default(''),
    cloudProvider: z.string().default('aliyun-realtime'),
    language: z.string().default(''),
    autoPrepare: z.boolean().default(false),
    modelDir: z.string().default(''),
    autoEndSilenceMs: z.natural().default(1600),
    noSpeechTimeoutMs: z.natural().min(1000).default(8000),
    maxLineBytes: z.natural().min(1024).default(1024 * 1024),
    restartDelaysMs: z.array(z.natural()).default([500, 2000, 5000, 15000, 60000]),
    graceMs: z.natural().min(1).default(1000),
    maxLogBytes: z.natural().min(1).default(64 * 1024),
  })

  private state: AirpodsSnapshot = { helper: 'starting', talk: 'idle', endSilenceMs: 1600, ownsPress: false, competitors: [],
    permissions: { microphone: 'unknown', bluetooth: 'unknown', speech: 'unknown' }, model: { phase: 'unknown' }, devices: [],
    reading: false, headMotion: false, route: { output: '', outputBluetooth: false },
    preferences: { sendMode: 'voice', pauseSeconds: 1, autoRead: true, asrSource: 'apple', onboarded: false,
      popupCard: true, doneSound: true, earcons: true, readApproval: true,
      progress: false, quickInterrupt: true, quickInsert: true, voiceCommands: true } }
  private readonly observers = new Set<Channel<AirpodsUpdate>>()
  private readonly helper: HelperProcess | undefined
  private turn: Turn | undefined
  private turns = 0
  /** Registered id of the local streaming provider, once seen. */
  private localModelId: SpeechProviderId | undefined
  /** Apple on-device recognition is authorized and available for the locale. */
  private appleReady = false

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'airpodsSpace', { namespace: 'airpods' })
    if (process.platform !== 'darwin') {
      this.state = { ...this.state, helper: 'unsupported', helperMessage: 'AirPods press-to-talk requires macOS' }
      return
    }
    const helper = new HelperProcess(ctx, {
      executable: config.executable ?? helperExecutable,
      assets: config.assets ?? helperAssets,
      maxLineBytes: config.maxLineBytes, restartDelaysMs: config.restartDelaysMs,
      graceMs: config.graceMs, maxLogBytes: config.maxLogBytes,
    }, (event) => { this.handle(event) }, (status, message) => {
      this.set({ helper: status, ...message === undefined ? {} : { helperMessage: message } })
    })
    this.helper = helper
    ctx.effect(() => {
      const lifetime = new AbortController()
      void this.followModel(lifetime.signal)
      return () => { lifetime.abort() }
    })
    ctx.effect(() => {
      helper.start()
      return async () => {
        this.endTurn('disposed')
        for (const observer of this.observers) observer.close()
        await helper.stop()
      }
    })
  }

  /**
   * Follow AirPods state and transcripts; the first item is the current snapshot.
   * @param signal - Client observation lifetime.
   * @returns snapshots after every change and transcript updates in order.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<AirpodsUpdate> {
    const channel = new Channel<AirpodsUpdate>()
    channel.push({ type: 'snapshot', snapshot: this.state })
    this.observers.add(channel)
    const stop = (): void => { channel.close() }
    signal.addEventListener('abort', stop, { once: true })
    try { yield* channel } finally {
      this.observers.delete(channel)
      signal.removeEventListener('abort', stop)
    }
  }

  /** Start or end a talk turn, exactly like a headphone press (keyboard shortcut and UI button). */
  @Remote
  press(): void { this.command({ cmd: 'press', source: 'ui' }) }

  /**
   * Allow or stop taking the Now Playing target that routes headphone presses to DSH.
   * @param enabled - whether DSH may claim it.
   */
  @Remote
  setClaim(enabled: boolean): void { this.command({ cmd: enabled ? 'claim' : 'release' }) }

  /**
   * Read text aloud in the headset with the system voice; replaces anything being read.
   * @param text - plain text.
   */
  @Remote
  speak(text: string): void { this.command({ cmd: 'speak', text: text.slice(0, 4000) }) }

  /** Stop reading aloud. */
  @Remote
  stopSpeaking(): void { this.command({ cmd: 'stop-speaking' }) }

  /**
   * Listen for nod / shake while an approval is waiting; sensors stay off otherwise.
   * @param on - whether an approval is pending.
   */
  @Remote
  setHeadGestures(on: boolean): void { if (this.state.headMotion || !on) this.command({ cmd: 'head', on }) }

  /** Show the gesture and voice-command guide on the desktop. */
  @Remote
  showGuide(): void {
    const connected = this.state.devices.find(device => device.connected) ?? this.state.devices[0]
    this.command({ cmd: 'guide', model: connected?.model ?? this.state.pods?.model ?? 'airpods-2', name: connected?.name ?? 'AirPods' })
  }

  /** Start (or resume) downloading the local recognition model; progress arrives in snapshots. */
  @Remote
  prepareModel(): void { if (this.localModelId) this.ctx.speechToText.prepare(this.localModelId) }

  /** Stop the local model download; downloaded files are kept and verified on the next attempt. */
  @Remote
  async cancelModelDownload(): Promise<void> { if (this.localModelId) await this.ctx.speechToText.cancelPreparation(this.localModelId) }

  /**
   * Apply the user's preferences (persisted by the Client). Choosing the local source never downloads by itself; the
   * user starts the download explicitly with {@link AirpodsSpace.prepareModel}.
   * @param preferences - complete preference set.
   */
  @Remote
  setPreferences(preferences: Preferences): void {
    this.set({ preferences, endSilenceMs: this.endSilenceMs(preferences) })
    this.helper?.send({ cmd: 'popup', enabled: preferences.popupCard })
    this.helper?.send({ cmd: 'earcons', on: preferences.earcons })
    this.helper?.send({ cmd: 'asr', source: preferences.asrSource === 'apple' ? 'apple' : 'host', locale: 'zh-CN' })
  }

  /**
   * Product render of a model family for the settings page, as a PNG data URL.
   * @param model - model key from a device, for example `airpods-pro-2`.
   * @param variant - the charging case, or the two earbuds alone.
   * @returns the image, or an empty string when no render exists.
   */
  @Remote
  async deviceImage(model: string, variant: 'case' | 'buds'): Promise<string> {
    const family = model.startsWith('airpods-max') ? 'airpods-max' : model.startsWith('airpods-pro') ? 'airpods-pro'
      : model.startsWith('airpods-4') ? 'airpods-4' : model === 'airpods-3' ? 'airpods-3' : 'airpods-2'
    const file = join(this.config.assets ?? helperAssets, 'thumb', family === 'airpods-max' ? 'airpods-max.png' : `${family}-${variant === 'buds' ? 'buds' : 'closed'}.png`)
    try { return `data:image/png;base64,${(await readFile(file)).toString('base64')}` } catch (_missing) {
      // Renders are optional product art; the page shows the glyph instead.
      return ''
    }
  }

  /**
   * Where the local model lives and how much space it takes.
   * @returns the directory and its size in bytes (0 when absent).
   */
  @Remote
  async modelInfo(): Promise<{ dir: string; bytes: number }> {
    const dir = this.config.modelDir
    return { dir, bytes: dir === '' ? 0 : await directorySize(dir) }
  }

  /** Stop any download and remove the local model's files; choosing the local source again needs a new download. */
  @Remote
  async deleteModel(): Promise<void> {
    if (this.localModelId) await this.ctx.speechToText.cancelPreparation(this.localModelId)
    if (this.config.modelDir !== '') await rm(this.config.modelDir, { recursive: true, force: true })
    this.set({ model: { phase: 'unknown' } })
  }

  /** Show the local model's folder in Finder. */
  @Remote
  revealModel(): void {
    if (this.config.modelDir !== '') execFile('/usr/bin/open', [this.config.modelDir], () => { /* Finder reports its own failures. */ })
  }

  /**
   * Play an outcome tone through the current output (the AirPods while connected).
   * @param name - `done` when a task finishes, `failed` when it stops with an error, `approval` when DSH asks.
   */
  @Remote
  chime(name: 'done' | 'failed' | 'approval'): void { this.command({ cmd: 'chime', name }) }

  /** Ask the helper to re-scan competing apps; the result arrives as a snapshot. */
  @Remote
  refreshConflicts(): void { this.command({ cmd: 'conflicts' }) }

  /** Ask for microphone access; the helper is its own TCC client, so the system prompt names it. */
  @Remote
  requestMicrophone(): void { this.command({ cmd: 'request-microphone' }) }

  /**
   * Connect a paired AirPods pair to this Mac, taking it from another device if needed.
   * @param address - Bluetooth address from `devices`.
   */
  @Remote
  connectDevice(address: string): void {
    this.command({ cmd: 'connect', address })
    this.set({ connecting: address, connectFailed: undefined })
  }

  /** Re-read microphone and Bluetooth authorization after the user answered a prompt. */
  @Remote
  refreshPermissions(): void { this.command({ cmd: 'permissions' }) }

  /** Open System Settings at Privacy & Security › Bluetooth. */
  @Remote
  openBluetoothSettings(): void { this.command({ cmd: 'open-bluetooth-settings' }) }

  /**
   * Save the Aliyun API key in the macOS Keychain (account `dshub`, service `dshub.aliyun.dashscope`), where the Aliyun
   * provider reads it; the key is never written to a file or a log.
   * @param apiKey - Model Studio API key.
   * @returns whether the Keychain accepted it.
   */
  @Remote
  async saveCloudKey(apiKey: string): Promise<boolean> {
    const key = apiKey.trim()
    if (process.platform !== 'darwin' || key === '' || key.length > 512) return false
    const { execFile } = await import('node:child_process')
    return await new Promise((resolve) => {
      execFile('security', ['add-generic-password', '-U', '-a', 'dshub', '-s', 'dshub.aliyun.dashscope', '-l', 'DSHub Aliyun API Key', '-w', key],
        (error) => { resolve(error === null) })
    })
  }

  /**
   * Whether an Aliyun key is saved, with only its last four characters for recognition.
   * @returns saved flag and a masked hint such as `sk-…a1b2`.
   */
  @Remote
  async cloudKeyStatus(): Promise<{ saved: boolean; hint: string }> {
    const key = await keychainRead('dshub.aliyun.dashscope')
    return { saved: key !== '', hint: key === '' ? '' : `${key.slice(0, 3)}…${key.slice(-4)}` }
  }

  /** Remove the saved Aliyun key from the Keychain. */
  @Remote
  async deleteCloudKey(): Promise<void> {
    await new Promise<void>((resolve) => {
      execFile('security', ['delete-generic-password', '-a', 'dshub', '-s', 'dshub.aliyun.dashscope'], () => { resolve() })
    })
  }

  /**
   * Open an Aliyun recognition session with a moment of silence and report whether it answers.
   * @returns success, round-trip milliseconds, and the provider's message on failure.
   */
  @Remote
  async testCloud(): Promise<{ ok: boolean; ms: number; message: string }> {
    const started = performance.now()
    const abort = new AbortController()
    const timer = setTimeout(() => { abort.abort(new Error('timeout')) }, 8000)
    try {
      const spec = this.ctx.speechStreaming.resolve(this.providerRequest(true))
      const session = await this.ctx.speechStreaming.open(spec, abort.signal)
      session.write(new Int16Array(4800))
      session.finish()
      for await (const event of session.events) if (event.type === 'end') break
      return { ok: true, ms: Math.round(performance.now() - started), message: '' }
    } catch (error) {
      return { ok: false, ms: Math.round(performance.now() - started), message: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timer)
      abort.abort()
    }
  }

  /**
   * Open a fixed help page in the browser.
   * @param target - `aliyun-console` for the Model Studio API key page, `aliyun-help` for how to get a key.
   */
  @Remote
  openLink(target: 'aliyun-console' | 'aliyun-help'): void {
    const url = target === 'aliyun-console' ? 'https://bailian.console.aliyun.com/?tab=model#/api-key' : 'https://help.aliyun.com/zh/model-studio/get-api-key'
    execFile('/usr/bin/open', [url], () => { /* The browser reports its own failures. */ })
  }

  /** Open System Settings › Bluetooth, where new AirPods are paired. */
  @Remote
  openBluetoothPairing(): void { this.command({ cmd: 'open-bluetooth-pairing' }) }

  /** Open System Settings at Privacy & Security › Microphone. */
  @Remote
  openMicrophoneSettings(): void { this.command({ cmd: 'open-microphone-settings' }) }

  private talkProvider(): SpeechProviderId | undefined {
    try {
      return this.ctx.speechStreaming.resolve(this.config.provider === '' ? {} : { providerId: this.config.provider as SpeechProviderId }).provider.info.id
    } catch (_unregistered) {
      // The provider registers asynchronously; readiness is re-read on the next registry change.
      return undefined
    }
  }

  /** Mirror the talk provider's preparation and start it once when it is missing. */
  private async followModel(signal: AbortSignal): Promise<void> {
    let requested = false
    try {
      for await (const snapshot of this.ctx.speechToText.follow(signal)) {
        const id = this.talkProvider()
        const view = snapshot.providers.find(provider => provider.id === id)
        if (!view || id === undefined) continue
        const prep = view.preparation
        const model: ModelState = prep.phase === 'ready' || prep.phase === 'standby' ? { phase: 'ready' }
          : prep.phase === 'downloading' ? { phase: 'downloading', completedBytes: prep.completedBytes, ...prep.totalBytes === undefined ? {} : { totalBytes: prep.totalBytes } }
            : prep.phase === 'failed' ? { phase: 'failed', message: prep.message }
              : prep.phase === 'unprepared' || prep.phase === 'cancelled' ? { phase: 'unknown' }
                : { phase: 'preparing' }
        if (JSON.stringify(model) !== JSON.stringify(this.state.model)) this.set({ model })
        if (prep.phase === 'unprepared' && this.config.autoPrepare && !requested) {
          requested = true
          this.ctx.speechToText.prepare(id)
        }
        this.localModelId = id
      }
    } catch (error) {
      if (!signal.aborted) this.ctx.logger.warn('AirPods model readiness stopped', error)
    }
  }

  private command(command: { readonly cmd: string } & Record<string, unknown>): void {
    if (this.helper?.send(command) !== true) {
      throw new RemoteError('airpods/helper-unavailable', 'The AirPods helper is not running', { reason: this.state.helper })
    }
  }

  private set(patch: Partial<AirpodsSnapshot>): void {
    this.state = { ...this.state, ...patch }
    this.publish({ type: 'snapshot', snapshot: this.state })
  }

  private publish(update: AirpodsUpdate): void { for (const observer of this.observers) observer.push(update) }

  private transcript(turn: Turn, phase: TranscriptUpdate['phase'], text: string, submit = false, steer = false): void {
    // Mirror the turn into the helper's background capsule (shown only while DSH is not frontmost).
    this.helper?.send({ cmd: 'caption', phase: phase === 'partial' ? 'listening' : phase === 'failed' ? 'failed' : 'sent', text: phase === 'failed' ? '' : text })
    this.publish({ type: 'transcript', transcript: { turn: turn.number, phase, text, sincePressMs: Math.round(performance.now() - turn.pressAt), ...submit ? { submit } : {}, ...steer ? { steer } : {} } })
  }

  private competitor(entry: Competitor): void {
    const others = this.state.competitors.filter(item =>
      !(item.bundle === entry.bundle && item.app === entry.app && item.kind === entry.kind))
    this.set({ competitors: [...others, entry] })
  }

  private pods(event: HelperEvent, patch: Partial<PodsState> = {}): void {
    const previous = this.state.pods
    const number = (key: string, fallback: number | null): number | null => typeof event[key] === 'number' ? event[key] as number : fallback
    const pods: PodsState = {
      model: typeof event.model === 'string' ? event.model : previous?.model ?? 'unknown',
      name: typeof event.name === 'string' ? event.name : previous?.name ?? 'AirPods',
      gesture: typeof event.gesture === 'string' ? event.gesture : previous?.gesture ?? 'double-tap',
      connected: previous?.connected ?? false,
      // Debounced transitions decide; the first advert seen sets the starting state.
      inEar: event.state === 'in-ear' ? true : event.state === 'out-of-ear' ? false
        : previous === undefined && typeof event.inEar === 'boolean' ? event.inEar : previous?.inEar ?? false,
      batteries: { left: number('left', previous?.batteries.left ?? null), right: number('right', previous?.batteries.right ?? null),
        case: number('case', previous?.batteries.case ?? null) },
      ...patch,
    }
    this.set({ pods })
  }

  private markDisconnected(model: string): void {
    if (!this.state.devices.some(device => device.connected && device.model === model)) return
    this.set({
      devices: this.state.devices.map(device => device.connected && device.model === model ? { ...device, connected: false } : device),
      ...this.state.pods ? { pods: { ...this.state.pods, connected: false, inEar: false } } : {},
    })
  }

  private handle(event: HelperEvent): void {
    switch (event.event) {
      case 'hello':
        this.helper?.send({ cmd: 'popup', enabled: this.config.popup })
        if (!this.config.claimNowPlaying) this.helper?.send({ cmd: 'release' })
        this.helper?.send({ cmd: 'conflicts' })
        this.helper?.send({ cmd: 'devices' })
        this.helper?.send({ cmd: 'asr', source: this.state.preferences.asrSource === 'apple' ? 'apple' : 'host', locale: 'zh-CN' })
        break
      case 'permissions':
        this.set({ permissions: { microphone: String(event.microphone), bluetooth: String(event.bluetooth), speech: String(event.speech ?? 'unknown') },
          headMotion: event.headMotion === true })
        this.appleReady = this.appleReady && event.speech === 'granted'
        break
      case 'asr':
        if (event.phase === 'source') this.appleReady = event.source === 'apple' && event.available === true && this.state.permissions.speech !== 'denied'
        else if (event.phase === 'unavailable') this.appleReady = false
        else {
          if (typeof event.error === 'string') this.ctx.logger.warn('Apple recognition ended with an error', event.error)
          this.appleText(String(event.phase), String(event.text ?? ''))
        }
        break
      case 'gesture': {
        const kinds: Record<string, CommandKind> = { interrupt: 'interrupt', undo: 'undo', 'stop-reading': 'stop-reading', send: 'send' }
        const command = kinds[String(event.kind)]
        if (command) this.publish({ type: 'command', command })
        break
      }
      case 'head':
        if (event.state === 'gesture') this.publish({ type: 'command', command: event.gesture === 'nod' ? 'approve' : 'deny' })
        break
      case 'speaking': {
        const reading = event.state === 'start' || event.state === 'resumed'
        if (reading !== this.state.reading) this.set({ reading })
        break
      }
      case 'pods':
        if (event.state === 'gone') { if (this.state.pods && !this.state.pods.connected) this.set({ pods: undefined }) }
        else this.pods(event)
        // Both buds in a closed case disconnect a few seconds later; show it now. A later connect event corrects it.
        if (event.state === 'closed' && event.budsInCase === 2) this.markDisconnected(String(event.model ?? ''))
        break
      case 'device':
        this.pods(event, { connected: true })
        try { this.ctx.speechStreaming.warm(this.providerRequest(this.state.preferences.asrSource === 'cloud')) }
        catch (error) { this.ctx.logger.warn('AirPods recognizer warm-up failed', error) }
        break
      case 'connected': if (this.state.pods) this.pods(event, { connected: true }); break
      case 'disconnected': if (this.state.pods) this.pods(event, { connected: false, inEar: false }); break
      case 'claim':
        if (event.state === 'claimed') this.set({ ownsPress: true })
        else if (event.state === 'released') this.set({ ownsPress: false })
        else if (event.state === 'lost') {
          this.set({ ownsPress: false })
          const to = event.to as { app?: string; bundle?: string } | undefined
          if (to?.app) this.competitor({ app: to.app, bundle: to.bundle ?? '', kind: 'now-playing' })
        }
        break
      case 'conflict': {
        const app = event.app as { app?: string; bundle?: string } | undefined
        if (app?.app) this.competitor({ app: app.app, bundle: app.bundle ?? '', kind: 'reclaimer' })
        break
      }
      case 'conflicts': {
        const list = (key: string, kind: Competitor['kind']): Competitor[] =>
          ((event[key] as { app?: string; bundle?: string }[] | undefined) ?? [])
            .flatMap(item => item.app ? [{ app: item.app, bundle: item.bundle ?? '', kind }] : [])
        const kept = this.state.competitors.filter(item => item.kind === 'now-playing' || item.kind === 'reclaimer')
        this.set({ competitors: [...kept, ...list('interceptors', 'interceptor'), ...list('recording', 'microphone')] })
        break
      }
      case 'voice':
        if (event.cancelled === true) { this.endTurn('cancelled'); this.set({ talk: 'idle' }); break }
        if (typeof event.error === 'string') this.set({ refused: event.error, refusedAt: Date.now() })
        else if (event.state === 'talking' && this.state.refused !== undefined) this.set({ refused: undefined })
        this.voice(String(event.state))
        break
      case 'devices': {
        const level = (value: unknown): number | null => typeof value === 'number' ? value : null
        const devices: DeviceInfo[] = ((event.devices as Record<string, unknown>[] | undefined) ?? []).map(item => ({
          address: String(item.address), name: String(item.deviceName ?? item.name ?? 'AirPods'), model: String(item.model ?? 'unknown'),
          connected: item.connected === true, batteries: { left: level(item.left), right: level(item.right), case: level(item.case) },
        })).sort((a, b) => Number(b.connected) - Number(a.connected))
        this.set({ devices })
        break
      }
      case 'connect': {
        const address = typeof event.address === 'string' ? event.address : undefined
        if (event.ok === false && address !== undefined) {
          this.set({ connecting: undefined, connectFailed: address })
          setTimeout(() => { if (this.state.connectFailed === address) this.set({ connectFailed: undefined }) }, 3000)
        } else this.set({ connecting: undefined, connectFailed: undefined })
        break
      }
      case 'route': this.set({ route: { output: String(event.output ?? ''), outputBluetooth: event.outputBluetooth === true } }); break
      case 'permissions-changed': this.set({ permissions: { ...this.state.permissions, microphone: String(event.microphone) } }); break
      case 'audio': this.audio(String(event.pcm)); break
      case 'error': this.ctx.logger.warn('AirPods helper error', event.message); break
      default: break
    }
  }

  private voice(state: string): void {
    const talk = (phase: TalkPhase): void => { if (this.state.talk !== phase) this.set({ talk: phase }) }
    switch (state) {
      case 'opening': this.startTurn(); talk('opening'); this.helper?.send({ cmd: 'caption', phase: 'listening', text: '' }); break
      case 'talking': if (!this.turn || this.turn.finished) this.startTurn(); talk('talking'); break
      case 'ended': this.finishTurn(); talk('finishing'); this.helper?.send({ cmd: 'caption', phase: 'recognizing' }); break
      case 'idle': if (!this.turn || this.turn.finished) talk('idle'); break
      default: break
    }
  }

  private startTurn(): void {
    this.endTurn('superseded')
    const turn: Turn = { number: ++this.turns, pressAt: performance.now(), abort: new AbortController(), pending: [], finished: false,
      heard: '', changedAt: performance.now(), delivered: false }
    this.turn = turn
    this.watchPause(turn)
    if (this.state.preferences.asrSource === 'apple' && this.appleReady) return
    void this.streamTurn(turn)
  }

  /** End the turn after a pause in the recognized text (pause mode) or when nothing was heard. */
  private watchPause(turn: Turn): void {
    const watch = setInterval(() => {
      if (turn.finished || this.turn !== turn) { clearInterval(watch); return }
      const idle = performance.now() - turn.changedAt
      // Every turn ends on a pause: while the microphone is open the AirPods are in call mode, where a double-tap
      // ends the "call" inside the headset and never reaches DSH. The send mode only decides whether the text is sent.
      const silenceMs = this.endSilenceMs(this.state.preferences)
      if (turn.heard !== '' && silenceMs > 0 && idle > silenceMs) {
        clearInterval(watch); this.helper?.send({ cmd: 'end', reason: 'pause' })
      } else if (turn.heard === '' && performance.now() - turn.pressAt > this.config.noSpeechTimeoutMs) {
        clearInterval(watch); this.helper?.send({ cmd: 'end', reason: 'no-speech' })
      }
    }, 200)
    turn.abort.signal.addEventListener('abort', () => { clearInterval(watch) }, { once: true })
  }

  /** Pause send mode waits the user's chosen silence; otherwise the configured end-of-turn silence applies. */
  private endSilenceMs(preferences: Preferences): number {
    return preferences.sendMode === 'pause' ? preferences.pauseSeconds * 1000 : this.config.autoEndSilenceMs
  }

  private partial(turn: Turn, text: string): void {
    if (text !== turn.heard) { turn.heard = text; turn.changedAt = performance.now() }
    this.transcript(turn, 'partial', text)
  }

  /** Deliver the turn's final text once; an utterance that is exactly a command phrase runs the command instead. */
  private deliver(turn: Turn, text: string): void {
    if (turn.delivered) return
    turn.delivered = true
    const prefs = this.state.preferences
    const parsed = parseCommand(text)
    // Disabled commands are ordinary speech; "send" always follows the send mode.
    const command = parsed === undefined || parsed === 'send' ? parsed
      : parsed === 'interrupt' ? (prefs.quickInterrupt ? parsed : undefined)
        : prefs.voiceCommands ? parsed : undefined
    const inserted = prefs.quickInsert ? trailingInsert(text) : undefined
    if (command === undefined && inserted !== undefined && inserted.trim() !== '') {
      this.transcript(turn, 'final', inserted, false, true)
      return
    }
    if (command === undefined) {
      const spoken = trailingSend(text)
      const body = spoken ?? text
      this.transcript(turn, 'final', body, body.trim() !== '' && (spoken !== undefined || this.state.preferences.sendMode === 'pause'))
      return
    }
    this.transcript(turn, 'final', '')
    this.publish({ type: 'command', command, turn: turn.number })
  }

  /** Provider request for the selected source; the cloud source names its provider explicitly. */
  private providerRequest(cloud: boolean): { providerId?: SpeechProviderId; language?: string } {
    const providerId = cloud ? this.config.cloudProvider : this.config.provider
    return { ...providerId === '' ? {} : { providerId: providerId as SpeechProviderId },
      ...this.config.language === '' ? {} : { language: this.config.language } }
  }

  private async streamTurn(turn: Turn): Promise<void> {
    try {
      // Apple selected but unavailable (not allowed, no on-device model): try the cloud, then the local model.
      const source = this.state.preferences.asrSource
      const cloud = source === 'cloud' || (source === 'apple' && !this.appleReady)
      // Network, credential or registration failure of the cloud provider: fall back to the local model.
      const openWith = async (useCloud: boolean) => {
        const resolved = this.ctx.speechStreaming.resolve(this.providerRequest(useCloud))
        return { spec: resolved, session: await this.ctx.speechStreaming.open(resolved, turn.abort.signal) }
      }
      let opened
      try { opened = await openWith(cloud) } catch (error) {
        if (!cloud || turn.abort.signal.aborted) throw error
        this.ctx.logger.warn('Cloud recognition unavailable, using the local model', error)
        opened = await openWith(false)
      }
      const { spec, session } = opened
      turn.session = session
      for (const chunk of turn.pending) session.write(chunk)
      turn.pending = []
      if (turn.finished) session.finish()
      // With a second pass configured, `final` waits for the refined text so the Client inserts exactly once.
      const finals: string[] = []
      let ended: string | undefined
      for await (const event of session.events) {
        switch (event.type) {
          case 'partial': this.partial(turn, [...finals, event.text].filter(Boolean).join(' ')); break
          case 'final': finals.push(event.text); break
          case 'end':
            ended = event.text
            if (spec.refine === undefined || ended === '') this.deliver(turn, ended)
            else this.transcript(turn, 'partial', ended)
            break
          case 'refined': this.deliver(turn, event.text || ended || ''); break
          default: break
        }
      }
      if (ended !== undefined) this.deliver(turn, ended)
    } catch (error) {
      if (!turn.abort.signal.aborted) {
        this.ctx.logger.warn('AirPods talk turn failed', error)
        this.transcript(turn, 'failed', error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (this.turn === turn) { this.turn = undefined; this.set({ talk: 'idle' }) }
    }
  }

  /** Apple on-device recognition runs in the helper; its text arrives as `asr` events. */
  private appleText(phase: string, text: string): void {
    const turn = this.turn
    if (!turn) return
    if (phase === 'partial') { this.partial(turn, text); return }
    if (phase === 'final') {
      this.deliver(turn, text)
      this.turn = undefined
      this.set({ talk: 'idle' })
    }
  }

  private audio(base64: string): void {
    const turn = this.turn
    if (!turn || turn.finished || (this.state.preferences.asrSource === 'apple' && this.appleReady)) return
    const bytes = Buffer.from(base64, 'base64')
    const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength - bytes.byteLength % 2))
    if (turn.session) turn.session.write(pcm); else turn.pending.push(pcm)
  }

  private finishTurn(): void {
    const turn = this.turn
    if (!turn || turn.finished) return
    turn.finished = true
    turn.session?.finish()
  }

  private endTurn(reason: string): void {
    const turn = this.turn
    if (!turn) return
    this.turn = undefined
    turn.abort.abort(new Error(`Talk turn ended: ${reason}`))
  }
}

/** Total size of the files under a directory; 0 when it does not exist. */
async function directorySize(dir: string): Promise<number> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch (_absent) {
    // No directory means nothing downloaded.
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const path = join(dir, entry.name)
    total += entry.isDirectory() ? await directorySize(path) : (await stat(path)).size
  }
  return total
}

/** A generic password from the login Keychain; empty when absent. */
function keychainRead(service: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-a', 'dshub', '-s', service, '-w'], (error, stdout) => { resolve(error ? '' : stdout.trim()) })
  })
}
