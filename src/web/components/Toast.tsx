import { useStore } from '../store';

export function Toast({ aboveNav }: { aboveNav: boolean }) {
  const { toast, dismissToast } = useStore();
  if (!toast) return null;
  return (
    <div className={`toast${aboveNav ? ' above-nav' : ''}`} role="status" key={toast.id}>
      <span>{toast.message}</span>
      {toast.actionLabel && (
        <button
          className="small primary"
          onClick={() => {
            toast.action?.();
            dismissToast();
          }}
        >
          {toast.actionLabel}
        </button>
      )}
      <button className="small ghost" onClick={dismissToast} aria-label="Close">
        Close
      </button>
    </div>
  );
}
