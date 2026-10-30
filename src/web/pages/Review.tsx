import { useCallback, useEffect, useRef, useState } from 'react';
import type { Atom } from '../../shared/types';
import { api, errorMessage } from '../api';
import { AtomChips, formatDate } from '../components/AtomDetails';
import { AtomEditor } from '../components/AtomEditor';
import { useStore } from '../store';

function useReviewAtoms() {
  const { reviewCount, refresh } = useStore();
  const [atoms, setAtoms] = useState<Atom[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const { atoms } = await api.get<{ atoms: Atom[] }>('/notes?scope=review');
      setAtoms(atoms);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, reviewCount]);
  const after = async () => {
    await Promise.all([load(), refresh()]);
  };
  return { atoms, error, setError, after, load };
}

/** Notes the AI was not sure about wait here for Approve, Edit or Delete. */
export function ReviewPage({ phone }: { phone: boolean }) {
  const { atoms, error, setError, after } = useReviewAtoms();
  const { showToast } = useStore();
  const [editingId, setEditingId] = useState<string | null>(null);

  const approve = async (a: Atom) => {
    try {
      await api.post(`/notes/${a.id}/approve`);
      await after();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const remove = async (a: Atom) => {
    try {
      await api.del(`/notes/${a.id}`);
      await after();
      showToast('Moved to Trash.', 'Undo', () => void api.post(`/notes/${a.id}/restore`).then(after));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (!atoms) return error ? <p className="error">{error}</p> : <div className="spinner" />;

  return (
    <div>
      <h1>Review</h1>
      <p className="muted">Notes the AI was not sure about. Approve them to add them to your graph.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {atoms.length === 0 && <div className="card"><p style={{ margin: 0 }}>Nothing to review.</p></div>}
      {phone && atoms.length > 0 ? (
        <SwipeReview
          key={atoms[0].id}
          atom={atoms[0]}
          remaining={atoms.length}
          editing={editingId === atoms[0].id}
          onEdit={() => setEditingId(atoms[0].id)}
          onEditDone={(saved) => {
            setEditingId(null);
            if (saved) void after();
          }}
          onApprove={() => approve(atoms[0])}
          onDelete={() => remove(atoms[0])}
        />
      ) : (
        <ul className="atom-list">
          {atoms.map((a) => (
            <li key={a.id} className="card" style={{ marginBottom: 10, listStyle: 'none' }}>
              {editingId === a.id ? (
                <AtomEditor
                  atom={a}
                  onDone={(saved) => {
                    setEditingId(null);
                    if (saved) void after();
                  }}
                />
              ) : (
                <>
                  <p className="atom-big-text">{a.text}</p>
                  <AtomChips atom={a} />
                  <p className="muted small-text" style={{ marginTop: 8 }}>
                    From {a.sourceAi ?? 'an AI app'}
                    {a.sourceChat ? ` · ${a.sourceChat}` : ''} · {formatDate(a.createdAt)}
                  </p>
                  <div className="row">
                    <button className="primary" onClick={() => approve(a)}>Approve</button>
                    <button onClick={() => setEditingId(a.id)}>Edit</button>
                    <button className="danger" onClick={() => remove(a)}>Delete</button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface SwipeProps {
  atom: Atom;
  remaining: number;
  editing: boolean;
  onEdit: () => void;
  onEditDone: (saved: Atom | null) => void;
  onApprove: () => void;
  onDelete: () => void;
}

/** Phone: one atom at a time. Swipe right to approve, left to delete. */
function SwipeReview({ atom, remaining, editing, onEdit, onEditDone, onApprove, onDelete }: SwipeProps) {
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState<'left' | 'right' | null>(null);
  const start = useRef<{ x: number; y: number; id: number; horizontal: boolean | null } | null>(null);
  const threshold = Math.min(120, window.innerWidth * 0.28);

  const finish = (dir: 'left' | 'right') => {
    setLeaving(dir);
    setTimeout(() => (dir === 'right' ? onApprove() : onDelete()), 180);
  };

  if (editing) {
    return (
      <div className="card" style={{ marginTop: 8 }}>
        <AtomEditor atom={atom} onDone={onEditDone} />
      </div>
    );
  }

  const offset = leaving === 'right' ? window.innerWidth : leaving === 'left' ? -window.innerWidth : dx;
  return (
    <div>
      <p className="muted small-text">{remaining} waiting</p>
      <div className="review-stack">
        <div
          className="review-card"
          style={{
            transform: `translateX(${offset}px) rotate(${offset / 30}deg)`,
            transition: start.current ? 'none' : 'transform 0.18s ease',
          }}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, horizontal: null };
          }}
          onPointerMove={(e) => {
            const s = start.current;
            if (!s || s.id !== e.pointerId) return;
            const mx = e.clientX - s.x;
            const my = e.clientY - s.y;
            if (s.horizontal === null && Math.hypot(mx, my) > 8) {
              s.horizontal = Math.abs(mx) > Math.abs(my);
              if (s.horizontal) {
                try {
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                } catch {
                  // The pointer may already be gone; the swipe still works without capture.
                }
              }
            }
            if (s.horizontal) setDx(mx);
          }}
          onPointerUp={() => {
            const s = start.current;
            start.current = null;
            if (s?.horizontal && Math.abs(dx) > threshold) finish(dx > 0 ? 'right' : 'left');
            else setDx(0);
          }}
          onPointerCancel={() => {
            start.current = null;
            setDx(0);
          }}
        >
          <span className="stamp approve" style={{ opacity: Math.max(0, Math.min(1, dx / threshold)) }}>Approve</span>
          <span className="stamp delete" style={{ opacity: Math.max(0, Math.min(1, -dx / threshold)) }}>Delete</span>
          <p className="atom-big-text" style={{ marginTop: 28 }}>{atom.text}</p>
          <AtomChips atom={atom} />
          <p className="muted small-text" style={{ marginTop: 8 }}>
            From {atom.sourceAi ?? 'an AI app'}
            {atom.sourceChat ? ` · ${atom.sourceChat}` : ''}
          </p>
        </div>
      </div>
      <p className="muted small-text" style={{ textAlign: 'center' }}>Swipe right to approve, left to delete.</p>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <button className="grow danger" onClick={() => finish('left')}>Delete</button>
        <button className="grow" onClick={onEdit}>Edit</button>
        <button className="grow primary" onClick={() => finish('right')}>Approve</button>
      </div>
    </div>
  );
}
