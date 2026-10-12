import { DOWNLOAD_PORT, type DownloadEvent, type DownloadRequest } from './messages';
import { connectOffscreen, prepareItems, type ItemSource, type OffscreenPort } from './offscreenClient';

export interface DownloadJob {
  cancel(): void;
}

export type DownloadSource = ItemSource;

/**
 * Hand images to the extension's offscreen document, which fetches, processes,
 * zips and saves them. `onEvent` receives progress / per-item results (by
 * 1-based index into `sources`) and a final `done`.
 */
export function startDownload(
  sources: DownloadSource[],
  opts: { zip: boolean; hostname: string },
  onEvent: (ev: DownloadEvent) => void,
): DownloadJob {
  let port: OffscreenPort | null = null;
  let finished = false;
  const finish = (ev: DownloadEvent & { type: 'done' }) => {
    if (finished) return;
    finished = true;
    onEvent(ev);
    port?.disconnect();
    port = null;
  };

  void (async () => {
    let localFailures = 0;
    const items = await prepareItems(sources, (index, error) => {
      localFailures++;
      onEvent({ type: 'item', index, ok: false, error });
    });
    if (finished) return;
    if (!items.length) {
      finish({ type: 'done', saved: 0, failed: localFailures, error: 'No images could be read.' });
      return;
    }
    try {
      port = await connectOffscreen(DOWNLOAD_PORT);
    } catch (err) {
      finish({ type: 'done', saved: 0, failed: sources.length, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (finished) {
      port.disconnect();
      return;
    }
    port.onMessage.addListener((ev: DownloadEvent) => {
      if (ev.type === 'done') finish({ ...ev, failed: ev.failed + localFailures });
      else onEvent(ev);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      finish({ type: 'done', saved: 0, failed: sources.length, error: 'Lost connection to the extension.' });
    });
    const req: DownloadRequest = { type: 'download', hostname: opts.hostname, zip: opts.zip, items };
    port.postMessage(req);
  })();

  return {
    cancel() {
      finished = true;
      port?.disconnect(); // the offscreen document aborts the job on disconnect
      port = null;
    },
  };
}
