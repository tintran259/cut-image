/**
 * Duplicate detection: perceptual fingerprints (dHash + aspect ratio + mean
 * colour) with a URL-normalisation fallback for images that couldn't be read.
 * Pure functions; the pixels are produced by the offscreen document.
 */

export interface Fingerprint {
  /** 64-bit difference hash as 16 hex chars. */
  hash: string;
  /** width / height of the decoded image. */
  aspect: number;
  /** Mean sRGB colour (0–255), composited on white. */
  color: [number, number, number];
  /**
   * THUMB×THUMB RGB thumbnail (row-major, 3 bytes per pixel), composited on
   * white. Compared cell by cell, so images that share a layout (store
   * templates, frames, banners) but differ in one region are told apart.
   */
  thumb: number[];
}

export const THUMB = 16;

/** Grid the image is reduced to before hashing: 9×8 grayscale → 8×8 horizontal gradients. */
export const HASH_W = 9;
export const HASH_H = 8;

/**
 * dHash: for each row, compare each pixel with its right neighbour.
 * `gray` is HASH_W × HASH_H luminance values, row-major.
 */
export function dHash(gray: ArrayLike<number>): string {
  let bits = 0n;
  for (let y = 0; y < HASH_H; y++) {
    for (let x = 0; x < HASH_W - 1; x++) {
      bits = (bits << 1n) | (gray[y * HASH_W + x] > gray[y * HASH_W + x + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

export interface SimilarityOptions {
  /** Max differing hash bits (of 64): a cheap pre-filter. */
  maxHamming?: number;
  /** Max relative aspect-ratio difference. */
  maxAspectDiff?: number;
  /** Max Euclidean distance between mean colours. */
  maxColorDist?: number;
  /** Max per-cell difference (largest of |ΔR|,|ΔG|,|ΔB|, 0–255) anywhere in the thumbnail. */
  maxCellDiff?: number;
  /** Max average per-cell difference over the whole thumbnail. */
  maxMeanDiff?: number;
}

/**
 * Compare two thumbnails cell by cell. Returns the worst cell and the mean.
 * Resized / recompressed copies stay low everywhere; a different product in
 * the same template produces a cluster of high cells.
 */
export function thumbDistance(a: number[], b: number[]): { max: number; mean: number } {
  if (a.length !== b.length || !a.length) return { max: 255, mean: 255 };
  let max = 0;
  let sum = 0;
  const cells = a.length / 3;
  for (let i = 0; i < a.length; i += 3) {
    // Largest channel difference: a brown vs a black version of one product differs mostly in R.
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d > max) max = d;
    sum += d;
  }
  return { max, mean: sum / cells };
}

/**
 * Hash bits alone over-match smooth images (gradients, flat colours), so the
 * aspect ratio and overall colour must agree too.
 */
export function isSimilar(a: Fingerprint, b: Fingerprint, opts: SimilarityOptions = {}): boolean {
  const { maxHamming = 10, maxAspectDiff = 0.08, maxColorDist = 16, maxCellDiff = 32, maxMeanDiff = 8 } = opts;
  if (Math.abs(Math.log(a.aspect / b.aspect)) > maxAspectDiff) return false;
  const dc = Math.hypot(a.color[0] - b.color[0], a.color[1] - b.color[1], a.color[2] - b.color[2]);
  if (dc > maxColorDist) return false;
  if (hamming(a.hash, b.hash) > maxHamming) return false;
  const d = thumbDistance(a.thumb, b.thumb);
  return d.max <= maxCellDiff && d.mean <= maxMeanDiff;
}

/** Query parameters CDNs use for size / format / quality variants of the same image. */
const VARIANT_PARAMS = new Set([
  'w', 'h', 'width', 'height', 'size', 'sz', 's', 'resize', 'fit', 'crop', 'q', 'quality', 'qlt',
  'fm', 'format', 'auto', 'dpr', 'scale', 'im', 'imwidth', 'imheight', 'tr', 'ixlib', 'cs', 'name', 'v', 'ver', 'version',
]);

/**
 * Key that is equal for size / format variants of one image URL, e.g.
 * `photo-300x200.jpg?w=300` and `photo.webp?w=1200` → same key.
 * Only used when pixels aren't available, so it errs on the side of caution.
 */
export function normalizeUrlKey(url: string): string {
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const params = [...u.searchParams.entries()].filter(([k]) => !VARIANT_PARAMS.has(k.toLowerCase())).sort(([a], [b]) => a.localeCompare(b));
  let path = decodeURIComponent(u.pathname).toLowerCase();
  path = path
    // Cloudinary / imgix-style transformation segments: /w_400,h_300,c_fill/ or /t_thumb/
    .replace(/\/(?:[a-z]{1,3}_[^/,]+)(?:,[a-z]{1,3}_[^/,]+)*(?=\/)/g, '')
    // Google-style suffixes: =s400, =w400-h300-c
    .replace(/=[swh]\d+(?:-[a-z0-9]+)*$/, '')
    // WordPress / generic size suffixes: -300x200, _400x400, @2x, _thumb, -scaled
    .replace(/[-_]\d{2,5}x\d{2,5}(?=\.[a-z0-9]+$|$)/, '')
    .replace(/@\dx(?=\.[a-z0-9]+$|$)/, '')
    .replace(/[-_](?:thumb|thumbnail|small|medium|large|scaled|orig|original)(?=\.[a-z0-9]+$|$)/, '')
    // Extension (format variants)
    .replace(/\.(?:jpe?g|png|webp|avif|gif)$/, '');
  return `${u.hostname.replace(/^www\./, '')}${path}?${new URLSearchParams(params).toString()}`;
}

export interface DupEntry {
  id: number;
  url: string;
  fp?: Fingerprint;
  /** Pixel area, to pick the best copy. */
  area: number;
}

/**
 * Group duplicates. Returns groups of ≥2 ids, best copy (largest, then
 * earliest) first.
 *
 * Grouping is greedy against each group's best copy rather than transitive,
 * so a chain of "slightly similar" images (A≈B, B≈C) never pulls unrelated
 * A and C together. Entries without a fingerprint fall back to matching
 * normalised URLs.
 */
export function findDuplicateGroups(entries: DupEntry[], opts?: SimilarityOptions): number[][] {
  const order = entries.map((_, i) => i).sort((x, y) => entries[y].area - entries[x].area || x - y);
  const keys = entries.map((e) => normalizeUrlKey(e.url));
  const groups: number[][] = []; // indexes into entries; [0] is the representative

  const matches = (i: number, j: number) => {
    const a = entries[i];
    const b = entries[j];
    return a.fp && b.fp ? isSimilar(a.fp, b.fp, opts) : keys[i] === keys[j];
  };

  for (const i of order) {
    const g = groups.find((members) => matches(members[0], i));
    if (g) g.push(i);
    else groups.push([i]);
  }

  return groups
    .filter((g) => g.length > 1)
    .map((g) => g.map((i) => entries[i].id))
    .sort((a, b) => Math.min(...a) - Math.min(...b));
}
