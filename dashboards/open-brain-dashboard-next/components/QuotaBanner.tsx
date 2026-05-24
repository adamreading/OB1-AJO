"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

interface QuotaCheck {
  name: string;
  table: string;
  current: number | null;
  cap: number | null;
  utilization: number | null;
  near_cap: boolean;
  over_cap: boolean;
  note: string;
  error: string | null;
}

interface QuotaResponse {
  checks: QuotaCheck[];
  near_cap: boolean;
  over_cap: boolean;
}

const DISMISS_KEY = "ob-quota-banner-dismissed-until";

// Lightweight tripwire banner. Polls /api/quotas once per session, shows a
// dismissible warning when any cap-bound table is past 80% utilization.
// Dismissals last 24h so an over-cap condition can't get permanently buried.
export function QuotaBanner() {
  const [quotas, setQuotas] = useState<QuotaResponse | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const dismissedUntil = Number(localStorage.getItem(DISMISS_KEY) || 0);
    if (Date.now() < dismissedUntil) {
      setDismissed(true);
    }
    // Skip the fetch on /login — the user isn't authed yet, so it would
    // always 401. Cosmetic only (the API handles it gracefully) but it
    // keeps the dev-server log clean.
    if (pathname === "/login") return;
    fetch("/api/quotas")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: QuotaResponse | null) => {
        if (d) setQuotas(d);
      })
      .catch(() => {});
  }, [pathname]);

  if (dismissed || !quotas) return null;
  if (!quotas.near_cap && !quotas.over_cap) return null;

  const offending = quotas.checks.filter((c) => c.near_cap || c.over_cap);
  const isOver = quotas.over_cap;
  const accent = isOver ? "rgba(255,80,80,0.6)" : "rgba(255,150,80,0.6)";
  const tint = isOver ? "rgba(255,80,80,0.10)" : "rgba(255,150,80,0.10)";
  const fg = isOver ? "#ff9b9b" : "#ffb787";

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 60,
        padding: "10px 16px",
        background: tint,
        borderBottom: `1px solid ${accent}`,
        color: fg,
        fontSize: 12.5,
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
      role="alert"
    >
      <span style={{ fontWeight: 600 }}>
        {isOver ? "⛔ Quota exceeded" : "⚠️ Quota warning"}
      </span>
      <span style={{ flex: 1, color: "var(--fg-2)" }}>
        {offending
          .map(
            (c) =>
              `${c.table}: ${c.current ?? "?"} / ${c.cap ?? "∞"}` +
              (c.utilization !== null
                ? ` (${(c.utilization * 100).toFixed(0)}%)`
                : "")
          )
          .join(" · ")}
        {" — "}
        {isOver
          ? "Data is being silently truncated. Bump the cap or convert the endpoint to RPC."
          : "Heading toward a silent truncation. Plan a fix before it bites."}
      </span>
      <button
        type="button"
        onClick={() => {
          // Dismiss for 24h
          localStorage.setItem(
            DISMISS_KEY,
            String(Date.now() + 24 * 60 * 60 * 1000)
          );
          setDismissed(true);
        }}
        style={{
          background: "transparent",
          border: `1px solid ${accent}`,
          color: fg,
          padding: "3px 9px",
          borderRadius: 4,
          fontSize: 11,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        Dismiss for 24h
      </button>
    </div>
  );
}
