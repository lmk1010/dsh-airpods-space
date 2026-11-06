/** Pinned model files: inspection, verified download with origin fallback, and atomic publication. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, readFileSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SpeechPreparationState } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { Config, ModelPaths } from './config.ts'

/** Release-pinned downloadable file. */
export interface Asset {
  readonly name: string
  readonly url: string
  readonly sha256: string
  readonly bytes: number
}

type Lock = Record<keyof ModelPaths, Asset>

/** Locked model files shipped with the package. */
export function readLock(): Lock {
  return JSON.parse(readFileSync(new URL('../runtime/assets.json', import.meta.url), 'utf8')) as Lock
}

/**
 * Resolve model file locations without touching the disk.
 * @param config - data root or explicit model directory.
 * @param lock - pinned file names.
 * @returns absolute model paths.
 */
export function modelPaths(config: Config, lock: Lock = readLock()): ModelPaths {
  const root = config.modelDirectory ?? join(config.dataRoot, 'models', 'paraformer-streaming-zh-en')
  return { encoder: join(root, lock.encoder.name), decoder: join(root, lock.decoder.name), tokens: join(root, lock.tokens.name) }
}

async function matches(path: string, asset: Asset, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size !== asset.bytes) return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) digest.update(chunk as Buffer)
  return digest.digest('hex') === asset.sha256
}

/**
 * Check whether every pinned file is present and intact; an explicit model directory is trusted as configured.
 * @param config - model location.
 * @param signal - inspection cancellation.
 * @returns paths when ready, otherwise `undefined`.
 */
export async function inspectModels(config: Config, signal: AbortSignal): Promise<ModelPaths | undefined> {
  const lock = readLock(), paths = modelPaths(config, lock)
  if (config.modelDirectory !== undefined) return paths
  for (const key of ['encoder', 'decoder', 'tokens'] as const) if (!await matches(paths[key], lock[key], signal)) return undefined
  return paths
}

/**
 * Download one file into a unique partial file, verify size and SHA-256, then rename it into place.
 * @param asset - pinned identity; `url` is the concrete source.
 * @param destination - final path.
 * @param signal - preparation cancellation.
 * @param report - download progress.
 */
export async function download(asset: Asset, destination: string, signal: AbortSignal,
  report: (completedBytes: number) => void): Promise<void> {
  const partial = `${destination}.${randomUUID()}.part`
  try {
    const response = await fetch(asset.url, { signal })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error(`HTTP ${response.status} from ${new URL(asset.url).origin}`)
    }
    const digest = createHash('sha256')
    let completed = 0
    const hashing = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      completed += chunk.length
      if (completed > asset.bytes) { callback(new Error(`${asset.name} is larger than expected`)); return }
      digest.update(chunk); report(completed); callback(null, chunk)
    } })
    await pipeline(response.body, hashing, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal })
    if (completed !== asset.bytes || digest.digest('hex') !== asset.sha256) throw new Error(`${asset.name} failed integrity verification`)
    await rename(partial, destination)
  } finally {
    await rm(partial, { force: true })
  }
}

/**
 * Ensure every pinned file is present, downloading missing or corrupted files from the configured origins in order.
 * @param config - data root and origins.
 * @param signal - preparation cancellation or deadline.
 * @param report - preparation progress.
 * @returns verified model paths.
 */
export async function prepareModels(config: Config, signal: AbortSignal,
  report: (state: SpeechPreparationState) => void): Promise<ModelPaths> {
  const lock = readLock(), paths = modelPaths(config, lock)
  if (config.modelDirectory !== undefined) return paths
  await mkdir(join(config.dataRoot, 'models', 'paraformer-streaming-zh-en'), { recursive: true })
  for (const key of ['encoder', 'decoder', 'tokens'] as const) {
    const asset = lock[key]
    report({ phase: 'checking', step: 'check', startedAt: Date.now() })
    if (await matches(paths[key], asset, signal)) continue
    const path = new URL(asset.url).pathname
    const failures: string[] = []
    for (const origin of config.modelOrigins) {
      try {
        await download({ ...asset, url: new URL(path, origin).href }, paths[key], signal, (completedBytes) => {
          report({ phase: 'downloading', step: 'model', resource: asset.name, completedBytes, totalBytes: asset.bytes })
        })
        break
      } catch (error) {
        signal.throwIfAborted()
        failures.push(`${origin}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failures.length === config.modelOrigins.length) throw new Error(`Could not download ${asset.name}; ${failures.join('; ')}`)
  }
  report({ phase: 'checking', step: 'verify', startedAt: Date.now() })
  if (await inspectModels(config, signal) === undefined) throw new Error('Streaming model verification failed')
  return paths
}
