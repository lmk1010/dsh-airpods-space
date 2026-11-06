/** JSON-safe updates of the `airpods` Remote namespace. */
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The native helper is not running, so the command could not be delivered. */
    'airpods/helper-unavailable': { readonly reason: string }
  }
}

/** Native helper lifecycle. `unsupported` means the Host is not macOS. */
export type HelperStatus = 'starting' | 'running' | 'restarting' | 'failed' | 'unsupported'

/** Battery levels in percent; `null` when the device does not report one. */
export interface Batteries {
  readonly left: number | null
  readonly right: number | null
  readonly case: number | null
}

/** The AirPods currently tracked, merged from proximity adverts and Bluetooth connections. */
export interface PodsState {
  readonly model: string
  readonly name: string
  /** What the user does to talk: `press` (stem), `double-tap` (AirPods 1/2) or `crown` (Max). */
  readonly gesture: string
  readonly connected: boolean
  /** At least one bud is in an ear, from the helper's debounced in-ear / out-of-ear transitions. */
  readonly inEar: boolean
  readonly batteries: Batteries
}

/** A paired AirPods pair as listed in the menu. */
export interface DeviceInfo {
  readonly address: string
  /** User-visible Bluetooth name, for example "Alex的AirPods". */
  readonly name: string
  readonly model: string
  readonly connected: boolean
  readonly batteries: Batteries
}

/** Press-to-talk phase. `opening` lasts until the microphone delivers audio. */
export type TalkPhase = 'idle' | 'opening' | 'talking' | 'finishing'

/** Another app that competes for the headphone press. */
export interface Competitor {
  readonly app: string
  readonly bundle: string
  /**
   * `now-playing` took the play/pause target; `reclaimer` keeps re-taking it;
   * `interceptor` can swallow media keys; `microphone` holds the mic.
   */
  readonly kind: 'now-playing' | 'reclaimer' | 'interceptor' | 'microphone'
}

/** Complete state replayed to every new observer. */
export interface AirpodsSnapshot {
  readonly helper: HelperStatus
  readonly helperMessage?: string
  readonly pods?: PodsState | undefined
  readonly talk: TalkPhase
  /** Silence after speech, in milliseconds, that ends a talk turn. */
  readonly endSilenceMs: number
  /** DSH currently holds the system Now Playing target, so a headphone press reaches it. */
  readonly ownsPress: boolean
  readonly competitors: readonly Competitor[]
  readonly permissions: { readonly microphone: string; readonly bluetooth: string; readonly speech: string }
  /** Recognition model readiness for the talk provider; downloads start automatically. */
  readonly model: ModelState
  /** Paired AirPods, connected first. */
  readonly devices: readonly DeviceInfo[]
  /** Address being connected from the menu, if any. */
  readonly connecting?: string | undefined
  /** Address whose last connection attempt failed; cleared after a few seconds. */
  readonly connectFailed?: string | undefined
  /** Why the last talk request did not start: `no-headset`, `microphone-prompt` or `microphone-denied`. */
  readonly refused?: string | undefined
  /** When `refused` was last set (ms since epoch), so repeated refusals are distinct. */
  readonly refusedAt?: number | undefined
  /** Current system audio output; AirPods that are the output are in use (works with several pairs of one model). */
  readonly route: { readonly output: string; readonly outputBluetooth: boolean }
  /** DSH is reading a reply aloud. */
  readonly reading: boolean
  /** The worn headphones report head motion, so nod / shake can answer approvals. */
  readonly headMotion: boolean
  readonly preferences: Preferences
}

/** Recognition model preparation as shown to the user. */
export interface ModelState {
  readonly phase: 'unknown' | 'preparing' | 'downloading' | 'ready' | 'failed'
  readonly completedBytes?: number
  readonly totalBytes?: number
  readonly message?: string
}

/** One recognized turn; `partial` replaces the live caption, `final` (exactly once per turn, after any second pass) is the text to use. */
export interface TranscriptUpdate {
  readonly turn: number
  readonly phase: 'partial' | 'final' | 'failed'
  readonly text: string
  /** Milliseconds from the press to this update. */
  readonly sincePressMs: number
  /** On `final`: send the text now (pause send mode, or the utterance ended with a spoken "send"). */
  readonly submit?: boolean
  /** On `final`: the utterance ended with a spoken "insert"; steer the text into the running task. */
  readonly steer?: boolean
}

/**
 * An action for the Client to perform in the current Session: from a headset gesture, a head gesture, or a spoken
 * command (a whole utterance that is exactly a command phrase).
 */
export type CommandKind = 'interrupt' | 'undo' | 'send' | 'cancel' | 'new-session' | 'clear' | 'read' | 'approve' | 'deny' | 'stop-reading'
  | 'steer'

/** What a Next / Previous Track gesture does (double / triple stem press, or an AirPod set to that track action). */
export type GestureAction = 'send' | 'interrupt' | 'steer' | 'undo' | 'read' | 'none'

/** User preferences, persisted by the Client and pushed with `setPreferences`. */
export interface Preferences {
  /**
   * How a finished turn is sent; a headset press only ever starts or continues talking. `voice`: the text waits in the
   * draft until the user says "send" (alone or ending a sentence); `pause`: it is sent after `pauseSeconds` of silence.
   */
  readonly sendMode: 'voice' | 'pause'
  /** Silence in seconds before sending in `pause` mode. */
  readonly pauseSeconds: 1 | 2 | 3
  /** Read each finished DSH reply aloud while the AirPods are worn. */
  readonly autoRead: boolean
  /** Speech recognition source: Apple on-device (no download), local streaming model (download), or Aliyun realtime (network). */
  readonly asrSource: 'apple' | 'local' | 'cloud'
  /** The setup dialog was completed; the floating gesture guide shows itself only afterwards. */
  readonly onboarded: boolean
  /** Show the battery card when an AirPods case opens nearby. */
  readonly popupCard: boolean
  /** Also show it for AirPods this Mac never paired, when opened within arm's reach. */
  readonly nearbyUnpaired: boolean
  /** Play a chime in the headset when DSH finishes a task, and a knock when it asks for approval. */
  readonly doneSound: boolean
  /** Soft tones when listening starts and ends. */
  readonly earcons: boolean
  /** Read DSH's approval request aloud while the AirPods are worn. */
  readonly readApproval: boolean
  /** Announce DSH's current step while it works and DSH is in the background (polls the page; off by default). */
  readonly progress: boolean
  /** Saying "stop" (or the Next Track gesture) stops DSH's running task. */
  readonly quickInterrupt: boolean
  /** A sentence ending in "insert" is steered into DSH's running task. */
  readonly quickInsert: boolean
  /** Whole-utterance voice commands other than send and stop: cancel, clear, new session, read, approve, deny. */
  readonly voiceCommands: boolean
  /** Next Track gesture: double stem press on AirPods 3/4/Pro (only while not talking), or an AirPods 1/2 bud set to Next Track. */
  readonly nextAction: GestureAction
  /** Previous Track gesture: triple stem press, or a bud set to Previous Track. */
  readonly previousAction: GestureAction
  /** Nod / shake to answer DSH's approval requests (AirPods with motion sensors). */
  readonly headGestures: boolean
}

/** Stream item: a full snapshot after any state change, a transcript update, or a command. */
export type AirpodsUpdate =
  | { readonly type: 'snapshot'; readonly snapshot: AirpodsSnapshot }
  | { readonly type: 'transcript'; readonly transcript: TranscriptUpdate }
  | { readonly type: 'command'; readonly command: CommandKind; readonly turn?: number }
