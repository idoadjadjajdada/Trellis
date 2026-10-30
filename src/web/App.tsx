import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { Me } from '../shared/types';
import { api, ApiError, errorMessage } from './api';
import { AtomDetails } from './components/AtomDetails';
import { BottomSheet, type SheetSize } from './components/BottomSheet';
import { FilterControls, ProjectsList } from './components/Filters';
import type { GraphHandle } from './components/GraphView';
import { CloseIcon, FilterIcon, GraphIcon, NotesIcon, PanelIcon, ResetIcon, ReviewIcon, SettingsIcon } from './components/Icons';
import { Menu } from './components/Menu';
import { Toast } from './components/Toast';
import { Consent } from './pages/Consent';
import { NotesPage } from './pages/Notes';
import { ReviewPage } from './pages/Review';
import { SettingsPage } from './pages/Settings';
import { AddPasskeyAfterRecovery, SignIn } from './pages/SignIn';
import { TrashPage } from './pages/Trash';
import { StoreProvider, useStore } from './store';

// three.js is large: load it only once someone is signed in.
const GraphView = lazy(() => import('./components/GraphView'));

interface LayoutInfo {
  phone: boolean;
  coarse: boolean;
  portrait: boolean;
}

function readLayout(): LayoutInfo {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  return {
    // Phones, including in landscape (short screen with a touch pointer).
    phone: w < 640 || (coarse && Math.min(w, h) < 500),
    coarse,
    portrait: h > w,
  };
}

