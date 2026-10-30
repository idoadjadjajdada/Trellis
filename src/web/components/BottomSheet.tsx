import { useEffect, useRef, useState, type ReactNode } from 'react';

export type SheetSize = 'half' | 'full';

interface Props {
  title?: ReactNode;
  size: SheetSize;
  onSizeChange: (size: SheetSize) => void;
  onClose: () => void;
  children: ReactNode;
  /** Height for the "half" position, as a fraction of the screen. */
  halfFraction?: number;
  label: string;
}

/**
 * A sheet that slides up from the bottom. Swipe up to expand to full screen,
 * swipe down to shrink or close.
 */
export function BottomSheet({ title, size, onSizeChange, onClose, children, halfFraction = 0.5, label }: Props) {
  const [drag, setDrag] = useState<number | null>(null); // px dragged down (+) or up (-)
  const start = useRef<{ y: number; t: number } | null>(null);
  const [vh, setVh] = useState(window.innerHeight);

  useEffect(() => {
    const onResize = () => setVh(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const baseHeight = size === 'full' ? vh - 12 : Math.round(vh * halfFraction);
  const height = Math.max(80, Math.min(vh - 12, baseHeight - (drag ?? 0)));

  const onPointerDown = (e: React.PointerEvent) => {
    // Let buttons in the header work normally.
    if ((e.target as HTMLElement).closest('button, input, select, textarea, a')) return;
    start.current = { y: e.clientY, t: Date.now() };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // The pointer may already be gone.
    }
    setDrag(0);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    setDrag(e.clientY - start.current.y);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!start.current) return;
    const dy = e.clientY - start.current.y;
    const fast = Math.abs(dy) / Math.max(1, Date.now() - start.current.t) > 0.5;
    start.current = null;
    setDrag(null);
    if (Math.abs(dy) < 6) {
      // A tap on the handle toggles the size.
      onSizeChange(size === 'half' ? 'full' : 'half');
      return;
    }
    if (dy < -40 || (fast && dy < 0)) onSizeChange('full');
    else if (dy > 40 || (fast && dy > 0)) {
      if (size === 'full' && dy < vh * 0.45) onSizeChange('half');
      else onClose();
    }
  };

  const handlers = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
  return (
    <>
      {size === 'full' && <div className="scrim" onClick={onClose} />}
      <section className={`sheet${drag !== null ? ' dragging' : ''}`} style={{ height }} role="dialog" aria-label={label}>
        <div className="grabber" {...handlers} aria-hidden="true">
          <span />
        </div>
        {title && (
          <div className="sheet-head" {...handlers}>
            {title}
          </div>
        )}
        <div className="sheet-body">{children}</div>
      </section>
    </>
  );
}
