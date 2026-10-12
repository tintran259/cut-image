/**
 * Per-image output settings (size, format, enhancement) and the pure math
 * shared by the panel (estimates) and the offscreen processor (actual output).
 */

export type OutputFormat = 'original' | 'png' | 'jpeg' | 'webp';
export type Enhance = 'none' | 'hd' | 'ai4k';
export type ResizeSpec = { kind: 'scale'; factor: number } | { kind: 'exact'; width: number; height: number };

/** Crop rectangle in fractions (0–1) of the source image, so it survives any source resolution. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OutputSettings {
  format: OutputFormat;
  /** 0.5–1, used for JPG / WebP. */
  quality: number;
  enhance: Enhance;
  /** Unsharp-mask strength for HD, 0–1. */
  sharpen: number;
  /** Ignored for `ai4k`, which always targets a 3840 px long side. */
  resize: ResizeSpec;
  /** Applied first, before resize / enhance. Undefined = whole image. */
  crop?: CropRect;
}

export const DEFAULT_OUTPUT: OutputSettings = {
  format: 'original',
  quality: 0.92,
  enhance: 'none',
  sharpen: 0.5,
  resize: { kind: 'scale', factor: 1 },
};

/** "4K" = 3840 px on the long side (UHD width). */
export const AI_TARGET_LONG_SIDE = 3840;
export const AI_SCALE = 4;
/** Chrome's canvas limits: 32767 px per side and ~268 MP; stay well below. */
export const MAX_SIDE = 16384;
export const MAX_PIXELS = 100_000_000;

export type EncodableMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface Size {
  width: number;
  height: number;
}

export function isFullCrop(c: CropRect | undefined): boolean {
  return !c || (c.x <= 0 && c.y <= 0 && c.w >= 1 && c.h >= 1);
}

export function isDefaultOutput(s: OutputSettings | undefined): boolean {
  if (!s) return true;
  return s.format === 'original' && s.enhance === 'none' && s.resize.kind === 'scale' && s.resize.factor === 1 && isFullCrop(s.crop);
}

/** Clamp a crop into the image and to a minimum size (in source pixels). */
export function normalizeCrop(c: CropRect, src: Size, minPx = 8): CropRect {
  const minW = Math.min(1, minPx / Math.max(1, src.width));
  const minH = Math.min(1, minPx / Math.max(1, src.height));
  const w = Math.min(1, Math.max(minW, c.w));
  const h = Math.min(1, Math.max(minH, c.h));
  const x = Math.min(1 - w, Math.max(0, c.x));
  const y = Math.min(1 - h, Math.max(0, c.y));
  return { x, y, w, h };
}

/** Crop in whole source pixels (what the processor actually cuts out). */
export function cropPixels(src: Size, c: CropRect | undefined): { x: number; y: number; width: number; height: number } {
  if (isFullCrop(c)) return { x: 0, y: 0, width: src.width, height: src.height };
  const x = Math.round(c!.x * src.width);
  const y = Math.round(c!.y * src.height);
  const width = Math.max(1, Math.min(src.width - x, Math.round(c!.w * src.width)));
  const height = Math.max(1, Math.min(src.height - y, Math.round(c!.h * src.height)));
  return { x, y, width, height };
}

/** Size of the image after cropping. */
export function croppedSize(src: Size, c: CropRect | undefined): Size {
  const r = cropPixels(src, c);
  return { width: r.width, height: r.height };
}

/**
 * Largest crop with pixel aspect `ratio` (w/h), centred on `around` (or the
 * image centre), inside the image.
 */
export function cropForAspect(src: Size, ratio: number, around?: CropRect): CropRect {
  const imgRatio = src.width / Math.max(1, src.height);
  // Fractions: (w * srcW) / (h * srcH) = ratio  →  w / h = ratio / imgRatio
  let w = 1;
  let h = imgRatio / ratio;
  if (h > 1) {
    h = 1;
    w = ratio / imgRatio;
  }
  const cx = around ? around.x + around.w / 2 : 0.5;
  const cy = around ? around.y + around.h / 2 : 0.5;
  return normalizeCrop({ x: cx - w / 2, y: cy - h / 2, w, h }, src);
}

