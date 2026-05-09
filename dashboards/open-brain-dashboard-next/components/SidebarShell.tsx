"use client";

import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";

export function SidebarShell() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      {/* Mobile top bar */}
      <div
        className="md:hidden fixed top-0 left-0 right-0 z-50 h-12 flex items-center px-4 gap-3"
        style={{
          background: "var(--bg-1)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          aria-label="Open menu"
          style={{
            background: "transparent",
            border: "none",
            color: "var(--fg-3)",
            cursor: "pointer",
            display: "flex",
            padding: 0,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <span
          style={{
            color: "var(--fg)",
            fontWeight: 600,
            fontSize: 15,
            letterSpacing: "-0.01em",
          }}
        >
          Open Brain
        </span>
      </div>

      {/* Backdrop */}
      {isOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/60"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Sidebar */}
      <Sidebar isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
}
