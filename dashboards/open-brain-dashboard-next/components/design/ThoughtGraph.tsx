"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export interface ConstellationNode {
  id: number;
  label: string;
  type: string;
  mentions: number;
  slug?: string | null;
}

export interface ConstellationEdge {
  source: number;
  target: number;
  weight: number;
}

export interface EntityTypeInfo {
  entity_type: string;
  label: string;
  color: string;
  count: number;
}

interface Props {
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
  width?: number;
  height?: number;
  /** Minimum edge weight to render. Nodes with no surviving edges still appear. */
  minWeight?: number;
  /** entity_types that the legend has toggled OFF. Keys are raw entity_type values. */
  hiddenTypes?: Set<string>;
  /** Authoritative color/label source per entity_type. If missing, falls back to a default palette. */
  entityTypes?: EntityTypeInfo[];
  /** Persistently highlight one node (e.g. the entity currently being viewed). */
  selectedId?: number | null;
  /** Additional entity_ids whose edges should bypass the min_weight filter
   *  alongside selectedId — used by the wiki search to keep matched entities
   *  fully connected even when their co-occurrences are single-thought. */
  bypassMinWeightIds?: Set<number>;
  /** Override the default plain-click behavior. If provided, click calls this instead of router.push. */
  onNodeClick?: (node: ConstellationNode) => void;
  /** Compact strip mode — only renders selected node + first-degree neighbors in a row. */
  collapsed?: boolean;
}

// Fallback palette used when no entityTypes prop is provided (or for unknown types).
const FALLBACK_COLOR: Record<string, string> = {
  person: "#9d83ff",
  project: "#6ca6ff",
  organization: "#ff9650",
  org: "#ff9650",
  tool: "#50c8c8",
  topic: "#b8a6ff",
  place: "#ffd870",
  entity: "#a8b8d0",
};

function colorFor(
  type: string,
  entityTypes?: EntityTypeInfo[]
): string {
  if (entityTypes) {
    const match = entityTypes.find((t) => t.entity_type === type);
    if (match) return match.color;
  }
  return FALLBACK_COLOR[type] ?? "#a8b8d0";
}

