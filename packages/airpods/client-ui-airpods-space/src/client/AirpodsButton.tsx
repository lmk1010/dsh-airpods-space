/**
 * Composer toolbar control beside the microphone. The AirPods glyph's color is the state (white ready, yellow not
 * connected, red blocked, green listening); clicking opens a menu like the model selector with every paired pair,
 * its connection and batteries, talk and fix actions. Live transcripts are written straight into the draft.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { Button, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AirpodsSnapshot, Competitor, DeviceInfo, Preferences } from '@dshub/airpods-space/types'
import { loadPreferences, type AirpodsView } from './mount.ts'
import { SettingsDialog, type SettingsPage } from './SettingsDialog.tsx'
import { SetupDialog } from './SetupDialog.tsx'

const ONBOARDED_KEY = 'dsh.airpods-space.onboarded'
import { NS } from './locales.ts'
import css from './AirpodsButton.module.css'

/** Dependencies captured by the button; list slots receive no injected props. */
export interface AirpodsButtonDeps {
  airpods: ObservableSnapshot<AirpodsView>
  press: () => void
  takeButton: () => void
  connectDevice: (address: string) => void
  openBluetoothSettings: () => void
  /** Open System Settings › Bluetooth to pair a new pair of AirPods. */
  openBluetoothPairing: () => void
  requestMicrophone: () => Promise<void>
  openMicrophoneSettings: () => void
  speak: (text: string) => void
  stopSpeaking: () => void
  setHeadGestures: (on: boolean) => void
  showGuide: () => void
  setPreferences: (preferences: Preferences) => void
  prepareModel: () => void
  cancelModelDownload: () => void
  saveCloudKey: (apiKey: string) => Promise<boolean>
  /** Product render of a model family as a data URL, or an empty string. */
  deviceImage: (model: string, variant?: 'case' | 'buds') => Promise<string>
  cloudKeyStatus: () => Promise<{ saved: boolean; hint: string }>
  deleteCloudKey: () => Promise<void>
  testCloud: () => Promise<{ ok: boolean; ms: number; message: string }>
  openLink: (target: 'aliyun-console' | 'aliyun-help') => void
  /** Task-finished chime in the headset. */
  chime: (name: 'done' | 'failed' | 'approval') => void
  /** Tell the Host whether DSH is answering, so a press interrupts instead of listening. */
  setBusy: (on: boolean) => void
  modelInfo: () => Promise<{ dir: string; bytes: number }>
  deleteModel: () => Promise<void>
  revealModel: () => void
  cancelSession: (sessionId: NonNullable<AirpodsButtonProps['sessionId']>) => void
}

export type AirpodsButtonProps = Pick<PropsRuntime<'conversation.input.right'>, 'inputActions' | 'useInput' | 'sessionId'> & PropsLocale<typeof NS>

/** Text of DSH's latest reply as rendered in the transcript, with the node key that identifies it. */
function latestReply(): { key: string; text: string } | undefined {
  const blocks = document.querySelectorAll('[data-chat-flow-kind="assistant-step"] [data-text-interaction-source]')
  const last = blocks[blocks.length - 1] as HTMLElement | undefined
  if (!last) return undefined
  const key = last.closest('[data-chat-node-key]')?.getAttribute('data-chat-node-key') ?? ''
  return { key, text: last.innerText.trim() }
}

/** Answer the visible approval card through its own keyboard handling (Enter allows, Escape rejects). */
function answerApproval(allow: boolean): boolean {
  const card = document.querySelector('[data-approval-key]')
  if (!card) return false
  card.dispatchEvent(new KeyboardEvent('keydown', { key: allow ? 'Enter' : 'Escape', bubbles: true }))
  return true
}

const use = <T,>(store: ObservableSnapshot<T>): T => useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())

/** Pair of earbuds drawn on the 24-unit grid used by the composer's outline icons. */
function AirpodsGlyph({ size = 18, className }: { size?: number; className?: string | undefined }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 3.5a3.6 3.6 0 0 0-.75 7.12v7.88a1.6 1.6 0 0 0 3.2 0V7.4A3.6 3.6 0 0 0 7 3.5Z" />
      <path d="M17 3.5a3.6 3.6 0 0 1 .75 7.12v7.88a1.6 1.6 0 0 1-3.2 0V7.4A3.6 3.6 0 0 1 17 3.5Z" />
      <path d="M5.4 6.6h.01M18.6 6.6h.01" strokeWidth="2.2" />
    </svg>
  )
}

