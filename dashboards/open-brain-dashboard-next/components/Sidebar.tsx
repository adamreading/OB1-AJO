"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Wordmark } from "@/components/design/Brand";

interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  match?: (pathname: string) => boolean;
  count?: number;
  badge?: number;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

interface SidebarCounts {
  thoughts: number;
  wiki: number;
  workflow: number;
  review: number;
}

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ isOpen = false, onClose }: SidebarProps) {
  const pathname = usePathname();
  const [counts, setCounts] = useState<SidebarCounts | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sidebar-counts")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setCounts(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (pathname === "/login") return null;

  const groups: NavGroup[] = [
    {
      label: "Capture",
      items: [
        {
          href: "/",
          label: "Today",
          icon: "home",
          match: (p) => p === "/",
        },
        {
          href: "/review",
          label: "Review",
          icon: "review",
          badge: counts?.review,
        },
      ],
    },
    {
      label: "Brain",
      items: [
        {
          href: "/thoughts",
          label: "Thoughts",
          icon: "thoughts",
          count: counts?.thoughts,
        },
        { href: "/wiki", label: "Wiki", icon: "wiki", count: counts?.wiki },
        {
          href: "/kanban",
          label: "Workflow",
          icon: "workflow",
          count: counts?.workflow,
        },
      ],
    },
    {
      label: "Discover",
      items: [{ href: "/actions", label: "Actions", icon: "actions" }],
    },
  ];

  return (
    <aside
      className={`fixed left-0 top-0 h-screen w-60 z-50 hidden md:flex ${
        isOpen ? "!flex" : ""
      }`}
      style={{
        flexDirection: "column",
        padding: "18px 12px",
        gap: 18,
        borderRight: "1px solid var(--line)",
        background:
          "linear-gradient(180deg, var(--bg-1) 0%, var(--bg-0) 100%)",
      }}
    >
      <Link
        href="/"
        onClick={onClose}
        style={{
          padding: "4px 8px 8px",
          textDecoration: "none",
          color: "inherit",
        }}
      >
        <Wordmark size={14} />
      </Link>

      <div
        style={{
          height: 1,
          background: "var(--line)",
          margin: "0 8px",
        }}
      />

      <nav
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 18,
          flex: 1,
        }}
      >
        {groups.map((g) => (
          <div
            key={g.label}
            style={{ display: "flex", flexDirection: "column", gap: 2 }}
          >
            <div className="eyebrow" style={{ padding: "0 10px 6px" }}>
              {g.label}
            </div>
            {g.items.map((item) => {
              const active = item.match
                ? item.match(pathname)
                : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "7px 10px",
                    borderRadius: 8,
                    fontSize: 13,
                    color: active ? "var(--fg)" : "var(--fg-3)",
                    background: active
                      ? "linear-gradient(180deg, rgba(130,97,255,0.18), rgba(130,97,255,0.08))"
                      : "transparent",
                    border: active
                      ? "1px solid rgba(157,131,255,0.25)"
                      : "1px solid transparent",
                    position: "relative",
                    textDecoration: "none",
                    transition: "background 120ms, color 120ms",
                  }}
                >
                  {active && (
                    <span
                      style={{
                        position: "absolute",
                        left: -12,
                        top: 8,
                        bottom: 8,
                        width: 2,
                        background: "var(--violet-400)",
                        borderRadius: 2,
                      }}
                    />
                  )}
                  <span
                    style={{
                      color: active ? "var(--violet-300)" : "var(--fg-4)",
                      display: "flex",
                    }}
                  >
                    <NavIcon name={item.icon} />
                  </span>
                  <span
                    style={{
                      flex: 1,
                      fontWeight: active ? 500 : 400,
                    }}
                  >
                    {item.label}
                  </span>
                  {item.count != null && (
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 10.5,
                        color: "var(--fg-4)",
                      }}
                    >
                      {item.count}
                    </span>
                  )}
                  {item.badge != null && item.badge > 0 && (
                    <span
                      style={{
                        minWidth: 16,
                        height: 16,
                        padding: "0 5px",
                        borderRadius: 8,
                        background: "var(--crit)",
                        color: "#fff",
                        fontSize: 10,
                        fontWeight: 600,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* User row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 10px",
        }}
      >
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #8261ff, #b8a6ff)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            fontWeight: 600,
            color: "#fff",
          }}
        >
          A
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minWidth: 0,
          }}
        >
          <span style={{ fontSize: 12, color: "var(--fg-2)" }}>Adam</span>
          <span style={{ fontSize: 10, color: "var(--fg-4)" }}>OB·1</span>
        </div>
        <form action="/api/logout" method="POST">
          <button
            type="submit"
            title="Sign out"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--fg-4)",
              cursor: "pointer",
              display: "flex",
              padding: 4,
              fontFamily: "inherit",
            }}
          >
            <NavIcon name="logout" size={14} />
          </button>
        </form>
      </div>
    </aside>
  );
}

const ICONS = {
  home: (
    <>
      <path d="M3 12 12 4l9 8" />
      <path d="M5 10v9h14v-9" />
    </>
  ),
  thoughts: <path d="M4 6h16M4 12h16M4 18h10" />,
  wiki: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </>
  ),
  workflow: (
    <>
      <rect x="4" y="4" width="5" height="16" rx="1" />
      <rect x="11" y="4" width="5" height="10" rx="1" />
      <rect x="18" y="4" width="3" height="6" rx="1" />
    </>
  ),
  actions: (
    <>
      <path d="M3 6h13M3 12h10M3 18h13" />
      <circle cx="20" cy="6" r="1.5" />
      <circle cx="17" cy="12" r="1.5" />
      <circle cx="20" cy="18" r="1.5" />
    </>
  ),
  review: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4-4" />
    </>
  ),
  add: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
};

export function NavIcon({
  name,
  size = 16,
}: {
  name: keyof typeof ICONS;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[name]}
    </svg>
  );
}
