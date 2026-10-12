/**
 * Offscreen document: the extension's "worker with a DOM". It owns the whole
 * download pipeline (fetch → resize / convert / AI upscale → zip) because
 * service workers lack WebGPU-friendly canvas + Image decoding and
 * `URL.createObjectURL`. Finished files are handed to the service worker as
 * blob: URLs, since only it can call chrome.downloads.
 */
import { zipSync, type Zippable } from 'fflate';
import { browser } from 'wxt/browser';
import { buildFileName, buildZipName, extFromMime, extFromUrl, inferExt, sanitizeFileName, uniqueFileName } from '../../lib/fileNames';
import {
  DOWNLOAD_PORT,
  HASH_PORT,
  type HashEvent,
  type HashRequest,
  type DownloadEvent,
  type DownloadRequest,
  type RuntimeMessage,
  type SaveResponse,
} from '../../lib/messages';
import { isDefaultOutput } from '../../lib/output';
import { load } from './fetcher';
import { fingerprint } from './fingerprint';
import { processImage } from './process';

const FETCH_CONCURRENCY = 4;
const HASH_CONCURRENCY = 6;

let activeJobs = 0;

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== DOWNLOAD_PORT) return;
  const ctrl = new AbortController();
  port.onDisconnect.addListener(() => ctrl.abort());
  const post = (ev: DownloadEvent) => {
    if (!ctrl.signal.aborted) port.postMessage(ev);
  };
  port.onMessage.addListener((msg: DownloadRequest) => {
    if (msg?.type !== 'download') return;
    jobStarted();
    runJob(msg, post, ctrl.signal)
      .catch((err) => post({ type: 'done', saved: 0, failed: msg.items.length, error: errorMessage(err) }))
      .finally(jobEnded);
  });
});

function jobStarted() {
  activeJobs++;
}

function jobEnded() {
  if (--activeJobs === 0) void send({ type: 'offscreen-idle' }).catch(() => {});
}

// Duplicate detection: fetch (into the cache) and fingerprint every image as soon as the panel opens.
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== HASH_PORT) return;
  const ctrl = new AbortController();
  port.onDisconnect.addListener(() => ctrl.abort());
  const post = (ev: HashEvent) => {
    if (!ctrl.signal.aborted) port.postMessage(ev);
  };
  port.onMessage.addListener((msg: HashRequest) => {
    if (msg?.type !== 'hash') return;
    jobStarted();
    mapLimit(msg.items, HASH_CONCURRENCY, async (item) => {
      if (ctrl.signal.aborted) return;
      try {
        const { bytes, mime } = await load(item);
        if (ctrl.signal.aborted) return;
        const ext = inferExt({ mime, bytes, url: item.url });
        post({ type: 'fingerprint', index: item.index, ext, ...(await fingerprint(bytes, mime)) });
      } catch (err) {
        post({ type: 'fingerprint', index: item.index, error: errorMessage(err) });
      }
    })
      .then(() => post({ type: 'hash-done' }))
      .finally(jobEnded);
  });
});

interface FileOut {
  index: number;
  name?: string;
  bytes: Uint8Array;
  ext: string;
}