// Lightweight force layout: spring edges + repulsion + center pull. Deterministic
// per `nodes/edges` content so the graph doesn't reshuffle on each re-render.
// Layout runs in a virtual coordinate space; the auto-fit step below scales the
// result to fill the visible canvas.
function layout(
  nodes: ConstellationNode[],
  edges: ConstellationEdge[],
  width: number,
  height: number,
  pinnedId: number | null
) {
  if (!nodes.length) return new Map<number, { x: number; y: number; r: number }>();

  const positions = new Map<
    number,
    { x: number; y: number; vx: number; vy: number; pinned: boolean }
  >();
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.38;

  // Seed: pinned node anchored at center, others on a sunflower (golden-ratio)
  // distribution. The sunflower fills 2D space evenly — far less prone to
  // collapsing into a line than a single-arm spiral.
  const others = nodes.filter((n) => n.id !== pinnedId);
  if (pinnedId !== null && nodes.some((n) => n.id === pinnedId)) {
    positions.set(pinnedId, { x: cx, y: cy, vx: 0, vy: 0, pinned: true });
  }
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  others.forEach((n, i) => {
    const t = i + 1;
    const angle = t * goldenAngle;
    const r = radius * Math.sqrt(t / Math.max(1, others.length));
    positions.set(n.id, {
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      vx: 0,
      vy: 0,
      pinned: false,
    });
  });

  const maxMentions = Math.max(...nodes.map((n) => n.mentions), 1);
  // Node radius scales with mention count. Slightly bigger when there are
  // fewer nodes (the auto-fit step amplifies this further).
  const sizeBoost = Math.max(1, Math.min(2.2, 30 / Math.max(4, nodes.length)));
  const radiusFor = (n: ConstellationNode) =>
    (8 + (n.mentions / maxMentions) * 22) * sizeBoost;

  // Forces tuned for typical 5–30 node graphs. Repulsion was previously 14000
  // which collapsed dense graphs onto a diagonal because center-pull couldn't
  // contain it. Lower repulsion + stronger center-pull keeps the cluster 2D.
  const ITERATIONS = 360;
  const REPULSION = 8500;
  const SPRING = 0.013;
  const CENTER_PULL = 0.018;
  const DAMPING = 0.82;
  // Hard separation floor — must clear the larger of the two nodes' radii
  // plus a label-height buffer so labels don't crash into other circles.
  const minDist = (a: ConstellationNode, b: ConstellationNode) =>
    radiusFor(a) + radiusFor(b) + 28;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    // Cooling: forces start strong and ease off so the layout settles instead
    // of oscillating. Velocity cap also tightens with temperature.
    const t = 1 - iter / ITERATIONS;
    const temp = 0.4 + 0.6 * t;
    const maxStep = 30 * t + 4;

    // Repulsion (every pair)
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const pa = positions.get(a.id)!;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const pb = positions.get(b.id)!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let dsq = dx * dx + dy * dy;
        if (dsq < 1) {
          dx = (i - j) * 0.5;
          dy = (j - i) * 0.5;
          dsq = 4;
        }
        const dist = Math.sqrt(dsq);
        const force = (REPULSION * temp) / dsq;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (!pa.pinned) {
          pa.vx += fx;
          pa.vy += fy;
        }
        if (!pb.pinned) {
          pb.vx -= fx;
          pb.vy -= fy;
        }
        // Hard separation
        const md = minDist(a, b);
        if (dist < md) {
          const push = (md - dist) * 0.5;
          if (!pa.pinned) {
            pa.x += (dx / dist) * push;
            pa.y += (dy / dist) * push;
          }
          if (!pb.pinned) {
            pb.x -= (dx / dist) * push;
            pb.y -= (dy / dist) * push;
          }
        }
      }
    }

    // Spring (edges) — heavier edges pull harder
    for (const e of edges) {
      const pa = positions.get(e.source);
      const pb = positions.get(e.target);
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const k = SPRING * Math.min(3, e.weight);
      if (!pa.pinned) {
        pa.vx += dx * k;
        pa.vy += dy * k;
      }
      if (!pb.pinned) {
        pb.vx -= dx * k;
        pb.vy -= dy * k;
      }
    }

    // Center pull + integrate (with velocity cap so a single iteration can't
    // fling a node halfway across the canvas).
    for (const n of nodes) {
      const p = positions.get(n.id)!;
      if (p.pinned) continue;
      p.vx += (cx - p.x) * CENTER_PULL;
      p.vy += (cy - p.y) * CENTER_PULL;
      p.vx *= DAMPING;
      p.vy *= DAMPING;
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > maxStep) {
        p.vx = (p.vx / speed) * maxStep;
        p.vy = (p.vy / speed) * maxStep;
      }
      p.x += p.vx;
      p.y += p.vy;
    }
  }

  // Auto-fit: scale & translate so the populated bbox fills the canvas with a
  // generous label margin. Fewer entities → bigger nodes; many entities → all
  // still visible (we allow zoom-out, not just zoom-in).
  const raw = nodes.map((n) => {
    const p = positions.get(n.id)!;
    return { id: n.id, x: p.x, y: p.y, r: radiusFor(n) };
  });
  const minX = Math.min(...raw.map((p) => p.x - p.r));
  const maxX = Math.max(...raw.map((p) => p.x + p.r));
  const minY = Math.min(...raw.map((p) => p.y - p.r));
  const maxY = Math.max(...raw.map((p) => p.y + p.r));
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;

  // Reserve room for labels on all sides.
  const padTop = 40;
  const padBottom = 56;
  const padX = 90;
  const targetW = width - padX * 2;
  const targetH = height - padTop - padBottom;
  const scaleX = bboxW > 0 ? targetW / bboxW : 1;
  const scaleY = bboxH > 0 ? targetH / bboxH : 1;
  // Cap zoom-in at 2.2× and zoom-out at 0.45× (so nothing vanishes).
  const finalScale = Math.max(0.45, Math.min(scaleX, scaleY, 2.2));

  const out = new Map<number, { x: number; y: number; r: number }>();
  for (const p of raw) {
    out.set(p.id, {
      x: padX + (p.x - minX) * finalScale + (targetW - bboxW * finalScale) / 2,
      y:
        padTop + (p.y - minY) * finalScale + (targetH - bboxH * finalScale) / 2,
      r: p.r * finalScale,
    });
  }
  return out;
}

export type LabelAnchor = "middle" | "start" | "end";
export interface LabelPlacement {
  x: number;
  y: number;
  anchor: LabelAnchor;
}

/** Place labels around their nodes, trying below → above → right → left.
 * A placement is rejected if its bounding box overlaps another node's circle
 * or another label. Labels in `forceShow` get one extra try (slightly farther
 * from the node) before being placed-anyway as a last resort. */
