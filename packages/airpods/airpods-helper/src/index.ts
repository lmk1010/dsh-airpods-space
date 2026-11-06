/** Locations of the native helper binary and connect-card renders shipped in this package. */
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Packaged Electron apps keep this package inside `app.asar`, while the binary and renders are unpacked next to it
 * (`app.asar.unpacked`); a path inside the archive cannot be spawned or used as a working directory.
 * @param path - path computed from this module's location.
 * @returns the on-disk path.
 */
function unpacked(path: string): string {
  return path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
}

/** Absolute path of the universal macOS helper executable. */
export const helperExecutable: string = unpacked(fileURLToPath(new URL('../bin/DSH AirPods.app/Contents/MacOS/dsh-airpods-helper', import.meta.url)))

/** Absolute path of the directory holding the product renders. */
export const helperAssets: string = unpacked(fileURLToPath(new URL('../assets', import.meta.url)))
