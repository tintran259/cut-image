/**
 * URL resolution helpers: srcset parsing, lazy-load attributes and CSS
 * `url(...)` / `image-set(...)` extraction. Pure functions, no DOM layout.
 */

export interface SrcsetCandidate {
  url: string;
  /** Width descriptor (`400w`). */
  w?: number;
  /** Pixel-density descriptor (`2x`). Defaults to 1 when no descriptor is given. */
  x?: number;
}

const WS = /[\t\n\f\r ]/;

/**
 * Parse a `srcset` attribute following the HTML spec tokenizer, so URLs that
 * contain commas (e.g. Cloudinary `w_400,c_fill`) are kept intact.
 */
export function parseSrcset(input: string | null | undefined): SrcsetCandidate[] {
  if (!input) return [];
  const out: SrcsetCandidate[] = [];
  const len = input.length;
  let pos = 0;

  while (pos < len) {
    while (pos < len && (WS.test(input[pos]) || input[pos] === ',')) pos++;
    if (pos >= len) break;

    const start = pos;
    while (pos < len && !WS.test(input[pos])) pos++;
    let url = input.slice(start, pos);
    const descriptors: string[] = [];

    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      let cur = '';
      let inParens = false;
      while (pos < len) {
        const c = input[pos++];
        if (inParens) {
          cur += c;
          if (c === ')') inParens = false;
        } else if (c === ',') {
          break;
        } else if (WS.test(c)) {
          if (cur) descriptors.push(cur);
          cur = '';
        } else {
          if (c === '(') inParens = true;
          cur += c;
        }
      }
      if (cur) descriptors.push(cur);
    }

    if (!url) continue;
    const cand: SrcsetCandidate = { url };
    let valid = true;
    for (const d of descriptors) {
      const m = /^(\d+(?:\.\d+)?|\.\d+)([wxh])$/i.exec(d);
      if (!m) {
        valid = false;
        break;
      }
      const n = parseFloat(m[1]);
      const kind = m[2].toLowerCase();
      if (kind === 'w') cand.w = n;
      else if (kind === 'x') cand.x = n;
      // `h` descriptors are ignored (future-compat in the spec).
    }
    if (!valid) continue;
    if (cand.w === undefined && cand.x === undefined) cand.x = 1;
    out.push(cand);
  }
  return out;
}

/**
 * Pick the largest candidate. Width descriptors win over density descriptors
 * because they carry real pixel information.
 */
export function pickLargestFromSrcset(srcset: string | null | undefined): string | null {
  return pickLargestCandidate(parseSrcset(srcset));
}

export function pickLargestCandidate(cands: SrcsetCandidate[]): string | null {
  if (!cands.length) return null;
  const withW = cands.filter((c) => c.w !== undefined);
  const pool = withW.length ? withW : cands;
  const key = (c: SrcsetCandidate) => (withW.length ? c.w! : c.x ?? 1);
  return pool.reduce((best, c) => (key(c) > key(best) ? c : best)).url;
}

/** Undo CSS string escapes (`\"`, `\\`, hex escapes like `\26 `). */
export function unescapeCss(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([\s\S])/g, (_, hex, ch) => {
    if (hex) {
      const cp = parseInt(hex, 16);
      return cp === 0 || cp > 0x10ffff ? '�' : String.fromCodePoint(cp);
    }
    return ch === '\n' ? '' : ch;
  });
}

/** Split a CSS value on commas that are not inside parentheses or quotes. */
export function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      cur += c;
      if (c === '\\' && i + 1 < value.length) cur += value[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const URL_RE = /url\(\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|((?:[^)\s\\]|\\[\s\S])*))\s*\)/gi;

/** Every `url(...)` inside a CSS value, in order, unescaped. */
export function extractCssUrls(value: string | null | undefined): string[] {
  if (!value || value === 'none') return [];
  const out: string[] = [];
  for (const m of value.matchAll(URL_RE)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    const url = unescapeCss(raw).trim();
    if (url) out.push(url);
  }
  return out;
}

/** Leading bare CSS string (`"a.png" 2x` inside image-set), unescaped. */
function quotedString(s: string): string | null {
  const m = /^\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)')/.exec(s);
  const raw = m?.[1] ?? m?.[2];
  return raw ? unescapeCss(raw) : null;
}

/**
 * One URL per background layer. Gradients are skipped; for
 * `image-set()` / `-webkit-image-set()` the highest-density URL wins.
 */
export function extractBackgroundUrls(value: string | null | undefined): string[] {
  if (!value || value === 'none') return [];
  const out: string[] = [];
  for (const layer of splitTopLevelCommas(value)) {
    const setMatch = /^(?:-webkit-)?image-set\(([\s\S]*)\)$/i.exec(layer);
    if (setMatch) {
      let best: { url: string; x: number } | null = null;
      for (const opt of splitTopLevelCommas(setMatch[1])) {
        const url = extractCssUrls(opt)[0] ?? quotedString(opt);
        if (!url) continue;
        const dm = /(\d+(?:\.\d+)?)(x|dppx)\s*(?:type\([^)]*\))?\s*$/i.exec(opt);
        const x = dm ? parseFloat(dm[1]) : 1;
        if (!best || x > best.x) best = { url, x };
      }
      if (best) out.push(best.url);
      continue;
    }
    const urls = extractCssUrls(layer);
    if (urls.length) out.push(urls[0]);
  }
  return out;
}

/** Resolve against a base URL; returns null for unparseable or non-fetchable values. */
export function toAbsoluteUrl(url: string | null | undefined, base: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  try {
    const abs = new URL(trimmed, base);
    if (!/^(https?|data|blob|file):$/.test(abs.protocol)) return null;
    return abs.href;
  } catch {
    return null;
  }
}

export const LAZY_SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url'] as const;
export const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'] as const;

/**
 * Tiny inline images (1x1 GIFs, blank SVGs) that lazy loaders use as
 * placeholders until the real source is swapped in.
 */
export function isPlaceholderUrl(url: string | null | undefined): boolean {
  if (!url) return true;
  const u = url.trim();
  if (!u || u === 'about:blank') return true;
  return u.startsWith('data:') && u.length < 256;
}

/** Minimal shape of an element we need, so this stays testable without a DOM. */
export interface AttrSource {
  getAttribute(name: string): string | null;
}

/**
 * Best URL for an `<img>`-like element, in priority order:
 * largest srcset candidate (from the element and any `<picture><source>`s),
 * `currentSrc`, `src`, then lazy-load attributes. Placeholders are skipped
 * unless nothing better exists.
 */
export function resolveImageUrl(
  el: AttrSource & { currentSrc?: string; src?: string },
  base: string,
  extraSrcsets: string[] = [],
): string | null {
  const candidates: (string | null | undefined)[] = [];

  const srcsets = [el.getAttribute('srcset'), ...extraSrcsets, ...LAZY_SRCSET_ATTRS.map((a) => el.getAttribute(a))];
  candidates.push(pickLargestCandidate(srcsets.flatMap((s) => parseSrcset(s))));
  candidates.push(el.currentSrc, el.getAttribute('src'));
  for (const a of LAZY_SRC_ATTRS) candidates.push(el.getAttribute(a));

  const resolved = candidates.map((c) => toAbsoluteUrl(c, base)).filter((c): c is string => !!c);
  return resolved.find((u) => !isPlaceholderUrl(u)) ?? resolved[0] ?? null;
}
