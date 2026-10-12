import { describe, expect, it } from 'vitest';
import { computeTiles, unsharpMask } from '../lib/imageOps';
import {
  adaptSettings,
  clampSize,
  DEFAULT_OUTPUT,
  isDefaultOutput,
  MAX_SIDE,
  needsProcessing,
  outputMime,
  planAiPasses,
  targetSize,
  type OutputSettings,
} from '../lib/output';

const S = (patch: Partial<OutputSettings>): OutputSettings => ({ ...DEFAULT_OUTPUT, ...patch });

describe('targetSize', () => {
  it('scales by factor', () => {
    expect(targetSize({ width: 1200, height: 800 }, S({ resize: { kind: 'scale', factor: 0.5 } }))).toEqual({ width: 600, height: 400 });
    expect(targetSize({ width: 333, height: 111 }, S({ resize: { kind: 'scale', factor: 2 } }))).toEqual({ width: 666, height: 222 });
  });

  it('uses exact sizes as given', () => {
    expect(targetSize({ width: 1200, height: 800 }, S({ resize: { kind: 'exact', width: 500, height: 500 } }))).toEqual({ width: 500, height: 500 });
  });

  it('targets a 3840 px long side for 4K AI, regardless of resize', () => {
    expect(targetSize({ width: 1000, height: 500 }, S({ enhance: 'ai4k', resize: { kind: 'scale', factor: 0.5 } }))).toEqual({ width: 3840, height: 1920 });
    expect(targetSize({ width: 300, height: 600 }, S({ enhance: 'ai4k' }))).toEqual({ width: 1920, height: 3840 });
  });

  it('clamps to canvas limits keeping the aspect ratio', () => {
    const t = clampSize(40000, 20000);
    expect(t.width).toBeLessThanOrEqual(MAX_SIDE);
    expect(t.width / t.height).toBeCloseTo(2, 2);
    expect(clampSize(0.2, 0.2)).toEqual({ width: 1, height: 1 });
  });
});

describe('processing decisions', () => {
  it('detects default settings', () => {
    expect(isDefaultOutput(undefined)).toBe(true);
    expect(isDefaultOutput(DEFAULT_OUTPUT)).toBe(true);
    expect(isDefaultOutput(S({ format: 'png' }))).toBe(false);
  });

  it('skips processing when nothing changes', () => {
    const src = { width: 400, height: 300 };
    expect(needsProcessing(undefined, src)).toBe(false);
    expect(needsProcessing(S({ resize: { kind: 'exact', width: 400, height: 300 } }), src)).toBe(false);
    expect(needsProcessing(S({ resize: { kind: 'exact', width: 200, height: 150 } }), src)).toBe(true);
    expect(needsProcessing(S({ enhance: 'hd' }), src)).toBe(true);
  });

  it('picks the encoder; "original" falls back to PNG for formats canvas cannot write', () => {
    expect(outputMime('webp', 'jpg')).toBe('image/webp');
    expect(outputMime('original', 'jpg')).toBe('image/jpeg');
    expect(outputMime('original', 'webp')).toBe('image/webp');
    expect(outputMime('original', 'gif')).toBe('image/png');
    expect(outputMime('original', 'svg')).toBe('image/png');
    expect(outputMime('original', null)).toBe('image/png');
  });

  it('converts exact sizes to a factor when applying to other images', () => {
    const s = S({ format: 'webp', resize: { kind: 'exact', width: 600, height: 400 } });
    const adapted = adaptSettings(s, { width: 1200, height: 800 }, { width: 500, height: 900 });
    expect(adapted).toMatchObject({ format: 'webp', resize: { kind: 'scale', factor: 0.5 } });
    expect(targetSize({ width: 500, height: 900 }, adapted)).toEqual({ width: 250, height: 450 });
  });
});

describe('planAiPasses', () => {
  it('caps input at target/4 and uses one pass for medium images', () => {
    expect(planAiPasses({ width: 2000, height: 1000 })).toEqual([{ inputLongSide: 960 }]);
    expect(planAiPasses({ width: 800, height: 600 })).toEqual([{ inputLongSide: 800 }]);
  });

  it('adds a second pass for small images', () => {
    expect(planAiPasses({ width: 200, height: 100 })).toEqual([{ inputLongSide: 200 }, { inputLongSide: 800 }]);
  });

  it('needs no pass when already 4K', () => {
    expect(planAiPasses({ width: 4000, height: 3000 })).toEqual([]);
  });
});

describe('computeTiles', () => {
  function coverage(w: number, h: number, tile: number, overlap: number) {
    const hits = new Uint8Array(w * h);
    for (const t of computeTiles(w, h, tile, overlap)) {
      // Writes must stay inside the tile, away from inner edges.
      expect(t.x0).toBeGreaterThanOrEqual(t.x);
      expect(t.x1).toBeLessThanOrEqual(t.x + tile);
      expect(t.y0).toBeGreaterThanOrEqual(t.y);
      expect(t.y1).toBeLessThanOrEqual(t.y + tile);
      if (t.x0 > 0) expect(t.x0 - t.x).toBeGreaterThanOrEqual(overlap);
      if (t.x1 < w) expect(t.x + tile - t.x1).toBeGreaterThanOrEqual(overlap);
      for (let y = t.y0; y < t.y1; y++) for (let x = t.x0; x < t.x1; x++) hits[y * w + x]++;
    }
    return hits;
  }

  it.each([
    [100, 80],
    [192, 192],
    [193, 500],
    [960, 540],
    [1001, 37],
  ])('covers %ix%i exactly once', (w, h) => {
    expect(coverage(w, h, 192, 12).every((n) => n === 1)).toBe(true);
  });

  it('uses a single tile for images smaller than a tile', () => {
    expect(computeTiles(50, 40, 192, 12)).toEqual([{ x: 0, y: 0, x0: 0, x1: 50, y0: 0, y1: 40 }]);
  });
});

