/** Host side of the local streaming recognizer: preparation, recognition process lifetime and duplex streams. */
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { Agent, request as httpRequest, type IncomingMessage } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { SpeechPreparationOptions, SpeechPreparationState, SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { Channel, type StreamEvent, type StreamingProvider, type StreamingSession, type StreamOptions } from '@dshub/speech-streaming'
import { z } from 'zod'
import type { Config, ModelPaths } from './config.ts'
import { inspectModels, prepareModels } from './models.ts'

interface Running { readonly handle: SubprocessHandle; readonly port: number; readonly token: string; closed: boolean }

const ready = z.object({ port: z.number().int().min(1).max(65535) }).strict()
const event = z.discriminatedUnion('type', [
  z.object({ type: z.literal('partial'), segment: z.number().int().min(0), text: z.string() }),
  z.object({ type: z.literal('final'), segment: z.number().int().min(0), text: z.string() }),
  z.object({ type: z.literal('end'), text: z.string(), audioSeconds: z.number().min(0) }),
  z.object({ type: z.literal('error'), message: z.string() }),
])

async function readReady(handle: SubprocessHandle, limit: number, signal: AbortSignal): Promise<number> {
  const stdout = handle.stdout
  if (!stdout) throw new Error('Streaming recognizer stdout is unavailable')
  const pending = Promise.withResolvers<number>()
  let text = ''
  const data = (chunk: Buffer): void => {
    text += chunk.toString('utf8')
    if (Buffer.byteLength(text) > limit) { pending.reject(new Error('Streaming recognizer readiness exceeded its byte limit')); return }
    const end = text.indexOf('\n')
    if (end < 0) return
    try { pending.resolve(ready.parse(JSON.parse(text.slice(0, end))).port) } catch (error) { pending.reject(new Error('Invalid streaming recognizer readiness', { cause: error })) }
  }
  const abort = (): void => { pending.reject(signal.reason instanceof Error ? signal.reason : new Error('Streaming recognizer start cancelled')) }
  stdout.on('data', data)
  signal.addEventListener('abort', abort, { once: true })
  void handle.done.then(() => { pending.reject(new Error(`Streaming recognizer exited: ${handle.collected.stderr?.readFrom(0).text ?? ''}`)) }, pending.reject)
  try { return await pending.promise } finally {
    stdout.off('data', data); signal.removeEventListener('abort', abort); stdout.resume()
  }
}

/** Local streaming Paraformer provider; the recognition process starts on prepare, warm or first stream. */
export class SherpaStreaming implements StreamingProvider {
  readonly info
  readonly preparation = {
    snapshot: (): SpeechPreparationState => this.state,
    subscribe: (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } },
    prepare: (_options?: SpeechPreparationOptions): void => { this.run(async (signal) => { await this.start(signal, true) }) },
    cancel: async (): Promise<void> => { this.task?.abort.abort(new Error('Streaming model preparation cancelled')); await this.task?.settled },
  }

  private state: SpeechPreparationState = { phase: 'unprepared' }
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private paths: ModelPaths | undefined
  private running: Running | undefined
  private starting: Promise<Running> | undefined
  private task: { abort: AbortController; settled: Promise<void> } | undefined
  private open_ = 0
  private idle: ReturnType<typeof setTimeout> | undefined
  private lastProgress = 0

  constructor(private readonly ctx: Context, private readonly config: Config) {
    this.info = { id: config.providerId as SpeechProviderId, name: 'Paraformer streaming (zh/en, local)', location: 'host-local' as const,
      languages: ['auto', 'zh', 'en'], downloadSources: config.modelDirectory === undefined ? config.modelOrigins : [],
      setupEstimate: { recommendedDiskBytes: 300_000_000, expectedMemoryBytes: 600_000_000, minimumMinutes: 1, maximumMinutes: 10 } }
  }

  /** Read disk state without downloading or starting the recognition process. */
  inspect(): void {
    this.run(async (signal) => {
      this.publish({ phase: 'checking', step: 'check', startedAt: Date.now() })
      this.paths = await inspectModels(this.config, signal)
      this.publish({ phase: this.paths ? 'standby' : 'unprepared' })
    })
  }

  warm(): void {
    if (this.paths === undefined || this.running !== undefined || this.task !== undefined) return
    this.run(async (signal) => { await this.start(signal, false) })
  }

  async open(options: StreamOptions, signal: AbortSignal): Promise<StreamingSession> {
    if (this.paths === undefined) throw new Error('Download the local streaming model before recording')
    const running = await this.start(AbortSignal.any([signal, this.lifetime.signal]), false)
    clearTimeout(this.idle)
    this.open_++
    const events = new Channel<StreamEvent>()
    const request = httpRequest({ host: '127.0.0.1', port: running.port, path: '/stream', method: 'POST', agent: new Agent(),
      headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/octet-stream', 'x-language': options.language },
      signal })
    const settle = (): void => { if (--this.open_ === 0) this.scheduleIdle() }
    request.on('error', (error) => { events.fail(error) })
    request.on('response', (response: IncomingMessage) => {
      let buffered = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        buffered += chunk
        for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
          const parsed = event.safeParse(JSON.parse(buffered.slice(0, end)))
          buffered = buffered.slice(end + 1)
          if (!parsed.success) { events.fail(new Error('Invalid streaming recognizer event', { cause: parsed.error })); continue }
          if (parsed.data.type === 'error') { events.fail(new Error(parsed.data.message)); continue }
          events.push(parsed.data)
        }
      })
      response.on('end', () => { events.close() })
      response.on('error', (error) => { events.fail(error) })
    })
    request.on('close', settle)
    request.flushHeaders()
    return {
      write: (pcm) => { request.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)) },
      finish: () => { request.end() },
      events,
    }
  }

  /** Stop the recognition process and pending preparation. */
  async dispose(): Promise<void> {
    this.listeners.clear()
    this.lifetime.abort(new Error('Streaming provider disposed'))
    clearTimeout(this.idle)
    await this.task?.settled
    await this.stop()
  }

  private run(work: (signal: AbortSignal) => Promise<void>): void {
    if (this.task) return
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, this.lifetime.signal])
    const task = { abort, settled: Promise.resolve() }
    this.task = task
    task.settled = work(signal).catch((error: unknown) => {
      if (this.lifetime.signal.aborted) return
      this.publish(abort.signal.aborted ? { phase: 'cancelled' } : { phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    }).finally(() => { this.task = undefined })
  }

  private async start(caller: AbortSignal, download: boolean): Promise<Running> {
    if (this.running && !this.running.closed) return this.running
    this.starting ??= (async () => {
      using setup = deadline(caller, this.config.prepareTimeoutMs, 'SPEECH_PREPARE_TIMEOUT')
      const cached = this.paths !== undefined
      this.paths ??= download ? await prepareModels(this.config, setup.signal, (state) => { this.publish(state) }) : undefined
      if (this.paths === undefined) throw new Error('Download the local streaming model before recording')
      this.publish({ phase: cached ? 'waking' : 'loading', step: 'load', startedAt: Date.now() })
      await mkdir(this.config.dataRoot, { recursive: true })
      const token = randomBytes(32).toString('hex')
      const worker = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url))
      const handle = this.ctx.subprocess.spawn({
        argv: [process.execPath, ...worker.endsWith('.ts') ? ['--import', import.meta.resolve('tsx/esm')] : [], worker,
          JSON.stringify({ ...this.config, ...this.paths })],
        cwd: this.config.dataRoot, graceMs: this.config.graceMs,
        env: { DSH_SPEECH_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' },
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: this.config.maxLogBytes } },
      })
      try {
        const running: Running = { handle, port: await readReady(handle, this.config.maxLogBytes, setup.signal), token, closed: false }
        const exited = (): void => { if (!running.closed) { running.closed = true; this.running = undefined; this.publish({ phase: 'standby' }) } }
        void handle.done.then(exited, exited)
        this.running = running
        this.publish({ phase: 'ready' })
        this.scheduleIdle()
        return running
      } catch (error) {
        handle.terminate(); await handle.waitForExit()
        this.publish(this.paths ? { phase: 'standby' } : { phase: 'unprepared' })
        throw error
      }
    })().finally(() => { this.starting = undefined })
    return await this.starting
  }

  private scheduleIdle(): void {
    clearTimeout(this.idle)
    if (this.config.idleTimeoutMs === 0 || this.open_ > 0) return
    this.idle = setTimeout(() => { void this.stop().catch((error: unknown) => { this.ctx.logger.warn('Streaming recognizer idle stop failed', error) }) },
      this.config.idleTimeoutMs)
  }

  private async stop(): Promise<void> {
    const running = this.running
    if (!running) return
    running.closed = true
    this.running = undefined
    running.handle.terminate()
    await running.handle.waitForExit()
    if (!this.lifetime.signal.aborted) this.publish({ phase: 'standby' })
  }

  private publish(state: SpeechPreparationState): void {
    const now = performance.now()
    if (state.phase === 'downloading' && this.state.phase === 'downloading' && state.completedBytes !== state.totalBytes
      && now - this.lastProgress < this.config.progressIntervalMs) { this.state = state; return }
    this.lastProgress = now
    this.state = state
    for (const listener of this.listeners) listener()
  }
}
