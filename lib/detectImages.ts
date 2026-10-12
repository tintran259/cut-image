import { extractBackgroundUrls, extractCssUrls, resolveImageUrl, toAbsoluteUrl } from './resolveUrl';

export type ImageKind = 'img' | 'svg' | 'canvas' | 'video' | 'background';

export interface DetectedImage {
  url: string;
  type: ImageKind;
  /** Intrinsic size when known (loaded <img>, canvas), otherwise rendered size. */
  width: number;
  height: number;
  element: Element;
}

/** A rectangle in viewport (client) coordinates. */
export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DetectOptions {
  /** Minimum fraction of the element's area that must lie inside the rect. Default 0.3. */
  minOverlap?: number;
  /** Elements whose rendered width or height is below this are skipped. Default 8. */
  minSize?: number;
  /** Grid spacing in CSS px for `elementsFromPoint` sampling. Default 20. */
  sampleStep?: number;
  /** Return true to ignore an element (e.g. the extension's own UI). */
  exclude?: (el: Element) => boolean;
  doc?: Document;
}

const MAX_SAMPLES = 6000;

export function overlapRatio(el: RectLike, sel: RectLike): number {
  const area = (el.right - el.left) * (el.bottom - el.top);
  if (area <= 0) return 0;
  const w = Math.min(el.right, sel.right) - Math.max(el.left, sel.left);
  const h = Math.min(el.bottom, sel.bottom) - Math.max(el.top, sel.top);
  return w > 0 && h > 0 ? (w * h) / area : 0;
}

/**
 * Find every image whose element overlaps `rect` (viewport coordinates) by at
 * least `minOverlap` of its own area. Combines a full DOM scan with a grid of
 * `elementsFromPoint` samples (which also pierces open shadow roots and finds
 * images buried under transparent overlay layers). Results are deduplicated by
 * URL and ordered top-to-bottom, left-to-right.
 *
 * Inline SVGs are returned as `blob:` URLs; call `releaseDetectedImages` when done.
 */
