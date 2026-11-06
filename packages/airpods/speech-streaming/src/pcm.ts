/** PCM16 helpers and a single-consumer event channel shared by streaming providers. */

/** Samples per second for every stream. */
export const SAMPLE_RATE = 16000

/**
 * Convert PCM16 samples to the float range sherpa-style recognizers expect.
 * @param pcm - signed 16-bit samples.
 * @returns samples in [-1, 1).
 */
export function toFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  pcm.forEach((sample, i) => { out[i] = sample / 32768 })
  return out
}

/**
 * Wrap concatenated PCM16 chunks in a canonical 16 kHz mono WAV accepted by batch providers.
 * @param chunks - recorded samples in order.
 * @returns WAV bytes.
 */
export function encodeWave(chunks: readonly Int16Array[]): Uint8Array {
  const samples = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const data = Buffer.alloc(44 + samples * 2)
  data.write('RIFF', 0, 'ascii'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVE', 8, 'ascii')
  data.write('fmt ', 12, 'ascii'); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22)
  data.writeUInt32LE(SAMPLE_RATE, 24); data.writeUInt32LE(SAMPLE_RATE * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34)
  data.write('data', 36, 'ascii'); data.writeUInt32LE(samples * 2, 40)
  let offset = 44
  for (const chunk of chunks) {
    Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(data, offset)
    offset += chunk.byteLength
  }
  return data
}

/**
 * Read PCM16 samples from a canonical WAV already checked by `validateWave`.
 * @param wave - 44-byte header followed by samples.
 * @returns a copy of the samples.
 */
export function decodeWave(wave: Uint8Array): Int16Array {
  const bytes = wave.slice(44)
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
}

/** Unbounded single-consumer queue that ends with completion or the first failure. */
export class Channel<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private waiter: PromiseWithResolvers<void> | undefined
  private closed = false
  private failure: { error: unknown } | undefined

  push(item: T): void {
    if (this.closed) return
    this.items.push(item); this.waiter?.resolve()
  }

  close(): void { this.closed = true; this.waiter?.resolve() }

  fail(error: unknown): void {
    if (this.closed) return
    this.failure = { error }; this.close()
  }

  get done(): boolean { return this.closed }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length > 0) { yield this.items.shift() as T; continue }
      if (this.failure !== undefined) throw this.failure.error
      if (this.closed) return
      this.waiter = Promise.withResolvers<void>()
      await this.waiter.promise
      this.waiter = undefined
    }
  }
}
