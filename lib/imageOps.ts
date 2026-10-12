/** Pure pixel operations on RGBA buffers (no canvas), so they can be unit-tested. */

/**
 * Unsharp mask on RGB (alpha untouched): out = src + amount * (src - blur).
 * Blur is a separable 5-tap binomial kernel [1 4 6 4 1] / 16 (≈ Gaussian σ≈1).
 * `strength` 0–1 maps to an amount of 0–1.5; differences below `threshold`
 * are left alone so flat areas and noise don't get amplified.
 */
export function unsharpMask(data: Uint8ClampedArray, width: number, height: number, strength: number, threshold = 3): void {
  const amount = Math.max(0, Math.min(1, strength)) * 1.5;
  if (amount === 0 || width < 3 || height < 3) return;
  const n = width * height;
  const tmp = new Float32Array(n * 3);
  const blur = new Float32Array(n * 3);
  const k = [1, 4, 6, 4, 1];

  // Horizontal pass: data -> tmp
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let i = -2; i <= 2; i++) {
        const xx = Math.min(width - 1, Math.max(0, x + i));
        const p = (y * width + xx) * 4;
        const w = k[i + 2];
        r += data[p] * w;
        g += data[p + 1] * w;
        b += data[p + 2] * w;
      }
      const o = (y * width + x) * 3;
      tmp[o] = r / 16;
      tmp[o + 1] = g / 16;
      tmp[o + 2] = b / 16;
    }
  }
  // Vertical pass: tmp -> blur
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let i = -2; i <= 2; i++) {
        const yy = Math.min(height - 1, Math.max(0, y + i));
        const p = (yy * width + x) * 3;
        const w = k[i + 2];
        r += tmp[p] * w;
        g += tmp[p + 1] * w;
        b += tmp[p + 2] * w;
      }
      const o = (y * width + x) * 3;
      blur[o] = r / 16;
      blur[o + 1] = g / 16;
      blur[o + 2] = b / 16;
    }
  }
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = data[i * 4 + c];
      const diff = v - blur[i * 3 + c];
      if (Math.abs(diff) >= threshold) data[i * 4 + c] = v + amount * diff; // Uint8ClampedArray clamps
    }
  }
}

export interface Tile {
  /** Top-left of the input tile (may extend past the image; pixels are edge-clamped). */
  x: number;
  y: number;
  /** Region of the input this tile is responsible for writing: [x0, x1) × [y0, y1). */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function axisPositions(len: number, tile: number, overlap: number): number[] {
  if (len <= tile) return [0];
  const stride = tile - 2 * overlap;
  const out: number[] = [];
  for (let p = 0; ; p += stride) {
    if (p + tile >= len) {
      out.push(len - tile);
      break;
    }
    out.push(p);
  }
  return out;
}

/**
 * Cover a width×height image with fixed-size tiles that overlap by
 * `overlap` px on inner edges. Each tile writes only its inner region so
 * seams (where the model lacks context) are discarded.
 */
export function computeTiles(width: number, height: number, tile: number, overlap: number): Tile[] {
  const xs = axisPositions(width, tile, overlap);
  const ys = axisPositions(height, tile, overlap);
  const regions = (ps: number[], len: number) =>
    ps.map((p, i) => {
      const start = i === 0 ? 0 : Math.max(p + overlap, 0);
      // End where the next tile starts writing, so regions never overlap.
      const end = i === ps.length - 1 ? len : ps[i + 1] + overlap;
      return [start, Math.min(end, len)] as const;
    });
  const rx = regions(xs, width);
  const ry = regions(ys, height);
  const tiles: Tile[] = [];
  ys.forEach((y, j) =>
    xs.forEach((x, i) => {
      tiles.push({ x, y, x0: rx[i][0], x1: rx[i][1], y0: ry[j][0], y1: ry[j][1] });
    }),
  );
  return tiles;
}

/** Copy a tile from RGBA into a planar float32 CHW tensor in [0, 1], edge-clamped. */
export function rgbaToChwTile(src: Uint8ClampedArray, width: number, height: number, tx: number, ty: number, tile: number, out: Float32Array): void {
  const plane = tile * tile;
  for (let y = 0; y < tile; y++) {
    const sy = Math.min(height - 1, Math.max(0, ty + y));
    for (let x = 0; x < tile; x++) {
      const sx = Math.min(width - 1, Math.max(0, tx + x));
      const p = (sy * width + sx) * 4;
      const o = y * tile + x;
      out[o] = src[p] / 255;
      out[plane + o] = src[p + 1] / 255;
      out[2 * plane + o] = src[p + 2] / 255;
    }
  }
}

/**
 * Write the responsible region of a model output (CHW, `tile*scale` square)
 * into the RGBA destination (`width*scale` × `height*scale`). Alpha is set to 255.
 */
export function writeChwTile(out: Float32Array, t: Tile, tile: number, scale: number, dst: Uint8ClampedArray, dstWidth: number): void {
  const ot = tile * scale;
  const plane = ot * ot;
  for (let y = t.y0 * scale; y < t.y1 * scale; y++) {
    const ly = y - t.y * scale;
    for (let x = t.x0 * scale; x < t.x1 * scale; x++) {
      const lx = x - t.x * scale;
      const o = ly * ot + lx;
      const p = (y * dstWidth + x) * 4;
      dst[p] = out[o] * 255 + 0.5;
      dst[p + 1] = out[plane + o] * 255 + 0.5;
      dst[p + 2] = out[2 * plane + o] * 255 + 0.5;
      dst[p + 3] = 255;
    }
  }
}

export function hasTransparency(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

/**
 * Spread colour from visible pixels into fully transparent ones (in place,
 * `passes` pixels deep). Transparent pixels are usually stored as black, which
 * an upscaler would otherwise smear into a dark fringe around edges.
 */
export function bleedTransparent(data: Uint8ClampedArray, width: number, height: number, passes = 6): void {
  const n = width * height;
  let known = new Uint8Array(n);
  for (let i = 0; i < n; i++) known[i] = data[i * 4 + 3] > 0 ? 1 : 0;
  for (let pass = 0; pass < passes; pass++) {
    const next = known.slice();
    let changed = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (known[i]) continue;
        let r = 0, g = 0, b = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width || (dx === 0 && dy === 0)) continue;
            const j = yy * width + xx;
            if (!known[j]) continue;
            r += data[j * 4];
            g += data[j * 4 + 1];
            b += data[j * 4 + 2];
            c++;
          }
        }
        if (c) {
          data[i * 4] = r / c;
          data[i * 4 + 1] = g / c;
          data[i * 4 + 2] = b / c;
          next[i] = 1;
          changed = true;
        }
      }
    }
    known = next;
    if (!changed) break;
  }
}

/** Copy the alpha channel into R, G and B with alpha 255 (so an RGB model can upscale it). */
export function alphaToGray(data: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    out[i] = out[i + 1] = out[i + 2] = a;
    out[i + 3] = 255;
  }
  return out;
}
