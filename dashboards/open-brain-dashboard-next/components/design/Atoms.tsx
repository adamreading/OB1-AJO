"use client";

import type { CSSProperties, ReactNode } from "react";

const TYPE_COLORS: Record<string, { bg: string; fg: string; dot: string }> = {
  task: { bg: "rgba(108,166,255,0.10)", fg: "#9bc0ff", dot: "#6ca6ff" },
  lesson: { bg: "rgba(255,150,80,0.10)", fg: "#ffb787", dot: "#ff9650" },
  decision: { bg: "rgba(220,120,220,0.10)", fg: "#e6a3e6", dot: "#dc78dc" },
  journal: { bg: "rgba(255,120,140,0.10)", fg: "#ffa3b3", dot: "#ff7894" },
  meeting: { bg: "rgba(80,200,200,0.10)", fg: "#88d8d8", dot: "#50c8c8" },
  idea: { bg: "rgba(240,180,80,0.10)", fg: "#f5cd84", dot: "#f0b450" },
  observation: { bg: "rgba(180,180,200,0.06)", fg: "#b5b5c5", dot: "#9595a8" },
  reference: { bg: "rgba(130,160,200,0.08)", fg: "#a8b8d0", dot: "#8aa0c8" },
  person_note: { bg: "rgba(157,131,255,0.10)", fg: "#c8b6ff", dot: "#9d83ff" },
};

export const TYPE_DOT_COLOR: Record<string, string> = Object.fromEntries(
  Object.entries(TYPE_COLORS).map(([k, v]) => [k, v.dot])
);

