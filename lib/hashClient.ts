import { HASH_PORT, type HashEvent, type HashRequest } from './messages';
import { connectOffscreen, prepareItems, type OffscreenPort } from './offscreenClient';

export interface HashJob {
  cancel(): void;
}

/**
 * Fingerprint every image for duplicate detection. Events carry 1-based
 * indexes into `urls`; `hash-done` always arrives last (also on failure).
 */
export function startHashing(urls: string[], onEvent: (ev: HashEvent) => void): HashJob {
  let port: OffscreenPort | null = null;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onEvent({ type: 'hash-done' });
    port?.disconnect();
    port = null;
  };

  void (async () => {
    const items = await prepareItems(
      urls.map((url) => ({ url })),
      (index, error) => onEvent({ type: 'fingerprint', index, error }),
    );
    if (finished) return;
    try {
      port = await connectOffscreen(HASH_PORT);
    } catch {
      finish();
      return;
    }
    if (finished) {
      port.disconnect();
      return;
    }
    port.onMessage.addListener((ev: HashEvent) => (ev.type === 'hash-done' ? finish() : onEvent(ev)));
    port.onDisconnect.addListener(() => {
      port = null;
      finish();
    });
    const req: HashRequest = { type: 'hash', items };
    port.postMessage(req);
  })();

  return {
    cancel() {
      finished = true;
      port?.disconnect();
      port = null;
    },
  };
}
