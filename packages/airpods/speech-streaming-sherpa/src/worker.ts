/**
 * Recognition process: loads the model, then serves `POST /stream` on loopback. The request body carries PCM16LE
 * audio; the response streams one JSON `StreamEvent` per line while the request is still being written.
 */
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { Config } from './config.ts'
import { createEngine, pcmChunk } from './engine.ts'

async function main(): Promise<void> {
  const raw: unknown = JSON.parse(z.string().parse(process.argv[2]))
  const paths = z.object({ encoder: z.string().min(1), decoder: z.string().min(1), tokens: z.string().min(1) }).parse(raw)
  const config = Config(z.record(z.string(), z.unknown()).parse(raw))
  const token = z.string().regex(/^[a-f0-9]{64}$/).parse(process.env.DSH_SPEECH_TOKEN)
  delete process.env.DSH_SPEECH_TOKEN
  const expected = Buffer.from(`Bearer ${token}`)
  const engine = createEngine(paths, config)
  const server = createServer((request, response) => {
    const authorization = Buffer.from(request.headers.authorization ?? '')
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      request.resume(); response.writeHead(401).end(); return
    }
    if (request.method !== 'POST' || request.url !== '/stream') { request.resume(); response.writeHead(404).end(); return }
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    response.flushHeaders()
    const stream = engine.open()
    let carry: Buffer = Buffer.alloc(0)
    const send = (events: object[]): void => { for (const event of events) response.write(`${JSON.stringify(event)}\n`) }
    const fail = (message: string): void => { send([{ type: 'error', message }]); response.end(); request.destroy() }
    request.on('data', (chunk: Buffer) => {
      try {
        const next = pcmChunk(carry, chunk)
        carry = next.carry
        send(stream.accept(next.samples))
        if (stream.seconds > config.maxStreamSeconds) fail(`Stream exceeds ${config.maxStreamSeconds} seconds`)
      } catch (error) { fail(error instanceof Error ? error.message : String(error)) }
    })
    request.on('end', () => {
      if (response.writableEnded) return
      try { send(stream.finish()); response.end() } catch (error) { fail(error instanceof Error ? error.message : String(error)) }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  process.stdout.write(`${JSON.stringify({ port: (server.address() as { port: number }).port })}\n`)
}

main().catch((error: unknown) => {
  // Exit once the message is flushed: a loaded native recognizer would otherwise keep the process alive.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => { process.exit(1) })
})
