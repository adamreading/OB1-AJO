# Handover specification: Open Brain Pro (AJO Version)

This document is a high-density brief for the next phase of development. 

---

## 🎯 Current Status
The project is a **Context-Aware Knowledge Management System**. It separates data into "Work" vs "Personal" using automatic AI categorization.

### 🛑 Critical Bugs (Top Priority)
1.  **Missing API Routes (404s)**:
    - The `rest-api` Edge Function is currently missing handlers for `/capture`, `/ingest`, and `POST /thought/:id/reflection`.
    - **Symptom**: "Add to Brain" and "Save Reflection" result in 404 errors.
    - **Fix**: Re-inject the standard handlers into `supabase/functions/rest-api/index.ts`.

2.  **The "Kanban Revert" Bug**:
    - Changing a thought's **type** (e.g. Task -> Observation) in the Edit Modal results in a DB error or a "Failure Reverting" message. 
    - The item disappears from the Kanban but may not actually update in the DB.
    - **Fix**: Synchronize the `updateThought` call in `lib/api.ts` with the backend `PUT` handler to ensure `type` changes are atomic.

3.  **Search Failure**:
    - The Search UI often returns "Search Failed." This is due to a mismatch in the `match_thoughts` RPC arguments or a missing API handler.

---

## ✨ Aesthetic & UX Requirements
The current UI is **High-Performance Dark Mode** (Coal/Matte), but has contrast issues (Grey-on-Black).
- **Goal**: Implement a "Professional Premium" visual tier.
- **Requirement**: Add a **Settings Cog** with a **Theme / Color Picker**.
- **Requirement**: Increase font contrast across the Kanban and Thoughts table.

---

## 📂 Architecture References
- **Configuration**: Root `.env` stores AI definitions; Dashboard `.env.local` stores API credentials.
- **Background Engine**: `scripts/local-brain-worker.js` handles auto-classification. It MUST skip already-classified items to avoid feedback loops.
- **API**: Centrally managed by the Hono-based `rest-api` Edge Function.

---

## 🚀 Immediate Next Steps
1.  **Health Check**: Restore the missing routes in `rest-api/index.ts`.
2.  **Sync**: Fix the update route to prevent "Reverts" on Type changes.
3.  **UI**: Implement the Theme Toggle/Cog in the Navigation bar.

*End of Handover.*
