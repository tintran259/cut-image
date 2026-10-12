import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import type { RuntimeMessage, SaveResponse } from '../lib/messages';

const MENU_ID = 'rig-select-region';
const COMMAND = 'start-selection';
const OFFSCREEN_PATH = '/offscreen.html';
/** Close the offscreen document (and free the AI model / GPU memory) after this much idle time. */
const OFFSCREEN_IDLE_MS = 60_000;

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({
      id: MENU_ID,
      title: 'Select region to grab images',
      contexts: ['page', 'image', 'link', 'selection', 'video'],
    });
  });

  browser.action.onClicked.addListener((tab) => void startSelection(tab));

  browser.commands.onCommand.addListener(async (command, tab) => {
    if (command !== COMMAND) return;
    const target = tab ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    void startSelection(target);
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_ID) void startSelection(tab);
  });

  browser.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'open-permissions':
        void browser.tabs.create({ url: browser.runtime.getURL('/grant.html') });
        return;
      case 'ensure-offscreen':
        ensureOffscreen().then(
          () => sendResponse({ ok: true }),
          (err) => sendResponse({ ok: false, error: errorMessage(err) }),
        );
        return true;
      case 'save':
        saveAndWait(msg.url, msg.filename).then(sendResponse);
        return true;
      case 'offscreen-idle':
        scheduleOffscreenClose();
        return;
    }
  });
});

/**
 * Inject the content script. Re-injecting into a tab that already has it
 * replaces the previous session (the old instance tears itself down).
 */
async function startSelection(tab: Browser.tabs.Tab | undefined) {
  if (tab?.id === undefined) return;
  try {
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['/content-scripts/content.js'],
    });
  } catch (err) {
    // chrome://, the Web Store, the New Tab page and other restricted pages can't be scripted.
    const reason = errorMessage(err);
    console.warn('[Region Image Grabber] Cannot run on this page:', reason, tab.url ?? '');
    await flagUnsupported(tab.id, reason);
  }
}

/** Show a red "!" on the toolbar icon for this tab, with the reason in the tooltip. */
async function flagUnsupported(tabId: number, reason: string) {
  const fileHint = /file:/.test(reason) || /Cannot access contents of url "file:/.test(reason)
    ? ' For local files, enable "Allow access to file URLs" in chrome://extensions → Details.'
    : '';
  try {
    await browser.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' });
    await browser.action.setBadgeText({ tabId, text: '!' });
    await browser.action.setTitle({ tabId, title: `Region Image Grabber can't run on this page.${fileHint}\n(${reason})` });
    setTimeout(() => {
      void browser.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      void browser.action.setTitle({ tabId, title: '' }).catch(() => {});
    }, 6000);
  } catch {
    /* tab closed */
  }
}

let creating: Promise<void> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

async function ensureOffscreen() {
  clearTimeout(idleTimer);
  const url = browser.runtime.getURL(OFFSCREEN_PATH);
  const existing = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as Browser.runtime.ContextType], documentUrls: [url] });
  if (existing.length) return;
  creating ??= browser.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['BLOBS' as Browser.offscreen.Reason, 'WORKERS' as Browser.offscreen.Reason],
      justification: 'Resize, convert and AI-upscale images, then zip them for download.',
    })
    .finally(() => (creating = null));
  await creating;
}

function scheduleOffscreenClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void browser.offscreen.closeDocument().catch(() => {}), OFFSCREEN_IDLE_MS);
}

/** Start a download and resolve once it has finished, so the caller can revoke its blob: URL. */
async function saveAndWait(url: string, filename: string): Promise<SaveResponse> {
  let id: number;
  try {
    id = await browser.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  return new Promise((resolve) => {
    const onChanged = (delta: Browser.downloads.DownloadDelta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') finish({ ok: true });
      else if (delta.state.current === 'interrupted') finish({ ok: false, error: delta.error?.current ?? 'Download interrupted' });
    };
    const finish = (r: SaveResponse) => {
      browser.downloads.onChanged.removeListener(onChanged);
      resolve(r);
    };
    browser.downloads.onChanged.addListener(onChanged);
    // It may already be finished (small blobs complete almost instantly).
    void browser.downloads.search({ id }).then(([item]) => {
      if (item?.state === 'complete') finish({ ok: true });
      else if (item?.state === 'interrupted') finish({ ok: false, error: item.error ?? 'Download interrupted' });
    });
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
