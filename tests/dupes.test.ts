import { describe, expect, it } from 'vitest';
import { dHash, findDuplicateGroups, hamming, HASH_H, HASH_W, isSimilar, normalizeUrlKey, THUMB, thumbDistance, type Fingerprint } from '../lib/dupes';

function gray(fn: (x: number, y: number) => number) {
  const out: number[] = [];
  for (let y = 0; y < HASH_H; y++) for (let x = 0; x < HASH_W; x++) out.push(fn(x, y));
  return out;
}

const FLAT = Array(THUMB * THUMB * 3).fill(120);
const fp = (hash: string, aspect = 1.5, color: [number, number, number] = [120, 120, 120], thumb = FLAT): Fingerprint => ({ hash, aspect, color, thumb });

/**
 * Synthetic "store template" thumbnail: white background, red corner banner,
 * orange promo box on the right, and a product blob in the middle.
 */
function templated(product: [number, number, number], jitter = 0): number[] {
  const out: number[] = [];
  for (let y = 0; y < THUMB; y++)
    for (let x = 0; x < THUMB; x++) {
      let c: [number, number, number] = [255, 255, 255];
      if (x < 4 && y < 3) c = [200, 30, 30];
      else if (x >= 12 && y >= 4 && y < 12) c = [240, 120, 40];
      else if (x >= 4 && x < 10 && y >= 5 && y < 12) c = product;
      const n = jitter ? (((x * 7 + y * 13) % 5) - 2) * (jitter / 2) : 0;
      out.push(...c.map((v) => Math.max(0, Math.min(255, v + n))));
    }
  return out;
}
const meanColor = (t: number[]): [number, number, number] => {
  const s = [0, 0, 0];
  for (let i = 0; i < t.length; i += 3) for (let c = 0; c < 3; c++) s[c] += t[i + c];
  return s.map((v) => v / (t.length / 3)) as [number, number, number];
};
const tfp = (t: number[]) => fp('ff00ff00ff00ff00', 1, meanColor(t), t);

