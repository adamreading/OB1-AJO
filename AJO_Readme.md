# Open Brain Pro (AJO Version)

This is a customized version of the Open Brain Dashboard, optimized for high-performance productivity, automated task categorization, and multi-context workflow management.

## 🚀 Key Features

-   **Work vs. Personal Contexts**: Every thought is automatically classified using a local LLM based on definitions provided in your `.env` file.
-   **Dashboard Refinements**: Configurable time windows (7d, 30d, 90d) for stats.
-   **n8n Connectivity**: Normalized MCP interface for seamless automation triggers.
-   **One-Click Startup**: A single PowerShell script to launch everything.

---

## 🛠️ Setup & Installation

### 1. Prerequisites
- **Node.js 22+** (required for native `--env-file` support).
- **Ollama**: Installed and running locally with the `Qwen3:30b` model.
- **Supabase**: Account with an active database and Edge Functions.

### 2. Environment Variables (.env)
Create a `.env` file in the root directory (see `example.env` for a template):

```env
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_KEY="your-service-role-key"
OLLAMA_URL="http://localhost:11434/api"
OLLAMA_MODEL="Qwen3:30b"

# Context Definitions - These drive the AI classification
WORK_CONTEXT_DESC="Your company projects and professional tasks"
PERSONAL_CONTEXT_DESC="Your side projects and home life"
```

### 3. Dependencies
Install the dashboard dependencies:
```powershell
cd dashboards/open-brain-dashboard-next
npm install
```

---

## ⚡ Running the Dashboard

Simply run the unified startup script from the root:
```powershell
.\start_brain.ps1
```

---

## 📂 Project Structure
- `/dashboards/open-brain-dashboard-next`: The main Next.js 15+ UI.
- `/scripts/local-brain-worker.js`: The background AI engine.
- `/supabase/functions/open-brain-mcp`: The n8n-compatible bridge.
- `start_brain.ps1`: The primary entry point.

---
*Created by AJO using the Open Brain Framework.*
