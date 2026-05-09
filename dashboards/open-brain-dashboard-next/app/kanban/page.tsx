import { requireSessionOrRedirect } from "@/lib/auth";
import { KanbanBoard } from "@/components/KanbanBoard";

export const dynamic = "force-dynamic";

export default async function KanbanPage() {
  await requireSessionOrRedirect();

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
          padding: "32px 32px 56px",
          display: "flex",
          flexDirection: "column",
          gap: 22,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              Brain · Workflow
            </div>
            <h1
              style={{
                margin: 0,
                fontSize: 30,
                fontWeight: 600,
                letterSpacing: "-0.025em",
                color: "var(--fg)",
              }}
            >
              Items in motion
            </h1>
            <p
              style={{
                margin: "6px 0 0",
                color: "var(--fg-3)",
                fontSize: 14,
              }}
            >
              Tasks and ideas extracted from your captures. Drag between stages.
            </p>
          </div>
        </div>

        <KanbanBoard />
      </div>
    </div>
  );
}
