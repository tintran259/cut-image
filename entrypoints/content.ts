import { h, render } from 'preact';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { App } from '../components/App';
import css from '../components/styles.css?inline';

declare global {
  interface Window {
    __regionImageGrabberDestroy?: () => void;
  }
}

/**
 * Injected on demand by the service worker (toolbar icon, Alt+Shift+S or the
 * context menu). Each injection starts a fresh selection session; a previous
 * session in the same tab is torn down first.
 */
export default defineContentScript({
  registration: 'runtime',
  main(ctx) {
    window.__regionImageGrabberDestroy?.();
    const destroy = mountSession();
    window.__regionImageGrabberDestroy = destroy;
    ctx.onInvalidated(destroy);
  },
});

function mountSession(): () => void {
  const host = document.createElement('region-image-grabber');
  host.setAttribute(
    'style',
    'all: initial !important; display: block !important; position: fixed !important; inset: 0 !important; ' +
      'z-index: 2147483647 !important; pointer-events: none !important;',
  );
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = css;
  const container = document.createElement('div');
  container.className = 'rig-root';
  shadow.append(style, container);

  // Keep typing in the panel from triggering page keyboard shortcuts.
  const stop = (e: Event) => e.stopPropagation();
  for (const type of ['keydown', 'keyup', 'keypress']) shadow.addEventListener(type, stop);

  document.documentElement.appendChild(host);

  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    render(null, container); // runs effect cleanups: window listeners, ports, blob URLs
    for (const type of ['keydown', 'keyup', 'keypress']) shadow.removeEventListener(type, stop);
    host.remove();
    if (window.__regionImageGrabberDestroy === destroy) delete window.__regionImageGrabberDestroy;
  };

  render(h(App, { host, onClose: destroy }), container);
  return destroy;
}
