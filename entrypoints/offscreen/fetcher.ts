import { base64ToBytes } from '../../lib/base64';
import type { DownloadItem } from '../../lib/messages';

const FETCH_TIMEOUT_MS = 30_000;
/** Bytes fetched for duplicate detection are kept so "Download" doesn't fetch them again. */
const CACHE_LIMIT_BYTES = 200 * 1024 * 1024;

export interface Loaded {
  bytes: Uint8Array;
  mime: string;
}

const cache = new Map<string, Loaded>();
let cacheBytes = 0;

function remember(url: string, v: Loaded) {
  if (v.bytes.byteLength > CACHE_LIMIT_BYTES / 4) return;
  const old = cache.get(url);
  if (old) {
    cacheBytes -= old.bytes.byteLength;
    cache.delete(url);
  }
  cache.set(url, v);
  cacheBytes += v.bytes.byteLength;
  // Evict oldest entries first (Map keeps insertion order).
  for (const [k, e] of cache) {
    if (cacheBytes <= CACHE_LIMIT_BYTES) break;
    cache.delete(k);
    cacheBytes -= e.bytes.byteLength;
  }
}

/** Bytes for an item: inline base64, the cache, or a network fetch (cached afterwards). */
export async function load(item: DownloadItem): Promise<Loaded> {
  if (item.base64 !== undefined) return { bytes: base64ToBytes(item.base64), mime: item.mime ?? '' };
  const hit = cache.get(item.url);
  if (hit) {
    // Refresh LRU position.
    cache.delete(item.url);
    cache.set(item.url, hit);
    return hit;
  }
  if (!/^https?:/i.test(item.url)) throw new Error(`Unsupported URL scheme: ${item.url.slice(0, 16)}…`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(item.url, { credentials: 'include', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (mime.startsWith('text/html')) throw new Error('Server returned an HTML page, not an image');
    const loaded = { bytes: new Uint8Array(await res.arrayBuffer()), mime };
    remember(item.url, loaded);
    return loaded;
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error('Timed out');
    // Opaque network errors are almost always CORS / missing host permission.
    if (err instanceof TypeError) throw new Error('Blocked (cross-origin). Grant site access and retry.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function clearCache() {
  cache.clear();
  cacheBytes = 0;
}
