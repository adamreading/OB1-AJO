# Open Brain: Unified Startup Script (psmux edition)
# Starts the 2 services Open Brain needs locally in a vertically-split
# Windows Terminal pane (fullscreen). Plaud ingestion now arrives via the
# Cowork scheduled task → MCP auto_review path, so the local
# plaud-webhook + Applaud daemon panes were removed on 2026-05-16.

$ProjectRoot = Get-Location
$psmux = "C:\Users\JoannaThompson\AppData\Local\Microsoft\WinGet\Links\psmux.exe"
$wt    = "C:\Users\JoannaThompson\AppData\Local\Microsoft\WindowsApps\wt.exe"
$ps    = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"

Write-Host ""
Write-Host "Open Brain Pro: Powering up..." -ForegroundColor Cyan

# Check for Ollama
Write-Host "Checking Ollama status..." -ForegroundColor Gray
$OllamaCheck = curl.exe -s http://localhost:11434/api/tags
if ($null -eq $OllamaCheck) {
    Write-Host "Warning: Ollama not detected at http://localhost:11434" -ForegroundColor Yellow
    Write-Host "Please start Ollama manually for background classification and entity extraction to work." -ForegroundColor Gray
} else {
    Write-Host "Ollama is online." -ForegroundColor Green
}

Write-Host ""
Write-Host "Launching all services in Windows Terminal (1x2)..." -ForegroundColor Cyan
Write-Host "------------------------------------------------"
Write-Host "TOP:    Dashboard     http://localhost:3010 (and via Tailscale)"
Write-Host "BOTTOM: Brain Worker"
Write-Host "------------------------------------------------"

$DashboardPath = Join-Path $ProjectRoot "dashboards\open-brain-dashboard-next"
$WorkerPath    = Join-Path $ProjectRoot "scripts\local-brain-worker.js"

# Kill any existing session
& $psmux kill-session -t "open-brain" 2>$null

# Step 1: Create session — pane 0 is top (Dashboard)
& $psmux new-session -d -s "open-brain" -x 220 -y 50
$pane0 = (& $psmux list-panes -t "open-brain" -F "#{pane_id}")[0]

# Step 2: Split down from pane 0 — creates bottom (Brain Worker)
& $psmux split-window -v -t $pane0

# Step 3: Get all pane IDs in order
$panes = & $psmux list-panes -t "open-brain" -F "#{pane_id}"

# Step 4: Send commands to each pane by ID
& $psmux send-keys -t $panes[0] "cd '$DashboardPath'; `$env:PORT=3010; `$env:HOST='0.0.0.0'; npm.cmd run dev" Enter
& $psmux send-keys -t $panes[1] "cd '$ProjectRoot'; node --env-file=.env '$WorkerPath'" Enter

# Open Windows Terminal fullscreen and attach
& $wt --maximized $ps -NoExit -Command "& '$psmux' attach-session -t 'open-brain'"
