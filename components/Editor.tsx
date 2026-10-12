import { useEffect, useState } from 'preact/hooks';
import {
  AI_TARGET_LONG_SIDE,
  cropForAspect,
  croppedSize,
  DEFAULT_OUTPUT,
  isDefaultOutput,
  isFullCrop,
  normalizeCrop,
  type CropRect,
  mimeLabel,
  outputMime,
  targetSize,
  type Enhance,
  type OutputFormat,
  type OutputSettings,
  type Size,
} from '../lib/output';
import { MAX_NAME_LENGTH, sanitizeFileName } from '../lib/fileNames';
import { CropEditor } from './CropEditor';
import { formatOf, sourceExt, type PanelItem } from './Panel';

interface Props {
  item: PanelItem;
  src: Size;
  position: number;
  total: number;
  selectedCount: number;
  onChange(s: OutputSettings): void;
  onApplyToSelected(): void;
  onBack(): void;
  onFileName(name: string): void;
  /** Extension the file will be saved with. */
  ext: string;
  /** Another image already uses this name + extension. */
  nameTaken: boolean;
}

const SCALE_PRESETS = [0.5, 1, 2, 4];

/** Crop aspect presets; `0` means "the image's own ratio". */
const ASPECTS: [string, number | null][] = [
  ['Free', null],
  ['Original', 0],
  ['1:1', 1],
  ['4:3', 4 / 3],
  ['3:4', 3 / 4],
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
];

const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;

