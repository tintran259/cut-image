// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { detectImages, overlapRatio } from '../lib/detectImages';

/**
 * jsdom has no layout. Markup declares rects as `data-rect="left top width height"`;
 * `layout()` moves them into a WeakMap so they don't leak into serialized SVG.
 */
let rects = new WeakMap<Element, DOMRect>();

function layout(root: ParentNode = document) {
  for (const el of Array.from(root.querySelectorAll('[data-rect]'))) {
    const [x, y, w, h] = el.getAttribute('data-rect')!.split(' ').map(Number);
    rects.set(el, { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON() {} } as DOMRect);
    el.removeAttribute('data-rect');
  }
}

function setBody(html: string) {
  document.body.innerHTML = html;
  layout();
}

beforeEach(() => {
  rects = new WeakMap();
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return rects.get(this) ?? ({ x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, toJSON() {} } as DOMRect);
  };
  document.body.innerHTML = '';
});

const SEL = { left: 0, top: 0, right: 500, bottom: 500 };

describe('overlapRatio', () => {
  it('computes intersection over element area', () => {
    expect(overlapRatio({ left: 0, top: 0, right: 100, bottom: 100 }, { left: 50, top: 0, right: 200, bottom: 200 })).toBe(0.5);
    expect(overlapRatio({ left: 0, top: 0, right: 100, bottom: 100 }, { left: 200, top: 0, right: 300, bottom: 100 })).toBe(0);
    expect(overlapRatio({ left: 0, top: 0, right: 0, bottom: 0 }, SEL)).toBe(0);
  });
});

describe('detectImages', () => {
  it('finds <img>, video posters and CSS backgrounds inside the rect', () => {
    setBody(`
      <img data-rect="10 10 100 100" src="https://cdn.test/a.jpg" srcset="https://cdn.test/a-400.jpg 400w, https://cdn.test/a-1600.jpg 1600w">
      <video data-rect="10 200 200 100" poster="/poster.jpg"></video>
      <div data-rect="300 10 150 150" style="background-image: url('https://cdn.test/bg.png')"></div>
    `);
    const urls = detectImages(SEL).map((i) => [i.type, i.url]);
    expect(urls).toEqual([
      ['img', 'https://cdn.test/a-1600.jpg'],
      ['background', 'https://cdn.test/bg.png'],
      ['video', new URL('/poster.jpg', document.baseURI).href],
    ]);
  });

  it('applies the overlap threshold', () => {
    setBody(`
      <img data-rect="450 0 100 100" src="https://cdn.test/half.jpg">
      <img data-rect="480 0 100 100" src="https://cdn.test/fifth.jpg">
    `);
    expect(detectImages(SEL).map((i) => i.url)).toEqual(['https://cdn.test/half.jpg']);
    expect(detectImages(SEL, { minOverlap: 0.1 }).map((i) => i.url)).toHaveLength(2);
  });

  it('skips hidden, transparent and tiny elements', () => {
    setBody(`
      <img data-rect="0 0 100 100" src="https://cdn.test/none.jpg" style="display:none">
      <img data-rect="0 0 100 100" src="https://cdn.test/vis.jpg" style="visibility:hidden">
      <div style="opacity:0"><img data-rect="0 0 100 100" src="https://cdn.test/op.jpg"></div>
      <img data-rect="0 0 4 4" src="https://cdn.test/pixel.gif">
      <img data-rect="0 0 100 100" src="https://cdn.test/ok.jpg">
    `);
    expect(detectImages(SEL).map((i) => i.url)).toEqual(['https://cdn.test/ok.jpg']);
  });

  it('resolves lazy-loaded images and deduplicates by URL', () => {
    setBody(`
      <img data-rect="0 0 100 100" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="https://cdn.test/lazy.jpg">
      <img data-rect="0 120 100 100" src="https://cdn.test/lazy.jpg">
    `);
    const found = detectImages(SEL);
    expect(found.map((i) => i.url)).toEqual(['https://cdn.test/lazy.jpg']);
  });

  it('uses the largest <picture><source> candidate', () => {
    setBody(`
      <picture>
        <source srcset="https://cdn.test/p-800.webp 800w, https://cdn.test/p-2400.webp 2400w" type="image/webp">
        <img data-rect="0 0 200 100" src="https://cdn.test/p.jpg">
      </picture>
    `);
    expect(detectImages(SEL)[0].url).toBe('https://cdn.test/p-2400.webp');
  });

  it('ignores excluded elements', () => {
    setBody(`<div id="ui"><img data-rect="0 0 100 100" src="https://cdn.test/ui.png"></div>`);
    const ui = document.getElementById('ui')!;
    expect(detectImages(SEL, { exclude: (el) => ui.contains(el) })).toEqual([]);
  });

  it('serializes inline SVGs once per unique markup', () => {
    setBody(`
      <svg data-rect="0 0 40 40" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>
      <svg data-rect="50 0 40 40" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>
    `);
    const found = detectImages(SEL);
    expect(found).toHaveLength(1);
    expect(found[0].type).toBe('svg');
  });

  it('samples a grid with elementsFromPoint and pierces open shadow roots', () => {
    setBody(`<x-card data-rect="0 0 200 200"></x-card><div id="cover" data-rect="0 0 200 200"></div>`);
    const card = document.querySelector('x-card')!;
    const cover = document.getElementById('cover')!;
    const shadow = card.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<img data-rect="0 0 200 200" src="https://cdn.test/in-shadow.jpg">`;
    layout(shadow);
    const inner = shadow.querySelector('img')!;

    let calls = 0;
    document.elementsFromPoint = () => {
      calls++;
      return [cover, card, document.body, document.documentElement];
    };
    (shadow as ShadowRoot & { elementsFromPoint: Document['elementsFromPoint'] }).elementsFromPoint = () => [inner, card];

    const found = detectImages({ left: 0, top: 0, right: 200, bottom: 200 }, { sampleStep: 100 });
    expect(calls).toBe(4);
    expect(found.map((i) => i.url)).toEqual(['https://cdn.test/in-shadow.jpg']);
  });
});