/** Final pixel size for a source of `src` dimensions. */
export function targetSize(full: Size, s: OutputSettings): Size {
  const src = croppedSize(full, s.crop);
  const sw = Math.max(1, src.width);
  const sh = Math.max(1, src.height);
  let w: number;
  let h: number;
  if (s.enhance === 'ai4k') {
    const k = AI_TARGET_LONG_SIDE / Math.max(sw, sh);
    w = sw * k;
    h = sh * k;
  } else if (s.resize.kind === 'exact') {
    w = s.resize.width;
    h = s.resize.height;
  } else {
    w = sw * s.resize.factor;
    h = sh * s.resize.factor;
  }
  return clampSize(w, h);
}

/** Scale down (keeping aspect) to fit canvas limits; round to whole pixels. */
export function clampSize(w: number, h: number): Size {
  let k = 1;
  if (w > MAX_SIDE || h > MAX_SIDE) k = Math.min(MAX_SIDE / w, MAX_SIDE / h);
  if (w * k * h * k > MAX_PIXELS) k = Math.sqrt(MAX_PIXELS / (w * h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Whether the source bytes must be decoded and re-encoded. */
export function needsProcessing(s: OutputSettings | undefined, src: Size): boolean {
  if (!s || isDefaultOutput(s)) return false;
  if (s.format !== 'original' || s.enhance !== 'none' || !isFullCrop(s.crop)) return true;
  const t = targetSize(src, s);
  return t.width !== src.width || t.height !== src.height;
}

/** Encoder mime. "Original" keeps PNG/JPG/WebP; anything else (GIF, SVG, AVIF…) becomes PNG. */
export function outputMime(format: OutputFormat, sourceExt: string | null | undefined): EncodableMime {
  if (format === 'png') return 'image/png';
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  if (sourceExt === 'jpg' || sourceExt === 'jpeg') return 'image/jpeg';
  if (sourceExt === 'webp') return 'image/webp';
  return 'image/png';
}

export function mimeLabel(mime: EncodableMime): string {
  return mime === 'image/jpeg' ? 'JPG' : mime === 'image/webp' ? 'WEBP' : 'PNG';
}

/**
 * Copy settings to another image. An exact size is converted to a scale
 * factor so differently-sized images keep their own aspect ratio.
 */
export function adaptSettings(s: OutputSettings, from: Size, _to: Size): OutputSettings {
  // A crop is specific to one picture's content, so it isn't copied.
  const { crop: _crop, ...rest } = s;
  if (rest.resize.kind !== 'exact') return { ...rest };
  return { ...rest, resize: { kind: 'scale', factor: rest.resize.width / Math.max(1, croppedSize(from, s.crop).width) } };
}

/**
 * Plan the AI passes: each pass is ×4 and its input is capped at target/4 on
 * the long side (larger inputs would just be downscaled again afterwards).
 * Small sources get a second pass so they actually reach ~4K.
 */
export function planAiPasses(src: Size, maxPasses = 2): { inputLongSide: number }[] {
  const target = AI_TARGET_LONG_SIDE;
  const cap = Math.ceil(target / AI_SCALE);
  const passes: { inputLongSide: number }[] = [];
  let cur = Math.max(src.width, src.height);
  // First pass whenever we're below target; another only if we're still under half of it
  // (the final resize handles anything up to 2× well, and each pass costs as much as the first).
  while (passes.length < maxPasses && (passes.length === 0 ? cur < target : cur * 2 < target)) {
    const input = Math.min(cur, cap);
    passes.push({ inputLongSide: input });
    cur = input * AI_SCALE;
  }
  return passes;
}