describe('unsharpMask', () => {
  it('increases contrast at edges and leaves flat areas alone', () => {
    const w = 8;
    const h = 3;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = x < 4 ? 100 : 160;
        data.set([v, v, v, 200], (y * w + x) * 4);
      }
    unsharpMask(data, w, h, 1);
    const at = (x: number) => data[(1 * w + x) * 4];
    expect(at(3)).toBeLessThan(100); // dark side of the edge gets darker
    expect(at(4)).toBeGreaterThan(160); // bright side gets brighter
    expect(at(0)).toBe(100); // flat area unchanged
    expect(data[(1 * w + 3) * 4 + 3]).toBe(200); // alpha untouched
  });

  it('is a no-op at strength 0', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 255, 200, 200, 200, 255, 10, 20, 30, 255].concat(Array(24).fill(0)));
    const copy = data.slice();
    unsharpMask(data, 3, 3, 0);
    expect(data).toEqual(copy);
  });
});

describe('transparency helpers', () => {
  it('bleeds edge colour into transparent pixels without touching alpha', async () => {
    const { bleedTransparent, alphaToGray } = await import('../lib/imageOps');
    // 3×1: red opaque | transparent black | transparent black
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
    bleedTransparent(data, 3, 1);
    expect(Array.from(data)).toEqual([255, 0, 0, 255, 255, 0, 0, 0, 255, 0, 0, 0]);
    expect(Array.from(alphaToGray(new Uint8ClampedArray([9, 9, 9, 128])))).toEqual([128, 128, 128, 255]);
  });
});

describe('crop', async () => {
  const { cropForAspect, cropPixels, croppedSize, normalizeCrop, isFullCrop } = await import('../lib/output');
  const src = { width: 1200, height: 800 };

  it('computes the output size from the cropped region', () => {
    const s = S({ crop: { x: 0.25, y: 0, w: 0.5, h: 0.5 }, resize: { kind: 'scale', factor: 2 } });
    expect(croppedSize(src, s.crop)).toEqual({ width: 600, height: 400 });
    expect(targetSize(src, s)).toEqual({ width: 1200, height: 800 });
    expect(targetSize(src, S({ crop: { x: 0, y: 0, w: 0.5, h: 1 }, enhance: 'ai4k' }))).toEqual({ width: 2880, height: 3840 });
  });

  it('marks cropping as a change that needs processing', () => {
    expect(isDefaultOutput(S({ crop: { x: 0, y: 0, w: 1, h: 1 } }))).toBe(true);
    expect(isDefaultOutput(S({ crop: { x: 0.1, y: 0, w: 0.9, h: 1 } }))).toBe(false);
    expect(needsProcessing(S({ crop: { x: 0.1, y: 0, w: 0.9, h: 1 } }), src)).toBe(true);
    expect(isFullCrop(undefined)).toBe(true);
  });

  it('converts to whole pixels inside the image', () => {
    expect(cropPixels(src, { x: 0.1, y: 0.25, w: 0.5, h: 0.5 })).toEqual({ x: 120, y: 200, width: 600, height: 400 });
    expect(cropPixels(src, { x: 0.999, y: 0, w: 0.5, h: 1 })).toEqual({ x: 1199, y: 0, width: 1, height: 800 });
  });

  it('clamps crops into the image with a minimum size', () => {
    expect(normalizeCrop({ x: -0.2, y: 0.9, w: 0.5, h: 0.5 }, src)).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    const tiny = normalizeCrop({ x: 0.5, y: 0.5, w: 0, h: 0 }, src);
    expect(tiny.w * src.width).toBeCloseTo(8);
    expect(tiny.h * src.height).toBeCloseTo(8);
  });

  it('builds the largest centred crop for an aspect ratio', () => {
    const sq = cropForAspect(src, 1);
    expect(croppedSize(src, sq)).toEqual({ width: 800, height: 800 });
    expect(sq.x).toBeCloseTo(1 / 6);
    const wide = cropForAspect(src, 16 / 9);
    expect(croppedSize(src, wide)).toEqual({ width: 1200, height: 675 });
    const tall = cropForAspect({ width: 800, height: 1200 }, 16 / 9);
    expect(croppedSize({ width: 800, height: 1200 }, tall)).toEqual({ width: 800, height: 450 });
  });

  it('does not copy the crop to other images', () => {
    const s = S({ format: 'png', crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, resize: { kind: 'exact', width: 300, height: 200 } });
    const a = adaptSettings(s, src, { width: 500, height: 500 });
    expect(a.crop).toBeUndefined();
    expect(a.resize).toEqual({ kind: 'scale', factor: 0.5 }); // 300 / 600 cropped px
  });
});
