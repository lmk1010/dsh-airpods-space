/** PCM byte framing and real-model incremental decoding (model-dependent cases skip without DSH_STREAMING_MODEL_DIR). */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { createEngine, pcmChunk } from '../src/engine.ts'

it('carries an odd trailing byte into the next chunk', () => {
  const first = pcmChunk(Buffer.alloc(0), Buffer.from([0x00, 0x40, 0x00]))
  expect([...first.samples]).toEqual([0.5])
  expect([...first.carry]).toEqual([0x00])
  const second = pcmChunk(first.carry, Buffer.from([0xc0]))
  expect([...second.samples]).toEqual([-0.5])
  expect(second.carry.length).toBe(0)
})

const modelDir = process.env.DSH_STREAMING_MODEL_DIR
const wave = modelDir === undefined ? undefined : join(modelDir, 'test_wavs', '0.wav')

describe.skipIf(wave === undefined || !existsSync(wave))('real streaming Paraformer', () => {
  it('emits growing partials, then final and end with the whole utterance', () => {
    const config = Config({ dataRoot: '/tmp' })
    const engine = createEngine({ encoder: join(modelDir!, 'encoder.int8.onnx'), decoder: join(modelDir!, 'decoder.int8.onnx'),
      tokens: join(modelDir!, 'tokens.txt') }, config)
    const stream = engine.open()
    const bytes = readFileSync(wave!).subarray(44)
    const events = []
    let carry: Buffer = Buffer.alloc(0)
    for (let offset = 0; offset < bytes.length; offset += 3201) {
      const next = pcmChunk(carry, bytes.subarray(offset, offset + 3201))
      carry = next.carry
      events.push(...stream.accept(next.samples))
    }
    events.push(...stream.finish())
    expect(events.filter(event => event.type === 'partial').length).toBeGreaterThan(3)
    const end = events.at(-1)!
    expect(end.type).toBe('end')
    expect(end.type === 'end' && end.text).toMatch(/monday.*星期三$/)
  })
})
