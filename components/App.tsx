import { useEffect, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { detectImages, releaseDetectedImages, type RectLike } from '../lib/detectImages';
import { startDownload, type DownloadJob } from '../lib/downloadClient';
import { findDuplicateGroups } from '../lib/dupes';
import { startHashing, type HashJob } from '../lib/hashClient';
import type { RuntimeMessage } from '../lib/messages';
import { sanitizeFileName } from '../lib/fileNames';
import { adaptSettings, isDefaultOutput, type OutputSettings } from '../lib/output';
import { Highlights } from './Highlights';
import { displaySize, Panel, type DownloadState, type DupState, type PanelItem } from './Panel';
import { SelectionOverlay } from './SelectionOverlay';

interface Props {
  /** The extension's shadow host; excluded from detection. */
  host: Element;
  onClose(): void;
}

const DEFAULT_MIN_SIZE = 50;
const DUP_PREF_KEY = 'detectDuplicates';

/** Mark duplicate groups on the items; non-best copies are unticked once (`autoUnchecked`). */
function applyDuplicateGroups(items: PanelItem[]): { items: PanelItem[]; groups: number; dupes: number } {
  const groups = findDuplicateGroups(
    items.map((it) => {
      const { width, height } = displaySize(it);
      return { id: it.id, url: it.url, fp: it.fp, area: width * height };
    }),
  );
  const info = new Map<number, { group: number; keeper: boolean; size: number }>();
  groups.forEach((g, gi) => g.forEach((id, k) => info.set(id, { group: gi, keeper: k === 0, size: g.length })));
  const next = items.map((it) => {
    const d = info.get(it.id);
    if (!d) return { ...it, dupGroup: undefined, dupKeeper: undefined, dupSize: undefined };
    const untick = !d.keeper && it.selected && !it.autoUnchecked;
    return {
      ...it,
      dupGroup: d.group,
      dupKeeper: d.keeper,
      dupSize: d.size,
      selected: untick ? false : it.selected,
      autoUnchecked: it.autoUnchecked || untick,
    };
  });
  return { items: next, groups: groups.length, dupes: groups.reduce((n, g) => n + g.length - 1, 0) };
}

export function App({ host, onClose }: Props) {
  const [phase, setPhase] = useState<'selecting' | 'results'>('selecting');
  const [items, setItems] = useState<PanelItem[]>([]);
  const [minSize, setMinSize] = useState(DEFAULT_MIN_SIZE);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [download, setDownload] = useState<DownloadState>({ running: false });
  const [tick, setTick] = useState(0);
  const [editingId, setEditingId] = useState<number | null>(null);
  const editingRef = useRef(editingId);
  editingRef.current = editingId;
  const jobRef = useRef<DownloadJob | null>(null);
  const hashRef = useRef<HashJob | null>(null);
  const [dup, setDup] = useState<DupState>({ enabled: true, running: false, done: 0, total: 0, groups: 0, dupes: 0 });
  const dupEnabledRef = useRef(true);

  useEffect(() => {
    void browser.storage.local
      .get(DUP_PREF_KEY)
      .then((v) => {
        const enabled = v[DUP_PREF_KEY] !== false;
        dupEnabledRef.current = enabled;
        setDup((d) => ({ ...d, enabled }));
      })
      .catch(() => {});
  }, []);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Esc closes; scroll/resize re-renders so the rectangle and outlines track the page.
  useEffect(() => {
    let frame = 0;
    const bump = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        setTick((t) => t + 1);
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // Esc steps back out of the editor first, then closes.
      if (editingRef.current !== null) setEditingId(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', bump, { capture: true, passive: true });
    window.addEventListener('resize', bump, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', bump, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', bump);
    };
  }, [onClose]);

  // Final teardown: stop any download and free inline-SVG blob URLs.
  useEffect(
    () => () => {
      jobRef.current?.cancel();
      hashRef.current?.cancel();
      releaseDetectedImages(itemsRef.current);
    },
    [],
  );

  const onSelect = (rect: RectLike) => {
    const found = detectImages(rect, { exclude: (el) => el === host || host.contains(el) });
    const next: PanelItem[] = found.map((img, i) => ({ ...img, id: i, selected: true }));
    setItems(next);
    setDownload({ running: false });
    setPhase('results');
    if (dupEnabledRef.current) startDuplicateScan(next);
  };

  /** Fetch + fingerprint every image in the offscreen document, then group look-alikes. */
  const startDuplicateScan = (list: PanelItem[]) => {
    hashRef.current?.cancel();
    const ids = list.map((it) => it.id);
    let done = 0;
    setDup((d) => ({ ...d, running: list.length > 1, done: 0, total: list.length, groups: 0, dupes: 0 }));
    if (list.length < 2) return;
    hashRef.current = startHashing(
      list.map((it) => it.url),
      (ev) => {
        if (ev.type === 'fingerprint') {
          const id = ids[ev.index - 1];
          done++;
          setDup((d) => ({ ...d, done }));
          if ('fp' in ev) {
            update((it) => {
              if (it.id !== id) return it;
              // Decoded size is the real one (CSS backgrounds only report their box until now).
              const real = it.type !== 'svg' && it.type !== 'canvas' && ev.width > 0;
              return { ...it, fp: ev.fp, fileExt: ev.ext, ...(real ? { naturalWidth: ev.width, naturalHeight: ev.height } : {}) };
            });
          }
          return;
        }
        hashRef.current = null;
        setItems((prev) => {
          const r = applyDuplicateGroups(prev);
          setDup((d) => ({ ...d, running: false, groups: r.groups, dupes: r.dupes }));
          return r.items;
        });
      },
    );
  };

  const toggleDuplicates = (enabled: boolean) => {
    dupEnabledRef.current = enabled;
    void browser.storage.local.set({ [DUP_PREF_KEY]: enabled }).catch(() => {});
    setDup((d) => ({ ...d, enabled, running: false, groups: 0, dupes: 0 }));
    if (enabled) {
      startDuplicateScan(items);
    } else {
      hashRef.current?.cancel();
      hashRef.current = null;
      // Undo our automatic unticking; leave the user's own choices alone.
      update((it) => ({
        ...it,
        selected: it.autoUnchecked ? true : it.selected,
        autoUnchecked: undefined,
        dupGroup: undefined,
        dupKeeper: undefined,
        dupSize: undefined,
      }));
    }
  };

  const deselectDuplicates = () => update((it) => (it.dupGroup !== undefined && !it.dupKeeper ? { ...it, selected: false } : it));

  const reselect = () => {
    jobRef.current?.cancel();
    jobRef.current = null;
    hashRef.current?.cancel();
    hashRef.current = null;
    releaseDetectedImages(items);
    setItems([]);
    setHoverId(null);
    setEditingId(null);
    setDownload({ running: false });
    setPhase('selecting');
  };

  const update = (fn: (it: PanelItem) => PanelItem) => setItems((prev) => prev.map(fn));

  const visibleItems = () =>
    items.filter((it) => {
      const { width, height } = displaySize(it);
      return width >= minSize && height >= minSize;
    });

  const run = (targets: PanelItem[], zip: boolean) => {
    if (!targets.length || download.running) return;
    const ids = targets.map((t) => t.id);
    const idSet = new Set(ids);
    update((it) => (idSet.has(it.id) ? { ...it, status: 'pending', stage: 'fetching', pct: undefined, error: undefined } : it));
    setDownload({ running: true, done: 0, total: targets.length });

    let processed = 0;
    jobRef.current = startDownload(
      targets.map((t) => ({
        url: t.url,
        output: isDefaultOutput(t.output) ? undefined : t.output,
        name: sanitizeFileName(t.fileName) || undefined,
      })),
      { zip, hostname: location.hostname },
      (ev) => {
        if (ev.type === 'progress') {
          const id = ids[ev.index - 1];
          update((it) => (it.id === id ? { ...it, stage: ev.stage, pct: ev.pct } : it));
          return;
        }
        if (ev.type === 'item') {
          const id = ids[ev.index - 1];
          processed++;
          setDownload((d) => ({ ...d, done: processed }));
          update((it) => (it.id === id ? { ...it, status: ev.ok ? 'ok' : 'error', error: ev.ok ? undefined : ev.error } : it));
          return;
        }
        jobRef.current = null;
        if (ev.cancelled) return;
        // Anything still pending never got a verdict (e.g. connection lost).
        update((it) => (idSet.has(it.id) && it.status === 'pending' ? { ...it, status: 'error', error: ev.error ?? 'Not downloaded' } : it));
        const failedNote = ev.failed ? ` · ${ev.failed} failed` : '';
        setDownload({
          running: false,
          tone: ev.saved === 0 ? 'error' : ev.failed ? 'warn' : 'ok',
          message: ev.saved ? `Saved ${ev.saved} image${ev.saved === 1 ? '' : 's'}${ev.filename ? ` → ${ev.filename}` : ''}${failedNote}` : ev.error ?? `Download failed${failedNote}`,
        });
      },
    );
  };

  const cancelDownload = () => {
    jobRef.current?.cancel();
    jobRef.current = null;
    update((it) => (it.status === 'pending' ? { ...it, status: undefined, stage: undefined, pct: undefined } : it));
    setDownload({ running: false, tone: 'warn', message: 'Cancelled.' });
  };

  const setOutput = (id: number, output: OutputSettings) => update((it) => (it.id === id ? { ...it, output } : it));
  const setFileName = (id: number, fileName: string) => update((it) => (it.id === id ? { ...it, fileName: fileName || undefined } : it));

  const applyToSelected = (fromId: number) => {
    const from = items.find((it) => it.id === fromId);
    if (!from) return;
    const settings = from.output;
    const visibleIds = new Set(visibleItems().map((v) => v.id));
    update((it) =>
      it.id !== fromId && it.selected && visibleIds.has(it.id)
        ? { ...it, output: settings ? adaptSettings(settings, displaySize(from), displaySize(it)) : undefined }
        : it,
    );
  };

  const grantAccess = () => {
    const msg: RuntimeMessage = { type: 'open-permissions' };
    void browser.runtime.sendMessage(msg).catch(() => {});
  };

  if (phase === 'selecting') return <SelectionOverlay onSelect={onSelect} tick={tick} />;

  const visible = visibleItems();
  return (
    <>
      <Highlights items={visible} hoverId={hoverId} hoverGroup={items.find((it) => it.id === hoverId)?.dupGroup} tick={tick} />
      <Panel
        items={items}
        minSize={minSize}
        download={download}
        onMinSize={setMinSize}
        onToggle={(id) => update((it) => (it.id === id ? { ...it, selected: !it.selected } : it))}
        onSelectAll={(selected) => {
          const ids = new Set(visible.map((v) => v.id));
          update((it) => (ids.has(it.id) ? { ...it, selected } : it));
        }}
        onDownloadSelected={() => {
          const sel = visible.filter((it) => it.selected);
          run(sel, sel.length > 1);
        }}
        onDownloadAll={() => run(visible, true)}
        onCancelDownload={cancelDownload}
        editingId={editingId}
        onEdit={setEditingId}
        onOutputChange={setOutput}
        onApplyToSelected={applyToSelected}
        onFileName={setFileName}
        dup={dup}
        onToggleDuplicates={toggleDuplicates}
        onDeselectDuplicates={deselectDuplicates}
        onReselect={reselect}
        onClose={onClose}
        onHover={setHoverId}
        onNaturalSize={(id, w, h) =>
          update((it) => (it.id === id && (it.naturalWidth !== w || it.naturalHeight !== h) ? { ...it, naturalWidth: w, naturalHeight: h } : it))
        }
        onGrantAccess={grantAccess}
      />
    </>
  );
}