function useLayout(): LayoutInfo {
  const [layout, setLayout] = useState(readLayout);
  useEffect(() => {
    const update = () => setLayout(readLayout());
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
  return layout;
}

const isTyping = (el: Element | null) =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable);

function Shell({ me, setMe, layout, onSignOut }: { me: Me; setMe: (me: Me) => void; layout: LayoutInfo; onSignOut: () => void }) {
  const { phone, coarse, portrait } = layout;
  const store = useStore();
  const { graph, atomsById, selectedId, select, reviewCount, query, setQuery, trashAtom, updateAtom, showToast, requestFocus, loadError, filtersActive, visibleAtoms } =
    store;
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname;
  const onGraph = path === '/';
  const graphRef = useRef<GraphHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // iPad portrait: both panels start closed. Landscape and desktop: the left panel stays open.
  const [leftOpen, setLeftOpen] = useState(() => !(coarse && portrait));
  useEffect(() => {
    if (coarse) setLeftOpen(!portrait);
  }, [coarse, portrait]);

  const [editing, setEditing] = useState(false);
  const [sheetSize, setSheetSize] = useState<SheetSize>('half');
  const [filterSheet, setFilterSheet] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const selected = selectedId ? atomsById.get(selectedId) ?? null : null;
  useEffect(() => {
    setEditing(false);
    setSheetSize('half');
  }, [selectedId]);
  // The selected atom disappeared (deleted, or filtered out on another device).
  useEffect(() => {
    if (selectedId && graph && !atomsById.has(selectedId)) select(null);
  }, [selectedId, graph, atomsById, select]);

  const closePanels = useCallback(() => {
    if (menu) setMenu(null);
    else if (filterSheet) setFilterSheet(false);
    else if (editing) setEditing(false);
    else if (selectedId) select(null);
    else if (!phone && coarse && portrait && leftOpen) setLeftOpen(false);
  }, [menu, filterSheet, editing, selectedId, select, phone, coarse, portrait, leftOpen]);

  // Keyboard: / opens Search, Esc closes panels, E edits the selected atom, Delete moves it to Trash.
  // The listener is registered once and reads the latest state from a ref, so a key pressed
  // right after a change never sees stale state.
  const keyState = useRef({ closePanels, selected, editing, phone });
  keyState.current = { closePanels, selected, editing, phone };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { closePanels, selected, editing, phone } = keyState.current;
      if (e.key === 'Escape') {
        if (isTyping(document.activeElement)) (document.activeElement as HTMLElement).blur();
        closePanels();
        return;
      }
      if (isTyping(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        if (phone) navigate('/notes');
        else searchRef.current?.focus();
      } else if ((e.key === 'e' || e.key === 'E') && selected && !editing) {
        e.preventDefault();
        setEditing(true);
        if (phone) setSheetSize('full');
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !editing) {
        e.preventDefault();
        trashAtom(selected.id).catch((err) => showToast(errorMessage(err)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, trashAtom, showToast]);

  const menuAtom = menu ? atomsById.get(menu.id) : null;
  const showLeft = !phone && (onGraph || path === '/notes');
  const pageClass = (extra = '') => `page${phone ? ' with-bottom-nav with-safe-top' : ' with-top'}${extra}`;

  const details = selected && (
    <AtomDetails
      atom={selected}
      editing={editing}
      setEditing={(v) => {
        setEditing(v);
        if (v && phone) setSheetSize('full');
      }}
      compact={phone && sheetSize === 'half' && !editing}
      onShowConnected={() => setSheetSize('full')}
    />
  );
  const showInGraph = !onGraph && selected && (
    <button
      className="small"
      onClick={() => {
        navigate('/');
        requestFocus();
      }}
    >
      Show in graph
    </button>
  );

  return (
    <div className="app">
      <Suspense fallback={null}>
      <GraphView
        ref={graphRef}
        active={onGraph}
        phone={phone}
        coarse={coarse}
        onSelect={(id) => {
          select(id);
          setMenu(null);
        }}
        onBackground={() => setMenu(null)}
        onLongPress={(id, x, y) => setMenu({ id, x, y })}
      />
      </Suspense>

      {onGraph && graph && visibleAtoms.length === 0 && (
        <div className="graph-hint card">
          {graph.atoms.length === 0 ? (
            <>
              <h2>No notes yet</h2>
              <p className="muted">Connect Claude or ChatGPT, and notes appear here as you talk about your projects.</p>
              <Link className="button primary" to="/settings">Connect an AI</Link>
            </>
          ) : (
            <>
              <h2>Nothing to show</h2>
              <p className="muted">Every note is hidden by the project list or filters.</p>
            </>
          )}
        </div>
      )}
      {loadError && (
        <div className="graph-hint card">
          <p className="error">{loadError}</p>
          <button onClick={() => void store.refresh()}>Try again</button>
        </div>
      )}

      {/* ---- Desktop and iPad -------------------------------------------- */}
      {!phone && (
        <header className="topbar">
          <Link to="/" className="brand" style={{ color: 'inherit', textDecoration: 'none' }}>
            <img src="/icons/icon.svg" alt="" />
            Trellis
          </Link>
          <nav aria-label="Main">
            <NavLink to="/" end>Graph</NavLink>
            <NavLink to="/notes">Notes</NavLink>
            <NavLink to="/review">
              Review {reviewCount > 0 && <span className="badge" aria-label={`${reviewCount} waiting`}>{reviewCount}</span>}
            </NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <div className="search">
            <input
              ref={searchRef}
              type="search"
              placeholder="Search  ( / )"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && path !== '/' && path !== '/notes') navigate('/notes');
              }}
            />
          </div>
        </header>
      )}

      {showLeft &&
        (leftOpen ? (
          <aside className="side-panel left" aria-label="Projects and filters">
            <div className="panel-head">
              <h2>Projects</h2>
              <button className="icon ghost" onClick={() => setLeftOpen(false)} aria-label="Close panel" title="Close panel">
                <CloseIcon />
              </button>
            </div>
            <div className="panel-body">
              <ProjectsList />
              <div className="divider" />
              <FilterControls />
            </div>
          </aside>
        ) : (
          <button className="panel-toggle" onClick={() => setLeftOpen(true)} aria-label="Open projects and filters">
            <PanelIcon /> Projects{filtersActive ? ' •' : ''}
          </button>
        ))}

      {!phone && selected && (onGraph || path === '/notes') && (
        <aside className="side-panel right" aria-label="Note details">
          <div className="panel-head">
            <h2>Note</h2>
            <div className="row" style={{ gap: 4 }}>
              {showInGraph}
              <button className="icon ghost" onClick={() => select(null)} aria-label="Close details (Esc)" title="Close (Esc)">
                <CloseIcon />
              </button>
            </div>
          </div>
          <div className="panel-body">{details}</div>
        </aside>
      )}

      {/* ---- Phone ------------------------------------------------------- */}
      {phone && onGraph && (
        <div className="graph-controls left with-bottom-nav">
          <button onClick={() => setFilterSheet(true)} aria-label="Filter">
            <FilterIcon /> Filter{filtersActive ? ' •' : ''}
          </button>
        </div>
      )}
      {onGraph && (
        <div className={`graph-controls${phone ? ' with-bottom-nav' : ''}${!phone && selected ? ' beside-panel' : ''}`}>
          <button onClick={() => graphRef.current?.resetView()} aria-label="Reset view">
            <ResetIcon /> Reset view
          </button>
        </div>
      )}

      {/* ---- Screens over the graph ---------------------------------------- */}
      {path === '/notes' && (
        <main className={pageClass(showLeft && leftOpen ? ' with-left' : '')}>
          <div className="page-inner" style={!phone && selected ? { paddingRight: 390 } : undefined}>
            <NotesPage phone={phone} onOpenFilters={() => setFilterSheet(true)} />
          </div>
        </main>
      )}
      {path === '/review' && (
        <main className={pageClass()}>
          <div className="page-inner">
            <ReviewPage phone={phone} />
          </div>
        </main>
      )}
      {path === '/settings' && (
        <main className={pageClass()}>
          <div className="page-inner">
            <SettingsPage me={me} onMeChange={setMe} onSignOut={onSignOut} />
          </div>
        </main>
      )}
      {path === '/trash' && (
        <main className={pageClass()}>
          <div className="page-inner">
            <TrashPage />
          </div>
        </main>
      )}

      {phone && selected && (onGraph || path === '/notes') && (
        <BottomSheet
          label="Note details"
          size={editing ? 'full' : sheetSize}
          onSizeChange={setSheetSize}
          onClose={() => select(null)}
          title={
            <>
              <strong>Note</strong>
              <div className="row" style={{ gap: 4 }}>
                {showInGraph}
                <button className="icon ghost" onClick={() => select(null)} aria-label="Close">
                  <CloseIcon />
                </button>
              </div>
            </>
          }
        >
          {details}
        </BottomSheet>
      )}

      {phone && filterSheet && (
        <BottomSheet
          label="Filter"
          size="full"
          onSizeChange={(s) => s === 'half' && setFilterSheet(false)}
          onClose={() => setFilterSheet(false)}
          title={
            <>
              <strong>Filter</strong>
              <button className="small primary" onClick={() => setFilterSheet(false)}>Done</button>
            </>
          }
        >
          <ProjectsList />
          <div className="divider" />
          <FilterControls />
        </BottomSheet>
      )}

      {phone && (
        <nav className="bottom-nav" aria-label="Main">
          <NavLink to="/" end><GraphIcon />Graph</NavLink>
          <NavLink to="/notes"><NotesIcon />Notes</NavLink>
          <NavLink to="/review">
            <ReviewIcon />Review
            {reviewCount > 0 && <span className="badge">{reviewCount}</span>}
          </NavLink>
          <NavLink to="/settings"><SettingsIcon />Settings</NavLink>
        </nav>
      )}

      {menu && menuAtom && (
        <Menu
          x={menu.x}
          y={menu.y}
          title={menuAtom.text.length > 90 ? `${menuAtom.text.slice(0, 90)}…` : menuAtom.text}
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Edit',
              onSelect: () => {
                select(menuAtom.id);
                // Wait for the selection to open the panel, then switch it to editing.
                setTimeout(() => {
                  setEditing(true);
                  if (phone) setSheetSize('full');
                }, 0);
              },
            },
            {
              label: menuAtom.pinned ? 'Unpin' : 'Pin',
              onSelect: () => void updateAtom(menuAtom.id, { pinned: !menuAtom.pinned }).catch((err) => showToast(errorMessage(err))),
            },
            { label: 'Delete', danger: true, onSelect: () => void trashAtom(menuAtom.id).catch((err) => showToast(errorMessage(err))) },
          ]}
        />
      )}

      <Toast aboveNav={phone} />
    </div>
  );
}