export function TypeChip({
  type,
  source,
  count,
}: {
  type: string;
  source?: string;
  count?: number;
}) {
  const c = TYPE_COLORS[type] || TYPE_COLORS.observation;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 7px 2px 6px",
        borderRadius: 4,
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        fontWeight: 500,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.bg}`,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: c.dot,
        }}
      />
      {type}
      {source && (
        <span style={{ color: "var(--fg-4)", marginLeft: 2, opacity: 0.8 }}>
          · {source}
        </span>
      )}
      {count != null && (
        <span style={{ color: "var(--fg-4)", marginLeft: 2 }}>{count}</span>
      )}
    </span>
  );
}

export function Card({
  children,
  title,
  eyebrow,
  action,
  padding = 20,
  style,
}: {
  children: ReactNode;
  title?: ReactNode;
  eyebrow?: ReactNode;
  action?: ReactNode;
  padding?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: "var(--bg-2)",
        border: "1px solid var(--line)",
        borderRadius: 14,
        padding,
        display: "flex",
        flexDirection: "column",
        ...style,
      }}
    >
      {(title || eyebrow || action) && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            {title && (
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: "var(--fg)",
                }}
              >
                {title}
              </span>
            )}
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function SegBar<T extends string>({
  options,
  active,
  onChange,
  size = "md",
}: {
  options: readonly T[];
  active: T;
  onChange?: (v: T) => void;
  size?: "sm" | "md";
}) {
  const padY = size === "sm" ? 4 : 6;
  const padX = size === "sm" ? 8 : 10;
  const fs = size === "sm" ? 11 : 12;
  return (
    <div
      style={{
        display: "inline-flex",
        padding: 3,
        gap: 2,
        background: "var(--bg-3)",
        border: "1px solid var(--line)",
        borderRadius: 8,
      }}
    >
      {options.map((o) => {
        const isActive = o === active;
        return (
          <button
            key={o}
            type="button"
            onClick={() => onChange?.(o)}
            style={{
              padding: `${padY}px ${padX}px`,
              borderRadius: 6,
              fontSize: fs,
              color: isActive ? "var(--fg)" : "var(--fg-3)",
              background: isActive
                ? "rgba(130,97,255,0.18)"
                : "transparent",
              border: isActive
                ? "1px solid rgba(157,131,255,0.25)"
                : "1px solid transparent",
              fontWeight: isActive ? 500 : 400,
              cursor: onChange ? "pointer" : "default",
              fontFamily: "inherit",
              whiteSpace: "nowrap",
            }}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

export function Sparkline({
  data,
  color = "var(--violet-400)",
  height = 32,
  fill = true,
}: {
  data: number[];
  color?: string;
  height?: number;
  fill?: boolean;
}) {
  if (!data.length) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const w = 100;
  const pts = data
    .map(
      (v, i) =>
        `${(i / (data.length - 1)) * w},${
          100 - ((v - min) / range) * 80 - 10
        }`
    )
    .join(" ");
  const fillPts = `0,100 ${pts} ${w},100`;
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ width: "100%", height, display: "block" }}
    >
      {fill && <polyline points={fillPts} fill={color} opacity="0.12" />}
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TypeDonut({
  data,
  size = 160,
}: {
  data: { value: number; color: string }[];
  size?: number;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={size / 2 - 12}
          fill="none"
          stroke="rgba(255,255,255,0.04)"
          strokeWidth="14"
        />
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--fg-4)"
          fontSize="11"
          fontFamily="var(--font-mono)"
        >
          0
        </text>
      </svg>
    );
  }
  const r = size / 2 - 12;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.04)"
        strokeWidth="14"
      />
      {data.map((d, i) => {
        const len = (d.value / total) * circ;
        const dasharray = `${len} ${circ - len}`;
        const dashoffset = -offset;
        offset += len;
        return (
          <circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={d.color}
            strokeWidth="14"
            strokeDasharray={dasharray}
            strokeDashoffset={dashoffset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        );
      })}
      <text
        x="50%"
        y="48%"
        textAnchor="middle"
        fill="var(--fg)"
        fontSize="22"
        fontFamily="var(--font-sans)"
        fontWeight="600"
        letterSpacing="-0.02em"
      >
        {total}
      </text>
      <text
        x="50%"
        y="60%"
        textAnchor="middle"
        fill="var(--fg-4)"
        fontSize="9"
        fontFamily="var(--font-mono)"
        letterSpacing="0.14em"
      >
        THOUGHTS
      </text>
    </svg>
  );
}

// Importance is 1–5. Color reflects label: 1–2 low, 3 med, 4–5 high/critical.
export function ImpDots({ value }: { value: number }) {
  const v = Math.max(1, Math.min(5, Math.round(value)));
  const labelColor = v >= 4 ? "#ff7894" : v === 3 ? "#f0b450" : "#8a8a9b";
  const label =
    v >= 5 ? "critical" : v >= 4 ? "high" : v === 3 ? "med" : v === 2 ? "low" : "min";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", gap: 2 }}>
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: i <= v ? labelColor : "var(--bg-4)",
              border: i <= v ? "none" : "1px solid var(--line)",
            }}
          />
        ))}
      </div>
      <span
        style={{
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          color: labelColor,
        }}
      >
        {label}
      </span>
    </div>
  );
}

// Score is the worker.js heuristic (0..100). Bar + numeric.
export function ScoreBar({ value }: { value: number }) {
  const max = 100;
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const color =
    value <= 15 ? "#ff9650" : value <= 30 ? "#ffb787" : "var(--violet-400)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div
        style={{
          flex: 1,
          height: 4,
          background: "var(--bg-3)",
          borderRadius: 2,
        }}
      >
        <div
          style={{
            width: `${Math.max(4, pct)}%`,
            height: "100%",
            background: color,
            borderRadius: 2,
          }}
        />
      </div>
      <span
        className="num"
        style={{
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: "var(--fg-2)",
          width: 22,
          textAlign: "right",
        }}
      >
        {Math.round(value)}
      </span>
    </div>
  );
}

// Importance comes in two flavors in the codebase:
// - 1..5 ("kanban-style", from design)
// - 0..100 ("legacy", with PRIORITY_LEVELS from lib/types)
// Map a 0..100 value to 1..5 for ImpDots display.
export function importanceToFiveScale(importance: number): number {
  if (importance >= 80) return 5;
  if (importance >= 60) return 4;
  if (importance >= 30) return 3;
  if (importance >= 10) return 2;
  return 1;
}
