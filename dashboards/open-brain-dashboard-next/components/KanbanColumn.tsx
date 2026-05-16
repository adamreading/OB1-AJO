"use client";

import { useState, useEffect } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Thought, KanbanStatus } from "@/lib/types";
import { KANBAN_LABELS } from "@/lib/types";
import { KanbanCard } from "@/components/KanbanCard";

const COLUMN_DOT_COLOR: Record<string, string> = {
  backlog: "#8aa0c8",
  new: "#8aa0c8",
  planning: "#b8a6ff",
  active: "#6ca6ff",
  review: "#f0b450",
  done: "#50c8c8",
  archived: "#5a5a6e",
};

function collapseKey(status: string): string {
  return `kanban-${status}-collapsed`;
}

interface KanbanColumnProps {
  status: string;
  thoughts: Thought[];
  onCardClick: (thought: Thought) => void;
  onPriorityChange: (thoughtId: number, importance: number) => void;
  onArchive: (thoughtId: number) => void;
}

export function KanbanColumn({
  status,
  thoughts,
  onCardClick,
  onPriorityChange,
  onArchive,
}: KanbanColumnProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(collapseKey(status));
    if (stored === "true") setIsCollapsed(true);
  }, [status]);

  function toggleCollapse() {
    const nextState = !isCollapsed;
    setIsCollapsed(nextState);
    localStorage.setItem(collapseKey(status), String(nextState));
  }

  const { setNodeRef, isOver } = useDroppable({ id: status });
  const dotColor = COLUMN_DOT_COLOR[status] || COLUMN_DOT_COLOR.new;
  const label = KANBAN_LABELS[status as KanbanStatus] ?? status;

  if (isCollapsed) {
    return (
      <div
        ref={setNodeRef}
        onClick={toggleCollapse}
        title={`Expand ${label} column`}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: 40,
          minWidth: 40,
          padding: "12px 0",
          borderRadius: 12,
          background: isOver
            ? "rgba(157,131,255,0.06)"
            : "rgba(255,255,255,0.015)",
          border: `1px solid ${isOver ? "rgba(157,131,255,0.25)" : "var(--line)"}`,
          cursor: "pointer",
          gap: 8,
          maxHeight: "calc(100vh - 220px)",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "var(--fg-4)", fontSize: 11 }}>▶</span>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 2,
            background: dotColor,
            boxShadow: `0 0 8px ${dotColor}`,
          }}
        />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--fg-3)",
            padding: "1px 6px",
            background: "var(--bg-3)",
            borderRadius: 4,
          }}
        >
          {thoughts.length}
        </span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--fg-2)",
            writingMode: "vertical-lr",
          }}
        >
          {label}
        </span>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      className="kanban-col-mobile"
      style={{
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "14px 12px",
        borderRadius: 12,
        background: isOver
          ? "rgba(157,131,255,0.04)"
          : "rgba(255,255,255,0.015)",
        border: `1px solid ${isOver ? "rgba(157,131,255,0.25)" : "var(--line)"}`,
        flex: 1,
        maxHeight: "calc(100vh - 220px)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 4px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            onClick={toggleCollapse}
            title="Collapse"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--fg-4)",
              cursor: "pointer",
              fontSize: 11,
              padding: 0,
            }}
          >
            ◀
          </button>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              background: dotColor,
              boxShadow: `0 0 8px ${dotColor}`,
            }}
          />
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: "var(--fg)",
            }}
          >
            {label}
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--fg-3)",
              padding: "1px 6px",
              background: "var(--bg-3)",
              borderRadius: 4,
            }}
          >
            {thoughts.length}
          </span>
        </div>
      </div>

      <SortableContext
        items={thoughts.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            overflowY: "auto",
            flex: 1,
            minHeight: 100,
          }}
        >
          {thoughts.length === 0 ? (
            <div
              style={{
                padding: "32px 12px",
                textAlign: "center",
                color: "var(--fg-4)",
                fontSize: 12,
                border: "1px dashed var(--line)",
                borderRadius: 8,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span style={{ fontSize: 18, opacity: 0.5 }}>○</span>
              Drop a card here…
            </div>
          ) : (
            thoughts.map((thought) => (
              <KanbanCard
                key={thought.id}
                thought={thought}
                onCardClick={onCardClick}
                onPriorityChange={onPriorityChange}
                showArchiveButton={status === "done"}
                onArchive={onArchive}
              />
            ))
          )}
        </div>
      </SortableContext>
    </div>
  );
}
