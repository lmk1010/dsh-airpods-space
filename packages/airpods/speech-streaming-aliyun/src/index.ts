/**
 * Aliyun Model Studio (DashScope) realtime recognition. One WebSocket is opened ahead of use and reused for every
 * turn (`run-task` … `finish-task`), so a press only pays for the task start, not the TLS and WebSocket handshake.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Channel, type SpeechProviderId, type StreamEvent, type StreamingProvider, type StreamingSession, type StreamOptions } from '@lmk1010/speech-streaming'
import type {} from '@lmk1010/speech-streaming'

export const name = 'speech-streaming-aliyun'
export const inject = ['speechStreaming']

export interface Config {
  providerId: string
  /** Realtime model: `paraformer-realtime-v2` or `fun-asr-realtime`. */
  model: string
  /** API host; empty reads the Keychain item `dshub.aliyun.host`, then falls back to `dashscope.aliyuncs.com`. */
  host: string
  /** API key; empty reads `DASHSCOPE_API_KEY`, then the macOS Keychain item `dshub.aliyun.dashscope`. */
  apiKey: string
  /** Close the idle connection after this long. */
  idleCloseMs: number
  /** Deadline for the connection and the task start. */
  startTimeoutMs: number
}

export const Config: z<Partial<Config>, Config> = z.object({
  providerId: z.string().min(1).default('aliyun-realtime'),
  model: z.string().min(1).default('paraformer-realtime-v2'),
  host: z.string().default(''),
  apiKey: z.string().default(''),
  idleCloseMs: z.natural().default(120_000),
  startTimeoutMs: z.natural().min(1000).default(8000),
})

function keychain(service: string): Promise<string> {
  if (process.platform !== 'darwin') return Promise.resolve('')
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-a', 'dshub', '-s', service, '-w'], (error, stdout) => { resolve(error ? '' : stdout.trim()) })
  })
}

/** Node's WebSocket (undici) also accepts an init object with request headers. */
type HeaderWebSocket = typeof WebSocket & (new (url: string, init: { headers: Record<string, string> }) => WebSocket)
const SocketWithHeaders = WebSocket as HeaderWebSocket

interface Message {
  header?: { event?: string; task_id?: string; error_code?: string; error_message?: string }
  payload?: { output?: { sentence?: { text?: string; sentence_end?: boolean } } }
}

/** Reused WebSocket with one task at a time. */
class Connection {
  private socket: WebSocket | undefined
  private opening: Promise<WebSocket> | undefined
  private idle: ReturnType<typeof setTimeout> | undefined
  private handler: ((message: Message) => void) | undefined

  constructor(private readonly config: Config, private readonly credentials: () => Promise<{ host: string; key: string }>) {}

  async get(): Promise<WebSocket> {
    clearTimeout(this.idle)
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket
    this.opening ??= (async () => {
      const { host, key } = await this.credentials()
      if (key === '') throw new Error('Aliyun API key is not configured')
      const socket = new SocketWithHeaders(`wss://${host}/api-ws/v1/inference`, { headers: { Authorization: `bearer ${key}` } })
      socket.binaryType = 'arraybuffer'
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('Aliyun connection timed out')); socket.close() }, this.config.startTimeoutMs)
        socket.onopen = () => { clearTimeout(timer); resolve() }
        socket.onerror = () => { clearTimeout(timer); reject(new Error('Aliyun connection failed')) }
      })
      socket.onmessage = (event) => {
        const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString()
        try { this.handler?.(JSON.parse(text) as Message) } catch (error) { this.handler?.({ header: { event: 'task-failed', error_message: String(error) } }) }
      }
      socket.onclose = () => { if (this.socket === socket) this.socket = undefined; this.handler?.({ header: { event: 'task-failed', error_message: 'connection closed' } }) }
      this.socket = socket
      return socket
    })().finally(() => { this.opening = undefined })
    return await this.opening
  }

  listen(handler: ((message: Message) => void) | undefined): void { this.handler = handler }

  release(): void {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => { this.close() }, this.config.idleCloseMs)
  }

  close(): void { clearTimeout(this.idle); this.socket?.close(); this.socket = undefined }
}

