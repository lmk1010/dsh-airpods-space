/** Validated settings shared by the Host provider and its recognition process. */
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

const origin = z.string().pattern(/^https?:\/\/[^/\s?#@]+\/?$/)

/** Local streaming Paraformer settings. */
export interface Config {
  /** Registered provider id. */
  providerId: string
  /** Provider-owned directory for downloaded models. */
  dataRoot: string
  /** Directory already holding `encoder.int8.onnx`, `decoder.int8.onnx` and `tokens.txt`; skips download and hash checks. */
  modelDirectory?: string
  /** Hugging Face-compatible origins tried in order for each pinned file. */
  modelOrigins: string[]
  /** ONNX Runtime CPU threads in the recognition process. */
  threads: number
  /** Close a segment and reset decoding at detected pauses; resetting mid-sentence loses context, so press-to-talk keeps it off. */
  segmentOnEndpoint: boolean
  /** Trailing silence that ends a segment when nothing was recognized yet. */
  endpointSilenceSeconds: number
  /** Trailing silence that ends a segment after text was recognized. */
  endpointSilenceAfterTextSeconds: number
  /** Segment length that forces an endpoint. */
  endpointMaxSegmentSeconds: number
  /** Silence appended at finish so the last chunk is decoded. */
  tailPaddingSeconds: number
  /** Longest accepted stream. */
  maxStreamSeconds: number
  /** Download and process start deadline. */
  prepareTimeoutMs: number
  /** Stop the idle recognition process after this delay; `0` keeps it running. */
  idleTimeoutMs: number
  /** Grace period before the recognition process is killed. */
  graceMs: number
  /** Retained recognition process stderr bytes. */
  maxLogBytes: number
  /** Minimum interval between download progress notifications. */
  progressIntervalMs: number
}

export const Config: z<Partial<Config>, Config> = z.object({
  providerId: z.string().min(1).default('paraformer-streaming-local'),
  dataRoot: z.string().min(1).required(),
  modelDirectory: z.string().min(1),
  modelOrigins: z.array(origin).min(1).default(['https://huggingface.co', 'https://hf-mirror.com']),
  threads: z.natural().min(1).default(2),
  segmentOnEndpoint: z.boolean().default(false),
  endpointSilenceSeconds: z.number().min(0.1).default(2.4),
  endpointSilenceAfterTextSeconds: z.number().min(0.1).default(0.8),
  endpointMaxSegmentSeconds: z.number().min(1).default(20),
  tailPaddingSeconds: z.number().min(0).max(2).default(0.5),
  maxStreamSeconds: z.natural().min(1).default(300),
  prepareTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(3_600_000),
  idleTimeoutMs: z.natural().max(MAX_TIMER_DELAY_MS).default(600_000),
  graceMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(1000),
  maxLogBytes: z.natural().min(1).default(64 * 1024),
  progressIntervalMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(100),
})

/** Verified model files passed to the recognition process. */
export interface ModelPaths {
  readonly encoder: string
  readonly decoder: string
  readonly tokens: string
}
