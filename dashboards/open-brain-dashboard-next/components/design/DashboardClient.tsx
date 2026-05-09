"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ThoughtGraph,
  type ConstellationNode,
  type ConstellationEdge,
  type EntityTypeInfo,
} from "./ThoughtGraph";
import { Card, SegBar, Sparkline, TypeChip, TypeDonut } from "./Atoms";
import { AddToBrain } from "@/components/AddToBrain";
import type { Thought } from "@/lib/types";

type Window = "7d" | "30d" | "90d" | "All";
type Context = "All" | "Work" | "Personal";

interface KpiData {
  total: number;
  active: number;
  wiki: number;
  review: number;
  newThisWindow: number;
}

interface TypeBreakdown {
  type: string;
  count: number;
  color: string;
}

interface WorkflowBreakdown {
  status: string;
  count: number;
  pct: number;
  color: string;
  label: string;
}

interface DashboardClientProps {
  initialWindow: Window;
  initialContext: Context;
  greeting: { eyebrow: string; title: string; subtitle: string };
  kpi: KpiData;
  typeBreakdown: TypeBreakdown[];
  workflowBreakdown: WorkflowBreakdown[];
  recent: Thought[];
}

const WORKFLOW_LABELS: Record<string, string> = {
  backlog: "Backlog",
  planning: "Planning",
  active: "Active",
  review: "Review",
  done: "Done",
};