export function detectImages(rect: RectLike, options: DetectOptions = {}): DetectedImage[] {
  const doc = options.doc ?? document;
  const win = doc.defaultView;
  if (!win) return [];
  const minOverlap = options.minOverlap ?? 0.3;
  const minSize = options.minSize ?? 8;
  const sel: RectLike = {
    left: Math.min(rect.left, rect.right),
    right: Math.max(rect.left, rect.right),
    top: Math.min(rect.top, rect.bottom),
    bottom: Math.max(rect.top, rect.bottom),
  };
  const base = doc.baseURI;

  const visited = new Set<Element>();
  const hiddenMemo = new Map<Element, boolean>();
  const seenSvgMarkup = new Set<string>();
  const byUrl = new Map<string, DetectedImage>();
  const rects = new Map<DetectedImage, DOMRect>();

  const isHidden = (el: Element): boolean => {
    const own = win.getComputedStyle(el);
    if (own.visibility === 'hidden' || own.visibility === 'collapse') return true;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const memo = hiddenMemo.get(e);
      if (memo !== undefined) return memo;
      const cs = e === el ? own : win.getComputedStyle(e);
      if (cs.display === 'none' || parseFloat(cs.opacity) === 0) {
        hiddenMemo.set(e, true);
        return true;
      }
    }
    return false;
  };

  const add = (img: DetectedImage, r: DOMRect) => {
    if (!img.url || byUrl.has(img.url)) return;
    byUrl.set(img.url, img);
    rects.set(img, r);
  };

  const consider = (el: Element) => {
    if (visited.has(el)) return;
    visited.add(el);
    if (options.exclude?.(el)) return;
    // Nested SVG parts are handled through their outermost <svg>.
    if (isSvgPart(el)) return;

    const r = el.getBoundingClientRect();
    if (overlapRatio(r, sel) < minOverlap) return;
    if (isHidden(el)) return;
    const bigEnough = r.width >= minSize && r.height >= minSize;
    const tag = el.localName;

    if (bigEnough) {
      if (tag === 'img') {
        const img = el as HTMLImageElement;
        const sources = img.parentElement?.localName === 'picture'
          ? Array.from(img.parentElement.querySelectorAll('source'), (s) => s.getAttribute('srcset') ?? s.getAttribute('data-srcset') ?? '')
          : [];
        const url = resolveImageUrl(img, base, sources);
        if (url) {
          const natural = img.naturalWidth > 1 && url === img.currentSrc;
          add({ url, type: 'img', width: natural ? img.naturalWidth : Math.round(r.width), height: natural ? img.naturalHeight : Math.round(r.height), element: el }, r);
        }
      } else if (tag === 'svg' && isOutermostSvg(el)) {
        const markup = serializeSvg(el as SVGSVGElement, doc, win, r);
        if (markup && !seenSvgMarkup.has(markup)) {
          seenSvgMarkup.add(markup);
          add({ url: svgToUrl(markup), type: 'svg', width: Math.round(r.width), height: Math.round(r.height), element: el }, r);
        }
      } else if (tag === 'image' && isSvgElement(el)) {
        const href = el.getAttribute('href') ?? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        const url = toAbsoluteUrl(href, base);
        if (url) add({ url, type: 'img', width: Math.round(r.width), height: Math.round(r.height), element: el }, r);
      } else if (tag === 'canvas') {
        const canvas = el as HTMLCanvasElement;
        try {
          const url = canvas.toDataURL('image/png');
          if (url.startsWith('data:image/png')) add({ url, type: 'canvas', width: canvas.width, height: canvas.height, element: el }, r);
        } catch {
          // Tainted by cross-origin content; skip.
        }
      } else if (tag === 'video') {
        const url = toAbsoluteUrl(el.getAttribute('poster'), base);
        if (url) add({ url, type: 'video', width: Math.round(r.width), height: Math.round(r.height), element: el }, r);
      }

      for (const url of extractBackgroundUrls(win.getComputedStyle(el).backgroundImage)) {
        const abs = toAbsoluteUrl(url, base);
        if (abs) add({ url: abs, type: 'background', width: Math.round(r.width), height: Math.round(r.height), element: el }, r);
      }
    }

    // ::before / ::after may carry an image even when the host box is tiny.
    for (const pseudo of ['::before', '::after']) {
      const pcs = win.getComputedStyle(el, pseudo);
      if (!pcs || pcs.content === 'none' || pcs.content === 'normal' || pcs.display === 'none') continue;
      const urls = [...extractBackgroundUrls(pcs.backgroundImage), ...extractCssUrls(pcs.content)];
      if (!urls.length) continue;
      const w = parseFloat(pcs.width) || r.width;
      const h = parseFloat(pcs.height) || r.height;
      if (w < minSize || h < minSize) continue;
      for (const url of urls) {
        const abs = toAbsoluteUrl(url, base);
        if (abs) add({ url: abs, type: 'background', width: Math.round(w), height: Math.round(h), element: el }, r);
      }
    }
  };

  // a) DOM scan. `picture > source` has no box; its srcset is folded into the sibling <img>.
  const root = doc.documentElement;
  if (root) {
    consider(root);
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (el.localName === 'source' || el.localName === 'script' || el.localName === 'style') continue;
      consider(el);
    }
  }

  // b) Grid sampling over the visible part of the rect.
  const vw = win.innerWidth || root?.clientWidth || 0;
  const vh = win.innerHeight || root?.clientHeight || 0;
  const vis = {
    left: Math.max(0, sel.left),
    top: Math.max(0, sel.top),
    right: Math.min(vw, sel.right),
    bottom: Math.min(vh, sel.bottom),
  };
  if (typeof doc.elementsFromPoint === 'function' && vis.right > vis.left && vis.bottom > vis.top) {
    let step = options.sampleStep ?? 20;
    const area = (vis.right - vis.left) * (vis.bottom - vis.top);
    if (area / (step * step) > MAX_SAMPLES) step = Math.ceil(Math.sqrt(area / MAX_SAMPLES));
    for (let y = vis.top + step / 2; y < vis.bottom; y += step) {
      for (let x = vis.left + step / 2; x < vis.right; x += step) {
        sampleAt(doc, x, y, consider);
      }
    }
  }

  const out = Array.from(byUrl.values());
  out.sort((a, b) => {
    const ra = rects.get(a)!;
    const rb = rects.get(b)!;
    return Math.round(ra.top) - Math.round(rb.top) || Math.round(ra.left) - Math.round(rb.left);
  });
  return out;
}