function placeLabels(
  nodes: ConstellationNode[],
  positions: Map<number, { x: number; y: number; r: number }>,
  forceShow: Set<number>
): Map<number, LabelPlacement> {
  const placements = new Map<number, LabelPlacement>();
  // Bigger nodes claim space first, then force-show, then the rest.
  const ordered = [...nodes].sort((a, b) => {
    const fa = forceShow.has(a.id) ? 1 : 0;
    const fb = forceShow.has(b.id) ? 1 : 0;
    if (fa !== fb) return fb - fa;
    return b.mentions - a.mentions;
  });

  const claimedLabels: { x: number; y: number; w: number; h: number }[] = [];

  for (const n of ordered) {
    const p = positions.get(n.id);
    if (!p) continue;
    const labelLen = n.label.length;
    const w = Math.min(180, labelLen * 6.8 + 10);
    const h = 16;
    const gap = 14;
    const force = forceShow.has(n.id);

    // Candidate placements ordered by preference
    type Candidate = LabelPlacement & {
      box: { x: number; y: number; w: number; h: number };
    };
    const candidates: Candidate[] = [
      // below center
      {
        x: p.x,
        y: p.y + p.r + gap,
        anchor: "middle",
        box: { x: p.x - w / 2, y: p.y + p.r + gap - 8, w, h },
      },
      // above center
      {
        x: p.x,
        y: p.y - p.r - gap + 4,
        anchor: "middle",
        box: { x: p.x - w / 2, y: p.y - p.r - gap - 4, w, h },
      },
      // right of node
      {
        x: p.x + p.r + 8,
        y: p.y + 4,
        anchor: "start",
        box: { x: p.x + p.r + 6, y: p.y - h / 2, w, h },
      },
      // left of node
      {
        x: p.x - p.r - 8,
        y: p.y + 4,
        anchor: "end",
        box: { x: p.x - p.r - w - 6, y: p.y - h / 2, w, h },
      },
    ];

    function intersectsCircle(box: {
      x: number;
      y: number;
      w: number;
      h: number;
    }): boolean {
      for (const other of nodes) {
        if (other.id === n.id) continue;
        const op = positions.get(other.id);
        if (!op) continue;
        const closestX = Math.max(box.x, Math.min(op.x, box.x + box.w));
        const closestY = Math.max(box.y, Math.min(op.y, box.y + box.h));
        const dx = op.x - closestX;
        const dy = op.y - closestY;
        if (dx * dx + dy * dy < op.r * op.r) return true;
      }
      return false;
    }

    function intersectsClaimed(box: {
      x: number;
      y: number;
      w: number;
      h: number;
    }): boolean {
      for (const c of claimedLabels) {
        if (
          box.x < c.x + c.w &&
          box.x + box.w > c.x &&
          box.y < c.y + c.h &&
          box.y + box.h > c.y
        ) {
          return true;
        }
      }
      return false;
    }

    let chosen: Candidate | null = null;
    for (const c of candidates) {
      if (!intersectsCircle(c.box) && !intersectsClaimed(c.box)) {
        chosen = c;
        break;
      }
    }
    // For force-shown labels, fall back to "below" even if it collides — we
    // accept the visual cost of an overlap to keep the focus context legible.
    if (!chosen && force) {
      chosen = candidates[0];
    }
    if (!chosen) continue;

    claimedLabels.push(chosen.box);
    placements.set(n.id, {
      x: chosen.x,
      y: chosen.y,
      anchor: chosen.anchor,
    });
  }
  return placements;
}