async function runJob(req: DownloadRequest, post: (ev: DownloadEvent) => void, signal: AbortSignal) {
  const total = req.items.length;
  const files: FileOut[] = [];
  let failed = 0;
  const fail = (index: number, err: unknown) => {
    failed++;
    post({ type: 'item', index, ok: false, error: errorMessage(err) });
  };

  // 1. Fetch everything (in parallel), so the slow AI step can run back-to-back.
  const fetched = new Map<number, { bytes: Uint8Array; mime: string }>();
  let savedByUrl = false;
  await mapLimit(req.items, FETCH_CONCURRENCY, async (item) => {
    if (signal.aborted) return;
    try {
      fetched.set(item.index, await load(item));
    } catch (err) {
      // A single, unmodified image can still be saved by URL: chrome.downloads isn't bound by CORS.
      if (!req.zip && isDefaultOutput(item.output) && /^https?:/.test(item.url)) {
        const ext = extFromUrl(item.url) ?? 'jpg';
        const filename = fileNameFor(req.hostname, { index: item.index, name: item.name, ext }, total, new Set());
        const res = await save(item.url, filename);
        if (res.ok) {
          post({ type: 'item', index: item.index, ok: true });
          post({ type: 'done', saved: 1, failed: 0, filename });
          savedByUrl = true;
          return;
        }
      }
      fail(item.index, err);
    }
  });
  if (signal.aborted || savedByUrl) return;

  // 2. Process one at a time (GPU / memory bound).
  for (const item of req.items) {
    const src = fetched.get(item.index);
    if (!src) continue;
    if (signal.aborted) return;
    try {
      if (!item.output || isDefaultOutput(item.output)) {
        files.push({ index: item.index, name: item.name, bytes: src.bytes, ext: inferExt({ mime: src.mime, bytes: src.bytes, url: item.url }) });
        post({ type: 'item', index: item.index, ok: true });
        continue;
      }
      const sourceExt = inferExt({ mime: src.mime, bytes: src.bytes, url: item.url });
      const out = await processImage(
        src.bytes,
        src.mime,
        sourceExt,
        item.output,
        (p) => post({ type: 'progress', index: item.index, ...p }),
        signal,
      );
      files.push({ index: item.index, name: item.name, bytes: out.bytes, ext: extFromMime(out.mime) ?? 'png' });
      post({ type: 'item', index: item.index, ok: true, width: out.width, height: out.height });
    } catch (err) {
      if (signal.aborted) return;
      fail(item.index, err);
    } finally {
      fetched.delete(item.index); // free memory early
    }
  }

  if (!files.length) {
    post({ type: 'done', saved: 0, failed, error: 'No images could be downloaded.' });
    return;
  }

  // 3. Save.
  let blob: Blob;
  let filename: string;
  if (!req.zip) {
    const f = files[0];
    filename = fileNameFor(req.hostname, f, total, new Set());
    // Without a type Chrome treats the blob as text and may rename the file to .txt.
    blob = new Blob([f.bytes as BlobPart], { type: mimeForExt(f.ext) });
  } else {
    const entries: Zippable = {};
    const taken = new Set<string>();
    const sorted = files.sort((a, b) => a.index - b.index);
    // Reserve custom names first so they keep their exact spelling; automatic names yield on clashes.
    const names = new Map<FileOut, string>();
    for (const f of sorted) if (f.name) names.set(f, fileNameFor(req.hostname, f, total, taken));
    for (const f of sorted) if (!f.name) names.set(f, fileNameFor(req.hostname, f, total, taken));
    for (const f of sorted) {
      // Images are already compressed; storing them is much faster with no size cost.
      entries[names.get(f)!] = [f.bytes, { level: 0 }];
    }
    filename = buildZipName(req.hostname);
    blob = new Blob([zipSync(entries) as BlobPart], { type: 'application/zip' });
  }
  const url = URL.createObjectURL(blob);
  try {
    const res = await save(url, filename);
    if (!res.ok) throw new Error(res.error ?? 'Download failed');
    post({ type: 'done', saved: files.length, failed, filename });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Custom name (re-sanitised: never trust the page side) or `{hostname}_{index}`, unique within `taken`. */
function fileNameFor(hostname: string, f: { index: number; name?: string; ext: string }, total: number, taken: Set<string>): string {
  const custom = sanitizeFileName(f.name);
  const base = custom || buildFileName(hostname, f.index, total, f.ext).replace(/\.[^.]+$/, '');
  return uniqueFileName(base, f.ext, taken);
}

function mimeForExt(ext: string): string {
  if (ext === 'jpg') return 'image/jpeg';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'ico') return 'image/x-icon';
  if (ext === 'tif') return 'image/tiff';
  return `image/${ext}`;
}

function send(msg: RuntimeMessage) {
  return browser.runtime.sendMessage(msg);
}

async function save(url: string, filename: string): Promise<SaveResponse> {
  try {
    return ((await send({ type: 'save', url, filename })) as SaveResponse | undefined) ?? { ok: false, error: 'No response' };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function errorMessage(err: unknown): string {
  if (err instanceof DOMException && err.name === 'AbortError') return 'Cancelled';
  return err instanceof Error ? err.message : String(err);
}
