/** Messages exchanged between the content script, service worker and offscreen document. */

import type { Fingerprint } from './dupes';
import type { OutputSettings } from './output';

/** Port from the content script to the offscreen document, which does fetch + process + zip. */
export const DOWNLOAD_PORT = 'rig-download';

export interface DownloadItem {
  /** Position in the user's selection (1-based); used for the file name. */
  index: number;
  /** Remote URL to fetch (http/https). */
  url: string;
  /** Pre-read bytes for `blob:` / `data:` URLs, which only exist in the page. */
  base64?: string;
  mime?: string;
  /** Resize / convert / enhance. Omitted = save the original bytes untouched. */
  output?: OutputSettings;
  /** Custom base name (already sanitised, no extension). Omitted = `{hostname}_{index}`. */
  name?: string;
}

export interface DownloadRequest {
  type: 'download';
  hostname: string;
  /** `true` → one .zip; `false` → requires exactly one item, saved as-is. */
  zip: boolean;
  items: DownloadItem[];
}

export type DownloadEvent =
  | { type: 'progress'; index: number; stage: 'fetching' | 'processing' | 'upscaling'; pct?: number }
  | { type: 'item'; index: number; ok: true; width?: number; height?: number }
  | { type: 'item'; index: number; ok: false; error: string }
  | { type: 'done'; saved: number; failed: number; filename?: string; error?: string; cancelled?: boolean };

/** Port from the content script to the offscreen document for duplicate fingerprints. */
export const HASH_PORT = 'rig-hash';

export interface HashRequest {
  type: 'hash';
  /** Same shape as download items; `output` is ignored. */
  items: DownloadItem[];
}

export type HashEvent =
  /** `ext` is the real file format (from Content-Type / magic bytes). */
  | { type: 'fingerprint'; index: number; fp: Fingerprint; width: number; height: number; ext: string }
  | { type: 'fingerprint'; index: number; error: string }
  | { type: 'hash-done' };

/** One-off messages handled by the service worker. */
export type RuntimeMessage =
  | { type: 'open-permissions' }
  /** Content script → SW: create the offscreen document before connecting the download port. */
  | { type: 'ensure-offscreen' }
  /** Offscreen → SW: save a blob: URL (or a remote URL) with chrome.downloads; replies when finished. */
  | { type: 'save'; url: string; filename: string }
  /** Offscreen → SW: no jobs running; the document may be closed. */
  | { type: 'offscreen-idle' };

export interface SaveResponse {
  ok: boolean;
  error?: string;
}
