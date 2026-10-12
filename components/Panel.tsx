import type { DetectedImage } from '../lib/detectImages';
import type { Fingerprint } from '../lib/dupes';
import { extFromMime, extFromUrl, formatLabel, sanitizeFileName } from '../lib/fileNames';
import { isDefaultOutput, isFullCrop, mimeLabel, outputMime, targetSize, type OutputSettings, type Size } from '../lib/output';
import { CroppedThumb } from './CropEditor';
import { Editor } from './Editor';

export interface PanelItem extends DetectedImage {
  id: number;
  selected: boolean;
  /** Intrinsic size learned when the thumbnail loads (useful for CSS backgrounds). */
  naturalWidth?: number;
  naturalHeight?: number;
  /** Resize / convert / enhance; undefined = save the original file. */
  output?: OutputSettings;
  status?: 'pending' | 'ok' | 'error';
  /** Live progress while pending. */
  stage?: 'fetching' | 'processing' | 'upscaling';
  pct?: number;
  error?: string;
  /** Duplicate detection. */
  fp?: Fingerprint;
  dupGroup?: number;
  /** Best (largest) copy in its group. */
  dupKeeper?: boolean;
  dupSize?: number;
  /** Unticked automatically as a duplicate (so it can be restored if detection is turned off). */
  autoUnchecked?: boolean;
  /** Real file format, known once the bytes were fetched (URLs often have no extension). */
  fileExt?: string;
  /** Custom base name for the saved file (no extension); empty/undefined = automatic. */
  fileName?: string;
}

export interface DupState {
  enabled: boolean;
  running: boolean;
  done: number;
  total: number;
  groups: number;
  /** Number of extra copies (group sizes minus one). */
  dupes: number;
}

export interface DownloadState {
  running: boolean;
  done?: number;
  total?: number;
  message?: string;
  tone?: 'ok' | 'warn' | 'error';
}

interface Props {
  items: PanelItem[];
  minSize: number;
  download: DownloadState;
  editingId: number | null;
  onMinSize(n: number): void;
  onToggle(id: number): void;
  onSelectAll(selected: boolean): void;
  onDownloadSelected(): void;
  onDownloadAll(): void;
  onCancelDownload(): void;
  onReselect(): void;
  onClose(): void;
  onHover(id: number | null): void;
  onNaturalSize(id: number, w: number, h: number): void;
  onGrantAccess(): void;
  onEdit(id: number | null): void;
  onOutputChange(id: number, s: OutputSettings): void;
  onApplyToSelected(fromId: number): void;
  onFileName(id: number, name: string): void;
  dup: DupState;
  onToggleDuplicates(enabled: boolean): void;
  onDeselectDuplicates(): void;
}

/** Keep each duplicate group together (best copy first) at the position of its first member. */
function groupOrder(items: PanelItem[]): PanelItem[] {
  const out: PanelItem[] = [];
  const emitted = new Set<number>();
  for (const it of items) {
    if (emitted.has(it.id)) continue;
    if (it.dupGroup === undefined) {
      out.push(it);
      emitted.add(it.id);
      continue;
    }
    const members = items.filter((m) => m.dupGroup === it.dupGroup).sort((a, b) => Number(!!b.dupKeeper) - Number(!!a.dupKeeper));
    for (const m of members) {
      out.push(m);
      emitted.add(m.id);
    }
  }
  return out;
}

const KIND_LABEL: Record<PanelItem['type'], string> = {
  img: 'Image',
  svg: 'SVG',
  canvas: 'Canvas',
  video: 'Video poster',
  background: 'Background',
};

export function displaySize(it: PanelItem): Size {
  return it.naturalWidth ? { width: it.naturalWidth, height: it.naturalHeight! } : { width: it.width, height: it.height };
}

export function sourceExt(it: PanelItem): string | null {
  return it.type === 'svg' ? 'svg' : it.type === 'canvas' ? 'png' : it.fileExt ?? extFromUrl(it.url);
}

/** Extension the saved file will get. */
export function outputExt(it: PanelItem): string {
  if (isDefaultOutput(it.output)) return sourceExt(it) ?? 'jpg';
  return extFromMime(outputMime(it.output!.format, sourceExt(it))) ?? 'png';
}

export function formatOf(it: PanelItem): string {
  const label = formatLabel(it.url, it.type);
  return label === '?' && it.fileExt ? it.fileExt.toUpperCase() : label;
}

function outputSummary(it: PanelItem): string | null {
  if (isDefaultOutput(it.output)) return null;
  const s = it.output!;
  const t = targetSize(displaySize(it), s);
  const tag = (s.enhance === 'ai4k' ? ' · AI' : s.enhance === 'hd' ? ' · HD' : '') + (isFullCrop(s.crop) ? '' : ' · Crop');
  return `→ ${t.width}×${t.height} ${mimeLabel(outputMime(s.format, sourceExt(it)))}${tag}`;
}

