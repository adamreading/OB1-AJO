"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { getThoughtContext } from "@/lib/types";
import type { Thought } from "@/lib/types";
import { TypeChip } from "@/components/design/Atoms";

function formatAge(dateString: string): string {
  const diffMs = Date.now() - new Date(dateString).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 1) return "today";
  if (diffDays === 1) return "1d";
  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
  return `${Math.floor(diffDays / 365)}y`;
}

// Map 0..100 importance to design's high/medium/low priority bucket
function priorityFromImportance(importance: number): "high" | "medium" | "low" {
  if (importance >= 60) return "high";
  if (importance >= 30) return "medium";
  return "low";
}

const PRIO_COLOR: Record<string, string> = {
  high: "#ff7894",
  medium: "#f0b450",
  low: "#8a8a9b",
};

interface KanbanCardProps {
  thought: Thought;
  onCardClick: (thought: Thought) => void;
  onPriorityChange: (thoughtId: number, importance: number) => void;
  showArchiveButton?: boolean;
  onArchive?: (thoughtId: number) => void;
}

export function KanbanCard({
  thought,
  onCardClick,
  onPriorityChange: _onPriorityChange,
  showArchiveButton = false,
  onArchive,
}: KanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: thought.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    touchAction: "pan-y pinch-zoom",
    padding: "10px 12px",
    borderRadius: 10,
    background: "var(--bg-2)",
    border: isDragging
      ? "1px solid rgba(157,131,255,0.4)"
      : "1px solid var(--line)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    position: "relative",
    cursor: "pointer",
    userSelect: "none",
    boxShadow: isDragging ? "0 8px 24px rgba(0,0,0,0.4)" : "none",
    opacity: isDragging ? 0.85 : 1,
  };

  const title = thought.content.split("\n")[0].slice(0, 240);
  const topics = Array.isArray(thought.metadata?.topics)
    ? (thought.metadata.topics as string[])
    : [];
  const primaryEntity = topics[0] || null;
  const restTags = topics.slice(1, 4);
  const sourceThoughtId = thought.metadata?.source_thought_id;
  const hasSource = sourceThoughtId !== undefined && sourceThoughtId !== null;
  const blocked = typeof thought.metadata?.blocked_reason === "string"
    ? (thought.metadata.blocked_reason as string)
    : null;

  const context = getThoughtContext(thought);
  const priority = priorityFromImportance(thought.importance);
  const prioColor = PRIO_COLOR[priority];

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onCardClick(thought)}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: prioColor,
            boxShadow: `0 0 5px ${prioColor}`,
            flexShrink: 0,
          }}
        />
        {primaryEntity ? (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--violet-300)",
              padding: "1px 6px",
              borderRadius: 3,
              background: "rgba(157,131,255,0.10)",
              border: "1px solid rgba(157,131,255,0.2)",
              whiteSpace: "nowrap",
              maxWidth: 140,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={primaryEntity}
          >
            @{primaryEntity}
          </span>
        ) : (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--fg-4)",
            }}
          >
            — unlinked
          </span>
        )}
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          <TypeChip type={thought.type} />
        </span>
      </div>

      <div
        style={{
          fontSize: 12,
          color: "var(--fg)",
          lineHeight: 1.45,
          fontWeight: 400,
          display: "-webkit-box",
          WebkitLineClamp: 6,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {title}
      </div>

      {restTags.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {restTags.map((t) => (
            <span
              key={t}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 9.5,
                color: "var(--fg-4)",
              }}
            >
              #{t}
            </span>
          ))}
        </div>
      )}

      {blocked && (
        <div
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "#ff9650",
            padding: "3px 6px",
            background: "rgba(255,150,80,0.08)",
            borderRadius: 4,
            border: "1px solid rgba(255,150,80,0.2)",
            display: "inline-flex",
            alignSelf: "flex-start",
          }}
        >
          ⊘ {blocked}
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 2,
          fontSize: 10,
          color: "var(--fg-4)",
          fontFamily: "var(--font-mono)",
          gap: 8,
        }}
      >
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
          {context}
          {hasSource && (
            <>
              {" · "}
              <a
                href={`/thoughts/${sourceThoughtId}`}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                title={`From action item on thought #${sourceThoughtId}`}
                style={{
                  color: "var(--violet-300)",
                  textDecoration: "none",
                }}
              >
                ←#{String(sourceThoughtId)}
              </a>
            </>
          )}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span>{formatAge(thought.created_at)}</span>
          {showArchiveButton && onArchive && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onArchive(thought.id);
              }}
              title="Archive"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--fg-4)",
                cursor: "pointer",
                fontSize: 11,
                padding: 0,
                fontFamily: "inherit",
              }}
            >
              ✓
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
