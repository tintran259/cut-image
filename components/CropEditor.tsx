import { useRef } from 'preact/hooks';
import { normalizeCrop, type CropRect, type Size } from '../lib/output';

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface Props {
  url: string;
  /** Source pixel size (crop math is in fractions, ratios need pixels). */
  src: Size;
  crop: CropRect | undefined;
  /** Locked pixel aspect ratio (w/h), or null for free cropping. */
  aspect: number | null;
  /** Show handles and accept dragging. */
  active: boolean;
  onChange(crop: CropRect): void;
}

const FULL: CropRect = { x: 0, y: 0, w: 1, h: 1 };
const HANDLES: Exclude<Handle, 'move'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Image preview with a draggable crop rectangle. All geometry is in fractions
 * of the image, so it maps 1:1 onto the full-resolution source later.
 */
export function CropEditor({ url, src, crop, aspect, active, onChange }: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ handle: Handle; start: CropRect; px: number; py: number; fw: number; fh: number; pointerId: number } | null>(null);
  const c = crop ?? FULL;
  // Aspect in fraction space: (w·srcW)/(h·srcH) = aspect  →  w/h = aspect · srcH / srcW
  const fracAspect = aspect ? (aspect * src.height) / Math.max(1, src.width) : null;

  const begin = (e: PointerEvent, handle: Handle, start: CropRect) => {
    if (!active || e.button !== 0 || !frameRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const r = frameRef.current.getBoundingClientRect();
    frameRef.current.setPointerCapture(e.pointerId);
    drag.current = { handle, start, px: e.clientX, py: e.clientY, fw: r.width, fh: r.height, pointerId: e.pointerId };
  };

  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = (e.clientX - d.px) / d.fw;
    const dy = (e.clientY - d.py) / d.fh;
    const s = d.start;

    if (d.handle === 'move') {
      onChange(normalizeCrop({ ...s, x: s.x + dx, y: s.y + dy }, src));
      return;
    }

    let left = s.x;
    let top = s.y;
    let right = s.x + s.w;
    let bottom = s.y + s.h;
    if (d.handle.includes('w')) left = Math.min(right, Math.max(0, left + dx));
    if (d.handle.includes('e')) right = Math.max(left, Math.min(1, right + dx));
    if (d.handle.includes('n')) top = Math.min(bottom, Math.max(0, top + dy));
    if (d.handle.includes('s')) bottom = Math.max(top, Math.min(1, bottom + dy));

    if (fracAspect) {
      // Corner drag with a locked ratio: follow the larger movement, anchored at the opposite corner.
      const ax = d.handle.includes('w') ? s.x + s.w : s.x;
      const ay = d.handle.includes('n') ? s.y + s.h : s.y;
      let w = right - left;
      let h = bottom - top;
      // Follow whichever axis the pointer moved more along (relative to the start size).
      const fromW = Math.abs(w - s.w);
      const fromH = Math.abs(h * fracAspect - s.w);
      if (fromW >= fromH) h = w / fracAspect;
      else w = h * fracAspect;
      const maxW = d.handle.includes('w') ? ax : 1 - ax;
      const maxH = d.handle.includes('n') ? ay : 1 - ay;
      const k = Math.min(1, maxW / w, maxH / h);
      w *= k;
      h *= k;
      left = d.handle.includes('w') ? ax - w : ax;
      top = d.handle.includes('n') ? ay - h : ay;
      right = left + w;
      bottom = top + h;
    }
    onChange(normalizeCrop({ x: left, y: top, w: right - left, h: bottom - top }, src));
  };

  const end = (e: PointerEvent) => {
    if (drag.current?.pointerId === e.pointerId) drag.current = null;
  };

  /** Dragging on the dimmed area draws a new crop from that point. */
  const onFrameDown = (e: PointerEvent) => {
    if (!active || !frameRef.current) return;
    const r = frameRef.current.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    begin(e, 'se', { x, y, w: 0, h: 0 });
  };

  const showRect = active || !!crop;
  return (
    <div class={`rig-crop-stage${active ? ' is-active' : ''}`}>
      <div
        class="rig-crop-frame"
        ref={frameRef}
        onPointerDown={onFrameDown}
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <img src={url} alt="" draggable={false} />
        {showRect && (
          <div
            class="rig-crop-rect"
            style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` }}
            // With no crop yet the box covers the whole image, so dragging draws a new crop instead.
            onPointerDown={(e) => (crop ? begin(e, 'move', c) : onFrameDown(e))}
          >
            {active && (
              <>
                <span class="rig-crop-grid" />
                {HANDLES.filter((h) => !fracAspect || h.length === 2).map((h) => (
                  <span key={h} class={`rig-crop-handle h-${h}`} onPointerDown={(e) => begin(e, h, c)} />
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Small preview that shows only the cropped part of an image (for list rows). */
export function CroppedThumb({ url, crop, src, box, onLoad }: { url: string; crop?: CropRect; src: Size; box: number; onLoad?: (e: Event) => void }) {
  if (!crop) return <img src={url} alt="" loading="lazy" decoding="async" onLoad={onLoad} />;
  const cw = crop.w * src.width;
  const ch = crop.h * src.height;
  const k = Math.min(box / cw, box / ch);
  return (
    <span class="rig-thumb-crop" style={{ width: `${cw * k}px`, height: `${ch * k}px` }}>
      <img
        src={url}
        alt=""
        loading="lazy"
        decoding="async"
        onLoad={onLoad}
        style={{
          width: `${100 / crop.w}%`,
          height: `${100 / crop.h}%`,
          left: `${(-crop.x / crop.w) * 100}%`,
          top: `${(-crop.y / crop.h) * 100}%`,
        }}
      />
    </span>
  );
}
