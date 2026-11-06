/** Long-running native helper: spawn, line-delimited JSON events, commands, restart with backoff. */
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

/** One helper event line; fields depend on `event`. */
export type HelperEvent = { readonly event: string } & Record<string, unknown>

export interface HelperOptions {
  readonly executable: string
  readonly assets: string
  readonly maxLineBytes: number
  readonly restartDelaysMs: readonly number[]
  readonly graceMs: number
  readonly maxLogBytes: number
}

/** Owns one helper process at a time; `stop()` ends restarts. */
export class HelperProcess {
  private handle: SubprocessHandle | undefined
  private stopped = false
  private failures = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly options: HelperOptions,
    private readonly onEvent: (event: HelperEvent) => void,
    private readonly onStatus: (status: 'running' | 'restarting' | 'failed', message?: string) => void,
  ) {}

  start(): void {
    if (this.stopped || this.handle) return
    const handle = this.ctx.subprocess.spawn({
      argv: [this.options.executable],
      cwd: this.options.assets,
      graceMs: this.options.graceMs,
      env: { DSH_AIRPODS_ASSETS: this.options.assets },
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: this.options.maxLogBytes } },
    })
    this.handle = handle
    // A write to a helper that just exited fails with EPIPE; it must never reach the Host as an uncaught error.
    handle.stdin?.on('error', (error) => { this.ctx.logger.warn('AirPods helper input closed', error) })
    let buffered = ''
    let healthy = false
    handle.stdout?.setEncoding('utf8')
    handle.stdout?.on('data', (chunk: string) => {
      buffered += chunk
      if (buffered.length > this.options.maxLineBytes && !buffered.includes('\n')) {
        buffered = ''
        this.ctx.logger.warn('AirPods helper line exceeded its byte limit')
        return
      }
      for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        let event: HelperEvent
        try { event = JSON.parse(line) as HelperEvent } catch (error) {
          this.ctx.logger.warn('AirPods helper wrote an invalid line', error); continue
        }
        if (event.event === 'hello') { healthy = true; this.failures = 0; this.onStatus('running') }
        this.onEvent(event)
      }
    })
    void handle.done.then(() => this.exited(handle, healthy), () => this.exited(handle, healthy))
  }

  /**
   * Send one command; dropped while the helper is not running.
   * @param command - command object with a `cmd` field.
   * @returns whether the command was written.
   */
  send(command: { readonly cmd: string } & Record<string, unknown>): boolean {
    const stdin = this.handle?.stdin
    if (!stdin || stdin.destroyed || !stdin.writable || stdin.writableEnded) return false
    try {
      stdin.write(`${JSON.stringify(command)}\n`)
    } catch (error) {
      // The helper is exiting; the restart path takes over and the command is dropped.
      this.ctx.logger.warn('AirPods helper command dropped', error)
      return false
    }
    return true
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    const handle = this.handle
    if (!handle) return
    handle.stdin?.end()
    handle.terminate()
    await handle.waitForExit()
  }

  private exited(handle: SubprocessHandle, healthy: boolean): void {
    if (this.handle !== handle) return
    this.handle = undefined
    if (this.stopped) return
    if (!healthy) this.failures++
    const stderr = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
    if (this.failures >= this.options.restartDelaysMs.length) {
      this.onStatus('failed', stderr || 'AirPods helper exited repeatedly')
      return
    }
    const delay = this.options.restartDelaysMs[this.failures]
    if (delay === undefined) throw new Error('AirPods helper restart delay is missing')
    this.onStatus('restarting', stderr)
    this.timer = setTimeout(() => { this.start() }, delay)
  }
}
