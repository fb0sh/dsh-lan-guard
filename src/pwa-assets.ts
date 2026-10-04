/**
 * dsh-lan-guard — the PNG icons the gate serves for installability.
 *
 * The bytes live in `assets/pwa/` (shipped in the package) rather than as
 * base64 in this file: they are real artwork rasterized from DSH's own
 * `favicon.svg`, and keeping them as files keeps the source readable and the
 * bundle small. Both paths below resolve to the PACKAGE root from either side
 * of the build — `src/` under test and `lib/index.js` once bundled — because
 * the two directories are siblings of `assets/`.
 */
import { readFile } from 'node:fs/promises'

/** One installability icon: its size and the bytes to serve. */
export interface PwaIcon {
  /** Edge length in pixels; also the manifest's declared `sizes`. */
  size: 192 | 512
  /** `image/png` bytes. */
  bytes: Buffer
}

/** Sizes offered, smallest first. */
export const PWA_ICON_SIZES: readonly (192 | 512)[] = [192, 512]

/**
 * Load one icon from the package.
 *
 * @param size - the edge length to load.
 * @returns the icon bytes.
 * @throws when the file is missing, which means the package was built without
 *   `assets/pwa` and installability would silently regress.
 */
export async function loadPwaIcon(size: 192 | 512): Promise<Buffer> {
  const url = new URL(`../assets/pwa/icon-${String(size)}.png`, import.meta.url)
  return readFile(url)
}

/**
 * Load every icon once, for the gate to serve from memory.
 *
 * @returns the icons in ascending size order.
 */
export async function loadPwaIcons(): Promise<PwaIcon[]> {
  const icons: PwaIcon[] = []
  for (const size of PWA_ICON_SIZES) icons.push({ size, bytes: await loadPwaIcon(size) })
  return icons
}
