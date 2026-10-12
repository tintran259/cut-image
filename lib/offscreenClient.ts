import { browser } from 'wxt/browser';
import { bytesToBase64, parseDataUrl } from './base64';
import type { DownloadItem, RuntimeMessage } from './messages';
import type { OutputSettings } from './output';

export type OffscreenPort = ReturnType<typeof browser.runtime.connect>;

export interface ItemSource {
  url: string;
  output?: OutputSettings;
  name?: string;
}

/** Make sure the offscreen document exists, then open a named port to it. */
export async function connectOffscreen(name: string): Promise<OffscreenPort> {
  try {
    const msg: RuntimeMessage = { type: 'ensure-offscreen' };
    const res = (await browser.runtime.sendMessage(msg)) as { ok: boolean; error?: string } | undefined;
    if (!res?.ok) throw new Error(res?.error ?? 'Could not start the image processor.');
    return browser.runtime.connect({ name });
  } catch (err) {
    if (!browser.runtime?.id) throw new Error('Extension was reloaded. Refresh the page and try again.');
    throw err;
  }
}

/**
 * Turn page URLs into items for the offscreen document. `blob:` and `data:`
 * URLs only exist in this page, so their bytes are read here and sent as base64.
 * Items that can't be read are reported through `onError` and left out.
 */
export async function prepareItems(sources: ItemSource[], onError: (index: number, error: string) => void): Promise<DownloadItem[]> {
  const items: DownloadItem[] = [];
  await Promise.all(
    sources.map(async ({ url, output, name }, i) => {
      const index = i + 1;
      if (!url.startsWith('blob:') && !url.startsWith('data:')) {
        items.push({ index, url, output, name });
        return;
      }
      try {
        const { base64, mime } = await readLocal(url);
        items.push({ index, url, base64, mime, output, name });
      } catch (err) {
        onError(index, err instanceof Error ? err.message : String(err));
      }
    }),
  );
  return items.sort((a, b) => a.index - b.index);
}

async function readLocal(url: string): Promise<{ base64: string; mime: string }> {
  if (url.startsWith('data:')) {
    const parsed = parseDataUrl(url);
    if (!parsed) throw new Error('Malformed data: URL');
    return { base64: bytesToBase64(parsed.bytes), mime: parsed.mime };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not read blob (${res.status})`);
  const blob = await res.blob();
  return { base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), mime: blob.type };
}