describe('dHash / hamming', () => {
  it('encodes left>right comparisons as 64 bits', () => {
    expect(dHash(gray((x) => 100 - x))).toBe('ffffffffffffffff'); // always decreasing
    expect(dHash(gray((x) => x))).toBe('0000000000000000'); // always increasing
    expect(dHash(gray(() => 50))).toBe('0000000000000000');
  });

  it('is stable under small brightness noise', () => {
    const base = gray((x, y) => ((x * 37 + y * 91) % 200) + 20);
    const noisy = base.map((v, i) => v + ((i * 7) % 3) - 1);
    expect(hamming(dHash(base), dHash(noisy))).toBeLessThanOrEqual(6);
  });

  it('counts differing bits', () => {
    expect(hamming('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hamming('00000000000000ff', '0000000000000000')).toBe(8);
    expect(hamming('abcdef0123456789', 'abcdef0123456789')).toBe(0);
  });
});

describe('isSimilar', () => {
  it('matches near-identical fingerprints', () => {
    expect(isSimilar(fp('f0f0f0f0f0f0f0f0'), fp('f0f0f0f0f0f0f0f1'))).toBe(true);
  });

  it('rejects different aspect ratios or colours even with equal hashes', () => {
    expect(isSimilar(fp('0000000000000000', 1.5), fp('0000000000000000', 1))).toBe(false);
    expect(isSimilar(fp('0000000000000000', 1, [255, 0, 0]), fp('0000000000000000', 1, [0, 0, 255]))).toBe(false);
  });

  it('rejects hashes that differ too much', () => {
    expect(isSimilar(fp('0000000000000000'), fp('ffffffff00000000'))).toBe(false);
  });

  it('tells apart different products in the same store template', () => {
    const wallet = templated([110, 60, 30]); // brown
    const bag = templated([30, 30, 30]); // black
    const tan = templated([170, 120, 80]); // light brown
    expect(isSimilar(tfp(wallet), tfp(bag))).toBe(false);
    expect(isSimilar(tfp(wallet), tfp(tan))).toBe(false);
    expect(thumbDistance(wallet, bag).max).toBeGreaterThan(60);
  });

  it('still matches a resized / recompressed copy of the same image', () => {
    const wallet = templated([110, 60, 30]);
    const copy = templated([110, 60, 30], 6); // ±6 noise ≈ JPEG + resampling error
    expect(isSimilar(tfp(wallet), tfp(copy))).toBe(true);
  });
});

describe('normalizeUrlKey', () => {
  const same = (a: string, b: string) => expect(normalizeUrlKey(a)).toBe(normalizeUrlKey(b));
  const diff = (a: string, b: string) => expect(normalizeUrlKey(a)).not.toBe(normalizeUrlKey(b));

  it('ignores CDN size / format / quality params', () => {
    same('https://images.x.com/p/abc.jpg?w=400&q=80', 'https://images.x.com/p/abc.jpg?w=1600&fm=webp');
    same('https://x.com/a.jpg?width=300&id=7', 'https://x.com/a.jpg?id=7&width=900');
  });

  it('strips path size suffixes and extensions', () => {
    same('https://blog.x.com/wp-content/uploads/cat-300x200.jpg', 'https://blog.x.com/wp-content/uploads/cat.jpg');
    same('https://x.com/img/logo@2x.png', 'https://x.com/img/logo.png');
    same('https://x.com/a/photo_thumb.webp', 'https://www.x.com/a/photo.jpg');
    same('https://res.cloudinary.com/demo/image/upload/w_400,h_300,c_fill/sample.jpg', 'https://res.cloudinary.com/demo/image/upload/sample.jpg');
    same('https://lh3.googleusercontent.com/abc=s400', 'https://lh3.googleusercontent.com/abc=w1200-h800-c');
  });

  it('keeps genuinely different images apart', () => {
    diff('https://x.com/a.jpg', 'https://x.com/b.jpg');
    diff('https://x.com/a.jpg?id=1', 'https://x.com/a.jpg?id=2');
    diff('https://x.com/a.jpg', 'https://y.com/a.jpg');
  });
});

describe('findDuplicateGroups', () => {
  it('does not chain loosely similar images into one group', () => {
    const shade = (v: number) => tfp(templated([v, v, v]));
    // Each neighbour differs by 24 (≤ 32 allowed), but the ends differ by 48.
    const groups = findDuplicateGroups([
      { id: 1, url: 'a', fp: shade(100), area: 300 },
      { id: 2, url: 'b', fp: shade(124), area: 200 },
      { id: 3, url: 'c', fp: shade(148), area: 100 },
    ]);
    expect(groups.flat()).not.toEqual(expect.arrayContaining([1, 3]));
    expect(groups).toEqual([[1, 2]]);
  });

  it('groups by fingerprint and puts the largest copy first', () => {
    const groups = findDuplicateGroups([
      { id: 10, url: 'https://x/a-small.jpg', fp: fp('ff00ff00ff00ff00'), area: 100 },
      { id: 11, url: 'https://x/other.jpg', fp: fp('0123456789abcdef'), area: 500 },
      { id: 12, url: 'https://cdn/a-big.webp', fp: fp('ff00ff00ff00ff01'), area: 900 },
      { id: 13, url: 'https://x/a-mid.png', fp: fp('ff00ff00ff00ff03'), area: 400 },
    ]);
    expect(groups).toEqual([[12, 13, 10]]);
  });

  it('falls back to URL keys when a fingerprint is missing', () => {
    const groups = findDuplicateGroups([
      { id: 1, url: 'https://x.com/p.jpg?w=200', area: 40_000 },
      { id: 2, url: 'https://x.com/p.jpg?w=800', fp: fp('1111111111111111'), area: 640_000 },
      { id: 3, url: 'https://x.com/q.jpg?w=800', area: 640_000 },
    ]);
    expect(groups).toEqual([[2, 1]]);
  });

  it('returns nothing when all images are distinct', () => {
    expect(findDuplicateGroups([{ id: 1, url: 'a', area: 1 }, { id: 2, url: 'b', area: 1 }])).toEqual([]);
  });
});
