/** File-name and extension helpers shared by the content script and the service worker. */

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/apng': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/jxl': 'jxl',
};

const KNOWN_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'heif', 'jxl']);

function normalizeExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === 'jpeg' || e === 'jpe' || e === 'jfif') return 'jpg';
  if (e === 'tiff') return 'tif';
  return e;
}

export function extFromMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  return MIME_EXT[mime.split(';')[0].trim().toLowerCase()] ?? null;
}

/** Detect the format from magic bytes, for servers that send `application/octet-stream`. */
export function sniffExt(bytes: Uint8Array): string | null {
  const b = bytes;
  const at = (i: number, ...sig: number[]) => sig.every((v, j) => b[i + j] === v);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'jpg';
  if (b.length >= 6 && at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif';
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  if (b.length >= 12 && at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'heic';
  }
  if (b.length >= 2 && at(0, 0x42, 0x4d)) return 'bmp';
  if (b.length >= 4 && at(0, 0x00, 0x00, 0x01, 0x00)) return 'ico';
  const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
}

/** Extension from a URL: `data:` mime, path suffix, or a `format=`/`fm=` query param (CDNs). */
export function extFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('data:')) return extFromMime(/^data:([^;,]*)/.exec(url)?.[1]);
  try {
    const u = new URL(url);
    const m = /\.([a-z0-9]{2,5})$/i.exec(u.pathname);
    if (m && KNOWN_EXTS.has(m[1].toLowerCase())) return normalizeExt(m[1]);
    for (const key of ['format', 'fm', 'ext', 'type']) {
      const v = u.searchParams.get(key)?.toLowerCase().replace(/^image\//, '');
      if (v && KNOWN_EXTS.has(v)) return normalizeExt(v);
    }
  } catch {
    /* not a URL */
  }
  return null;
}

/** Content-Type first, then magic bytes, then the URL; `jpg` as a last resort. */
export function inferExt(opts: { mime?: string | null; bytes?: Uint8Array; url?: string | null }): string {
  return extFromMime(opts.mime) ?? (opts.bytes ? sniffExt(opts.bytes) : null) ?? extFromUrl(opts.url) ?? 'jpg';
}

export function sanitizeHostname(hostname: string | null | undefined): string {
  const h = (hostname ?? '').toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9.-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '');
  return h || 'page';
}

/** `{hostname}_{index}.{ext}`; index is 1-based and zero-padded to the width of `total`. */
export function buildFileName(hostname: string, index: number, total: number, ext: string): string {
  const width = Math.max(2, String(total).length);
  return `${sanitizeHostname(hostname)}_${String(index).padStart(width, '0')}.${ext}`;
}

/** `{hostname}_{YYYYMMDD-HHmm}.zip` in local time. */
export function buildZipName(hostname: string, date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
  return `${sanitizeHostname(hostname)}_${stamp}.zip`;
}

/** Short format label for the panel (`JPG`, `SVG`, …). */
export function formatLabel(url: string, kind?: string): string {
  if (kind === 'svg') return 'SVG';
  if (kind === 'canvas') return 'PNG';
  return (extFromUrl(url) ?? '?').toUpperCase();
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const MAX_NAME_LENGTH = 120;

/**
 * Make a user-typed base name safe for chrome.downloads on every OS:
 * no path separators or reserved characters, no leading dots, no trailing
 * dots/spaces, no Windows device names. A trailing image extension the user
 * typed is dropped (the real one is added from the output format).
 * Returns '' when nothing usable is left (→ automatic name).
 */
export function sanitizeFileName(name: string | null | undefined): string {
  let n = (name ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ') // tabs / newlines become spaces before other control chars are dropped
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  n = n.replace(/\.(jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?|heic|heif|jxl)$/i, '');
  n = n.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (WINDOWS_RESERVED.test(n)) n = `_${n}`;
  if (n.length > MAX_NAME_LENGTH) n = n.slice(0, MAX_NAME_LENGTH).replace(/[.\s]+$/, '');
  return n;
}

/** `name.ext`, or `name (2).ext`, `name (3).ext`… if already taken (case-insensitive). */
export function uniqueFileName(base: string, ext: string, taken: Set<string>): string {
  let candidate = `${base}.${ext}`;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${base} (${i}).${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}