export function ThoughtGraph({
  nodes,
  edges,
  width = 1100,
  height = 600,
  minWeight = 1,
  hiddenTypes,
  entityTypes,
  selectedId = null,
  bypassMinWeightIds,
  onNodeClick,
  collapsed = false,
}: Props) {
  const router = useRouter();
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Responsive width. The `width` prop is a fallback / minimum; in reality
  // the constellation should fill its container, which on desktop is often
  // 1600-1800px (wider than the 1100 default). Without this, the viewBox
  // aspect mismatches the container aspect and preserveAspectRatio="meet"
  // letterboxes 300-400px of empty space on each side. ResizeObserver
  // measures the actual container width and we use that for the viewBox +
  // the layout's spread area.
  const [actualWidth, setActualWidth] = useState<number>(width);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = Math.round(e.contentRect.width);
        // Only update if meaningfully different (>2px) so micro-jitter
        // doesn't yo-yo the layout.
        if (w > 0 && Math.abs(w - actualWidth) > 2) setActualWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Effective width used by layout + viewBox. Use the larger of the prop
  // width (minimum) and the measured container width.
  const effWidth = Math.max(width, actualWidth);

  // Viewport transform: scale (k) and translate (x, y) of the world-space
  // graph relative to the SVG viewBox. Wheel/pinch updates k; click-drag
  // updates x/y. Pointer-vs-click is resolved via a movement threshold so
  // node selection still works for non-drag clicks.
  const [viewport, setViewport] = useState<{ k: number; x: number; y: number }>({
    k: 1,
    x: 0,
    y: 0,
  });
  // True after the first time we auto-fit to content. Stops the layout
  // useEffect from re-fitting (and zooming the user back out) every time
  // they pan or filter nodes.
  const didAutoFit = useRef(false);
  const pointers = useRef<
    Map<number, { x: number; y: number; startK: number; startX: number; startY: number }>
  >(new Map());
  const dragState = useRef<{
    moved: boolean;
    pointerId: number;
    nodeId: number | null;
    startX: number;
    startY: number;
    startVx: number;
    startVy: number;
  } | null>(null);
  const pinchState = useRef<{ initialDist: number; initialK: number; centerWorld: { x: number; y: number } } | null>(null);

  // Filter nodes by entity_type visibility (legend toggle)
  const categoryVisibleNodes = useMemo(() => {
    if (!hiddenTypes || hiddenTypes.size === 0) return nodes;
    return nodes.filter((n) => !hiddenTypes.has(n.type));
  }, [nodes, hiddenTypes]);

  const categoryVisibleIds = useMemo(
    () => new Set(categoryVisibleNodes.map((n) => n.id)),
    [categoryVisibleNodes]
  );

  // Edges respecting min-weight + hidden categories (full set, focus-agnostic).
  //
  // Edges that touch the selected entity (or any search-match entity passed in
  // via bypassMinWeightIds) skip the min_weight filter so focusing on or
  // searching for someone always shows their full neighborhood — including
  // single-thought (weight=1) co-occurrences. Without this bypass, a sparsely
  // connected entity (someone mentioned in only a couple of personal thoughts)
  // would appear with no neighbors when min_weight defaults to 2. Edges between
  // non-bypassed pairs still respect min_weight, so the background stays clean.
  const baseEdges = useMemo(
    () =>
      edges.filter(
        (e) => {
          if (!categoryVisibleIds.has(e.source) || !categoryVisibleIds.has(e.target)) {
            return false;
          }
          const bypass =
            (selectedId !== null && (e.source === selectedId || e.target === selectedId)) ||
            (bypassMinWeightIds &&
              (bypassMinWeightIds.has(e.source) || bypassMinWeightIds.has(e.target)));
          if (bypass) return true;
          return e.weight >= minWeight;
        }
      ),
    [edges, minWeight, categoryVisibleIds, selectedId, bypassMinWeightIds]
  );

  // Full adjacency (used to compute the neighborhood when focusing)
  const baseAdjacency = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const n of categoryVisibleNodes) map.set(n.id, new Set());
    for (const e of baseEdges) {
      map.get(e.source)?.add(e.target);
      map.get(e.target)?.add(e.source);
    }
    return map;
  }, [categoryVisibleNodes, baseEdges]);

  // Visible nodes:
  // - Focus mode (shift+click drilldown) → focused node + first-degree neighbors only
  // - Otherwise → keep EVERY node from the server response, including orphans
  //   (nodes with no edges at the current min_weight). The min_weight slider
  //   filters edges; orphans drift into their own clusters via the force
  //   layout's repulsion. This is what surfaces disconnected entities like
  //   Jira-ticket clusters or work-topic islands that don't co-occur with the
  //   user themself — previously these were silently filtered out.
  const visibleNodes = useMemo(() => {
    if (focused !== null && baseAdjacency.has(focused)) {
      const neighbors = baseAdjacency.get(focused) ?? new Set();
      const keep = new Set<number>([focused, ...neighbors]);
      return categoryVisibleNodes.filter((n) => keep.has(n.id));
    }
    return categoryVisibleNodes;
  }, [categoryVisibleNodes, focused, baseAdjacency]);

  const visibleIds = useMemo(
    () => new Set(visibleNodes.map((n) => n.id)),
    [visibleNodes]
  );

  // Edges to render — both endpoints must be in visibleNodes
  const filteredEdges = useMemo(
    () =>
      baseEdges.filter(
        (e) => visibleIds.has(e.source) && visibleIds.has(e.target)
      ),
    [baseEdges, visibleIds]
  );

  const hottestId = useMemo(
    () =>
      visibleNodes.length === 0
        ? null
        : visibleNodes.reduce((best, n) =>
            n.mentions > best.mentions ? n : best
          ).id,
    [visibleNodes]
  );

  // Always anchor a node at the center: focused (user-selected) or the hottest
  // node by default, so the layout doesn't fly apart at low min-weights.
  // Anchor priority: explicit focus > caller-provided selection > hottest node
  const pinnedId = focused ?? selectedId ?? hottestId;

  // Layout uses the effective (container-measured) width so positions
  // spread to fill the actual canvas, not just the fallback 1100.
  const positions = useMemo(
    () => layout(visibleNodes, filteredEdges, effWidth, height, pinnedId),
    [visibleNodes, filteredEdges, effWidth, height, pinnedId]
  );

  // Active node for label emphasis (focus is centered; non-focus uses hover)
  const activeId = focused ?? hover;
  const activeNeighbors = activeId !== null ? baseAdjacency.get(activeId) : null;
  // No more dimming — focus filters the visible node set, hover just highlights
  const isHoverDimmed = (id: number): boolean => {
    if (focused !== null) return false; // focus mode already filters
    if (hover === null) return false;
    if (id === hover) return false;
    return !baseAdjacency.get(hover)?.has(id);
  };

  // Label placements (per-node x/y/anchor). Nodes missing from the map have
  // no clear slot — they go unlabelled until hovered/focused.
  const labelPlacements = useMemo(() => {
    const force = new Set<number>();
    if (hottestId !== null) force.add(hottestId);
    if (activeId !== null) {
      force.add(activeId);
      activeNeighbors?.forEach((n) => {
        if (visibleIds.has(n)) force.add(n);
      });
    }
    return placeLabels(visibleNodes, positions, force);
  }, [visibleNodes, positions, hottestId, activeId, activeNeighbors, visibleIds]);

  // ─── Zoom + pan plumbing ─────────────────────────────────────────────────
  // World coord = position the layout produced (in viewBox units before
  // viewport transform). Screen coord = position the user actually sees in
  // viewBox units after the transform. Labels are positioned in screen
  // space so they stay readable at any zoom level.

  // Convert a client (clientX/clientY) point into viewBox coords by
  // inverting the SVG's CTM. Handles the fact that the SVG element may be
  // rendered at any client size; viewBox stays at width×height.
  const clientToViewBox = (cx: number, cy: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = cx;
    pt.y = cy;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    return pt.matrixTransform(ctm.inverse());
  };

  // Wheel zoom — toward cursor position. React's onWheel is registered as
  // a passive listener and can't preventDefault, which causes the page to
  // scroll instead of the graph zooming. We attach a non-passive native
  // listener via useEffect instead.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    function onWheel(this: SVGSVGElement, e: WheelEvent) {
      e.preventDefault();
      const pt = clientToViewBox(e.clientX, e.clientY);
      if (!pt) return;
      const wx = (pt.x - viewport.x) / viewport.k;
      const wy = (pt.y - viewport.y) / viewport.k;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newK = Math.max(0.15, Math.min(12, viewport.k * factor));
      setViewport({
        k: newK,
        x: pt.x - wx * newK,
        y: pt.y - wy * newK,
      });
    }
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
    // viewport intentionally in deps so the handler closure picks up the
    // latest transform state on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport.k, viewport.x, viewport.y]);

  function handlePointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (e.button !== 0 && e.pointerType !== "touch") return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, startK: viewport.k, startX: viewport.x, startY: viewport.y });
    if (pointers.current.size === 1) {
      // Single pointer → potential pan. Set dragState; real pan triggers
      // when movement crosses the threshold in pointermove.
      dragState.current = {
        moved: false,
        pointerId: e.pointerId,
        nodeId: null,
        startX: e.clientX,
        startY: e.clientY,
        startVx: viewport.x,
        startVy: viewport.y,
      };
    } else if (pointers.current.size === 2) {
      // Two pointers → pinch zoom. Cancel any in-progress pan.
      const pts = Array.from(pointers.current.values());
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      pinchState.current = {
        initialDist: Math.hypot(dx, dy),
        initialK: viewport.k,
        centerWorld: { x: 0, y: 0 }, // recomputed on first pinch move
      };
      dragState.current = null;
    }
  }

  // Pan/pinch updates fire on window so they survive the pointer leaving the
  // SVG bounds mid-drag. Cleanup runs when pointers go back to zero.
  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, {
        ...pointers.current.get(e.pointerId)!,
        x: e.clientX,
        y: e.clientY,
      });
      // Pinch (two pointers)
      if (pinchState.current && pointers.current.size === 2) {
        const pts = Array.from(pointers.current.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const factor = dist / pinchState.current.initialDist;
        const newK = Math.max(0.15, Math.min(12, pinchState.current.initialK * factor));
        // Centroid (in client coords) → viewBox → world. Keep that world
        // point under the centroid as scale changes.
        const cx = (pts[0].x + pts[1].x) / 2;
        const cy = (pts[0].y + pts[1].y) / 2;
        const pt = clientToViewBox(cx, cy);
        if (pt) {
          const wx = (pt.x - viewport.x) / viewport.k;
          const wy = (pt.y - viewport.y) / viewport.k;
          setViewport({ k: newK, x: pt.x - wx * newK, y: pt.y - wy * newK });
        }
        if (dragState.current) dragState.current.moved = true;
        return;
      }
      // Pan (single pointer)
      if (dragState.current && dragState.current.pointerId === e.pointerId) {
        const dx = e.clientX - dragState.current.startX;
        const dy = e.clientY - dragState.current.startY;
        if (!dragState.current.moved && Math.hypot(dx, dy) < 5) return;
        dragState.current.moved = true;
        // Translate client px → SVG units. Reuse one CTM-inverse multiply
        // by transforming both endpoints and subtracting.
        const a = clientToViewBox(dragState.current.startX, dragState.current.startY);
        const b = clientToViewBox(e.clientX, e.clientY);
        if (!a || !b) return;
        setViewport({
          k: viewport.k,
          x: dragState.current.startVx + (b.x - a.x),
          y: dragState.current.startVy + (b.y - a.y),
        });
      }
    }
    function onUp(e: PointerEvent) {
      pointers.current.delete(e.pointerId);
      if (pointers.current.size === 0) {
        pinchState.current = null;
        // Leave dragState.moved set until the next pointerdown — handleNodeClick
        // checks it to suppress clicks that were actually drags.
      } else if (pointers.current.size === 1 && pinchState.current) {
        // Pinch ended, fall back to pan on the remaining pointer
        pinchState.current = null;
        const remaining = Array.from(pointers.current.entries())[0];
        dragState.current = {
          moved: true,
          pointerId: remaining[0],
          nodeId: null,
          startX: remaining[1].x,
          startY: remaining[1].y,
          startVx: viewport.x,
          startVy: viewport.y,
        };
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport.k, viewport.x, viewport.y]);

  // Auto-fit: zoom-to-fit so the bounding box of all positions fills 80% of
  // the canvas. Extracted so the useEffect and the manual "⌖ fit" button
  // can share the same code path.
  function applyAutoFit() {
    if (positions.size === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [, pos] of positions) {
      minX = Math.min(minX, pos.x - pos.r);
      maxX = Math.max(maxX, pos.x + pos.r);
      minY = Math.min(minY, pos.y - pos.r);
      maxY = Math.max(maxY, pos.y + pos.r);
    }
    const pad = 80;
    const bboxW = Math.max(1, maxX - minX);
    const bboxH = Math.max(1, maxY - minY);
    const k = Math.min((effWidth - pad * 2) / bboxW, (height - pad * 2) / bboxH, 1.6);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setViewport({
      k,
      x: effWidth / 2 - cx * k,
      y: height / 2 - cy * k,
    });
  }

  // Auto-fit on first render so the user sees the whole graph rather than a
  // tight blob. Only runs once per mount; the user's wheel/pinch takes over
  // from there. Re-fitting on every filter change would yo-yo the zoom.
  // The ⌖ fit button gives a manual escape hatch.
  //
  // ALSO re-fit when effWidth changes meaningfully (container resize / first
  // ResizeObserver tick). Otherwise the initial fit uses the fallback width
  // (1100) and the user sees a tight cluster, then the container measures
  // its real ~1700px width but the viewport doesn't re-fit.
  const prevEffWidth = useRef(effWidth);
  useEffect(() => {
    if (positions.size === 0) return;
    const widthChanged = Math.abs(effWidth - prevEffWidth.current) > 20;
    if (didAutoFit.current && !widthChanged) return;
    applyAutoFit();
    didAutoFit.current = true;
    prevEffWidth.current = effWidth;
    // applyAutoFit closes over positions/effWidth, both already in deps;
    // re-creating it on every render would cause loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, effWidth, height]);

  function handleNodeClick(node: ConstellationNode, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Drag suppression: if the user just panned (movement > threshold during
    // pointer-down→up), don't fire the node click. Reset the flag for the
    // next pointer interaction.
    if (dragState.current?.moved) {
      dragState.current.moved = false;
      return;
    }
    // Shift/cmd-click → focus mode (always, regardless of onNodeClick override)
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      setFocused((f) => (f === node.id ? null : node.id));
      return;
    }
    // Plain click — onNodeClick override takes priority (used by the wiki page
    // to switch the loaded entity in-place instead of full navigation).
    if (onNodeClick) {
      onNodeClick(node);
      return;
    }
    if (node.slug) {
      router.push(`/wiki?slug=${node.slug}`);
      return;
    }
    setFocused((f) => (f === node.id ? null : node.id));
  }

  if (!visibleNodes.length) {
    return (
      <div
        style={{
          width: "100%",
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--fg-4)",
          fontSize: 12,
        }}
      >
        No entities captured yet — start adding thoughts to populate the graph.
      </div>
    );
  }

  // Collapsed mode — horizontal strip of selected + first-degree neighbors,
  // skipping the force layout entirely.
  if (collapsed) {
    const anchorId = selectedId ?? hottestId;
    const anchor = anchorId !== null ? nodes.find((n) => n.id === anchorId) : null;
    if (!anchor) return null;
    const neighborIds = baseAdjacency.get(anchor.id) ?? new Set<number>();
    const neighbors = nodes
      .filter((n) => neighborIds.has(n.id))
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 8);

    const stripH = Math.max(80, height);
    const cy = stripH / 2;
    const cx = width / 2;
    const stride = Math.min(110, (width - 200) / Math.max(1, neighbors.length));

    return (
      <svg
        width="100%"
        height={stripH}
        viewBox={`0 0 ${width} ${stripH}`}
        style={{ display: "block" }}
      >
        {/* Edges from anchor to each neighbor */}
        {neighbors.map((n, i) => {
          const x = cx + (i - (neighbors.length - 1) / 2) * stride + stride * (neighbors.length / 2 + 1);
          return (
            <line
              key={n.id}
              x1={cx}
              y1={cy}
              x2={x}
              y2={cy}
              stroke="rgba(157,131,255,0.4)"
              strokeWidth={1}
            />
          );
        })}
        {/* Anchor */}
        {(() => {
          const color = colorFor(anchor.type, entityTypes);
          return (
            <g
              onClick={(e) => handleNodeClick(anchor, e)}
              style={{ cursor: "pointer" }}
            >
              <circle cx={cx} cy={cy} r={28} fill={color} fillOpacity={0.5} stroke="#fff" strokeOpacity={0.8} strokeWidth={1.5} />
              <circle cx={cx} cy={cy} r={6} fill={color} />
              <text x={cx} y={cy + 46} textAnchor="middle" fill="var(--fg)" fontSize="12" fontWeight="600">
                {anchor.label}
              </text>
            </g>
          );
        })()}
        {/* Neighbors */}
        {neighbors.map((n, i) => {
          const x = cx + (i - (neighbors.length - 1) / 2) * stride + stride * (neighbors.length / 2 + 1);
          const color = colorFor(n.type, entityTypes);
          return (
            <g
              key={n.id}
              onClick={(e) => handleNodeClick(n, e)}
              style={{ cursor: "pointer" }}
            >
              <circle cx={x} cy={cy} r={14} fill={color} fillOpacity={0.4} stroke={color} strokeWidth={1} />
              <circle cx={x} cy={cy} r={4} fill={color} />
              <text x={x} y={cy + 32} textAnchor="middle" fill="var(--fg-3)" fontSize="10.5">
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100%" }}
      onClick={(e) => {
        // Click on empty canvas exits focus mode
        if (e.target === e.currentTarget) setFocused(null);
      }}
    >
      {focused !== null && (() => {
        const focusedNode = nodes.find((n) => n.id === focused);
        return (
          <div
            style={{
              position: "absolute",
              top: 12,
              left: 12,
              display: "flex",
              alignItems: "center",
              gap: 8,
              zIndex: 2,
            }}
          >
            <button
              type="button"
              onClick={() => setFocused(null)}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                border: "1px solid var(--line)",
                background: "color-mix(in srgb, var(--bg-0) 80%, transparent)",
                color: "var(--violet-300)",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
              }}
            >
              ← exit focus
            </button>
            {focusedNode && (
              <span
                style={{
                  fontSize: 11,
                  color: "var(--fg-3)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                showing {focusedNode.label}&apos;s neighborhood
              </span>
            )}
          </div>
        );
      })()}
      <svg
        ref={svgRef}
        width="100%"
        height={height}
        viewBox={`0 0 ${effWidth} ${height}`}
        style={{
          display: "block",
          cursor: dragState.current?.moved
            ? "grabbing"
            : hover !== null
              ? "pointer"
              : "grab",
          touchAction: "none", // Prevent native browser pinch/scroll on touch
        }}
        onPointerDown={handlePointerDown}
      >
        <defs>
          <radialGradient id="constellation-hot-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#9d83ff" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#9d83ff" stopOpacity="0" />
          </radialGradient>
          <radialGradient
            id="constellation-canvas-glow"
            cx="50%"
            cy="50%"
            r="50%"
          >
            <stop offset="0%" stopColor="rgba(130,97,255,0.10)" />
            <stop offset="100%" stopColor="rgba(130,97,255,0)" />
          </radialGradient>
        </defs>
        <rect
          x="0"
          y="0"
          width={effWidth}
          height={height}
          fill="url(#constellation-canvas-glow)"
          onClick={() => {
            // Empty-canvas click resets focus only if it wasn't a drag.
            if (dragState.current?.moved) {
              dragState.current.moved = false;
              return;
            }
            setFocused(null);
          }}
          style={{ cursor: focused !== null ? "pointer" : "inherit" }}
        />

        {/* World-space content (edges + nodes) inside the viewport transform.
            Scaling/panning happens here; labels are rendered outside this
            group so they stay readable at any zoom level. */}
        <g transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.k})`}>
          {/* Edges */}
          {filteredEdges.map((e, i) => {
            const a = positions.get(e.source);
            const b = positions.get(e.target);
            if (!a || !b) return null;
            const isHoverEdge =
              hover !== null && (e.source === hover || e.target === hover);
            const dimmed =
              hover !== null && focused === null && !isHoverEdge
                ? 0.06
                : Math.min(1, 0.25 + e.weight * 0.04);
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={
                  isHoverEdge
                    ? "rgba(157,131,255,0.9)"
                    : `rgba(157,131,255,${dimmed})`
                }
                // Scale stroke width inversely with zoom so edges stay 1px-ish
                // at any zoom level rather than getting comically thick.
                strokeWidth={(isHoverEdge ? 1.5 : 0.8) / Math.max(0.5, viewport.k)}
              />
            );
          })}

          {/* Hot-node glow */}
          {hottestId !== null &&
            (() => {
              const node = visibleNodes.find((n) => n.id === hottestId);
              const pos = positions.get(hottestId);
              if (!node || !pos) return null;
              return (
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={pos.r * 2.4}
                  fill="url(#constellation-hot-glow)"
                  opacity={isHoverDimmed(hottestId) ? 0.15 : 1}
                />
              );
            })()}

          {/* Node circles only (no text — text rendered in screen space below). */}
          {visibleNodes.map((n) => {
            const pos = positions.get(n.id);
            if (!pos) return null;
            const color = colorFor(n.type, entityTypes);
            const isHot = n.id === hottestId;
            const isActive = n.id === activeId;
            const isSelected = selectedId !== null && n.id === selectedId;
            const dimmed = isHoverDimmed(n.id);

            return (
              <g
                key={n.id}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                onClick={(e) => handleNodeClick(n, e)}
                opacity={dimmed ? 0.18 : 1}
                style={{ cursor: "pointer", transition: "opacity 160ms" }}
              >
                {isSelected && (
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={pos.r + 6 / viewport.k}
                    fill="none"
                    stroke="#ffffff"
                    strokeOpacity={0.7}
                    strokeWidth={1.5 / Math.max(0.5, viewport.k)}
                  />
                )}
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={pos.r}
                  fill={color}
                  fillOpacity={isSelected ? 0.42 : isActive ? 0.32 : isHot ? 0.25 : 0.15}
                  stroke={color}
                  strokeWidth={(isSelected ? 2 : isActive ? 2 : isHot ? 1.5 : 1) / Math.max(0.5, viewport.k)}
                />
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={Math.max(2 / viewport.k, pos.r * 0.25)}
                  fill={color}
                />
                <title>{`${n.label} · ${n.mentions} mentions${
                  n.slug ? " · click to open wiki, ⇧-click to focus" : " · click to focus"
                }`}</title>
              </g>
            );
          })}
        </g>

        {/* Labels in screen space — outside the viewport transform so they
            stay readable at any zoom level. Includes leader lines from each
            labeled node to its label position so the user can always tell
            which label belongs to which node. */}
        {(() => {
          // Recompute labels at the current viewport so more labels surface
          // as the user zooms in (more screen space per node = more slots
          // for non-overlapping labels).
          const screenPositions = new Map<number, { x: number; y: number; r: number }>();
          for (const [id, pos] of positions) {
            screenPositions.set(id, {
              x: pos.x * viewport.k + viewport.x,
              y: pos.y * viewport.k + viewport.y,
              r: pos.r * viewport.k,
            });
          }
          const force = new Set<number>();
          if (hottestId !== null) force.add(hottestId);
          if (activeId !== null) {
            force.add(activeId);
            activeNeighbors?.forEach((nId) => {
              if (visibleIds.has(nId)) force.add(nId);
            });
          }
          if (selectedId !== null) force.add(selectedId);
          const zoomPlacements = placeLabels(visibleNodes, screenPositions, force);
          return visibleNodes.map((n) => {
            const sp = screenPositions.get(n.id);
            const placement = zoomPlacements.get(n.id);
            if (!sp || !placement) return null;
            const isHot = n.id === hottestId;
            const isActive = n.id === activeId;
            const isSelected = selectedId !== null && n.id === selectedId;
            const dimmed = isHoverDimmed(n.id);
            if (dimmed) return null;
            const labelEmphasis = isActive || isHot || isSelected;

            // Leader line from node centre to label position — drawn when
            // the label is offset more than the node radius from the node.
            const dx = placement.x - sp.x;
            const dy = placement.y - sp.y;
            const dist = Math.hypot(dx, dy);
            const showLeader = dist > sp.r + 6;
            // Pull leader endpoint slightly off the label baseline so it
            // attaches to the label visually rather than overlapping.
            const labelAttachX =
              placement.anchor === "start"
                ? placement.x - 2
                : placement.anchor === "end"
                  ? placement.x + 2
                  : placement.x;
            const labelAttachY = placement.y - 3;

            return (
              <g key={`label-${n.id}`} style={{ pointerEvents: "none" }}>
                {showLeader && (
                  <line
                    x1={sp.x}
                    y1={sp.y}
                    x2={labelAttachX}
                    y2={labelAttachY}
                    stroke={labelEmphasis ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.15)"}
                    strokeWidth={0.6}
                  />
                )}
                <text
                  x={placement.x}
                  y={placement.y}
                  textAnchor={placement.anchor}
                  fill={labelEmphasis ? "var(--fg)" : "var(--fg-3)"}
                  fontSize={labelEmphasis ? 12 : 10.5}
                  fontWeight={labelEmphasis ? 500 : 400}
                >
                  {n.label}
                </text>
                {isHot && !isActive && (
                  <text
                    x={sp.x}
                    y={sp.y + 4}
                    textAnchor="middle"
                    fill="var(--fg)"
                    fontSize="13"
                    fontWeight="600"
                  >
                    {n.mentions}
                  </text>
                )}
              </g>
            );
          });
        })()}
      </svg>
      <div
        style={{
          position: "absolute",
          bottom: 8,
          left: 12,
          fontSize: 10,
          color: "var(--fg-4)",
          fontFamily: "var(--font-mono)",
          pointerEvents: "none",
        }}
      >
        click → wiki · ⇧-click → focus · drag → pan · wheel/pinch → zoom
      </div>
      <button
        type="button"
        onClick={applyAutoFit}
        style={{
          position: "absolute",
          bottom: 8,
          right: 12,
          padding: "4px 9px",
          borderRadius: 6,
          fontSize: 10,
          background: "var(--bg-2)",
          border: "1px solid var(--line)",
          color: "var(--fg-3)",
          fontFamily: "var(--font-mono)",
          cursor: "pointer",
        }}
        title="Reset zoom — fit the whole graph in view"
      >
        ⌖ fit
      </button>
    </div>
  );
}
