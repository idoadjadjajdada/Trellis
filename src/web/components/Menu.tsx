import { useEffect, useRef } from 'react';

export interface MenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/** A small menu at a screen position, e.g. after a long-press on an atom. */
export function Menu({ x, y, title, items, onClose }: { x: number; y: number; title?: string; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const width = 220;
  const left = Math.max(8, Math.min(x - width / 2, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(y + 12, window.innerHeight - (items.length * 48 + 70)));
  return (
    <>
      <div className="scrim" style={{ background: 'transparent' }} onPointerDown={onClose} />
      <div className="menu" role="menu" ref={ref} style={{ left, top, width }}>
        {title && <div className="muted small-text" style={{ padding: '4px 10px 6px', overflowWrap: 'anywhere' }}>{title}</div>}
        {items.map((item) => (
          <button
            key={item.label}
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
