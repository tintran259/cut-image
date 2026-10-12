import { useRef, useState } from 'preact/hooks';
import type { RectLike } from '../lib/detectImages';

interface Point {
  x: number;
  y: number;
}

interface Props {
  /** Called with the selection in viewport coordinates at the moment of release. */
  onSelect(rect: RectLike): void;
  /** Bumped by the parent on scroll so the rectangle stays pinned to the page. */
  tick: number;
}

const MIN_DRAG = 4;

/**
 * Full-viewport crosshair overlay. Drag points are stored in document
 * coordinates so the rectangle stays anchored to the page if the user scrolls
 * (wheel / trackpad) mid-drag.
 */
export function SelectionOverlay({ onSelect }: Props) {
  const [start, setStart] = useState<Point | null>(null);
  const [end, setEnd] = useState<Point | null>(null);
  const pointerId = useRef<number | null>(null);

  const toDoc = (e: PointerEvent): Point => ({ x: e.clientX + window.scrollX, y: e.clientY + window.scrollY });

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointerId.current = e.pointerId;
    const p = toDoc(e);
    setStart(p);
    setEnd(p);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (pointerId.current !== e.pointerId) return;
    setEnd(toDoc(e));
  };

  const onPointerUp = (e: PointerEvent) => {
    if (pointerId.current !== e.pointerId || !start) return;
    pointerId.current = null;
    const p = toDoc(e);
    setStart(null);
    setEnd(null);
    if (Math.abs(p.x - start.x) < MIN_DRAG || Math.abs(p.y - start.y) < MIN_DRAG) return;
    onSelect({
      left: Math.min(start.x, p.x) - window.scrollX,
      top: Math.min(start.y, p.y) - window.scrollY,
      right: Math.max(start.x, p.x) - window.scrollX,
      bottom: Math.max(start.y, p.y) - window.scrollY,
    });
  };

  const rect =
    start && end
      ? {
          left: Math.min(start.x, end.x) - window.scrollX,
          top: Math.min(start.y, end.y) - window.scrollY,
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
        }
      : null;

  return (
    <div
      class={`rig-overlay${rect ? ' is-dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        pointerId.current = null;
        setStart(null);
        setEnd(null);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {!rect && <div class="rig-hint">Drag to select a region · <kbd>Esc</kbd> to cancel</div>}
      {rect && (
        <div class="rig-selection" style={{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }}>
          <span class="rig-selection-size">
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </span>
        </div>
      )}
    </div>
  );
}
