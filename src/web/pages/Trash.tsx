import { useCallback, useEffect, useState } from 'react';
import type { Atom } from '../../shared/types';
import { api, errorMessage } from '../api';
import { formatDate } from '../components/AtomDetails';
import { useStore } from '../store';

const TRASH_DAYS = 30;

export function TrashPage() {
  const { refresh } = useStore();
  const [atoms, setAtoms] = useState<Atom[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAtoms((await api.get<{ atoms: Atom[] }>('/notes?scope=trash')).atoms);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await Promise.all([load(), refresh()]);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const daysLeft = (a: Atom) =>
    Math.max(0, Math.ceil(TRASH_DAYS - (Date.now() - new Date(a.deletedAt!).getTime()) / 86_400_000));

  return (
    <div>
      <div className="row" style={{ flexWrap: 'nowrap', marginBottom: 8 }}>
        <h1 className="grow" style={{ margin: 0 }}>Trash</h1>
        <button
          className="danger small"
          disabled={!atoms?.length}
          onClick={() => {
            if (window.confirm('Delete everything in Trash for good? This cannot be undone.')) void act(() => api.del('/trash'));
          }}
        >
          Empty Trash
        </button>
      </div>
      <p className="muted">Deleted notes stay here for {TRASH_DAYS} days, then they are removed for good.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {atoms && atoms.length === 0 && <div className="card"><p style={{ margin: 0 }}>Trash is empty.</p></div>}
      <ul className="atom-list">
        {atoms?.map((a) => (
          <li key={a.id} className="atom-item" style={{ cursor: 'default' }}>
            <div className="grow">
              <div>{a.text}</div>
              <div className="meta">
                <span>{a.projectName}</span>
                <span>Deleted {formatDate(a.deletedAt!)}</span>
                <span>{daysLeft(a)} days left</span>
              </div>
            </div>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <button className="small" onClick={() => act(() => api.post(`/notes/${a.id}/restore`))}>Restore</button>
              <button
                className="small danger"
                onClick={() => {
                  if (window.confirm('Delete this note for good?')) void act(() => api.del(`/trash/${a.id}`));
                }}
              >
                Delete forever
              </button>
            </div>
          </li>
        ))}
      </ul>
      {!atoms && !error && <div className="spinner" />}
    </div>
  );
}
