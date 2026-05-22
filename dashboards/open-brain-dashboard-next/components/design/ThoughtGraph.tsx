"use client";

import { useMemo, useRef, useState } from "react";
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
  // - Focus mode → focused node + its first-degree neighbors only
  // - Otherwise → drop orphans (no edges at current min-weight). Always keep
  //   the hottest visible entity as a center anchor.
  const visibleNodes = useMemo(() => {
    if (focused !== null && baseAdjacency.has(focused)) {
      const neighbors = baseAdjacency.get(focused) ?? new Set();
      const keep = new Set<number>([focused, ...neighbors]);
      return categoryVisibleNodes.filter((n) => keep.has(n.id));
    }
    const connected = new Set<number>();
    for (const e of baseEdges) {
      connected.add(e.source);
      connected.add(e.target);
    }
    const hottest = categoryVisibleNodes.length
      ? categoryVisibleNodes.reduce((best, n) =>
          n.mentions > best.mentions ? n : best
        )
      : null;
    if (hottest) connected.add(hottest.id);
    return categoryVisibleNodes.filter((n) => connected.has(n.id));
  }, [categoryVisibleNodes, baseEdges, focused, baseAdjacency]);

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

  const positions = useMemo(
    () => layout(visibleNodes, filteredEdges, width, height, pinnedId),
    [visibleNodes, filteredEdges, width, height, pinnedId]
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

  function handleNodeClick(node: ConstellationNode, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
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
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ display: "block", cursor: hover !== null ? "pointer" : "default" }}
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
          width={width}
          height={height}
          fill="url(#constellation-canvas-glow)"
          onClick={() => setFocused(null)}
          style={{ cursor: focused !== null ? "pointer" : "default" }}
        />

        {/* Edges */}
        {filteredEdges.map((e, i) => {
          const a = positions.get(e.source);
          const b = positions.get(e.target);
          if (!a || !b) return null;
          // In hover mode, dim edges that don't touch the hovered node.
          // Focus mode already filters non-relevant nodes out, so all
          // remaining edges are by definition the focused entity's network.
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
              strokeWidth={isHoverEdge ? 1.5 : 0.8}
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

        {/* Nodes */}
        {visibleNodes.map((n) => {
          const pos = positions.get(n.id);
          if (!pos) return null;
          const color = colorFor(n.type, entityTypes);
          const isHot = n.id === hottestId;
          const isActive = n.id === activeId;
          const isSelected = selectedId !== null && n.id === selectedId;
          const dimmed = isHoverDimmed(n.id);
          const placement = labelPlacements.get(n.id);
          const showLabel = !dimmed && !!placement;
          const labelEmphasis = isActive || isHot || isSelected;

          const NodeContent = (
            <g
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
              onClick={(e) => handleNodeClick(n, e)}
              opacity={dimmed ? 0.18 : 1}
              style={{ cursor: "pointer", transition: "opacity 160ms" }}
            >
              {/* Selection ring — wiki "you are here" indicator */}
              {isSelected && (
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={pos.r + 6}
                  fill="none"
                  stroke="#ffffff"
                  strokeOpacity={0.7}
                  strokeWidth={1.5}
                />
              )}
              <circle
                cx={pos.x}
                cy={pos.y}
                r={pos.r}
                fill={color}
                fillOpacity={isSelected ? 0.42 : isActive ? 0.32 : isHot ? 0.25 : 0.15}
                stroke={color}
                strokeWidth={isSelected ? 2 : isActive ? 2 : isHot ? 1.5 : 1}
              />
              <circle
                cx={pos.x}
                cy={pos.y}
                r={Math.max(2, pos.r * 0.25)}
                fill={color}
              />
              {showLabel && placement && (
                <text
                  x={placement.x}
                  y={placement.y}
                  textAnchor={placement.anchor}
                  fill={labelEmphasis ? "var(--fg)" : "var(--fg-3)"}
                  fontSize={labelEmphasis ? 12 : 10.5}
                  fontWeight={labelEmphasis ? 500 : 400}
                  style={{ pointerEvents: "none" }}
                >
                  {n.label}
                </text>
              )}
              {isHot && !isActive && (
                <text
                  x={pos.x}
                  y={pos.y + 4}
                  textAnchor="middle"
                  fill="var(--fg)"
                  fontSize="13"
                  fontWeight="600"
                  style={{ pointerEvents: "none" }}
                >
                  {n.mentions}
                </text>
              )}
              <title>{`${n.label} · ${n.mentions} mentions${
                n.slug ? " · click to open wiki, ⇧-click to focus" : " · click to focus"
              }`}</title>
            </g>
          );

          return <g key={n.id}>{NodeContent}</g>;
        })}
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
        click → wiki · ⇧-click → focus · click empty → reset
      </div>
    </div>
  );
}