function Root() {
  const layout = useLayout();
  const location = useLocation();
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  const loadMe = useCallback(async () => {
    try {
      setMe(await api.get<Me>('/me'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else setMe(null);
    }
  }, []);
  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  const signOut = useCallback(async () => {
    await api.post('/auth/logout').catch(() => {});
    setMe(null);
    navigate('/');
  }, [navigate]);

  if (me === undefined) {
    return (
      <div className="center-screen">
        <div className="spinner" aria-label="Loading" />
      </div>
    );
  }

  if (location.pathname === '/oauth/consent') {
    const requestId = new URLSearchParams(location.search).get('request') ?? '';
    if (!me) return <SignIn onSignedIn={loadMe} subtitle="Sign in to connect an AI app to your notes." />;
    if (me.recovery) return <AddPasskeyAfterRecovery onDone={loadMe} onSignOut={signOut} />;
    return <Consent requestId={requestId} userName={me.displayName} />;
  }

  if (!me) return <SignIn onSignedIn={loadMe} />;
  if (me.recovery) return <AddPasskeyAfterRecovery onDone={loadMe} onSignOut={signOut} />;

  return (
    <StoreProvider phone={layout.phone} key={me.id}>
      <Shell me={me} setMe={setMe} layout={layout} onSignOut={signOut} />
    </StoreProvider>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Root />
    </BrowserRouter>
  );
}
