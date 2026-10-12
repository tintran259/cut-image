import { sniffExt } from '../../lib/fileNames';
import { alphaToGray, bleedTransparent, hasTransparency, unsharpMask } from '../../lib/imageOps';
import { cropPixels, isFullCrop, outputMime, planAiPasses, targetSize, type OutputSettings, type Size } from '../../lib/output';
import { upscale4x } from './upscaler';

type Canvas2D = OffscreenCanvasRenderingContext2D;

interface Decoded extends Size {
  source: CanvasImageSource;
  isVector: boolean;
  close(): void;
}

export interface ProcessProgress {
  stage: 'processing' | 'upscaling';
  /** 0–100 for the AI stage. */
  pct?: number;
}

export async function decode(bytes: Uint8Array, mime: string): Promise<Decoded> {
  const isSvg = mime.includes('svg') || sniffExt(bytes) === 'svg';
  const blob = new Blob([bytes as BlobPart], { type: isSvg ? 'image/svg+xml' : mime || '' });
  if (isSvg) {
    // createImageBitmap can't decode SVG; an <img> can, and draws it crisply at any size.
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error('Could not decode SVG');
    }
    return {
      source: img,
      width: img.naturalWidth || 300,
      height: img.naturalHeight || 150,
      isVector: true,
      close: () => URL.revokeObjectURL(url),
    };
  }
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    throw new Error('Unsupported or corrupt image');
  }
  return { source: bmp, width: bmp.width, height: bmp.height, isVector: false, close: () => bmp.close() };
}

export function canvas(w: number, h: number): [OffscreenCanvas, Canvas2D] {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return [c, ctx];
}

/**
 * High-quality resize. Large reductions are done in ≤2× steps, which avoids
 * the aliasing a single big drawImage step produces.
 */
function resize(src: CanvasImageSource, sw: number, sh: number, tw: number, th: number, vector = false): OffscreenCanvas {
  let cur: CanvasImageSource = src;
  let cw = sw;
  let ch = sh;
  if (!vector) {
    while (cw / 2 >= tw && ch / 2 >= th) {
      const [c, ctx] = canvas(Math.max(tw, Math.round(cw / 2)), Math.max(th, Math.round(ch / 2)));
      ctx.drawImage(cur, 0, 0, c.width, c.height);
      cur = c;
      cw = c.width;
      ch = c.height;
    }
  }
  const [out, ctx] = canvas(tw, th);
  ctx.drawImage(cur, 0, 0, tw, th);
  return out;
}

function fitLongSide(w: number, h: number, long: number): Size {
  const k = long / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/**
 * Run the planned ×4 AI passes on an opaque RGBA image. Each pass input is
 * first reduced to the planned size (bigger inputs would only be thrown away).
 */
async function upscaleAi(
  img: ImageData,
  passes: { inputLongSide: number }[],
  onFrac: (frac: number) => void,
  signal: AbortSignal,
): Promise<OffscreenCanvas> {
  let [cur, ctx] = canvas(img.width, img.height);
  ctx.putImageData(img, 0, 0);
  for (let p = 0; p < passes.length; p++) {
    const long = Math.min(passes[p].inputLongSide, Math.max(cur.width, cur.height));
    const inSize = fitLongSide(cur.width, cur.height, long);
    const input = inSize.width === cur.width && inSize.height === cur.height ? cur : resize(cur, cur.width, cur.height, inSize.width, inSize.height);
    const data = input.getContext('2d')!.getImageData(0, 0, input.width, input.height);
    const up = await upscale4x(data, (done, total) => onFrac((p + done / total) / passes.length), signal);
    [cur, ctx] = canvas(up.width, up.height);
    ctx.putImageData(up, 0, 0);
  }
  return cur;
}

interface Source extends Size {
  source: CanvasImageSource;
  isVector: boolean;
}

/**
 * Cut the crop region out of the decoded image. Raster images are cut at
 * native resolution; SVGs are rendered at the output scale first so the
 * cropped region stays sharp.
 */
function applyCrop(dec: Decoded, settings: OutputSettings, target: Size): Source {
  if (isFullCrop(settings.crop)) return dec;
  const r = cropPixels(dec, settings.crop);
  const k = dec.isVector ? Math.max(1, target.width / r.width, target.height / r.height) : 1;
  const [c, ctx] = canvas(Math.max(1, Math.round(r.width * k)), Math.max(1, Math.round(r.height * k)));
  ctx.drawImage(dec.source, -r.x * k, -r.y * k, dec.width * k, dec.height * k);
  return { source: c, width: c.width, height: c.height, isVector: false };
}

/** Decode → crop → (AI ×4 passes | HD sharpen) → resize → encode. */
export async function processImage(
  bytes: Uint8Array,
  mime: string,
  sourceExt: string | null,
  settings: OutputSettings,
  onProgress: (p: ProcessProgress) => void,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; mime: string; width: number; height: number }> {
  onProgress({ stage: 'processing' });
  const dec = await decode(bytes, mime);
  try {
    const target = targetSize(dec, settings);
    const src = applyCrop(dec, settings, target);
    let result: OffscreenCanvas;

    if (settings.enhance === 'ai4k') {
      const passes = planAiPasses(src);
      // Vector sources can simply be rendered at full size; no AI needed.
      if (src.isVector || passes.length === 0) {
        result = resize(src.source, src.width, src.height, target.width, target.height, src.isVector);
      } else {
        const base = resize(src.source, src.width, src.height, src.width, src.height);
        const px = base.getContext('2d')!.getImageData(0, 0, base.width, base.height);
        const transparent = hasTransparency(px.data);
        // Transparent images run twice: colour, then the alpha mask (so edges stay crisp too).
        const runs = transparent ? 2 : 1;
        const report = (run: number) => (frac: number) =>
          onProgress({ stage: 'upscaling', pct: Math.round(((run + frac) / runs) * 100) });

        if (transparent) bleedTransparent(px.data, px.width, px.height);
        const color = await upscaleAi(px, passes, report(0), signal);
        result = resize(color, color.width, color.height, target.width, target.height);

        if (transparent) {
          const mask = await upscaleAi(new ImageData(alphaToGray(px.data), px.width, px.height), passes, report(1), signal);
          const alpha = resize(mask, mask.width, mask.height, target.width, target.height).getContext('2d')!.getImageData(0, 0, target.width, target.height).data;
          const rctx = result.getContext('2d')!;
          const out = rctx.getImageData(0, 0, target.width, target.height);
          for (let i = 3; i < out.data.length; i += 4) out.data[i] = alpha[i - 3]; // R of the gray mask
          rctx.putImageData(out, 0, 0);
        }
      }
    } else {
      result = resize(src.source, src.width, src.height, target.width, target.height, src.isVector);
      if (settings.enhance === 'hd' && settings.sharpen > 0) {
        const ctx = result.getContext('2d')!;
        const px = ctx.getImageData(0, 0, result.width, result.height);
        unsharpMask(px.data, px.width, px.height, settings.sharpen);
        ctx.putImageData(px, 0, 0);
      }
    }

    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    onProgress({ stage: 'processing' }); // encoding a 4K PNG can take a moment
    const outMime = outputMime(settings.format, sourceExt);
    let final = result;
    if (outMime === 'image/jpeg') {
      // JPEG has no alpha: flatten onto white instead of black.
      const [c, ctx] = canvas(result.width, result.height);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(result, 0, 0);
      final = c;
    }
    const blob = await final.convertToBlob({ type: outMime, quality: outMime === 'image/png' ? undefined : settings.quality });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || outMime, width: final.width, height: final.height };
  } finally {
    dec.close();
  }
}