export class AliyunRealtime implements StreamingProvider {
  readonly info
  private readonly connection: Connection
  private busy: Promise<void> = Promise.resolve()
  constructor(private readonly config: Config) {
    this.info = { id: config.providerId as SpeechProviderId, name: `Aliyun ${config.model}`, location: 'cloud' as const, languages: ['auto', 'zh', 'en'] }
    this.connection = new Connection(config, async () => {
      // Read on every new connection (a few milliseconds), so a key saved, replaced or deleted in settings applies at once.
      return {
        host: config.host || await keychain('dshub.aliyun.host') || 'dashscope.aliyuncs.com',
        key: config.apiKey || process.env.DASHSCOPE_API_KEY || await keychain('dshub.aliyun.dashscope'),
      }
    })
  }

  warm(): void { void this.connection.get().then(() => { this.connection.release() }, () => {}) }

  async open(_options: StreamOptions, signal: AbortSignal): Promise<StreamingSession> {
    // One task at a time on the shared connection.
    const previous = this.busy
    let done!: () => void
    this.busy = new Promise((resolve) => { done = resolve })
    await previous
    const events = new Channel<StreamEvent>()
    const taskId = randomUUID().replaceAll('-', '')
    const finals: string[] = []
    let segment = 0, ended = false
    const finish = (error?: Error): void => {
      if (ended) return
      ended = true
      this.connection.listen(undefined)
      this.connection.release()
      if (error) events.fail(error)
      else { events.push({ type: 'end', text: finals.join(''), audioSeconds: 0 }); events.close() }
      done()
    }
    let socket: WebSocket
    try { socket = await this.connection.get() } catch (error) {
      finish(error as Error); throw error
    }
    const started = Promise.withResolvers<void>()
    const timer = setTimeout(() => { started.reject(new Error('Aliyun task did not start')) }, this.config.startTimeoutMs)
    this.connection.listen((message) => {
      switch (message.header?.event) {
        case 'task-started': clearTimeout(timer); started.resolve(); break
        case 'result-generated': {
          const sentence = message.payload?.output?.sentence
          if (!sentence?.text) break
          if (sentence.sentence_end) { finals.push(sentence.text); events.push({ type: 'final', segment, text: sentence.text }); segment++ }
          else events.push({ type: 'partial', segment, text: sentence.text })
          break
        }
        case 'task-finished': finish(); break
        case 'task-failed': clearTimeout(timer); started.reject(new Error(message.header.error_message ?? 'Aliyun task failed')); finish(new Error(message.header.error_message ?? 'Aliyun task failed')); break
        default: break
      }
    })
    socket.send(JSON.stringify({ header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
      payload: { task_group: 'audio', task: 'asr', function: 'recognition', model: this.config.model,
        parameters: { format: 'pcm', sample_rate: 16000 }, input: {} } }))
    // WebSocket.send needs bytes backed by an ordinary ArrayBuffer.
    const bytes = (pcm: Int16Array): Uint8Array<ArrayBuffer> => Uint8Array.from(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    const pending: Uint8Array<ArrayBuffer>[] = []
    let ready = false, finishing = false
    const sendFinish = (): void => {
      socket.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }))
    }
    void started.promise.then(() => {
      ready = true
      for (const chunk of pending) socket.send(chunk)
      pending.length = 0
      if (finishing) sendFinish()
    }, (error: unknown) => { finish(error as Error) })
    signal.addEventListener('abort', () => { if (!ended) { if (ready) sendFinish(); finish(new Error('cancelled')) } }, { once: true })
    return {
      write: (pcm) => { if (ready) socket.send(bytes(pcm)); else pending.push(bytes(pcm)) },
      finish: () => { finishing = true; if (ready) sendFinish() },
      events,
    }
  }

  dispose(): void { this.connection.close() }
}

/**
 * Register the Aliyun realtime provider.
 * @param ctx - streaming registry owner.
 * @param config - model, host and credentials.
 */
export function apply(ctx: Context, config: Config): void {
  const provider = new AliyunRealtime(config)
  ctx.effect(() => {
    const unregister = ctx.speechStreaming.register(provider)
    return async () => { provider.dispose(); await unregister() }
  })
}