type Blocker = { kind: 'conflict'; competitor: Competitor } | { kind: 'microphone'; denied: boolean } | { kind: 'bluetooth' } | { kind: 'error'; message: string }

/** Problems that stop a talk turn even though AirPods are connected. */
function blocker(snapshot: AirpodsSnapshot): Blocker | undefined {
  if (snapshot.helper === 'failed') return { kind: 'error', message: snapshot.helperMessage ?? '' }
  if (snapshot.model.phase === 'failed') return { kind: 'error', message: snapshot.model.message ?? '' }
  if (snapshot.permissions.bluetooth === 'denied') return { kind: 'bluetooth' }
  // Never asked is not a problem: the first press brings up the system dialog.
  if (snapshot.permissions.microphone === 'denied') return { kind: 'microphone', denied: true }
  const competitor = snapshot.ownsPress ? undefined
    : snapshot.competitors.find(item => item.kind === 'reclaimer') ?? snapshot.competitors.find(item => item.kind === 'now-playing')
  if (competitor) return { kind: 'conflict', competitor }
  return undefined
}

/** Join spoken text to the existing draft, with a space only between Latin words. */
function joinDraft(base: string, text: string): string {
  if (base === '') return text
  return /[A-Za-z0-9.,!?]$/.test(base) && /^[A-Za-z0-9]/.test(text) ? `${base} ${text}` : `${base}${text}`
}

const percent = (value: number | null): string => value === null ? '—' : `${value}%`

/**
 * Build the toolbar control over Host observations and commands.
 * @param deps - stores and commands owned by the plugin mount.
 * @returns slot component; renders nothing on hosts without the AirPods helper.
 */
