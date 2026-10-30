import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage } from './api';
import {
  ATOM_STATUSES,
  ATOM_TYPES,
  UNSORTED,
  UNSORTED_COLOR,
  type Atom,
  type AtomStatus,
  type AtomType,
  type GraphData,
  type SyncState,
} from '../shared/types';

export const UNSORTED_KEY = 'unsorted';
export const projectKey = (a: Pick<Atom, 'projectId'>) => a.projectId ?? UNSORTED_KEY;

export interface Filters {
  /** Project keys (ids, or "unsorted") that are hidden. Hidden rather than shown, so new projects appear. */
  hiddenProjects: string[];
  types: AtomType[];
  statuses: AtomStatus[];
  from: string; // YYYY-MM-DD or ''
  to: string;
  minWeight: number;
}

export const DEFAULT_FILTERS: Filters = {
  hiddenProjects: [],
  types: [...ATOM_TYPES],
  statuses: [...ATOM_STATUSES],
  from: '',
  to: '',
  minWeight: 0,
};

export interface Layer {
  key: string;
  name: string;
  color: string;
  count: number;
  projectId: string | null;
}

interface Toast {
  id: number;
  message: string;
  actionLabel?: string;
  action?: () => void;
}

interface Store {
  graph: GraphData | null;
  loadError: string | null;
  reviewCount: number;
  layers: Layer[];
  colorOf: (a: Pick<Atom, 'projectId'>) => string;
  atomsById: Map<string, Atom>;
  filters: Filters;
  setFilters: (update: (f: Filters) => Filters) => void;
  filtersActive: boolean;
  passes: (a: Atom) => boolean;
  visibleAtoms: Atom[];
  query: string;
  setQuery: (q: string) => void;
  /** Ids matching the search, or null when there is no search. */
  matches: Set<string> | null;
  selectedId: string | null;
  select: (id: string | null) => void;
  /** Incremented to ask the graph to fly to the selected atom. */
  focusRequest: number;
  requestFocus: () => void;
  refresh: () => Promise<void>;
  updateAtom: (id: string, patch: Partial<Pick<Atom, 'text' | 'type' | 'status' | 'pinned' | 'projectId'>>) => Promise<Atom>;
  trashAtom: (id: string) => Promise<void>;
  approveAtom: (id: string) => Promise<void>;
  toast: Toast | null;
  showToast: (message: string, actionLabel?: string, action?: () => void) => void;
  dismissToast: () => void;
}

const StoreContext = createContext<Store | null>(null);

const FILTERS_KEY = 'trellis.filters.v1';

function loadFilters(): Filters | null {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return null;
    const f = JSON.parse(raw) as Partial<Filters>;
    return {
      hiddenProjects: Array.isArray(f.hiddenProjects) ? f.hiddenProjects.filter((x) => typeof x === 'string') : [],
      types: Array.isArray(f.types) ? f.types.filter((t) => ATOM_TYPES.includes(t)) : [...ATOM_TYPES],
      statuses: Array.isArray(f.statuses) ? f.statuses.filter((s) => ATOM_STATUSES.includes(s)) : [...ATOM_STATUSES],
      from: typeof f.from === 'string' ? f.from : '',
      to: typeof f.to === 'string' ? f.to : '',
      minWeight: typeof f.minWeight === 'number' && f.minWeight >= 0 && f.minWeight <= 1 ? f.minWeight : 0,
    };
  } catch {
    return null;
  }
}

function saveFilters(f: Filters) {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(f));
  } catch {
    // Storage can be unavailable (private mode); filters just won't persist.
  }
}

/** Semantic search results at or above this similarity count as matches. */
const SEMANTIC_MATCH = 0.6;