function statusText(it: PanelItem): string | null {
  if (it.status !== 'pending') return null;
  if (it.stage === 'upscaling') return `AI ${it.pct ?? 0}%`;
  if (it.stage === 'processing') return 'Processing…';
  return null;
}

export function Panel(p: Props) {
  const visible = groupOrder(
    p.items.filter((it) => {
      const { width, height } = displaySize(it);
      return width >= p.minSize && height >= p.minSize;
    }),
  );
  const dupesStillSelected = p.items.some((it) => it.dupGroup !== undefined && !it.dupKeeper && it.selected);
  const selectedCount = visible.filter((it) => it.selected).length;
  const allSelected = visible.length > 0 && selectedCount === visible.length;
  const hidden = p.items.length - visible.length;
  const corsFailure = p.items.some((it) => it.status === 'error' && /cross-origin/i.test(it.error ?? ''));
  const editing = p.editingId !== null ? p.items.find((it) => it.id === p.editingId) : undefined;
  const aiCount = visible.filter((it) => it.selected && it.output?.enhance === 'ai4k').length;

  return (
    <aside class="rig-panel" role="dialog" aria-label="Region Image Grabber">
      <header class="rig-header">
        <div class="rig-title">
          <strong>Images in region</strong>
          <span class="rig-muted">
            {visible.length}
            {hidden > 0 && ` · ${hidden} hidden by size filter`}
          </span>
        </div>
        <button class="rig-btn rig-btn-ghost" onClick={p.onReselect} title="Draw a new region">
          Reselect
        </button>
        <button class="rig-icon-btn" onClick={p.onClose} aria-label="Close (Esc)" title="Close (Esc)">
          ×
        </button>
      </header>

      {editing ? (
        <div class="rig-grid-wrap">
          <Editor
            item={editing}
            src={displaySize(editing)}
            position={visible.findIndex((v) => v.id === editing.id) + 1 || 1}
            total={visible.length}
            selectedCount={visible.filter((v) => v.selected && v.id !== editing.id).length}
            onChange={(s) => p.onOutputChange(editing.id, s)}
            onApplyToSelected={() => p.onApplyToSelected(editing.id)}
            onFileName={(name) => p.onFileName(editing.id, name)}
            ext={outputExt(editing)}
            nameTaken={
              !!sanitizeFileName(editing.fileName) &&
              p.items.some(
                (o) =>
                  o.id !== editing.id &&
                  sanitizeFileName(o.fileName).toLowerCase() === sanitizeFileName(editing.fileName).toLowerCase() &&
                  outputExt(o) === outputExt(editing),
              )
            }
            onBack={() => p.onEdit(null)}
          />
        </div>
      ) : (
        <>
          <div class="rig-toolbar">
            <label class="rig-minsize">
              Min size
              <input
                type="number"
                min={0}
                step={10}
                value={p.minSize}
                onInput={(e) => p.onMinSize(Math.max(0, Number((e.currentTarget as HTMLInputElement).value) || 0))}
              />
              <span class="rig-muted">px</span>
            </label>
            <button class="rig-btn rig-btn-ghost" disabled={!visible.length} onClick={() => p.onSelectAll(!allSelected)}>
              {allSelected ? 'Select none' : 'Select all'}
            </button>
          </div>

          <div class="rig-dupbar">
            <label class="rig-switch" title="Find look-alike images (same picture at different sizes or formats)">
              <input type="checkbox" checked={p.dup.enabled} onChange={(e) => p.onToggleDuplicates((e.currentTarget as HTMLInputElement).checked)} />
              <span>Duplicates</span>
            </label>
            <span class="rig-dupbar-status">
              {!p.dup.enabled
                ? 'off'
                : p.dup.running
                  ? `Checking… ${p.dup.done}/${p.dup.total}`
                  : p.dup.dupes
                    ? `${p.dup.dupes} duplicate${p.dup.dupes === 1 ? '' : 's'} in ${p.dup.groups} group${p.dup.groups === 1 ? '' : 's'}`
                    : p.dup.total > 1
                      ? 'None found'
                      : ''}
            </span>
            {p.dup.enabled && !p.dup.running && dupesStillSelected && (
              <button class="rig-link" onClick={p.onDeselectDuplicates}>
                Deselect duplicates
              </button>
            )}
          </div>

          <div class="rig-grid-wrap">
            {visible.length === 0 ? (
              <div class="rig-empty">
                <p>{p.items.length ? 'Every image is below the minimum size.' : 'No images found in that region.'}</p>
                <button class="rig-btn" onClick={p.onReselect}>
                  Select another region
                </button>
              </div>
            ) : (
              <ul class="rig-list">
                {visible.map((it) => {
                  const { width, height } = displaySize(it);
                  const summary = outputSummary(it);
                  const progress = statusText(it);
                  return (
                    <li
                      key={it.id}
                      class={`rig-row${it.selected ? ' is-selected' : ''}${it.status === 'error' ? ' is-error' : ''}${it.dupGroup !== undefined ? ' in-dup-group' : ''}${it.dupGroup !== undefined && !it.dupKeeper ? ' is-dup' : ''}${it.dupKeeper ? ' is-dup-keeper' : ''}`}
                      onMouseEnter={() => p.onHover(it.id)}
                      onMouseLeave={() => p.onHover(null)}
                    >
                      <label class="rig-row-main">
                        <input type="checkbox" class="rig-row-check" checked={it.selected} onChange={() => p.onToggle(it.id)} />
                        <div class="rig-row-thumb">
                          <CroppedThumb
                            url={it.url}
                            crop={isFullCrop(it.output?.crop) ? undefined : it.output!.crop}
                            src={displaySize(it)}
                            box={56}
                            onLoad={(e) => {
                              const img = e.currentTarget as HTMLImageElement;
                              if ((it.type === 'background' || it.type === 'img' || it.type === 'video') && img.naturalWidth > 0) {
                                p.onNaturalSize(it.id, img.naturalWidth, img.naturalHeight);
                              }
                            }}
                          />
                        </div>
                        <div class="rig-row-info">
                          <div class="rig-row-title">
                            <span class="rig-row-dims">
                              {width}×{height}
                            </span>
                            <span class="rig-chip">{formatOf(it)}</span>
                            {it.dupGroup !== undefined ? (
                              <span
                                class={`rig-dup-chip${it.dupKeeper ? ' is-keeper' : ''}`}
                                title={it.dupKeeper ? `Largest of ${it.dupSize} look-alike images` : 'Looks the same as the image above'}
                              >
                                {it.dupKeeper ? `Best of ${it.dupSize}` : 'Duplicate'}
                              </span>
                            ) : (
                              <span class="rig-muted rig-row-kind">{KIND_LABEL[it.type]}</span>
                            )}
                          </div>
                          {progress ? (
                            <div class="rig-row-progress">
                              <span>{progress}</span>
                              {it.stage === 'upscaling' && (
                                <span class="rig-row-bar">
                                  <span style={{ width: `${it.pct ?? 0}%` }} />
                                </span>
                              )}
                            </div>
                          ) : it.status === 'error' ? (
                            <div class="rig-error" title={it.error}>
                              {it.error}
                            </div>
                          ) : (
                            <div class="rig-row-sub">
                              {sanitizeFileName(it.fileName) && (
                                <span class="rig-row-name" title="File name">
                                  {sanitizeFileName(it.fileName)}.{outputExt(it)}
                                </span>
                              )}
                              {summary ? (
                                <span class="rig-out" title={summary}>
                                  {summary}
                                </span>
                              ) : (
                                !sanitizeFileName(it.fileName) && <span class="rig-muted">Original file</span>
                              )}
                            </div>
                          )}
                        </div>
                      </label>
                      {it.status === 'ok' && <span class="rig-row-status is-ok" title="Downloaded">✓</span>}
                      {it.status === 'error' && <span class="rig-row-status is-error" title={it.error}>!</span>}
                      <button
                        type="button"
                        class={`rig-row-edit${summary || sanitizeFileName(it.fileName) ? ' is-modified' : ''}`}
                        title="Resize, convert or enhance"
                        aria-label="Edit output"
                        onClick={() => p.onEdit(it.id)}
                      >
                        ✎
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      <footer class="rig-footer">
        {(p.download.running || p.download.message) && (
          <div class={`rig-progress rig-tone-${p.download.tone ?? 'ok'}`} role="status">
            {p.download.running ? `Working… ${p.download.done ?? 0}/${p.download.total ?? 0}` : p.download.message}
            {p.download.running && (
              <button class="rig-link" onClick={p.onCancelDownload}>
                Cancel
              </button>
            )}
            {corsFailure && !p.download.running && (
              <button class="rig-link" onClick={p.onGrantAccess}>
                Grant access to all sites
              </button>
            )}
          </div>
        )}
        {aiCount > 0 && !p.download.running && !editing && (
          <div class="rig-help">
            {aiCount} image{aiCount === 1 ? '' : 's'} will be AI-upscaled to 4K on this device. This can take a while.
          </div>
        )}
        <div class="rig-actions">
          {editing ? (
            <button class="rig-btn rig-btn-primary" onClick={() => p.onEdit(null)}>
              Done
            </button>
          ) : (
            <>
              <button class="rig-btn rig-btn-primary" disabled={!selectedCount || p.download.running} onClick={p.onDownloadSelected}>
                Download selected ({selectedCount})
              </button>
              <button class="rig-btn" disabled={!visible.length || p.download.running} onClick={p.onDownloadAll}>
                Download all (.zip)
              </button>
            </>
          )}
        </div>
      </footer>
    </aside>
  );
}
