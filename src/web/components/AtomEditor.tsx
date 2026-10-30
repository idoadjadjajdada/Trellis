import { useState } from 'react';
import { ATOM_STATUSES, ATOM_TYPES, type Atom, type AtomStatus, type AtomType } from '../../shared/types';
import { api, errorMessage } from '../api';
import { UNSORTED_KEY, useStore } from '../store';
import { STATUS_LABELS, TYPE_LABELS } from './Filters';

/** Edits an atom's text, type, status and project. Saving re-generates the embedding on the server. */
export function AtomEditor({ atom, onDone }: { atom: Atom; onDone: (saved: Atom | null) => void }) {
  const { layers, refresh } = useStore();
  const [text, setText] = useState(atom.text);
  const [type, setType] = useState<AtomType>(atom.type);
  const [status, setStatus] = useState<AtomStatus>(atom.status);
  const [projectKey, setProjectKey] = useState(atom.projectId ?? UNSORTED_KEY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      if (text.trim() !== atom.text) patch.text = text;
      if (type !== atom.type) patch.type = type;
      if (status !== atom.status) patch.status = status;
      const projectId = projectKey === UNSORTED_KEY ? null : projectKey;
      if (projectId !== atom.projectId) patch.projectId = projectId;
      if (Object.keys(patch).length === 0) {
        onDone(null);
        return;
      }
      const { atom: saved } = await api.patch<{ atom: Atom }>(`/notes/${atom.id}`, patch);
      await refresh();
      onDone(saved);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone(null);
        }
      }}
    >
      <label className="field">
        <span>Text</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} autoFocus rows={4} />
      </label>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <label className="field grow">
          <span>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value as AtomType)}>
            {ATOM_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as AtomStatus)}>
            {ATOM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Project</span>
        <select value={projectKey} onChange={(e) => setProjectKey(e.target.value)}>
          {layers.map((l) => (
            <option key={l.key} value={l.key}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row end">
        <button type="button" onClick={() => onDone(null)} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={saving || !text.trim()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