/** Revoke the `blob:` URLs created for inline SVGs. */
export function releaseDetectedImages(images: DetectedImage[]): void {
  for (const img of images) {
    if (img.type === 'svg' && img.url.startsWith('blob:')) URL.revokeObjectURL(img.url);
  }
}

function sampleAt(root: Document | ShadowRoot, x: number, y: number, consider: (el: Element) => void, depth = 0) {
  for (const hit of root.elementsFromPoint(x, y)) {
    const el = outermostSvgOf(hit) ?? hit;
    consider(el);
    // Pierce open shadow roots (custom elements), which the DOM scan cannot see.
    const sr = (hit as HTMLElement).shadowRoot;
    if (sr && sr !== root && depth < 8 && typeof sr.elementsFromPoint === 'function') {
      sampleAt(sr, x, y, consider, depth + 1);
    }
  }
}

function isSvgElement(el: Element): el is SVGElement {
  return el.namespaceURI === 'http://www.w3.org/2000/svg';
}

function isOutermostSvg(el: Element): boolean {
  return isSvgElement(el) && !(el as SVGSVGElement).ownerSVGElement;
}

/** An element inside an <svg> that isn't an <image> (those are real raster images). */
function isSvgPart(el: Element): boolean {
  return isSvgElement(el) && el.localName !== 'image' && !isOutermostSvg(el);
}

function outermostSvgOf(el: Element): Element | null {
  if (!isSvgElement(el) || el.localName === 'image') return null;
  let svg: SVGSVGElement | null = el.localName === 'svg' ? (el as SVGSVGElement) : (el as SVGElement).ownerSVGElement;
  while (svg?.ownerSVGElement) svg = svg.ownerSVGElement;
  return svg;
}

function serializeSvg(svg: SVGSVGElement, doc: Document, win: Window, r: DOMRect): string | null {
  try {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!clone.hasAttribute('xmlns:xlink')) clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    if (!clone.getAttribute('width')) clone.setAttribute('width', String(Math.round(r.width)));
    if (!clone.getAttribute('height')) clone.setAttribute('height', String(Math.round(r.height)));
    // `currentColor` would otherwise resolve to black once detached from the page.
    const color = win.getComputedStyle(svg).color;
    if (color) clone.style.color = color;

    // Inline sprite symbols referenced via <use href="#id"> so the file is self-contained.
    const defs = doc.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const copied = new Set<string>();
    for (const use of Array.from(clone.querySelectorAll('use'))) {
      const href = use.getAttribute('href') ?? use.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '';
      if (!href.startsWith('#')) continue;
      const id = href.slice(1);
      if (copied.has(id) || Array.from(clone.querySelectorAll('[id]')).some((n) => n.id === id)) continue;
      const target = doc.getElementById(id);
      if (target) {
        defs.appendChild(target.cloneNode(true));
        copied.add(id);
      }
    }
    if (defs.childNodes.length) clone.insertBefore(defs, clone.firstChild);

    return new ((win as Window & typeof globalThis).XMLSerializer)().serializeToString(clone);
  } catch {
    return null;
  }
}

function svgToUrl(markup: string): string {
  if (typeof URL.createObjectURL === 'function') {
    return URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}