export function createAirpodsButton({ airpods, press, takeButton, connectDevice, openBluetoothSettings, openBluetoothPairing,
  requestMicrophone, openMicrophoneSettings, speak, stopSpeaking, setHeadGestures, setPreferences, cancelSession, prepareModel,
  cancelModelDownload, saveCloudKey, deviceImage, modelInfo, deleteModel, revealModel, cloudKeyStatus, deleteCloudKey, testCloud,
  openLink, chime, setBusy }: AirpodsButtonDeps) {
  return function AirpodsButton({ inputActions, useInput, sessionId, t }: AirpodsButtonProps) {
    const view = use(airpods)
    const draft = useInput(state => state.draft)
    const draftRef = useRef(draft)
    draftRef.current = draft
    const turn = useRef<{ number: number; base: string } | undefined>(undefined)
    /** Draft before the last delivered turn, for undo, and whether that turn was sent. */
    const lastTurn = useRef<{ base: string; sent: boolean } | undefined>(undefined)
    // Partial results heard in the current turn; each one restarts the end-of-turn countdown ring.
    const [heard, setHeard] = useState(0)
    const [awaiting, setAwaiting] = useState(false)
    useEffect(() => { if (draft.trim() === '') setAwaiting(false) }, [draft])
    const done = useRef(new Set<number>())
    const [open, setOpen] = useState(false)
    // First run (or until configured): the setup dialog opens once the helper reports in.
    const [settingsOpen, setSettingsOpen] = useState(false)
    const [settingsPage, setSettingsPage] = useState<SettingsPage>('devices')
    const openSettings = (page: SettingsPage): void => { setSettingsPage(page); setSettingsOpen(true) }
    const [setupOpen, setSetupOpen] = useState(() => globalThis.localStorage?.getItem(ONBOARDED_KEY) === null)
    const closeSetup = (): void => {
      globalThis.localStorage?.setItem(ONBOARDED_KEY, '1'); setSetupOpen(false)
      setPreferences({ ...(view.snapshot?.preferences ?? loadPreferences()), onboarded: true })
    }
    /** Brief feedback flashes: `sent` after a turn is sent, `pop` when AirPods connect. */
    const [flash, setFlash] = useState<'sent' | 'pop' | 'refused' | undefined>(undefined)
    const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    const showFlash = (kind: 'sent' | 'pop' | 'refused', ms: number): void => {
      clearTimeout(flashTimer.current)
      setFlash(kind)
      flashTimer.current = setTimeout(() => { setFlash(undefined) }, ms)
    }
    useEffect(() => () => { clearTimeout(flashTimer.current) }, [])
    const transcript = view.transcript

    // Live text goes into the draft as it is recognized; the final text replaces it and is sent.
    useEffect(() => {
      if (!transcript || done.current.has(transcript.turn)) return
      if (turn.current?.number !== transcript.turn) turn.current = { number: transcript.turn, base: draftRef.current.trimEnd() }
      const base = turn.current.base
      if (transcript.phase === 'partial') {
        inputActions.setDraft(joinDraft(base, transcript.text))
        if (transcript.text.trim() !== '') setHeard(seq => seq + 1)
        return
      }
      setHeard(0)
      done.current.add(transcript.turn)
      turn.current = undefined
      // A failed turn keeps the words already recognized in the draft, unsent, so nothing the user said is lost.
      if (transcript.phase !== 'final') { lastTurn.current = { base, sent: false }; return }
      const text = transcript.text.trim()
      inputActions.setDraft(joinDraft(base, text))
      if (text !== '' && transcript.steer === true) { steer(); showFlash('sent', 1200); lastTurn.current = { base, sent: true }; return }
      const send = text !== '' && transcript.submit === true
      // Unsent dictated words wait in the draft until "send"; the icon shows a dot meanwhile.
      setAwaiting(text !== '' && !send)
      if (send) { inputActions.submit(); showFlash('sent', 1200) }
      // Unsent words wait in the draft; the next headset press sends them instead of opening the microphone.
      lastTurn.current = { base, sent: send }
    }, [transcript, inputActions])

    // Commands from headset gestures, head gestures and spoken command phrases.
    const command = view.command
    const handledCommand = useRef(0)
    useEffect(() => {
      if (!command || command.seq <= handledCommand.current) return
      handledCommand.current = command.seq
      switch (command.kind) {
        case 'interrupt':
          stopSpeaking()
          if (sessionId !== undefined && (view.snapshot?.preferences.quickInterrupt ?? true)) cancelSession(sessionId)
          break
        case 'undo': case 'cancel': if (lastTurn.current && !lastTurn.current.sent) inputActions.setDraft(lastTurn.current.base); break
        case 'steer': setAwaiting(false); steer(); showFlash('sent', 1200); break
        case 'send': setAwaiting(false); inputActions.submit(); showFlash('sent', 1200); break
        case 'clear': inputActions.setDraft(''); break
        case 'new-session': document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', metaKey: true, bubbles: true })); break
        case 'read': { const reply = latestReply(); if (reply?.text) speak(reply.text); break }
        case 'approve': case 'deny': answerApproval(command.kind === 'approve'); break
        default: break
      }
    }, [command, inputActions, sessionId])

    // DSH is answering while the composer's primary button shows Stop (a square glyph).
    useEffect(() => {
      let busy = false
      const sync = (): void => {
        const now = document.querySelector('button[aria-label] svg rect[rx="3"]') !== null
        if (now !== busy) { busy = now; setBusy(now) }
      }
      sync()
      const observer = new MutationObserver(sync)
      observer.observe(document.body, { childList: true, subtree: true })
      return () => { observer.disconnect(); if (busy) setBusy(false) }
    }, [])

    // Read each new reply once it has stopped changing, while the AirPods are worn.
    const readKeys = useRef<Set<string> | undefined>(undefined)
    const autoRead = view.snapshot?.preferences.autoRead ?? false
    const worn = view.snapshot?.pods?.inEar ?? false
    useEffect(() => {
      if (readKeys.current === undefined) { readKeys.current = new Set([latestReply()?.key ?? '']) }
      // A freshly opened window renders old replies a moment later; treat anything seen while warming up as read.
      const warmUntil = Date.now() + 4000
      const keys = readKeys.current
      if (!autoRead || !worn) return
      let lastText = '', stableSince = 0
      const timer = setInterval(() => {
        const reply = latestReply()
        if (Date.now() < warmUntil && reply) { keys.add(reply.key); return }
        if (!reply || reply.text === '' || keys.has(reply.key)) return
        if (reply.text !== lastText) { lastText = reply.text; stableSince = Date.now(); return }
        if (Date.now() - stableSince < 2500) return
        keys.add(reply.key)
        speak(reply.text)
      }, 500)
      return () => { clearInterval(timer) }
    }, [autoRead, worn])

    const doneSound = view.snapshot?.preferences.doneSound ?? false
    // A light knock when DSH starts waiting for an approval.
    const readApproval = view.snapshot?.preferences.readApproval ?? false
    const wornNow = view.snapshot?.pods?.inEar ?? false
    useEffect(() => {
      if (!doneSound && !(readApproval && wornNow)) return
      const card = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-approval-key]')
      let shown = card() !== null
      const observer = new MutationObserver(() => {
        const now = card()
        if (now && !shown) {
          if (doneSound) chime('approval')
          // Read what DSH asks to do, so it can be answered by voice ("approve" / "deny") away from the screen.
          if (readApproval && wornNow) {
            const text = (now.closest('[role="dialog"], section, article') ?? now).textContent?.replace(/\s+/g, ' ').trim() ?? ''
            if (text !== '') setTimeout(() => { speak(text.slice(0, 280)) }, 500)
          }
        }
        shown = now !== null
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => { observer.disconnect() }
    }, [doneSound, readApproval, wornNow])

    // Progress announcements: while DSH works in the background, read its current step title when it changes, at
    // most every 15 s. Polls the page every 3 s, so it is off unless the user turns it on.
    const announceProgress = view.snapshot?.preferences.progress ?? false
    useEffect(() => {
      if (!announceProgress || !wornNow) return
      let last = '', spokenAt = 0
      const timer = setInterval(() => {
        const rows = document.querySelectorAll<HTMLElement>('[data-chat-flow-kind="turn-process"]')
        const step = rows[rows.length - 1]?.innerText.split('\n')[0]?.trim() ?? ''
        if (step === '' || step === last) return
        last = step
        if (document.hasFocus() || Date.now() - spokenAt < 15_000) return
        spokenAt = Date.now()
        speak(step)
      }, 3000)
      return () => { clearInterval(timer) }
    }, [announceProgress, wornNow])

    // A chime when DSH finishes a task (one turn-tail row per finished turn) and a low tone when it fails (turn-error).
    useEffect(() => {
      if (!doneSound) return
      const count = (kind: string): number => document.querySelectorAll(`[data-chat-flow-kind="${kind}"]`).length
      let seen = count('turn-tail'), failed = count('turn-error'), session = sessionId
      const observer = new MutationObserver(() => {
        const tails = count('turn-tail'), errors = count('turn-error')
        // A session switch re-renders the whole list; only growth within one session is a finished or failed task.
        if (session === sessionId) {
          if (errors > failed) chime('failed')
          else if (tails > seen) chime('done')
        }
        seen = tails; failed = errors; session = sessionId
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => { observer.disconnect() }
    }, [doneSound, sessionId])

    // Nod / shake listen only while an approval card is on screen.
    const headMotion = (view.snapshot?.headMotion ?? false) && (view.snapshot?.preferences.headGestures ?? true)
    useEffect(() => {
      if (!headMotion) return
      let on = false
      const sync = (): void => {
        const pending = document.querySelector('[data-approval-key]') !== null
        if (pending !== on) { on = pending; setHeadGestures(pending) }
      }
      const observer = new MutationObserver(sync)
      observer.observe(document.body, { childList: true, subtree: true })
      sync()
      return () => { observer.disconnect(); if (on) setHeadGestures(false) }
    }, [headMotion])

    // A refused press (no AirPods, no microphone) shakes the icon and names the reason for a moment.
    const refusedAt = view.snapshot?.refusedAt
    const lastRefusal = useRef(refusedAt)
    useEffect(() => {
      // A first-use permission question is not a failure; the system dialog is the feedback.
      if (refusedAt !== undefined && refusedAt !== lastRefusal.current && !view.snapshot?.refused?.endsWith('-prompt')) showFlash('refused', 2600)
      lastRefusal.current = refusedAt
    }, [refusedAt])

    // A pair that just connected gets a small pop so the change from yellow to white is noticed.
    const connectedAddress = view.snapshot?.devices.find(device => device.connected)?.address
    const previousConnected = useRef(connectedAddress)
    useEffect(() => {
      if (connectedAddress && connectedAddress !== previousConnected.current) showFlash('pop', 600)
      previousConnected.current = connectedAddress
    }, [connectedAddress])

    const snapshot = view.snapshot
    if (!snapshot || snapshot.helper === 'unsupported') return null
    const connected = snapshot.devices.find(device => device.connected)
    const problem = blocker(snapshot)
    const prefsNow = snapshot.preferences ?? loadPreferences()
    const preparing = prefsNow.asrSource === 'local' && (snapshot.model.phase === 'downloading' || snapshot.model.phase === 'preparing')
    const progress = snapshot.model.totalBytes ? (snapshot.model.completedBytes ?? 0) / snapshot.model.totalBytes : 0
    // One state drives color and motion; earlier entries win.
    const state = snapshot.talk === 'opening' || snapshot.talk === 'talking' ? 'talking'
      : snapshot.talk === 'finishing' ? 'recognizing'
        : flash === 'sent' ? 'sent'
          : flash === 'refused' ? 'failed'
            : snapshot.connecting !== undefined ? 'connecting'
              : snapshot.connectFailed !== undefined ? 'failed'
                : problem?.kind === 'conflict' ? 'yielded' : problem ? 'blocked' : !connected ? 'disconnected'
                // Usable means in use: the connected pair is the audio output (exact per pair, even with several pairs of one model),
                // or ear detection says a bud is in an ear. Taking the buds out moves the output away within a second.
                  : !(snapshot.route.outputBluetooth && snapshot.route.output === connected.name) && snapshot.pods !== undefined && !snapshot.pods.inEar ? 'notWorn'
                    : preparing ? 'preparing' : 'ready'

    const levels = connected ? [connected.batteries.left, connected.batteries.right].filter((value): value is number => value !== null) : []
    const lowBattery = levels.length > 0 && Math.min(...levels) < 10 ? Math.min(...levels) : undefined
    const tooltip = (): string => {
      if (awaiting && state === 'ready') return t('send.voiceDetail')
      if (lowBattery !== undefined && (state === 'ready' || state === 'notWorn')) return t('state.lowBattery', { level: `${lowBattery}%` })
      switch (state) {
        case 'talking': return t('listening')
        case 'recognizing': return t('finishing')
        case 'sent': return t('sent')
        case 'connecting': return t('menu.connecting')
        case 'failed': return flash === 'refused'
          ? t(snapshot.refused === 'no-headset' ? 'refused.noHeadset' : snapshot.refused === 'microphone-denied' ? 'permission.denied'
            : snapshot.refused === 'speech-prompt' ? 'refused.speech' : 'refused.microphone')
          : t('menu.failed')
        case 'yielded': case 'blocked': return problem?.kind === 'conflict' ? t('conflict.title', { app: problem.competitor.app })
          : problem?.kind === 'microphone' ? t(problem.denied ? 'permission.denied' : 'permission.microphone')
            : problem?.kind === 'bluetooth' ? t('permission.bluetooth')
              : t('failed', { message: problem?.kind === 'error' ? problem.message : '' })
        case 'notWorn': return t('state.notWorn')
        case 'disconnected': return snapshot.permissions.bluetooth === 'prompt' ? t('permission.bluetoothPrompt') : t('state.disconnected')
        case 'preparing': return t('model.downloading', { percent: `${Math.floor(progress * 100)}%` })
        default: {
          if (connected === undefined) throw new TypeError('AirPods connected state without a device')
          const doubleTap = connected.model.startsWith('airpods-1') || connected.model.startsWith('airpods-2')
          return `${connected.name} · ${doubleTap ? t('hint.double-tap') : t('hint.press')}`
        }
      }
    }

    const deviceRow = (device: DeviceInfo): MenuEntry => ({
      id: `device:${device.address}`,
      icon: <span className={css.menuGlyph} data-connected={device.connected}><AirpodsGlyph size={16} /></span>,
      label: (
        <span className={css.device}>
          <span className={css.deviceName}>{device.name}</span>
          <span className={css.deviceMeta}>
            {snapshot.connecting === device.address ? t('menu.connecting')
              : snapshot.connectFailed === device.address ? t('menu.failed')
                : device.connected ? t('menu.batteries', { left: percent(device.batteries.left), right: percent(device.batteries.right), case: percent(device.batteries.case) })
                  : t('menu.connect')}
          </span>
        </span>
      ),
    })

    // The menu only switches headphones; everything else lives in the settings window.
    const items: MenuEntry[] = [
      { type: 'label', id: 'devices', text: t('menu.devices') },
      ...snapshot.devices.length > 0 ? snapshot.devices.map(deviceRow) : [{ id: 'pair', label: t('menu.noDevices') }],
      { type: 'separator', id: 'more-separator' },
      { id: 'more', label: t('menu.more') },
    ]
    const selectedIds = connected ? [`device:${connected.address}`] : []
    const prefs = prefsNow
    const settingsStatus = problem?.kind === 'microphone' ? { text: t('permission.denied'), action: t('menu.settings'), run: openMicrophoneSettings }
      : problem?.kind === 'bluetooth' ? { text: t('permission.bluetooth'), action: t('menu.bluetooth'), run: openBluetoothSettings }
        : problem?.kind === 'conflict' ? { text: t('conflict.title', { app: problem.competitor.app }), action: t('menu.take', { app: problem.competitor.app }), run: takeButton }
          : problem?.kind === 'error' ? { text: t('failed', { message: problem.message }), action: t('menu.setup'), run: () => { setSettingsOpen(false); setSetupOpen(true) } }
            : undefined
    const select = (id: string): void => {
      setOpen(false)
      if (id.startsWith('device:')) {
        const address = id.slice(7)
        if (!snapshot.devices.find(d => d.address === address)?.connected && snapshot.connecting === undefined) connectDevice(address)
        return
      }
      switch (id) {
        case 'more': openSettings('devices'); break
        case 'pair': openBluetoothPairing(); break
        default: break
      }
    }

    // Same anchoring as the composer's permission selector: the trigger itself is the Menu anchor.
    return (<>
      <SetupDialog open={setupOpen} snapshot={snapshot} preferences={prefs} t={t}
        onDone={(next) => { globalThis.localStorage?.setItem(ONBOARDED_KEY, '1'); setSetupOpen(false); setPreferences({ ...next, onboarded: true }) }} onLater={closeSetup}
        onAllowMicrophone={() => { if (snapshot.permissions.microphone === 'denied') openMicrophoneSettings(); else void requestMicrophone() }}
        onGuide={() => { openSettings('guide') }} onOpenBluetooth={openBluetoothPairing} onSaveCloudKey={saveCloudKey} />
      <SettingsDialog open={settingsOpen} onClose={() => { setSettingsOpen(false) }} snapshot={snapshot} preferences={prefs} t={t}
        onPreferences={(next) => { if (prefs.autoRead && !next.autoRead) stopSpeaking(); setPreferences(next) }}
        status={settingsStatus} glyph={size => <AirpodsGlyph size={size} />} deviceImage={deviceImage} onConnect={connectDevice}
        onPair={openBluetoothPairing} onDownload={prepareModel} onCancelDownload={cancelModelDownload}
        onSpeak={speak} onChime={(name) => { chime(name) }}
        onGuide={() => { setSettingsPage('guide') }} onSetup={() => { setSettingsOpen(false); setSetupOpen(true) }}
        onSaveCloudKey={saveCloudKey} onOpenBluetooth={openBluetoothPairing} modelInfo={modelInfo} onDeleteModel={deleteModel}
        onRevealModel={revealModel} initialPage={settingsPage}
        cloudKeyStatus={cloudKeyStatus} onDeleteCloudKey={deleteCloudKey} onTestCloud={testCloud} onOpenLink={openLink} />
      <Menu open={open} portal side="top" align="end" items={items}
        selectedIds={selectedIds} onSelect={select} onClose={() => { setOpen(false) }}
        anchor={(
          <Button className={css.trigger} size="sm" data-state={state} data-pop={flash === 'pop'} aria-label={tooltip()} title={open ? undefined : tooltip()}
            aria-haspopup="menu" aria-expanded={open}
            onMouseDown={(event) => { event.preventDefault() }} onClick={() => { if (state === 'talking' || state === 'recognizing') press(); else setOpen(value => !value) }}>
            {(state === 'talking' || state === 'connecting') && <span className={css.halo} aria-hidden />}
            {preparing && (
              <svg className={css.ring} viewBox="0 0 28 28" aria-hidden>
                <circle cx="14" cy="14" r="12.5" pathLength="1" strokeDasharray={`${Math.max(progress, 0.04)} 1`} />
              </svg>
            )}
            <AirpodsGlyph className={css.glyph} />
            {state === 'talking' && heard > 0 && snapshot.endSilenceMs > 0 && (
              <svg key={heard} className={css.countdown} viewBox="0 0 28 28" aria-hidden style={{ animationDuration: `${snapshot.endSilenceMs}ms` }}>
                <circle cx="14" cy="14" r="12.5" pathLength="1" />
              </svg>
            )}
            {awaiting && state === 'ready' && <span className={css.pending} aria-hidden />}
            {lowBattery !== undefined && <span className={css.lowBattery} aria-hidden />}
          </Button>
        )} />
    </>)
  }
}

/** Steer the draft into the running task, as Cmd/Ctrl+Enter does in the composer; with nothing running it sends. */
function steer(): void {
  const editor = document.querySelector<HTMLElement>('[data-input-editor] [contenteditable="true"], [contenteditable="true"]')
  if (!editor) return
  editor.focus()
  const mac = navigator.platform.toLowerCase().includes('mac')
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }))
}
