import { describe, expect, it } from 'vitest';
import {
  extractBackgroundUrls,
  extractCssUrls,
  isPlaceholderUrl,
  parseSrcset,
  pickLargestFromSrcset,
  resolveImageUrl,
  splitTopLevelCommas,
  toAbsoluteUrl,
  unescapeCss,
} from '../lib/resolveUrl';

const BASE = 'https://example.com/gallery/page.html';

function fakeImg(attrs: Record<string, string>, extra: { currentSrc?: string } = {}) {
  return { getAttribute: (n: string) => attrs[n] ?? null, currentSrc: extra.currentSrc ?? '' };
}

describe('parseSrcset', () => {
  it('parses width descriptors', () => {
    expect(parseSrcset('a.jpg 320w, b.jpg 640w, c.jpg 1280w')).toEqual([
      { url: 'a.jpg', w: 320 },
      { url: 'b.jpg', w: 640 },
      { url: 'c.jpg', w: 1280 },
    ]);
  });

  it('parses density descriptors and defaults to 1x', () => {
    expect(parseSrcset('a.jpg, b.jpg 2x, c.jpg 1.5x')).toEqual([
      { url: 'a.jpg', x: 1 },
      { url: 'b.jpg', x: 2 },
      { url: 'c.jpg', x: 1.5 },
    ]);
  });

  it('keeps commas that are part of the URL (Cloudinary-style)', () => {
    const s = 'https://res.cloudinary.com/demo/image/upload/w_400,c_fill/cat.jpg 400w, https://res.cloudinary.com/demo/image/upload/w_800,c_fill/cat.jpg 800w';
    expect(parseSrcset(s).map((c) => c.url)).toEqual([
      'https://res.cloudinary.com/demo/image/upload/w_400,c_fill/cat.jpg',
      'https://res.cloudinary.com/demo/image/upload/w_800,c_fill/cat.jpg',
    ]);
  });

  it('handles irregular whitespace, newlines and trailing commas', () => {
    expect(parseSrcset('\n  a.jpg   100w ,\n\tb.jpg 200w,,  ')).toEqual([
      { url: 'a.jpg', w: 100 },
      { url: 'b.jpg', w: 200 },
    ]);
  });

  it('treats a URL ending in a comma as descriptor-less (spec tokenizer)', () => {
    expect(parseSrcset('a.jpg, b.jpg 2x')).toEqual([
      { url: 'a.jpg', x: 1 },
      { url: 'b.jpg', x: 2 },
    ]);
    // Without whitespace the comma is part of the URL, as in browsers.
    expect(parseSrcset('a.jpg,b.jpg 2x')).toEqual([{ url: 'a.jpg,b.jpg', x: 2 }]);
  });

  it('drops candidates with invalid descriptors', () => {
    expect(parseSrcset('a.jpg foo, b.jpg 300w')).toEqual([{ url: 'b.jpg', w: 300 }]);
  });

  it('keeps data: URLs intact', () => {
    expect(parseSrcset('data:image/png;base64,iVBORw0KGgo= 1x')).toEqual([{ url: 'data:image/png;base64,iVBORw0KGgo=', x: 1 }]);
  });

  it('returns [] for empty input', () => {
    expect(parseSrcset('')).toEqual([]);
    expect(parseSrcset(null)).toEqual([]);
    expect(parseSrcset('  ,  ')).toEqual([]);
  });
});

describe('pickLargestFromSrcset', () => {
  it('picks the widest w candidate regardless of order', () => {
    expect(pickLargestFromSrcset('m.jpg 800w, xl.jpg 2400w, s.jpg 320w')).toBe('xl.jpg');
  });

  it('picks the highest density when only x descriptors exist', () => {
    expect(pickLargestFromSrcset('a.jpg, b.jpg 3x, c.jpg 2x')).toBe('b.jpg');
  });

  it('prefers w descriptors over x descriptors', () => {
    expect(pickLargestFromSrcset('dense.jpg 3x, wide.jpg 1000w')).toBe('wide.jpg');
  });

  it('returns null when there is nothing to pick', () => {
    expect(pickLargestFromSrcset('')).toBeNull();
  });
});

describe('extractCssUrls', () => {
  it('handles double-quoted, single-quoted and unquoted urls', () => {
    expect(extractCssUrls(`url("a.png"), url('b.png'), url(c.png)`)).toEqual(['a.png', 'b.png', 'c.png']);
  });

  it('handles whitespace inside url()', () => {
    expect(extractCssUrls('url(  "a b.png"  )')).toEqual(['a b.png']);
  });

  it('unescapes quotes, parentheses and hex escapes', () => {
    expect(extractCssUrls('url("a\\"b.png")')).toEqual(['a"b.png']);
    expect(extractCssUrls('url(a\\(1\\).png)')).toEqual(['a(1).png']);
    expect(extractCssUrls('url("x.png?a=1\\26 b=2")')).toEqual(['x.png?a=1&b=2']);
  });

  it('keeps data: URLs with commas and semicolons', () => {
    const data = 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E';
    expect(extractCssUrls(`url("${data}")`)).toEqual([data]);
  });

  it('is case-insensitive and ignores none/empty', () => {
    expect(extractCssUrls('URL(a.png)')).toEqual(['a.png']);
    expect(extractCssUrls('none')).toEqual([]);
    expect(extractCssUrls('')).toEqual([]);
    expect(extractCssUrls('url("")')).toEqual([]);
  });
});

