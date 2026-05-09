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

  const ITERATIONS = 320;
  const REPULSION = 14000;
  const SPRING = 0.014;
  const CENTER_PULL = 0.008;
  const DAMPING = 0.78;
  const MIN_DIST = 80; // hard separation floor

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
        // Hard separation if too close
        if (dist < MIN_DIST) {
          const push = (MIN_DIST - dist) * 0.5;
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

  const out = new Map<number, { x: number; y: number; r: number }>();
  for (const n of nodes) {
    const p = positions.get(n.id)!;
    const r = 8 + (n.mentions / maxMentions) * 22;
    out.set(n.id, {
      x: Math.max(r + 70, Math.min(width - r - 70, p.x)),
      y: Math.max(r + 28, Math.min(height - r - 28, p.y)),
      r,
    });
  }
  return out;
}

/** Cheap label-collision pass: hide the smaller node's label when its bounding
 * box would overlap a larger node's. Always show labels for `forceShow`. */
function pickVisibleLabels(
  nodes: ConstellationNode[],
  positions: Map<number, { x: number; y: number; r: number }>,
  forceShow: Set<number>
): Set<number> {
  const visible = new Set<number>(forceShow);
  // Sort by mentions desc — bigger nodes claim space first.
  const ordered = [...nodes].sort((a, b) => b.mentions - a.mentions);
  const claimed: { x: number; y: number; w: number; h: number; id: number }[] = [];
  for (const n of ordered) {
    const p = positions.get(n.id);
    if (!p) continue;
    const labelLen = n.label.length;
    const w = Math.min(160, labelLen * 6.5 + 8);
    const h = 14;
    const labelY = p.y + p.r + 14;
    const box = { x: p.x - w / 2, y: labelY - 6, w, h, id: n.id };
    let overlaps = false;
    for (const c of claimed) {
      if (
        box.x < c.x + c.w &&
        box.x + box.w > c.x &&
        box.y < c.y + c.h &&
        box.y + box.h > c.y
      ) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps || forceShow.has(n.id)) {
      claimed.push(box);
      visible.add(n.id);
    }
  }
  return visible;
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

  // Filter nodes by category visibility
  const visibleNodes = useMemo(() => {
    if (!hiddenCategories || hiddenCategories.size === 0) return nodes;
    return nodes.filter((n) => {
      const cat = TYPE_TO_CATEGORY[n.type] || "projects";
      return !hiddenCategories.has(cat);
    });
  }, [nodes, hiddenCategories]);

  const visibleNodeIds = useMemo(
    () => new Set(visibleNodes.map((n) => n.id)),
    [visibleNodes]
  );

  // Apply min-weight + hidden-category filters to edges
  const filteredEdges = useMemo(
    () =>
      edges.filter(
        (e) =>
          e.weight >= minWeight &&
          visibleNodeIds.has(e.source) &&
          visibleNodeIds.has(e.target)
      ),
    [edges, minWeight, visibleNodeIds]
  );

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

  // Visible labels = collision-resolved set, expanded with hover/focus + neighbors
  const visibleLabels = useMemo(() => {
    const force = new Set<number>();
    if (hottestId !== null) force.add(hottestId);
    if (activeId !== null) {
      force.add(activeId);
      activeNeighbors?.forEach((n) => force.add(n));
    }
    return pickVisibleLabels(visibleNodes, positions, force);
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
          const showLabel = !dimmed && visibleLabels.has(n.id);
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
              {showLabel && (
                <text
                  x={pos.x}
                  y={pos.y + pos.r + 14}
                  textAnchor="middle"
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
