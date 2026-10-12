/** Base64 / data-URL helpers that work in both content scripts and service workers. */

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface ParsedDataUrl {
  mime: string;
  bytes: Uint8Array;
}

/** Decode a `data:` URL without `fetch` (which page CSP may block). */
export function parseDataUrl(url: string): ParsedDataUrl | null {
  const m = /^data:([^,]*?),([\s\S]*)$/i.exec(url);
  if (!m) return null;
  const meta = m[1].split(';');
  const isBase64 = meta.slice(1).some((p) => p.trim().toLowerCase() === 'base64');
  const mime = meta[0].trim().toLowerCase() || 'text/plain';
  try {
    const bytes = isBase64 ? base64ToBytes(decodeURIComponent(m[2])) : new TextEncoder().encode(decodeURIComponent(m[2]));
    return { mime, bytes };
  } catch {
    return null;
  }
}
