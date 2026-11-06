/** Contracts shared by streaming recognizers, the registry and the Remote controller. */
import type { SpeechPreparation, SpeechProviderId, SpeechProviderInfo } from '@deepseek-ai/dsh-experimental-speech-to-text/types'

/** Options fixed for the lifetime of one stream. */
export interface StreamOptions {
  /** Provider language hint, `auto` when the provider detects it. */
  readonly language: string
  /** Domain words the provider should prefer when it supports biasing. */
  readonly hotwords?: readonly string[]
}

/**
 * Recognition progress. `partial` replaces the current segment's text; `final` closes a segment at an
 * endpoint; `end` carries the whole utterance once input is finished; `refined` replaces `end` text after
 * an optional batch second pass.
 */
export type StreamEvent =
  | { readonly type: 'partial'; readonly segment: number; readonly text: string }
  | { readonly type: 'final'; readonly segment: number; readonly text: string }
  | { readonly type: 'end'; readonly text: string; readonly audioSeconds: number }
  | { readonly type: 'refined'; readonly text: string; readonly providerId: SpeechProviderId; readonly inferenceSeconds: number }

/** One live recognition owned by its caller until `finish()` settles `events` or the signal aborts it. */
export interface StreamingSession {
  /**
   * Append audio.
   * @param pcm - 16 kHz mono signed 16-bit little-endian samples.
   */
  write(pcm: Int16Array): void
  /** Close input; `events` completes after the provider's `end` event. */
  finish(): void
  /** Ordered progress; iterating more than once is not supported. */
  readonly events: AsyncIterable<StreamEvent>
}

/** Streaming recognizer registered by a provider plugin. */
export interface StreamingProvider {
  readonly info: SpeechProviderInfo
  readonly preparation?: SpeechPreparation
  /** Load models or open connections ahead of the first stream, for example when a headset connects. */
  warm?(): void
  /**
   * Start one stream.
   * @param options - language and biasing for this stream.
   * @param signal - aborts the stream and releases provider resources.
   */
  open(options: StreamOptions, signal: AbortSignal): Promise<StreamingSession>
}

/** Caller choices; omitted fields follow the registry's configured selection. */
export interface StreamRequest {
  readonly providerId?: SpeechProviderId
  readonly language?: string
  readonly hotwords?: readonly string[]
  /** Batch provider for the second pass; `false` disables it for this stream. */
  readonly refine?: SpeechProviderId | false
}

export type { SpeechProviderId, SpeechProviderInfo }