export function Editor({ item, src, position, total, selectedCount, onChange, onApplyToSelected, onBack, onFileName, ext, nameTaken }: Props) {
  const s = item.output ?? DEFAULT_OUTPUT;
  const out = targetSize(src, s);
  const srcExt = sourceExt(item);
  const mime = outputMime(s.format, srcExt);
  const isAi = s.enhance === 'ai4k';
  const [lock, setLock] = useState(true);
  const [w, setW] = useState(String(out.width));
  const [h, setH] = useState(String(out.height));
  const [applied, setApplied] = useState(false);
  const [cropping, setCropping] = useState(false);
  const [aspectKey, setAspectKey] = useState('Free');
  const cropped = croppedSize(src, s.crop);
  const aspectValue = ASPECTS.find(([k]) => k === aspectKey)?.[1] ?? null;
  const lockedAspect = aspectValue === 0 ? src.width / Math.max(1, src.height) : aspectValue;
  useEffect(() => {
    setCropping(false);
    setAspectKey('Free');
  }, [item.id]);

  // Keep the inputs in sync when presets / enhance change the size.
  useEffect(() => {
    setW(String(out.width));
    setH(String(out.height));
  }, [out.width, out.height]);
  useEffect(() => setApplied(false), [item.id]);

  const set = (patch: Partial<OutputSettings>) => {
    setApplied(false);
    onChange({ ...s, ...patch });
  };

  /** Keep an exact output size meaningful when the crop changes by switching it to a scale factor. */
  const setCrop = (c: CropRect | undefined) => {
    const crop = c && !isFullCrop(c) ? normalizeCrop(c, src) : undefined;
    const resize = s.resize.kind === 'exact' ? { kind: 'scale' as const, factor: s.resize.width / Math.max(1, cropped.width) } : s.resize;
    set({ crop, resize });
  };

  const setEnhance = (enhance: Enhance) => {
    const isScale = (f: number) => s.resize.kind === 'scale' && s.resize.factor === f;
    let resize = s.resize;
    // HD means "bigger and sharper": go to 2× when switching it on from 1×, and back when switching off.
    if (enhance === 'hd' && isScale(1)) resize = { kind: 'scale', factor: 2 };
    if (enhance !== 'hd' && s.enhance === 'hd' && isScale(2)) resize = { kind: 'scale', factor: 1 };
    set({ enhance, resize });
  };

  const commitSize = (which: 'w' | 'h', raw: string) => {
    which === 'w' ? setW(raw) : setH(raw);
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 1) return;
    const ratio = cropped.height / Math.max(1, cropped.width);
    let width = which === 'w' ? n : Number(w) || out.width;
    let height = which === 'h' ? n : Number(h) || out.height;
    if (lock) {
      if (which === 'w') height = Math.max(1, Math.round(n * ratio));
      else width = Math.max(1, Math.round(n / ratio));
    }
    set({ resize: { kind: 'exact', width, height } });
  };

  const activeFactor = s.resize.kind === 'scale' ? s.resize.factor : null;
  const originalLabel = formatOf(item);

  return (
    <div class="rig-editor">
      <div class="rig-editor-nav">
        <button class="rig-btn rig-btn-ghost" onClick={onBack}>
          ← All images
        </button>
        <span class="rig-muted">
          Image {position} of {total}
        </span>
      </div>

      <CropEditor url={item.url} src={src} crop={s.crop} aspect={lockedAspect} active={cropping} onChange={setCrop} />
      <div class="rig-editor-src rig-muted">
        Original: {src.width}×{src.height} · {originalLabel === '?' ? 'unknown format' : originalLabel}
        {!isFullCrop(s.crop) && ` · Crop: ${cropped.width}×${cropped.height}`}
      </div>

      <section class="rig-field">
        <div class="rig-field-label">Crop</div>
        <div class="rig-crop-bar">
          <button class={`rig-btn${cropping ? ' rig-btn-primary' : ''}`} onClick={() => setCropping(!cropping)}>
            {cropping ? 'Done cropping' : isFullCrop(s.crop) ? 'Crop' : 'Edit crop'}
          </button>
          {!isFullCrop(s.crop) && (
            <button class="rig-btn rig-btn-ghost" onClick={() => setCrop(undefined)}>
              Reset crop
            </button>
          )}
        </div>
        {cropping && (
          <>
            <div class="rig-chips">
              {ASPECTS.map(([label, value]) => (
                <button
                  key={label}
                  class={`rig-chip-btn${aspectKey === label ? ' is-active' : ''}`}
                  onClick={() => {
                    setAspectKey(label);
                    if (value !== null) setCrop(cropForAspect(src, value === 0 ? src.width / Math.max(1, src.height) : value, s.crop));
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <p class="rig-help">Drag the corners or edges, move the box, or drag on the dark area to draw a new one.</p>
          </>
        )}
      </section>

      <section class="rig-field">
        <label class="rig-field-label" for="rig-filename">
          File name
        </label>
        <div class="rig-filename">
          <input
            id="rig-filename"
            type="text"
            value={item.fileName ?? ''}
            placeholder={`Automatic (${location.hostname.replace(/^www\./, '') || 'page'}_##)`}
            maxLength={MAX_NAME_LENGTH + 20}
            spellcheck={false}
            onInput={(e) => onFileName((e.currentTarget as HTMLInputElement).value)}
            onBlur={(e) => {
              const clean = sanitizeFileName((e.currentTarget as HTMLInputElement).value);
              if (clean !== (item.fileName ?? '')) onFileName(clean);
            }}
          />
          <span class="rig-filename-ext">.{ext}</span>
          {item.fileName && (
            <button class="rig-filename-clear" title="Use the automatic name" aria-label="Clear file name" onClick={() => onFileName('')}>
              ×
            </button>
          )}
        </div>
        {item.fileName && sanitizeFileName(item.fileName) !== item.fileName.trim() && (
          <p class="rig-help">Will be saved as “{sanitizeFileName(item.fileName) || 'automatic name'}.{ext}”.</p>
        )}
        {nameTaken && (
          <p class="rig-help rig-warn">
            Another image uses this name, so one of them will be saved as “{sanitizeFileName(item.fileName)} (2).{ext}”.
          </p>
        )}
      </section>

      <section class="rig-field">
        <div class="rig-field-label">Enhance</div>
        <div class="rig-seg" role="radiogroup" aria-label="Enhance">
          {(
            [
              ['none', 'None'],
              ['hd', 'HD'],
              ['ai4k', '4K AI'],
            ] as [Enhance, string][]
          ).map(([v, label]) => (
            <button key={v} role="radio" aria-checked={s.enhance === v} class={s.enhance === v ? 'is-active' : ''} onClick={() => setEnhance(v)}>
              {label}
            </button>
          ))}
        </div>
        {s.enhance === 'hd' && (
          <>
            <p class="rig-help">High-quality resampling plus sharpening. Instant, runs on this device.</p>
            <label class="rig-slider">
              <span>Sharpness</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(s.sharpen * 100)}
                onInput={(e) => set({ sharpen: Number((e.currentTarget as HTMLInputElement).value) / 100 })}
              />
              <span class="rig-slider-val">{Math.round(s.sharpen * 100)}</span>
            </label>
          </>
        )}
        {isAi && (
          <p class="rig-help">
            Real-ESRGAN AI upscaling to {AI_TARGET_LONG_SIDE}px on the long side. Runs privately on this device, free.
            {hasWebGpu ? ' Takes a few seconds to a minute per image.' : ' WebGPU is unavailable, so it will run on the CPU and be slow.'}
          </p>
        )}
      </section>

      <section class="rig-field">
        <div class="rig-field-label">Size</div>
        <div class="rig-size">
          <input type="number" min={1} value={w} disabled={isAi} aria-label="Width" onInput={(e) => commitSize('w', (e.currentTarget as HTMLInputElement).value)} />
          <button
            class={`rig-lock${lock ? ' is-on' : ''}`}
            disabled={isAi}
            onClick={() => setLock(!lock)}
            title={lock ? 'Aspect ratio locked' : 'Aspect ratio unlocked'}
            aria-pressed={lock}
          >
            {lock ? '🔒' : '🔓'}
          </button>
          <input type="number" min={1} value={h} disabled={isAi} aria-label="Height" onInput={(e) => commitSize('h', (e.currentTarget as HTMLInputElement).value)} />
          <span class="rig-muted">px</span>
        </div>
        <div class="rig-chips">
          {SCALE_PRESETS.map((f) => (
            <button key={f} class={`rig-chip-btn${activeFactor === f ? ' is-active' : ''}`} disabled={isAi} onClick={() => set({ resize: { kind: 'scale', factor: f } })}>
              {f * 100}%
            </button>
          ))}
        </div>
      </section>

      <section class="rig-field">
        <div class="rig-field-label">Format</div>
        <div class="rig-seg" role="radiogroup" aria-label="Format">
          {(
            [
              ['original', 'Original'],
              ['png', 'PNG'],
              ['jpeg', 'JPG'],
              ['webp', 'WebP'],
            ] as [OutputFormat, string][]
          ).map(([v, label]) => (
            <button key={v} role="radio" aria-checked={s.format === v} class={s.format === v ? 'is-active' : ''} onClick={() => set({ format: v })}>
              {label}
            </button>
          ))}
        </div>
        {(mime === 'image/jpeg' || mime === 'image/webp') && !(s.format === 'original' && isDefaultOutput(s)) && (
          <label class="rig-slider">
            <span>Quality</span>
            <input
              type="range"
              min={50}
              max={100}
              value={Math.round(s.quality * 100)}
              onInput={(e) => set({ quality: Number((e.currentTarget as HTMLInputElement).value) / 100 })}
            />
            <span class="rig-slider-val">{Math.round(s.quality * 100)}</span>
          </label>
        )}
        {s.format === 'original' && !isDefaultOutput(s) && !['jpg', 'png', 'webp'].includes(srcExt ?? '') && (
          <p class="rig-help">This format can't be re-encoded, so it will be saved as PNG.</p>
        )}
      </section>

      <div class="rig-output">
        <span class="rig-muted">Output</span>
        <strong>
          {isDefaultOutput(s) ? `Original file · ${src.width}×${src.height}` : `${out.width}×${out.height} · ${mimeLabel(mime)}${s.enhance === 'hd' ? ' · HD' : isAi ? ' · AI' : ''}${isFullCrop(s.crop) ? '' : ' · Cropped'}`}
        </strong>
      </div>

      <div class="rig-editor-actions">
        <button class="rig-btn rig-btn-ghost" disabled={isDefaultOutput(s)} onClick={() => set({ ...DEFAULT_OUTPUT })}>
          Reset
        </button>
        <button
          class="rig-btn"
          disabled={selectedCount === 0}
          onClick={() => {
            onApplyToSelected();
            setApplied(true);
          }}
        >
          {applied ? 'Applied ✓' : `Apply to selected (${selectedCount})`}
        </button>
      </div>
    </div>
  );
}
