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

interface Props {
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
  width?: number;
  height?: number;
  /** Minimum edge weight to render. Nodes with no surviving edges still appear. */
  minWeight?: number;
  /** Categories to hide (clicking the legend toggles these). */
  hiddenCategories?: Set<string>;
}

const TYPE_TO_CATEGORY: Record<string, "people" | "projects" | "orgs" | "tools"> = {
  person: "people",
  project: "projects",
  organization: "orgs",
  org: "orgs",
  tool: "tools",
  topic: "projects",
  place: "orgs",
  entity: "projects",
};

const CATEGORY_COLOR: Record<string, string> = {
  people: "#9d83ff",
  projects: "#6ca6ff",
  orgs: "#ff9650",
  tools: "#50c8c8",
};

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

  // Seed: pinned node anchored at center, others on a spiral around it.
  const others = nodes.filter((n) => n.id !== pinnedId);
  if (pinnedId !== null && nodes.some((n) => n.id === pinnedId)) {
    positions.set(pinnedId, { x: cx, y: cy, vx: 0, vy: 0, pinned: true });
  }
  others.forEach((n, i) => {
    const angle = (i / Math.max(1, others.length)) * Math.PI * 2;
    const r = radius * (0.45 + 0.55 * (i / Math.max(1, others.length)));
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

  const ITERATIONS = 320;
  const REPULSION = 14000;
  const SPRING = 0.014;
  const CENTER_PULL = 0.008;
  const DAMPING = 0.78;
  // Hard separation floor — must clear the larger of the two nodes' radii
  // plus a label-height buffer so labels don't crash into other circles.
  const minDist = (a: ConstellationNode, b: ConstellationNode) =>
    radiusFor(a) + radiusFor(b) + 28;

  for (let iter = 0; iter < ITERATIONS; iter++) {
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
        const force = REPULSION / dsq;
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

    // Center pull + integrate
    for (const n of nodes) {
      const p = positions.get(n.id)!;
      if (p.pinned) continue;
      p.vx += (cx - p.x) * CENTER_PULL;
      p.vy += (cy - p.y) * CENTER_PULL;
      p.vx *= DAMPING;
      p.vy *= DAMPING;
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
  hiddenCategories,
}: Props) {
  const router = useRouter();
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Filter nodes by category visibility (legend toggle)
  const categoryVisibleNodes = useMemo(() => {
    if (!hiddenCategories || hiddenCategories.size === 0) return nodes;
    return nodes.filter((n) => {
      const cat = TYPE_TO_CATEGORY[n.type] || "projects";
      return !hiddenCategories.has(cat);
    });
  }, [nodes, hiddenCategories]);

  const categoryVisibleIds = useMemo(
    () => new Set(categoryVisibleNodes.map((n) => n.id)),
    [categoryVisibleNodes]
  );

  // Apply min-weight + hidden-category filters to edges
  const filteredEdges = useMemo(
    () =>
      edges.filter(
        (e) =>
          e.weight >= minWeight &&
          categoryVisibleIds.has(e.source) &&
          categoryVisibleIds.has(e.target)
      ),
    [edges, minWeight, categoryVisibleIds]
  );

  // Drop orphan nodes: only keep entities that still have at least one edge at
  // the current min-weight. The hottest node is always kept so the canvas has
  // a center anchor even when min-weight is high.
  const visibleNodes = useMemo(() => {
    const connected = new Set<number>();
    for (const e of filteredEdges) {
      connected.add(e.source);
      connected.add(e.target);
    }
    // Always pin the hottest visible node so the layout never goes empty
    const hottest = categoryVisibleNodes.length
      ? categoryVisibleNodes.reduce((best, n) =>
          n.mentions > best.mentions ? n : best
        )
      : null;
    if (hottest) connected.add(hottest.id);
    return categoryVisibleNodes.filter((n) => connected.has(n.id));
  }, [categoryVisibleNodes, filteredEdges]);

  // Adjacency for hover/focus dimming
  const adjacency = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const n of visibleNodes) map.set(n.id, new Set());
    for (const e of filteredEdges) {
      map.get(e.source)?.add(e.target);
      map.get(e.target)?.add(e.source);
    }
    return map;
  }, [visibleNodes, filteredEdges]);

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
  const pinnedId = focused ?? hottestId;

  const positions = useMemo(
    () => layout(visibleNodes, filteredEdges, width, height, pinnedId),
    [visibleNodes, filteredEdges, width, height, pinnedId]
  );

  // Active node = focused (locked) > hover (transient) > hottest
  const activeId = focused ?? hover;
  const activeNeighbors = activeId !== null ? adjacency.get(activeId) : null;
  const isDimmed = (id: number): boolean => {
    if (activeId === null) return false;
    if (id === activeId) return false;
    return !activeNeighbors?.has(id);
  };

  // Label placements (per-node x/y/anchor). A node missing from the map has
  // no room for its label — hidden until hovered or focused.
  const labelPlacements = useMemo(() => {
    const force = new Set<number>();
    if (hottestId !== null) force.add(hottestId);
    if (activeId !== null) {
      force.add(activeId);
      activeNeighbors?.forEach((n) => force.add(n));
    }
    return placeLabels(visibleNodes, positions, force);
  }, [visibleNodes, positions, hottestId, activeId, activeNeighbors]);

  function handleNodeClick(node: ConstellationNode, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Shift/cmd-click → focus mode (also covers no-slug nodes)
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      setFocused((f) => (f === node.id ? null : node.id));
      return;
    }
    // Plain click → wiki if we have a slug, else focus mode
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

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100%" }}
      onClick={(e) => {
        // Click on empty canvas exits focus mode
        if (e.target === e.currentTarget) setFocused(null);
      }}
    >
      {focused !== null && (
        <button
          type="button"
          onClick={() => setFocused(null)}
          style={{
            position: "absolute",
            top: 12,
            left: 12,
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid var(--line)",
            background: "rgba(7,7,10,0.7)",
            color: "var(--violet-300)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
            zIndex: 2,
          }}
        >
          ← exit focus
        </button>
      )}
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
          const isActiveEdge =
            activeId !== null &&
            (e.source === activeId || e.target === activeId);
          const dimmed =
            activeId !== null && !isActiveEdge ? 0.06 : Math.min(1, 0.25 + e.weight * 0.04);
          return (
            <line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={
                isActiveEdge
                  ? "rgba(157,131,255,0.9)"
                  : `rgba(157,131,255,${dimmed})`
              }
              strokeWidth={isActiveEdge ? 1.5 : 0.8}
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
                opacity={isDimmed(hottestId) ? 0.15 : 1}
              />
            );
          })()}

        {/* Nodes */}
        {visibleNodes.map((n) => {
          const pos = positions.get(n.id);
          if (!pos) return null;
          const cat = TYPE_TO_CATEGORY[n.type] || "projects";
          const color = CATEGORY_COLOR[cat];
          const isHot = n.id === hottestId;
          const isActive = n.id === activeId;
          const dimmed = isDimmed(n.id);
          const placement = labelPlacements.get(n.id);
          const showLabel = !dimmed && !!placement;
          const labelEmphasis = isActive || isHot;

          const NodeContent = (
            <g
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
              onClick={(e) => handleNodeClick(n, e)}
              opacity={dimmed ? 0.18 : 1}
              style={{ cursor: "pointer", transition: "opacity 160ms" }}
            >
              <circle
                cx={pos.x}
                cy={pos.y}
                r={pos.r}
                fill={color}
                fillOpacity={isActive ? 0.32 : isHot ? 0.25 : 0.15}
                stroke={color}
                strokeWidth={isActive ? 2 : isHot ? 1.5 : 1}
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