describe('extractBackgroundUrls', () => {
  it('returns one URL per layer and skips gradients', () => {
    expect(
      extractBackgroundUrls('linear-gradient(rgba(0, 0, 0, 0.5), rgb(0, 0, 0)), url("https://cdn.x/hero.jpg"), url("https://cdn.x/tex.png")'),
    ).toEqual(['https://cdn.x/hero.jpg', 'https://cdn.x/tex.png']);
  });

  it('returns [] for pure gradients and none', () => {
    expect(extractBackgroundUrls('radial-gradient(circle, red, blue)')).toEqual([]);
    expect(extractBackgroundUrls('none')).toEqual([]);
  });

  it('picks the highest-density candidate from image-set()', () => {
    expect(extractBackgroundUrls('image-set(url("a-1x.jpg") 1x, url("a-2x.jpg") 2x)')).toEqual(['a-2x.jpg']);
    expect(extractBackgroundUrls('-webkit-image-set(url(a-2x.jpg) 2x, url(a-1x.jpg) 1x)')).toEqual(['a-2x.jpg']);
    expect(extractBackgroundUrls('image-set("a.avif" type("image/avif") 1x, "a@3x.avif" 3dppx)')).toEqual(['a@3x.avif']);
  });

  it('does not split on commas inside quoted URLs', () => {
    expect(extractBackgroundUrls('url("https://cdn.x/w_400,h_300/a.jpg"), url(b.jpg)')).toEqual(['https://cdn.x/w_400,h_300/a.jpg', 'b.jpg']);
  });
});

describe('splitTopLevelCommas / unescapeCss', () => {
  it('splits only at depth 0 outside quotes', () => {
    expect(splitTopLevelCommas('a(b, c), "d, e", f')).toEqual(['a(b, c)', '"d, e"', 'f']);
  });

  it('decodes hex escapes, consuming one trailing space', () => {
    expect(unescapeCss('\\41 B')).toBe('AB');
    expect(unescapeCss('\\1F600')).toBe('😀');
  });
});

describe('toAbsoluteUrl / isPlaceholderUrl', () => {
  it('resolves relative paths against the base', () => {
    expect(toAbsoluteUrl('../img/a.png', BASE)).toBe('https://example.com/img/a.png');
    expect(toAbsoluteUrl('//cdn.example.com/a.png', BASE)).toBe('https://cdn.example.com/a.png');
  });

  it('rejects fragments, javascript: and garbage', () => {
    expect(toAbsoluteUrl('#icon', BASE)).toBeNull();
    expect(toAbsoluteUrl('javascript:alert(1)', BASE)).toBeNull();
    expect(toAbsoluteUrl('', BASE)).toBeNull();
  });

  it('flags tiny inline placeholders', () => {
    expect(isPlaceholderUrl('data:image/gif;base64,R0lGODlhAQABAAAAACw=')).toBe(true);
    expect(isPlaceholderUrl('')).toBe(true);
    expect(isPlaceholderUrl('https://x/a.jpg')).toBe(false);
  });
});

describe('resolveImageUrl', () => {
  it('prefers the largest srcset candidate over currentSrc', () => {
    const img = fakeImg({ src: 'small.jpg', srcset: 'small.jpg 400w, big.jpg 1600w' }, { currentSrc: 'https://example.com/gallery/small.jpg' });
    expect(resolveImageUrl(img, BASE)).toBe('https://example.com/gallery/big.jpg');
  });

  it('considers <picture><source> srcsets', () => {
    const img = fakeImg({ src: 'fallback.jpg' });
    expect(resolveImageUrl(img, BASE, ['p-800.webp 800w, p-2000.webp 2000w'])).toBe('https://example.com/gallery/p-2000.webp');
  });

  it('falls back to currentSrc, then src', () => {
    expect(resolveImageUrl(fakeImg({ src: 'a.jpg' }, { currentSrc: 'https://cdn.x/a.jpg' }), BASE)).toBe('https://cdn.x/a.jpg');
    expect(resolveImageUrl(fakeImg({ src: 'a.jpg' }), BASE)).toBe('https://example.com/gallery/a.jpg');
  });

  it('skips lazy-load placeholders in favour of data-src / data-original / data-lazy-src', () => {
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    expect(resolveImageUrl(fakeImg({ src: gif, 'data-src': 'real.jpg' }, { currentSrc: gif }), BASE)).toBe('https://example.com/gallery/real.jpg');
    expect(resolveImageUrl(fakeImg({ src: gif, 'data-original': '/o.jpg' }), BASE)).toBe('https://example.com/o.jpg');
    expect(resolveImageUrl(fakeImg({ 'data-lazy-src': 'l.jpg' }), BASE)).toBe('https://example.com/gallery/l.jpg');
  });

  it('uses data-srcset for lazy responsive images', () => {
    expect(resolveImageUrl(fakeImg({ 'data-srcset': 'a.jpg 1x, a@2x.jpg 2x' }), BASE)).toBe('https://example.com/gallery/a@2x.jpg');
  });

  it('returns the placeholder if nothing better exists, or null', () => {
    const gif = 'data:image/gif;base64,R0lGOD=';
    expect(resolveImageUrl(fakeImg({ src: gif }), BASE)).toBe(gif);
    expect(resolveImageUrl(fakeImg({}), BASE)).toBeNull();
  });
});