export function DashboardClient({
  initialWindow,
  initialContext,
  greeting,
  kpi,
  typeBreakdown,
  workflowBreakdown,
  recent,
}: DashboardClientProps) {
  const [windowSel, setWindowSel] = useState<Window>(initialWindow);
  const [contextSel, setContextSel] = useState<Context>(initialContext);

  const [graph, setGraph] = useState<{
    nodes: ConstellationNode[];
    edges: ConstellationEdge[];
    strongest: { source: string; target: string; weight: number } | null;
  }>({ nodes: [], edges: [], strongest: null });
  const [graphLoading, setGraphLoading] = useState(true);
  const [minWeight, setMinWeight] = useState(2);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [entityTypes, setEntityTypes] = useState<EntityTypeInfo[]>([]);

  function toggleType(t: string) {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  // Pull the dynamic entity-type catalog so the legend matches the DB
  useEffect(() => {
    let cancelled = false;
    fetch("/api/entity-types")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.types) return;
        setEntityTypes(d.types as EntityTypeInfo[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Reflect filter changes in the URL so server-rendered KPIs update on hard nav
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    sp.set("window", windowSel === "All" ? "all" : windowSel.replace("d", ""));
    if (contextSel === "All") sp.delete("context");
    else sp.set("context", contextSel.toLowerCase());
    const qs = sp.toString();
    const target = `/${qs ? `?${qs}` : ""}`;
    if (window.location.pathname + window.location.search !== target) {
      window.history.replaceState(null, "", target);
    }
  }, [windowSel, contextSel]);

  useEffect(() => {
    let cancelled = false;
    setGraphLoading(true);
    const params = new URLSearchParams();
    const days =
      windowSel === "All"
        ? "0"
        : windowSel === "7d"
          ? "7"
          : windowSel === "30d"
            ? "30"
            : "90";
    params.set("days", days);
    params.set("limit", "30");
    // Always fetch with min_weight=1 so the client-side slider can tighten the
    // graph without re-fetching from the server every adjustment.
    params.set("min_weight", "1");
    if (contextSel !== "All") params.set("classification", contextSel.toLowerCase());

    fetch(`/api/constellation?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setGraph({
          nodes: data.nodes ?? [],
          edges: data.edges ?? [],
          strongest: data.strongest ?? null,
        });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setGraphLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [windowSel, contextSel]);

  return (
    <div
      className="ob1-fullbleed from-legacy"
      style={{
        background: "var(--bg-0)",
        fontFamily: "var(--font-sans)",
        minHeight: "100vh",
      }}
    >
      <div
        style={{
          padding: "32px 40px 56px",
          display: "flex",
          flexDirection: "column",
          gap: 28,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 24,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              {greeting.eyebrow}
            </div>
            <h1
              style={{
                margin: 0,
                fontSize: 32,
                fontWeight: 600,
                letterSpacing: "-0.025em",
                lineHeight: 1.15,
                color: "var(--fg)",
              }}
            >
              {greeting.title}
            </h1>
            <p
              style={{
                margin: "6px 0 0",
                color: "var(--fg-3)",
                fontSize: 15,
                maxWidth: 620,
              }}
            >
              {greeting.subtitle}
            </p>
          </div>
          <div
            style={{ display: "flex", gap: 12, alignItems: "center" }}
          >
            <SegBar
              options={["All", "Work", "Personal"] as const}
              active={contextSel}
              onChange={setContextSel}
            />
            <div
              style={{ width: 1, height: 28, background: "var(--line)" }}
            />
            <SegBar
              options={["7d", "30d", "90d", "All"] as const}
              active={windowSel}
              onChange={setWindowSel}
            />
          </div>
        </div>

        {/* KPIs */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 16,
          }}
        >
          {[
            {
              eyebrow: "Total Thoughts",
              num: kpi.total.toLocaleString(),
              sub:
                kpi.newThisWindow > 0
                  ? `+${kpi.newThisWindow} this ${windowSel === "All" ? "all-time" : windowSel}`
                  : "no new in window",
              color: "var(--violet-400)",
            },
            {
              eyebrow: "Active Items",
              num: String(kpi.active),
              sub: kpi.active === 0 ? "nothing in motion" : "in workflow",
              color: "var(--violet-400)",
            },
            {
              eyebrow: "Wiki Entities",
              num: String(kpi.wiki),
              sub: "with a wiki page",
              color: "var(--violet-400)",
            },
            {
              eyebrow: "Awaiting Review",
              num: String(kpi.review),
              sub: kpi.review === 0 ? "Inbox zero ✓" : "pending triage",
              color: kpi.review === 0 ? "var(--ok)" : "#ffb787",
            },
          ].map((k) => {
            const num = parseInt(k.num.replace(/,/g, ""), 10);
            const spark = makeSparkline(num);
            return (
              <div
                key={k.eyebrow}
                style={{
                  padding: "18px 18px 14px",
                  borderRadius: 12,
                  background: "var(--bg-2)",
                  border: "1px solid var(--line)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <span className="eyebrow">{k.eyebrow}</span>
                <span
                  className="num"
                  style={{
                    fontSize: 32,
                    fontWeight: 600,
                    color: "var(--fg)",
                    lineHeight: 1,
                  }}
                >
                  {k.num}
                </span>
                <span
                  style={{
                    fontSize: 11.5,
                    color: k.color,
                    marginTop: 2,
                  }}
                >
                  {k.sub}
                </span>
                <div style={{ marginTop: 6 }}>
                  <Sparkline data={spark} color={k.color} height={24} />
                </div>
              </div>
            );
          })}
        </div>

        {/* Constellation hero */}
        <div
          style={{
            borderRadius: 16,
            overflow: "hidden",
            background:
              "radial-gradient(ellipse at 50% 30%, rgba(130,97,255,0.08), rgba(12,12,18,0.4))",
            border: "1px solid var(--line)",
            position: "relative",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              padding: "20px 24px 0",
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            <div>
              <span className="eyebrow">Constellation</span>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 500,
                  marginTop: 4,
                  color: "var(--fg)",
                }}
              >
                What your brain is thinking about
              </div>
            </div>
            <div
              style={{
                display: "flex",
                gap: 16,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              {entityTypes.map((t) => {
                const hidden = hiddenTypes.has(t.entity_type);
                return (
                  <button
                    key={t.entity_type}
                    type="button"
                    onClick={() => toggleType(t.entity_type)}
                    title={
                      hidden
                        ? `Show ${t.label}`
                        : `Hide ${t.label} — click to filter the graph`
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 11,
                      color: hidden ? "var(--fg-4)" : "var(--fg-3)",
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      padding: "2px 4px",
                      fontFamily: "inherit",
                      opacity: hidden ? 0.4 : 1,
                      textDecoration: hidden ? "line-through" : "none",
                      transition: "opacity 120ms",
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: t.color,
                        opacity: hidden ? 0.3 : 1,
                      }}
                    />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
          {/* Edge-weight slider — thin out weak connections without a refetch */}
          {!graphLoading && graph.edges.length > 0 && (() => {
            const sliderMax = Math.max(
              5,
              Math.min(20, Math.max(...graph.edges.map((e) => e.weight)))
            );
            return (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 24px 0",
                  fontSize: 11,
                  color: "var(--fg-3)",
                }}
              >
                <span className="eyebrow">Min co-occurrence</span>
                <input
                  type="range"
                  min={1}
                  max={sliderMax}
                  value={minWeight}
                  onChange={(e) => setMinWeight(parseInt(e.target.value, 10))}
                  style={{
                    flex: 1,
                    maxWidth: 240,
                    accentColor: "var(--violet-400)",
                  }}
                />
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--fg-2)",
                    minWidth: 24,
                  }}
                >
                  {minWeight}
                </span>
                <span style={{ color: "var(--fg-4)" }}>
                  {(() => {
                    const liveEdges = graph.edges.filter(
                      (e) => e.weight >= minWeight
                    );
                    const liveNodes = new Set<number>();
                    for (const e of liveEdges) {
                      liveNodes.add(e.source);
                      liveNodes.add(e.target);
                    }
                    return `showing ${liveNodes.size} entities · ${liveEdges.length} of ${graph.edges.length} links`;
                  })()}
                </span>
              </div>
            );
          })()}
          <div style={{ padding: "12px 12px 28px" }}>
            {graphLoading ? (
              <div
                style={{
                  height: 600,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--fg-4)",
                  fontSize: 12,
                }}
              >
                Loading entity constellation…
              </div>
            ) : (
              <ThoughtGraph
                nodes={graph.nodes}
                edges={graph.edges}
                width={1100}
                height={600}
                minWeight={minWeight}
                hiddenTypes={hiddenTypes}
                entityTypes={entityTypes}
              />
            )}
          </div>
          {graph.strongest && (
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                padding: "0 24px 16px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  fontSize: 11,
                  color: "var(--fg-4)",
                  padding: "6px 10px",
                  background: "rgba(7,7,10,0.7)",
                  borderRadius: 6,
                  border: "1px solid var(--line)",
                }}
              >
                Strongest cluster:{" "}
                <span style={{ color: "var(--violet-300)" }}>
                  {graph.strongest.source} ↔ {graph.strongest.target} (
                  {graph.strongest.weight} thoughts)
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Donut + Workflow */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 16,
          }}
        >
          <Card
            eyebrow="By type"
            title={`Composition · ${windowSel === "All" ? "all-time" : `last ${windowSel}`}`}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 24,
                flexWrap: "wrap",
              }}
            >
              <TypeDonut
                size={150}
                data={typeBreakdown.map((t) => ({
                  value: t.count,
                  color: t.color,
                }))}
              />
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "6px 20px",
                  flex: 1,
                  minWidth: 220,
                }}
              >
                {typeBreakdown.length === 0 && (
                  <span style={{ color: "var(--fg-4)", fontSize: 12 }}>
                    No thoughts in window.
                  </span>
                )}
                {typeBreakdown.slice(0, 8).map((t) => (
                  <div
                    key={t.type}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <TypeChip type={t.type} />
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: "var(--fg-3)",
                      }}
                    >
                      {t.count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <Card
            eyebrow="Workflow"
            title={`${workflowBreakdown.reduce((s, w) => (w.status === "done" ? s : s + w.count), 0)} items in motion`}
            action={
              <Link
                href="/kanban"
                style={{
                  fontSize: 12,
                  color: "var(--violet-300)",
                  textDecoration: "none",
                }}
              >
                Open board →
              </Link>
            }
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              {workflowBreakdown.map((s) => (
                <div
                  key={s.status}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <span
                    style={{
                      width: 70,
                      fontSize: 12,
                      color: "var(--fg-2)",
                    }}
                  >
                    {s.label}
                  </span>
                  <div
                    style={{
                      flex: 1,
                      height: 6,
                      background: "var(--bg-3)",
                      borderRadius: 3,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${s.pct}%`,
                        height: "100%",
                        background: s.color,
                        opacity: 0.85,
                      }}
                    />
                  </div>
                  <span
                    className="num"
                    style={{
                      width: 28,
                      textAlign: "right",
                      fontSize: 13,
                      color: "var(--fg)",
                    }}
                  >
                    {s.count}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Add to brain */}
        <Card eyebrow="Capture" title="Add to brain" padding={20}>
          <AddToBrain rows={3} />
        </Card>

        {/* Recent activity */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
              marginBottom: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <span className="eyebrow">Recent activity</span>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: "var(--fg)",
                }}
              >
                Last {recent.length} captures
              </span>
            </div>
            <Link
              href="/thoughts"
              style={{
                fontSize: 12,
                color: "var(--violet-300)",
                textDecoration: "none",
              }}
            >
              View all {kpi.total.toLocaleString()} →
            </Link>
          </div>
          <div
            style={{
              background: "var(--bg-2)",
              border: "1px solid var(--line)",
              borderRadius: 14,
              overflow: "hidden",
            }}
          >
            {recent.length === 0 && (
              <div
                style={{
                  padding: 32,
                  textAlign: "center",
                  color: "var(--fg-4)",
                  fontSize: 13,
                }}
              >
                Nothing captured yet — add your first thought above.
              </div>
            )}
            {recent.map((t, i) => {
              const tags = (t.metadata?.topics as string[]) ?? [];
              return (
                <Link
                  key={t.id}
                  href={`/thoughts/${t.id}`}
                  style={{
                    padding: "14px 20px",
                    borderBottom:
                      i < recent.length - 1
                        ? "1px solid var(--line)"
                        : "none",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 16,
                    textDecoration: "none",
                    color: "inherit",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      minWidth: 100,
                    }}
                  >
                    <TypeChip type={t.type} source={t.source_type} />
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        color: "var(--fg-4)",
                      }}
                    >
                      imp {t.importance}
                    </span>
                  </div>
                  <div
                    style={{
                      flex: 1,
                      fontSize: 13.5,
                      color: "var(--fg-2)",
                      lineHeight: 1.45,
                    }}
                  >
                    {t.content.split("\n")[0].slice(0, 180)}
                    {tags.length > 0 && (
                      <div
                        style={{
                          marginTop: 6,
                          display: "flex",
                          gap: 6,
                          flexWrap: "wrap",
                        }}
                      >
                        {tags.slice(0, 4).map((tag) => (
                          <span
                            key={tag}
                            style={{
                              fontSize: 10.5,
                              fontFamily: "var(--font-mono)",
                              color: "var(--fg-4)",
                            }}
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10.5,
                      color: "var(--fg-4)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatRelative(t.created_at)}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// Decorative monotonic sparkline ramping up to the current value. Deterministic
// — uses a sine-based jitter seeded by `target` so the server and client render
// identical points (no hydration mismatch).
function makeSparkline(target: number): number[] {
  const points = 14;
  if (target <= 0) return Array(points).fill(0);
  const arr: number[] = [];
  for (let i = 0; i < points; i++) {
    const ratio = (i + 1) / points;
    const jitter = 0.92 + 0.16 * Math.abs(Math.sin((i + 1) * (target % 7 || 3)));
    arr.push(Math.max(1, Math.round(target * ratio * jitter)));
  }
  arr[points - 1] = target;
  return arr;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days < 1) {
    const hours = Math.floor(ms / 3600000);
    if (hours < 1) return "just now";
    return `${hours}h`;
  }
  if (days === 1) return "1d";
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}
