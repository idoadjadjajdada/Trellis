import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { Atom } from '../../shared/types';
import { formatDate } from '../components/AtomDetails';
import { TYPE_LABELS } from '../components/Filters';
import { FilterIcon } from '../components/Icons';
import { useStore } from '../store';

export function AtomRow({ atom, selected, onClick }: { atom: Atom; selected?: boolean; onClick: () => void }) {
  const { colorOf } = useStore();
  return (
    <li
      className={`atom-item${selected ? ' selected' : ''}${atom.replacedBy.length ? ' replaced' : ''}`}
      onClick={onClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick())}
      tabIndex={0}
      role="button"
      aria-pressed={selected}
    >
      <span className="swatch" style={{ background: colorOf(atom) }} />
      <div className="grow">
        <div className="atom-text">{atom.text}</div>
        <div className="meta">
          <span>{atom.projectName}</span>
          <span>{TYPE_LABELS[atom.type]}</span>
          <span>{atom.status === 'decided' ? 'Decided' : 'Proposed'}</span>
          <span>{formatDate(atom.createdAt)}</span>
          {atom.pinned && <span>Pinned</span>}
        </div>
      </div>
    </li>
  );
}

/** A searchable list of atoms with the same filters as the graph. */
export function NotesPage({ phone, onOpenFilters }: { phone: boolean; onOpenFilters: () => void }) {
  const { graph, visibleAtoms, query, setQuery, matches, selectedId, select, filtersActive } = useStore();

  const list = useMemo(() => {
    const atoms = matches ? visibleAtoms.filter((a) => matches.has(a.id)) : visibleAtoms;
    return [...atoms].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [visibleAtoms, matches]);

  const total = graph?.atoms.length ?? 0;
  return (
    <div>
      <div className="row" style={{ flexWrap: 'nowrap', marginBottom: 12 }}>
        <h1 className="grow" style={{ margin: 0 }}>Notes</h1>
        <Link className="button small" to="/trash">Trash</Link>
      </div>
      {phone && (
        <div className="row" style={{ flexWrap: 'nowrap', marginBottom: 10 }}>
          <input
            type="search"
            placeholder="Search notes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search notes"
          />
          <button onClick={onOpenFilters} aria-label="Filter">
            <FilterIcon /> Filter{filtersActive ? ' •' : ''}
          </button>
        </div>
      )}
      <p className="muted small-text">
        {list.length === total ? `${total} notes` : `Showing ${list.length} of ${total} notes`}
        {filtersActive && ' (filters are on)'}
      </p>
      {total === 0 && graph && (
        <div className="card">
          <p>No notes yet.</p>
          <p className="muted small-text">Connect Claude or ChatGPT in Settings, and notes will appear here as you talk about your projects.</p>
          <Link className="button small" to="/settings">Open Settings</Link>
        </div>
      )}
      <ul className="atom-list">
        {list.map((a) => (
          <AtomRow key={a.id} atom={a} selected={a.id === selectedId} onClick={() => select(a.id)} />
        ))}
      </ul>
    </div>
  );
}