export function StoreProvider({ children, phone }: { children: ReactNode; phone: boolean }) {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reviewCount, setReviewCount] = useState(0);
  const savedFilters = useRef(loadFilters());
  const [filters, setFiltersState] = useState<Filters>(savedFilters.current ?? DEFAULT_FILTERS);
  const [query, setQuery] = useState('');
  const [semantic, setSemantic] = useState<Map<string, number> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const version = useRef<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const setFilters = useCallback((update: (f: Filters) => Filters) => {
    setFiltersState((f) => {
      const next = update(f);
      saveFilters(next);
      return next;
    });
  }, []);

  const loadGraph = useCallback(async () => {
    try {
      const [data, sync] = await Promise.all([api.get<GraphData>('/graph'), api.get<SyncState>('/sync')]);
      setGraph(data);
      setReviewCount(sync.reviewCount);
      version.current = sync.version;
      setLoadError(null);
      return data;
    } catch (err) {
      setLoadError(errorMessage(err));
      return null;
    }
  }, []);

  // First load. On phones, with no saved filters, open on one project (the biggest) instead of all.
  useEffect(() => {
    void loadGraph().then((data) => {
      if (!data || !phone || savedFilters.current) return;
      const biggest = [...data.projects].sort((a, b) => b.atomCount - a.atomCount)[0];
      if (biggest && biggest.atomCount > 0) {
        const hidden = [...data.projects.filter((p) => p.id !== biggest.id).map((p) => p.id), UNSORTED_KEY];
        setFilters((f) => ({ ...f, hiddenProjects: hidden }));
      }
    });
  }, [loadGraph, phone, setFilters]);

  // Pick up notes the AI saves while the app is open.
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const sync = await api.get<SyncState>('/sync');
        if (stopped) return;
        setReviewCount(sync.reviewCount);
        if (sync.version !== version.current) await loadGraph();
      } catch {
        // Offline or signed out; try again next time.
      }
    };
    const timer = setInterval(check, 10_000);
    const onVisible = () => void check();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [loadGraph]);

  // Semantic search, debounced.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSemantic(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const { results } = await api.get<{ results: { id: string; similarity: number }[] }>(`/search?q=${encodeURIComponent(q)}`);
        if (!cancelled) setSemantic(new Map(results.map((r) => [r.id, r.similarity])));
      } catch {
        if (!cancelled) setSemantic(new Map());
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const atomsById = useMemo(() => new Map((graph?.atoms ?? []).map((a) => [a.id, a])), [graph]);

  const layers = useMemo<Layer[]>(() => {
    if (!graph) return [];
    const unsorted = graph.atoms.filter((a) => a.projectId === null).length;
    return [
      ...graph.projects.map((p) => ({ key: p.id, name: p.name, color: p.color, count: p.atomCount, projectId: p.id })),
      { key: UNSORTED_KEY, name: UNSORTED, color: UNSORTED_COLOR, count: unsorted, projectId: null },
    ];
  }, [graph]);

  const colorOf = useCallback(
    (a: Pick<Atom, 'projectId'>) => layers.find((l) => l.key === projectKey(a))?.color ?? UNSORTED_COLOR,
    [layers],
  );

  const passes = useCallback(
    (a: Atom) => {
      if (filters.hiddenProjects.includes(projectKey(a))) return false;
      if (!filters.types.includes(a.type)) return false;
      if (!filters.statuses.includes(a.status)) return false;
      if (a.weight < filters.minWeight - 1e-9) return false;
      const day = a.createdAt.slice(0, 10);
      if (filters.from && day < filters.from) return false;
      if (filters.to && day > filters.to) return false;
      return true;
    },
    [filters],
  );

  const visibleAtoms = useMemo(() => (graph?.atoms ?? []).filter(passes), [graph, passes]);

  const filtersActive =
    filters.hiddenProjects.length > 0 ||
    filters.types.length !== ATOM_TYPES.length ||
    filters.statuses.length !== ATOM_STATUSES.length ||
    !!filters.from ||
    !!filters.to ||
    filters.minWeight > 0;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const out = new Set<string>();
    for (const a of graph?.atoms ?? []) if (a.text.toLowerCase().includes(q)) out.add(a.id);
    for (const [id, sim] of semantic ?? []) if (sim >= SEMANTIC_MATCH) out.add(id);
    return out;
  }, [query, semantic, graph]);

  const showToast = useCallback((message: string, actionLabel?: string, action?: () => void) => {
    clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), message, actionLabel, action });
    toastTimer.current = setTimeout(() => setToast(null), actionLabel ? 7000 : 3500);
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const updateAtom = useCallback<Store['updateAtom']>(
    async (id, patch) => {
      const { atom } = await api.patch<{ atom: Atom }>(`/notes/${id}`, patch);
      await loadGraph();
      return atom;
    },
    [loadGraph],
  );

  const trashAtom = useCallback(
    async (id: string) => {
      await api.del(`/notes/${id}`);
      setSelectedId((cur) => (cur === id ? null : cur));
      await loadGraph();
      showToast('Moved to Trash.', 'Undo', () => {
        void api.post(`/notes/${id}/restore`).then(loadGraph);
      });
    },
    [loadGraph, showToast],
  );

  const approveAtom = useCallback(
    async (id: string) => {
      await api.post(`/notes/${id}/approve`);
      await loadGraph();
    },
    [loadGraph],
  );

  const refresh = useCallback(async () => {
    await loadGraph();
  }, [loadGraph]);

  const requestFocus = useCallback(() => setFocusRequest((n) => n + 1), []);

  const value: Store = {
    graph,
    loadError,
    reviewCount,
    layers,
    colorOf,
    atomsById,
    filters,
    setFilters,
    filtersActive,
    passes,
    visibleAtoms,
    query,
    setQuery,
    matches,
    selectedId,
    select: setSelectedId,
    focusRequest,
    requestFocus,
    refresh,
    updateAtom,
    trashAtom,
    approveAtom,
    toast,
    showToast,
    dismissToast,
  };
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}

/** Neighbours of an atom in the graph, strongest first. */
export function connectedAtoms(graph: GraphData | null, id: string) {
  if (!graph) return [];
  const byId = new Map(graph.atoms.map((a) => [a.id, a]));
  const out: { atom: Atom; similarity: number; kind: 'similar' | 'replaces' | 'replacedBy' }[] = [];
  for (const l of graph.links) {
    const other = l.source === id ? l.target : l.target === id ? l.source : null;
    if (!other) continue;
    const atom = byId.get(other);
    if (!atom) continue;
    const kind = l.kind === 'similar' ? 'similar' : l.source === id ? 'replaces' : 'replacedBy';
    out.push({ atom, similarity: l.similarity, kind });
  }
  return out.sort((a, b) => (a.kind === 'similar' ? 1 : 0) - (b.kind === 'similar' ? 1 : 0) || b.similarity - a.similarity);
}
