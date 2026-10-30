import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import * as THREE from 'three';
import type { Atom, GraphLink } from '../../shared/types';
import { useStore } from '../store';

interface GNode {
  id: string;
  atom: Atom;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  __obj?: THREE.Mesh<THREE.SphereGeometry, THREE.MeshLambertMaterial>;
}

interface GLink {
  source: string | GNode;
  target: string | GNode;
  similarity: number;
  kind: GraphLink['kind'];
  cross: boolean;
}

export interface GraphHandle {
  resetView: () => void;
}

interface Props {
  /** Paused (no rendering) while another screen covers the graph. */
  active: boolean;
  phone: boolean;
  coarse: boolean;
  onSelect: (id: string) => void;
  onBackground: () => void;
  onLongPress: (id: string, x: number, y: number) => void;
}

const GEOMETRY = new THREE.SphereGeometry(1, 18, 14);
const RECENCY_HALF_LIFE_DAYS = 60;
/** On phones only the heaviest atoms render at first; more appear as you zoom in. */
const PHONE_BUCKETS = [40, 80, 160, 320, Infinity];

const radiusOf = (a: Atom) => 2.2 + 5.5 * a.weight;

/** Older atoms dim but never disappear. */
function recencyOpacity(a: Atom, now: number) {
  const ageDays = Math.max(0, (now - new Date(a.updatedAt).getTime()) / 86_400_000);
  return 0.3 + 0.7 * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

const idOf = (end: string | GNode) => (typeof end === 'string' ? end : end.id);

export const GraphView = forwardRef<GraphHandle, Props>(function GraphView(props, ref) {
  const { active, phone, coarse } = props;
  const { graph, visibleAtoms, colorOf, matches, selectedId, focusRequest } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraph3DInstance<GNode, GLink> | null>(null);
  const nodeCache = useRef(new Map<string, GNode>());
  const currentNodes = useRef<GNode[]>([]);
  const fittedOnce = useRef(false);
  const refDistance = useRef<number | null>(null);
  const [bucket, setBucket] = useState(0);
  const callbacks = useRef(props);
  callbacks.current = props;
  // Applies size, color and fade to one node. Replaced every render so it always sees current state.
  const styleNode = useRef<(n: GNode) => void>(() => {});

  // ---- Create the graph once -------------------------------------------
  useEffect(() => {
    const el = containerRef.current!;
    const fg = new ForceGraph3D(el, { controlType: 'orbit' }) as unknown as ForceGraph3DInstance<GNode, GLink>;
    fgRef.current = fg;
    fg.backgroundColor('#0d1117')
      .showNavInfo(false)
      .width(el.clientWidth)
      .height(el.clientHeight)
      .nodeId('id')
      .nodeThreeObject((n: GNode) => {
        if (!n.__obj) {
          n.__obj = new THREE.Mesh(GEOMETRY, new THREE.MeshLambertMaterial({ transparent: true }));
        }
        // The engine builds objects after graphData() returns, so style them here as well.
        styleNode.current(n);
        return n.__obj;
      })
      .linkOpacity(0.32)
      .linkDirectionalArrowLength((l: GLink) => (l.kind === 'replaces' ? 5 : 0))
      .linkDirectionalArrowRelPos(1)
      .d3VelocityDecay(0.35)
      .cooldownTime(6000)
      .enableNodeDrag(true);

    const controls = fg.controls() as THREE.EventDispatcher<{ change: object }> & { target: THREE.Vector3 };
    // Phones keep atoms clear of the floating buttons and the bottom bar.
    const fitPadding = () => (callbacks.current.phone ? 110 : 60);
    const charge = fg.d3Force('charge') as unknown as { strength(n: number): { distanceMax(n: number): void } };
    charge.strength(-35).distanceMax(220);

    // The first layout is computed before anything is drawn (warm-up ticks), so the camera can
    // fit it straight away; it fits once more after the layout settles.
    fg.warmupTicks(80);
    let settledFit = false;
    let ticks = 0;
    fg.onEngineTick(() => {
      if (fittedOnce.current || !currentNodes.current.length) return;
      // Wait until the meshes have been moved to their warmed-up positions.
      if (++ticks < 3) return;
      fittedOnce.current = true;
      fg.warmupTicks(0); // later updates start from the existing positions
      fg.zoomToFit(0, fitPadding());
    });
    fg.onEngineStop(() => {
      if (settledFit || !fittedOnce.current) return;
      settledFit = true;
      fg.zoomToFit(700, fitPadding());
      // Measure the zoomed-out distance once the camera has arrived (phones load more atoms when closer).
      setTimeout(() => {
        refDistance.current = fg.camera().position.distanceTo(controls.target);
      }, 800);
    });

    // Lazy loading on phones: track how far the camera is from what it looks at.
    const onCameraChange = () => {
      if (!callbacks.current.phone || refDistance.current === null) return;
      const dist = fg.camera().position.distanceTo(controls.target);
      const ratio = refDistance.current / Math.max(dist, 1);
      const b = ratio < 1.4 ? 0 : ratio < 2 ? 1 : ratio < 2.8 ? 2 : ratio < 4 ? 3 : 4;
      setBucket((cur) => (b > cur ? b : cur)); // never unload while zooming back out
    };
    controls.addEventListener('change', onCameraChange);

    const resize = new ResizeObserver(() => {
      fg.width(el.clientWidth).height(el.clientHeight);
    });
    resize.observe(el);

    // ---- Our own picking: bigger invisible tap areas, long-press and double-tap.
    const canvas = fg.renderer().domElement;
    const pick = (x: number, y: number): GNode | null => {
      const cam = fg.camera() as THREE.PerspectiveCamera;
      const focal = canvas.clientHeight / 2 / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
      const minRadius = callbacks.current.phone ? 22 : callbacks.current.coarse ? 18 : 4;
      const v = new THREE.Vector3();
      let best: { node: GNode; d: number; depth: number; direct: boolean } | null = null;
      for (const node of currentNodes.current) {
        if (node.x === undefined || node.y === undefined || node.z === undefined) continue;
        v.set(node.x, node.y, node.z).applyMatrix4(cam.matrixWorldInverse);
        if (v.z >= 0) continue; // behind the camera
        const depth = -v.z;
        const s = fg.graph2ScreenCoords(node.x, node.y, node.z);
        const r = (radiusOf(node.atom) * focal) / depth;
        const d = Math.hypot(s.x - x, s.y - y);
        if (d > Math.max(r, minRadius)) continue;
        const direct = d <= r;
        if (
          !best ||
          (direct && !best.direct) ||
          (direct && best.direct && depth < best.depth) ||
          (!direct && !best.direct && d < best.d)
        ) {
          best = { node, d, depth, direct };
        }
      }
      return best?.node ?? null;
    };

    const pointers = new Set<number>();
    let down: { x: number; y: number; t: number; moved: boolean } | null = null;
    let longTimer: ReturnType<typeof setTimeout> | undefined;
    let longFired = false;
    let lastTap: { x: number; y: number; t: number } | null = null;
    const local = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const onDown = (e: PointerEvent) => {
      pointers.add(e.pointerId);
      if (pointers.size > 1) {
        // Pinch or two-finger pan, not a tap.
        if (down) down.moved = true;
        clearTimeout(longTimer);
        return;
      }
      if (e.button !== 0) {
        down = null;
        return;
      }
      const p = local(e);
      down = { ...p, t: Date.now(), moved: false };
      longFired = false;
      if (e.pointerType !== 'mouse') {
        longTimer = setTimeout(() => {
          if (!down || down.moved) return;
          const node = pick(down.x, down.y);
          if (node) {
            longFired = true;
            callbacks.current.onLongPress(node.id, e.clientX, e.clientY);
          }
        }, 550);
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      const p = local(e);
      if (Math.hypot(p.x - down.x, p.y - down.y) > 8) {
        down.moved = true;
        clearTimeout(longTimer);
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      clearTimeout(longTimer);
      const d = down;
      down = null;
      if (!d || d.moved || longFired || Date.now() - d.t > 600) return;
      const node = pick(d.x, d.y);
      const now = Date.now();
      const isDouble = lastTap && now - lastTap.t < 330 && Math.hypot(lastTap.x - d.x, lastTap.y - d.y) < 30;
      lastTap = isDouble ? null : { x: d.x, y: d.y, t: now };
      if (isDouble) {
        if (node) centerOn(node);
        else resetView();
        return;
      }
      if (node) callbacks.current.onSelect(node.id);
      else callbacks.current.onBackground();
    };
    const onCancel = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      clearTimeout(longTimer);
      down = null;
    };
    const noMenu = (e: Event) => e.preventDefault();
    // 3d-force-graph fires a fake pointerup at the document after a node drag; three's
    // OrbitControls crashes on it for mouse pointers. Real pointer events never target the document.
    const blockFakePointerUp = (e: PointerEvent) => {
      if (!e.isTrusted && e.target === document) e.stopImmediatePropagation();
    };
    window.addEventListener('pointerup', blockFakePointerUp, { capture: true });
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('contextmenu', noMenu);

    return () => {
      clearTimeout(longTimer);
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('contextmenu', noMenu);
      window.removeEventListener('pointerup', blockFakePointerUp, { capture: true });
      controls.removeEventListener('change', onCameraChange);
      resize.disconnect();
      fg._destructor();
      fgRef.current = null;
    };
  }, []);

  function centerOn(node: GNode) {
    const fg = fgRef.current;
    if (!fg || node.x === undefined) return;
    const { x = 0, y = 0, z = 0 } = node;
    const cam = fg.camera().position;
    const dist = 90;
    const dx = cam.x - x;
    const dy = cam.y - y;
    const dz = cam.z - z;
    const len = Math.hypot(dx, dy, dz) || 1;
    fg.cameraPosition({ x: x + (dx / len) * dist, y: y + (dy / len) * dist, z: z + (dz / len) * dist }, { x, y, z }, 800);
  }

  function resetView() {
    fgRef.current?.zoomToFit(700, callbacks.current.phone ? 110 : 60);
  }

  useImperativeHandle(ref, () => ({ resetView }));

  // ---- Tooltips (mouse only) ----------------------------------------------
  useEffect(() => {
    fgRef.current?.nodeLabel((n: GNode) => {
      if (coarse) return '';
      // Built with textContent: note text comes from AI chats and must never be parsed as HTML.
      const div = document.createElement('div');
      div.className = 'tooltip-label';
      div.textContent = n.atom.text;
      return div;
    });
  }, [coarse]);

  // ---- Which atoms render --------------------------------------------------
  const shown = useMemo(() => {
    if (!phone) return visibleAtoms;
    const limit = PHONE_BUCKETS[bucket];
    if (visibleAtoms.length <= limit) return visibleAtoms;
    const heaviest = [...visibleAtoms].sort((a, b) => b.weight - a.weight).slice(0, limit);
    const sel = selectedId && visibleAtoms.find((a) => a.id === selectedId);
    if (sel && !heaviest.includes(sel)) heaviest.push(sel);
    return heaviest;
  }, [visibleAtoms, phone, bucket, selectedId]);

  // ---- Push data into the simulation, keeping existing positions --------------
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !graph) return;
    const ids = new Set(shown.map((a) => a.id));
    const byId = new Map(shown.map((a) => [a.id, a]));
    // Fresh link objects every time: the force engine replaces source/target with node objects.
    const links: GLink[] = graph.links
      .filter((l) => ids.has(l.source) && ids.has(l.target))
      .map((l) => ({
        source: l.source,
        target: l.target,
        similarity: l.similarity,
        kind: l.kind,
        cross: byId.get(l.source)!.projectId !== byId.get(l.target)!.projectId,
      }));

    const nodes = shown.map((atom) => {
      let node = nodeCache.current.get(atom.id);
      if (!node) {
        node = { id: atom.id, atom };
        // Start a new atom next to its most similar neighbour so the graph shifts instead of scrambling.
        const neighbour = links
          .filter((l) => l.kind === 'similar' && (l.source === atom.id || l.target === atom.id))
          .sort((a, b) => b.similarity - a.similarity)
          .map((l) => nodeCache.current.get(idOf(l.source) === atom.id ? idOf(l.target) : idOf(l.source)))
          .find((n) => n?.x !== undefined);
        if (neighbour) {
          node.x = neighbour.x! + (Math.random() - 0.5) * 12;
          node.y = neighbour.y! + (Math.random() - 0.5) * 12;
          node.z = neighbour.z! + (Math.random() - 0.5) * 12;
        }
        nodeCache.current.set(atom.id, node);
      }
      node.atom = atom;
      return node;
    });
    currentNodes.current = nodes;

    const degree = new Map<string, number>();
    for (const l of links) {
      degree.set(idOf(l.source), (degree.get(idOf(l.source)) ?? 0) + 1);
      degree.set(idOf(l.target), (degree.get(idOf(l.target)) ?? 0) + 1);
    }
    const linkForce = fg.d3Force('link') as unknown as {
      distance(fn: (l: GLink) => number): { strength(fn: (l: GLink) => number): void };
    };
    // Distance means similarity: more similar atoms sit closer together.
    linkForce
      .distance((l) => (l.kind === 'replaces' ? 45 : 22 + 150 * (1 - l.similarity)))
      .strength((l) => {
        const deg = Math.min(degree.get(idOf(l.source)) ?? 1, degree.get(idOf(l.target)) ?? 1);
        const base = l.kind === 'replaces' ? 0.25 : Math.pow(l.similarity, 3);
        return base / Math.sqrt(Math.max(deg, 1));
      });

    fg.graphData({ nodes, links });
  }, [graph, shown]);

  // ---- Looks: size = importance, fade = recency, plus selection and search ----
  const neighbours = useMemo(() => {
    const out = new Set<string>();
    if (selectedId && graph) {
      for (const l of graph.links) {
        if (l.source === selectedId) out.add(l.target);
        if (l.target === selectedId) out.add(l.source);
      }
    }
    return out;
  }, [graph, selectedId]);

  styleNode.current = (node: GNode) => {
    const obj = node.__obj;
    if (!obj) return;
    const a = node.atom;
    const color = new THREE.Color(colorOf(a));
    let opacity = recencyOpacity(a, Date.now());
    if (a.replacedBy.length) opacity *= 0.35;
    let emissive = 0.12;
    let scale = radiusOf(a);
    if (matches) {
      if (matches.has(a.id)) emissive = 0.55;
      else opacity *= 0.15;
    }
    if (selectedId === a.id) {
      emissive = 0.75;
      scale *= 1.35;
      opacity = Math.max(opacity, 0.9);
    } else if (neighbours.has(a.id)) {
      emissive = Math.max(emissive, 0.3);
    }
    obj.material.color = color;
    obj.material.emissive = color.clone().multiplyScalar(emissive);
    obj.material.opacity = opacity;
    obj.material.depthWrite = opacity > 0.6;
    obj.scale.setScalar(scale);
  };

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !graph) return;
    for (const node of currentNodes.current) styleNode.current(node);
    const touchesSelected = (l: GLink) => !!selectedId && (idOf(l.source) === selectedId || idOf(l.target) === selectedId);
    fg.linkColor((l: GLink) => {
      if (l.kind === 'replaces') return '#f5a524';
      if (touchesSelected(l)) return '#e6edf3';
      if (l.cross) return '#5b6878';
      return typeof l.source === 'string' ? '#5b6878' : colorOf(l.source.atom);
    }).linkWidth((l: GLink) => (touchesSelected(l) ? 0.8 : 0));
  }, [graph, matches, selectedId, colorOf, shown, neighbours]);

  // ---- Fly to the selected atom when asked (e.g. picked from the Notes list) ----
  useEffect(() => {
    if (!focusRequest || !selectedId) return;
    const node = nodeCache.current.get(selectedId);
    if (node && currentNodes.current.includes(node)) centerOn(node);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  // ---- Pause rendering while hidden ----------------------------------------------
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    if (active) fg.resumeAnimation();
    else fg.pauseAnimation();
  }, [active]);

  return <div ref={containerRef} className="graph-layer" aria-label="Notes graph" role="img" />;
});

export default GraphView;
