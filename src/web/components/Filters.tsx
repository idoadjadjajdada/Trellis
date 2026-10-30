import { ATOM_STATUSES, ATOM_TYPES, type AtomStatus, type AtomType } from '../../shared/types';
import { DEFAULT_FILTERS, useStore } from '../store';

export const TYPE_LABELS: Record<AtomType, string> = {
  decision: 'Decision',
  fact: 'Fact',
  task: 'Task',
  idea: 'Idea',
  question: 'Question',
};
export const STATUS_LABELS: Record<AtomStatus, string> = { decided: 'Decided', proposed: 'Proposed' };

function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/** The Projects list (one checkbox and color per project) and the filters. */
export function ProjectsList() {
  const { layers, filters, setFilters } = useStore();
  const allShown = filters.hiddenProjects.length === 0;
  return (
    <div>
      <div className="row between" style={{ marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Projects</h3>
        <div className="row" style={{ gap: 4 }}>
          <button className="small ghost" disabled={allShown} onClick={() => setFilters((f) => ({ ...f, hiddenProjects: [] }))}>
            Show all
          </button>
          <button
            className="small ghost"
            disabled={filters.hiddenProjects.length === layers.length}
            onClick={() => setFilters((f) => ({ ...f, hiddenProjects: layers.map((l) => l.key) }))}
          >
            Hide all
          </button>
        </div>
      </div>
      {layers.map((l) => (
        <div key={l.key} className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
          <label className="check grow">
            <input
              type="checkbox"
              checked={!filters.hiddenProjects.includes(l.key)}
              onChange={() => setFilters((f) => ({ ...f, hiddenProjects: toggle(f.hiddenProjects, l.key) }))}
            />
            <span className="swatch" style={{ background: l.color }} />
            <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {l.name}
            </span>
            <span className="muted small-text">{l.count}</span>
          </label>
          <button
            className="small ghost"
            title={`Show only ${l.name}`}
            onClick={() => setFilters((f) => ({ ...f, hiddenProjects: layers.filter((x) => x.key !== l.key).map((x) => x.key) }))}
          >
            Only
          </button>
        </div>
      ))}
    </div>
  );
}

export function FilterControls() {
  const { filters, setFilters, filtersActive } = useStore();
  return (
    <div>
      <div className="row between" style={{ marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Filters</h3>
        <button
          className="small ghost"
          disabled={!filtersActive}
          onClick={() => setFilters((f) => ({ ...DEFAULT_FILTERS, hiddenProjects: f.hiddenProjects }))}
        >
          Clear filters
        </button>
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: '4px 0 10px' }}>
        <legend className="muted small-text">Type</legend>
        {ATOM_TYPES.map((t) => (
          <label key={t} className="check">
            <input type="checkbox" checked={filters.types.includes(t)} onChange={() => setFilters((f) => ({ ...f, types: toggle(f.types, t) }))} />
            {TYPE_LABELS[t]}
          </label>
        ))}
      </fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: '4px 0 10px' }}>
        <legend className="muted small-text">Status</legend>
        {ATOM_STATUSES.map((s) => (
          <label key={s} className="check">
            <input
              type="checkbox"
              checked={filters.statuses.includes(s)}
              onChange={() => setFilters((f) => ({ ...f, statuses: toggle(f.statuses, s) }))}
            />
            {STATUS_LABELS[s]}
          </label>
        ))}
      </fieldset>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <label className="field grow">
          <span>Saved from</span>
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
        </label>
        <label className="field grow">
          <span>Saved to</span>
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
        </label>
      </div>
      <label className="field">
        <span>Minimum weight: {Math.round(filters.minWeight * 100)}%</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={filters.minWeight}
          onChange={(e) => setFilters((f) => ({ ...f, minWeight: Number(e.target.value) }))}
          aria-label="Minimum weight"
        />
      </label>
    </div>
  );
}
