import type { PanelItem } from './Panel';

interface Props {
  items: PanelItem[];
  hoverId: number | null;
  /** Duplicate group of the hovered item: its look-alikes are highlighted too. */
  hoverGroup?: number;
  /** Bumped on scroll / resize; positions are re-read from the live elements. */
  tick: number;
}

/** Outlines over detected images, positioned from live `getBoundingClientRect()`s. */
export function Highlights({ items, hoverId, hoverGroup }: Props) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return (
    <div class="rig-highlights" aria-hidden="true">
      {items.map((it) => {
        if (!it.element.isConnected) return null;
        const r = it.element.getBoundingClientRect();
        if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw || r.width === 0) return null;
        const cls = [
          'rig-hl',
          it.selected ? 'is-on' : 'is-off',
          it.id === hoverId && 'is-hover',
          it.id !== hoverId && hoverGroup !== undefined && it.dupGroup === hoverGroup && 'is-hover-dup',
          it.status === 'error' && 'is-error',
        ]
          .filter(Boolean)
          .join(' ');
        return <div key={it.id} class={cls} style={{ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` }} />;
      })}
    </div>
  );
}
