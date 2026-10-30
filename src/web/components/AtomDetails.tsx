import { useRef } from 'react';
import type { Atom } from '../../shared/types';
import { errorMessage } from '../api';
import { connectedAtoms, useStore } from '../store';
import { AtomEditor } from './AtomEditor';
import { STATUS_LABELS, TYPE_LABELS } from './Filters';

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function AtomChips({ atom }: { atom: Atom }) {
  const { colorOf } = useStore();
  return (
    <div className="row" style={{ gap: 6 }}>
      <span className="chip">
        <span className="swatch" style={{ background: colorOf(atom) }} />
        {atom.projectName}
      </span>
      <span className="chip">{TYPE_LABELS[atom.type]}</span>
      <span className="chip">{STATUS_LABELS[atom.status]}</span>
      {atom.pinned && <span className="chip">Pinned</span>}
      {atom.replacedBy.length > 0 && <span className="chip">Replaced</span>}
      {atom.reviewState === 'pending' && <span className="chip">Waiting for review</span>}
    </div>
  );
}

interface Props {
  atom: Atom;
  editing: boolean;
  setEditing: (v: boolean) => void;
  /** Phone half-height sheet: text plus Edit, Delete, Connected. */
  compact?: boolean;
  onShowConnected?: () => void;
}

export function AtomDetails({ atom, editing, setEditing, compact, onShowConnected }: Props) {
  const { graph, select, requestFocus, trashAtom, updateAtom, showToast, atomsById } = useStore();
  const connectedRef = useRef<HTMLDivElement>(null);
  const connected = connectedAtoms(graph, atom.id);

  if (editing) return <AtomEditor atom={atom} onDone={() => setEditing(false)} />;

  const remove = () => trashAtom(atom.id).catch((err) => showToast(errorMessage(err)));
  const togglePin = () =>
    updateAtom(atom.id, { pinned: !atom.pinned }).catch((err) => showToast(errorMessage(err)));

  if (compact) {
    return (
      <div>
        <p className="atom-big-text">{atom.text}</p>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <button className="grow" onClick={() => setEditing(true)}>Edit</button>
          <button className="grow danger" onClick={remove}>Delete</button>
          <button className="grow" onClick={onShowConnected}>Connected ({connected.length})</button>
        </div>
      </div>
    );
  }

  const refFactor = Math.min(1, Math.log(1 + atom.referenceCount) / Math.log(11));
  return (
    <div className="details">
      <p className="atom-big-text">{atom.text}</p>
      <AtomChips atom={atom} />
      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={() => setEditing(true)} title="Edit (E)">Edit</button>
        <button onClick={togglePin}>{atom.pinned ? 'Unpin' : 'Pin'}</button>
        <button className="danger" onClick={remove} title="Move to Trash (Delete)">Delete</button>
      </div>
      <dl>
        <dt>Source</dt>
        <dd>
          {atom.sourceAi ?? 'Unknown'}
          {atom.sourceChat ? ` · ${atom.sourceChat}` : ''}
        </dd>
        <dt>Weight</dt>
        <dd>
          {Math.round(atom.weight * 100)}%
          <div className="muted small-text">
            {atom.pinned
              ? 'Pinned (full weight)'
              : `AI score ${Math.round(atom.aiScore * 100)}% · referenced ${atom.referenceCount} time${atom.referenceCount === 1 ? '' : 's'} (${Math.round(refFactor * 100)}%)`}
          </div>
        </dd>
        <dt>Saved</dt>
        <dd>{formatDate(atom.createdAt)}</dd>
        <dt>Updated</dt>
        <dd>{formatDate(atom.updatedAt)}</dd>
      </dl>
      {atom.replacedBy.length > 0 && (
        <p className="muted small-text">
          Replaced by a newer note{atom.replacedBy.some((id) => !atomsById.has(id)) ? ' (hidden by filters or in Review)' : ''}.
        </p>
      )}
      <div ref={connectedRef}>
        <h3 style={{ marginTop: 14 }}>Connected ({connected.length})</h3>
        {connected.length === 0 && <p className="muted small-text">No connected notes above the link threshold.</p>}
        <ul className="connected-list">
          {connected.map(({ atom: other, similarity, kind }) => (
            <li key={`${kind}-${other.id}`}>
              <button
                onClick={() => {
                  select(other.id);
                  requestFocus();
                }}
              >
                <span className="grow">
                  {kind === 'replaces' && <span className="muted small-text">Replaces: </span>}
                  {kind === 'replacedBy' && <span className="muted small-text">Replaced by: </span>}
                  {other.text}
                </span>
                {kind === 'similar' && <span className="sim">{Math.round(similarity * 100)}%</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
