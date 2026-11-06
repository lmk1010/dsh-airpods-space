/** Browser entry for the AirPods space Remote contribution and composer dock. */
import type { Context } from '@deepseek-ai/cordis'
import airpodsRemote from '@lmk1010/airpods-space/remote'
import { mountAirpodsSpace } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Activate the AirPods space contribution.
 * @param ctx - Client runtime.
 * @returns complete UI and Remote disposer.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountAirpodsSpace(ctx, airpodsRemote)
}
