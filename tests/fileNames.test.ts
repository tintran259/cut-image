import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, parseDataUrl } from '../lib/base64';
import { buildFileName, buildZipName, extFromMime, extFromUrl, inferExt, sanitizeHostname, sniffExt } from '../lib/fileNames';

describe('extension inference', () => {
  it('maps Content-Type, ignoring parameters', () => {
    expect(extFromMime('image/jpeg')).toBe('jpg');
    expect(extFromMime('image/svg+xml; charset=utf-8')).toBe('svg');
    expect(extFromMime('application/octet-stream')).toBeNull();
  });

  it('sniffs magic bytes', () => {
    expect(sniffExt(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniffExt(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(sniffExt(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffExt(new TextEncoder().encode('\0\0\0\x1cftypavif'))).toBe('avif');
    expect(sniffExt(new TextEncoder().encode('<?xml version="1.0"?><svg></svg>'))).toBe('svg');
  });

  it('reads the extension from the URL path or CDN query params', () => {
    expect(extFromUrl('https://x.com/a/b.JPEG?v=2')).toBe('jpg');
    expect(extFromUrl('https://pbs.twimg.com/media/abc?format=webp&name=large')).toBe('webp');
    expect(extFromUrl('https://images.example.com/photo-1?fm=avif')).toBe('avif');
    expect(extFromUrl('data:image/png;base64,AAA')).toBe('png');
    expect(extFromUrl('https://x.com/image')).toBeNull();
  });

  it('prefers Content-Type, then bytes, then URL, then jpg', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(inferExt({ mime: 'image/webp', bytes: png, url: 'a.gif' })).toBe('webp');
    expect(inferExt({ mime: 'application/octet-stream', bytes: png, url: 'https://x/a.gif' })).toBe('png');
    expect(inferExt({ mime: '', bytes: new Uint8Array([1, 2, 3]), url: 'https://x/a.gif' })).toBe('gif');
    expect(inferExt({})).toBe('jpg');
  });
});

describe('file names', () => {
  it('sanitizes hostnames', () => {
    expect(sanitizeHostname('www.Example.com')).toBe('example.com');
    expect(sanitizeHostname('')).toBe('page');
    expect(sanitizeHostname('[::1]')).toBe('1');
  });

  it('builds {hostname}_{index}.{ext} with stable padding', () => {
    expect(buildFileName('www.pinterest.com', 3, 12, 'jpg')).toBe('pinterest.com_03.jpg');
    expect(buildFileName('a.com', 7, 250, 'png')).toBe('a.com_007.png');
  });

  it('builds {hostname}_{YYYYMMDD-HHmm}.zip', () => {
    expect(buildZipName('www.example.com', new Date(2026, 0, 5, 9, 7))).toBe('example.com_20260105-0907.zip');
  });
});

describe('base64 / data URLs', () => {
  it('round-trips large buffers', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) & 255);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('parses base64 and percent-encoded data URLs', () => {
    expect(parseDataUrl('data:image/png;base64,AQID')).toEqual({ mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
    const svg = parseDataUrl('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E');
    expect(svg?.mime).toBe('image/svg+xml');
    expect(new TextDecoder().decode(svg!.bytes)).toBe('<svg/>');
    expect(parseDataUrl('not-a-data-url')).toBeNull();
  });
});

describe('custom file names', async () => {
  const { sanitizeFileName, uniqueFileName, MAX_NAME_LENGTH } = await import('../lib/fileNames');

  it('keeps normal names, including Vietnamese and spaces', () => {
    expect(sanitizeFileName('  Ví da nam   màu nâu ')).toBe('Ví da nam màu nâu');
    expect(sanitizeFileName('product-01')).toBe('product-01');
  });

  it('replaces reserved characters and strips path tricks', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFileName('...hidden')).toBe('hidden');
    expect(sanitizeFileName('name. . .')).toBe('name');
    expect(sanitizeFileName('tab\there\u0007')).toBe('tab here');
  });

  it('drops an image extension the user typed', () => {
    expect(sanitizeFileName('wallet.JPG')).toBe('wallet');
    expect(sanitizeFileName('v1.2 final')).toBe('v1.2 final');
  });

  it('handles Windows device names, empty input and length', () => {
    expect(sanitizeFileName('con')).toBe('_con');
    expect(sanitizeFileName('   ')).toBe('');
    expect(sanitizeFileName(undefined)).toBe('');
    expect(sanitizeFileName('x'.repeat(500))).toHaveLength(MAX_NAME_LENGTH);
  });

  it('numbers clashing names', () => {
    const taken = new Set<string>();
    expect(uniqueFileName('bag', 'jpg', taken)).toBe('bag.jpg');
    expect(uniqueFileName('Bag', 'jpg', taken)).toBe('Bag (2).jpg');
    expect(uniqueFileName('bag', 'jpg', taken)).toBe('bag (3).jpg');
    expect(uniqueFileName('bag', 'png', taken)).toBe('bag.png');
  });
});
