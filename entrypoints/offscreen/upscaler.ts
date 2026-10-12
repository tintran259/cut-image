import * as ort from 'onnxruntime-web/webgpu';
import { browser } from 'wxt/browser';
import { computeTiles, rgbaToChwTile, writeChwTile } from '../../lib/imageOps';
import { AI_SCALE } from '../../lib/output';

/** Must match TILE in scripts/convert-model.py (the model has a static input shape). */
export const TILE = 192;
/** Context discarded at inner tile edges to avoid seams. */
const OVERLAP = 12;
const MODEL_PATH = '/models/realesr-general-x4v3.onnx';
/** Directory holding ort-wasm-simd-threaded.asyncify.{mjs,wasm} (copied by wxt.config.ts). */
const ORT_DIR = '/ort/';

export type Backend = 'webgpu' | 'wasm';

let sessionPromise: Promise<{ session: ort.InferenceSession; backend: Backend }> | null = null;

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

/** Load the model once. Everything is served from the extension package; no network. */
export function getSession() {
  sessionPromise ??= (async () => {
    // Copied into the build by the hook in wxt.config.ts, so it isn't in WXT's typed public paths.
    ort.env.wasm.wasmPaths = (browser.runtime.getURL as (p: string) => string)(ORT_DIR);
    ort.env.wasm.numThreads = 1; // extension pages aren't cross-origin isolated
    ort.env.logLevel = 'error';
    const model = new Uint8Array(await (await fetch(browser.runtime.getURL(MODEL_PATH))).arrayBuffer());
    const backends: Backend[] = (await hasWebGpu()) ? ['webgpu', 'wasm'] : ['wasm'];
    let lastErr: unknown;
    for (const backend of backends) {
      try {
        const session = await ort.InferenceSession.create(model, {
          executionProviders: [backend],
          graphOptimizationLevel: 'all',
        });
        console.info(`[Region Image Grabber] AI upscaler ready (${backend})`);
        return { session, backend };
      } catch (err) {
        console.warn(`[Region Image Grabber] ${backend} backend unavailable:`, err);
        lastErr = err;
      }
    }
    throw lastErr;
  })().catch((err) => {
    sessionPromise = null;
    throw err;
  });
  return sessionPromise;
}

/**
 * ×4 super-resolution of an RGBA image, tile by tile. Returns RGBA with
 * alpha = 255 (callers restore transparency separately).
 */
export async function upscale4x(
  img: ImageData,
  onTile: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<ImageData> {
  const { session } = await getSession();
  const { width, height, data } = img;
  const tiles = computeTiles(width, height, TILE, OVERLAP);
  const outW = width * AI_SCALE;
  const outH = height * AI_SCALE;
  const dst = new Uint8ClampedArray(outW * outH * 4);
  const input = new Float32Array(3 * TILE * TILE);

  for (let i = 0; i < tiles.length; i++) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const t = tiles[i];
    rgbaToChwTile(data, width, height, t.x, t.y, TILE, input);
    const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, TILE, TILE]) };
    const result = await session.run(feeds);
    const out = result[session.outputNames[0]];
    writeChwTile(out.data as Float32Array, t, TILE, AI_SCALE, dst, outW);
    out.dispose();
    onTile(i + 1, tiles.length);
  }
  return new ImageData(dst, outW, outH);
}
