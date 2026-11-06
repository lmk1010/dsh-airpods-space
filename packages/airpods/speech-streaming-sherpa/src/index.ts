/** Optional local streaming recognizer; activation inspects the model cache without downloading or loading. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@dshub/speech-streaming'
import { Config } from './config.ts'
import { SherpaStreaming } from './provider.ts'

export { Config } from './config.ts'
export const name = 'speech-streaming-sherpa'
export const inject = ['speechStreaming', 'subprocess']

/**
 * Register the local streaming provider.
 * @param ctx - streaming registry and subprocess owner.
 * @param config - validated runtime configuration.
 */
export function apply(ctx: Context, config: Config): void {
  for (const path of [config.dataRoot, config.modelDirectory]) {
    if (path !== undefined && !isAbsolute(path)) throw new Error(`Streaming model paths must be absolute: ${path}`)
  }
  const provider = new SherpaStreaming(ctx, config)
  ctx.effect(() => {
    const unregister = ctx.speechStreaming.register(provider)
    provider.inspect()
    return async () => {
      const removing = unregister()
      await provider.dispose()
      await removing
    }
  })
}
