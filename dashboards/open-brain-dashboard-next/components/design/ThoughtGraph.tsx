"use client";

import { useEffect, useMemo, useState } from "react";

export interface ConstellationNode {
  id: number;
  label: string;
  type: string;
  mentions: number;
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
  height: number
) {
  if (!nodes.length) return new Map<number, { x: number; y: number }>();

  // Seed positions on a spiral so layout converges quickly
  const positions = new Map<number, { x: number; y: number; vx: number; vy: number }>();
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.35;
  nodes.forEach((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2;
    const r = radius * (0.4 + 0.6 * (i / nodes.length));
    positions.set(n.id, {
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      vx: 0,
      vy: 0,
    });
  });

  const maxMentions = Math.max(...nodes.map((n) => n.mentions), 1);

  const ITERATIONS = 220;
  const REPULSION = 6500;
  const SPRING = 0.018;
  const CENTER_PULL = 0.012;
  const DAMPING = 0.78;

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
          dx = (Math.random() - 0.5) * 2;
          dy = (Math.random() - 0.5) * 2;
          dsq = 4;
        }
        const dist = Math.sqrt(dsq);
        const force = REPULSION / dsq;
        pa.vx += (dx / dist) * force;
        pa.vy += (dy / dist) * force;
        pb.vx -= (dx / dist) * force;
        pb.vy -= (dy / dist) * force;
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
      pa.vx += dx * k;
      pa.vy += dy * k;
      pb.vx -= dx * k;
      pb.vy -= dy * k;
    }

    // Center pull
    for (const n of nodes) {
      const p = positions.get(n.id)!;
      p.vx += (cx - p.x) * CENTER_PULL;
      p.vy += (cy - p.y) * CENTER_PULL;
      p.vx *= DAMPING;
      p.vy *= DAMPING;
      p.x += p.vx;
      p.y += p.vy;
    }
  }

  // Clamp to viewport with a margin proportional to node radius
  const out = new Map<number, { x: number; y: number }>();
  for (const n of nodes) {
    const p = positions.get(n.id)!;
    const r = 8 + (n.mentions / maxMentions) * 22;
    out.set(n.id, {
      x: Math.max(r + 60, Math.min(width - r - 60, p.x)),
      y: Math.max(r + 24, Math.min(height - r - 24, p.y)),
    });
  }
  return out;
}

export function ThoughtGraph({
  nodes,
  edges,
  width = 1100,
  height = 400,
}: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const positions = useMemo(
    () => layout(nodes, edges, width, height),
    [nodes, edges, width, height]
  );

  const maxMentions = useMemo(
    () => Math.max(1, ...nodes.map((n) => n.mentions)),
    [nodes]
  );
  const hottestId = useMemo(
    () => nodes.reduce<number | null>((best, n) => {
      if (best === null) return n.id;
      const bestNode = nodes.find((x) => x.id === best);
      return n.mentions > (bestNode?.mentions ?? 0) ? n.id : best;
    }, null),
    [nodes]
  );

  if (!nodes.length) {
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
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: "block" }}
    >
      <defs>
        <radialGradient id="constellation-hot-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#9d83ff" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#9d83ff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="constellation-canvas-glow" cx="50%" cy="50%" r="50%">
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
      />

      {/* Edges */}
      {edges.map((e, i) => {
        const a = positions.get(e.source);
        const b = positions.get(e.target);
        if (!a || !b) return null;
        const isHot = e.source === hottestId || e.target === hottestId;
        const opacity = Math.min(1, 0.25 + e.weight * 0.04);
        return (
          <line
            key={i}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={`rgba(157,131,255,${opacity})`}
            strokeWidth={isHot ? 1 : 0.6}
          />
        );
      })}

      {/* Hot-node glow */}
      {hottestId !== null &&
        (() => {
          const node = nodes.find((n) => n.id === hottestId);
          const pos = positions.get(hottestId);
          if (!node || !pos) return null;
          const r = 8 + (node.mentions / maxMentions) * 22;
          return (
            <circle
              cx={pos.x}
              cy={pos.y}
              r={r * 2.4}
              fill="url(#constellation-hot-glow)"
            />
          );
        })()}

      {/* Nodes */}
      {nodes.map((n) => {
        const pos = positions.get(n.id);
        if (!pos) return null;
        const r = 8 + (n.mentions / maxMentions) * 22;
        const cat = TYPE_TO_CATEGORY[n.type] || "projects";
        const color = CATEGORY_COLOR[cat];
        const isHot = n.id === hottestId;
        const isHover = hover === n.id;
        return (
          <g
            key={n.id}
            style={{ cursor: "pointer" }}
            onMouseEnter={() => setHover(n.id)}
            onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
          >
            <circle
              cx={pos.x}
              cy={pos.y}
              r={r}
              fill={color}
              fillOpacity={isHot ? 0.25 : 0.15}
              stroke={color}
              strokeWidth={isHot || isHover ? 1.5 : 1}
            />
            <circle
              cx={pos.x}
              cy={pos.y}
              r={Math.max(2, r * 0.25)}
              fill={color}
            />
            <text
              x={pos.x}
              y={pos.y + r + 14}
              textAnchor="middle"
              fill={isHot ? "var(--fg)" : "var(--fg-3)"}
              fontSize={isHot ? 12 : 10.5}
              fontWeight={isHot ? 500 : 400}
            >
              {n.label}
            </text>
            {isHot && (
              <text
                x={pos.x}
                y={pos.y + 4}
                textAnchor="middle"
                fill="var(--fg)"
                fontSize="13"
                fontWeight="600"
              >
                {n.mentions}
              </text>
            )}
            {isHover && !isHot && (
              <title>{`${n.label} · ${n.mentions} mentions`}</title>
            )}
          </g>
        );
      })}
    </svg>
  );
}
