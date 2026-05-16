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

# ─── Reap leftover services before launching ───────────────────────────
# Closing a psmux window with X does NOT always kill the child node
# processes — they get reparented to the session leader and survive,
# locking port 3010 (next dev) and double-running the brain worker.
# Identify and kill them by purpose before psmux respawns the panes.
Write-Host ""
Write-Host "Reaping any leftover services..." -ForegroundColor Gray

# 1) Anything listening on port 3010 (old next dev)
$dashListeners = Get-NetTCPConnection -LocalPort 3010 -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $dashListeners) {
    try {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
        Write-Host "  Killing PID $($proc.Id) ($($proc.ProcessName)) on :3010" -ForegroundColor Yellow
        Stop-Process -Id $proc.Id -Force -ErrorAction Stop
    } catch {}
}

# 2) Any node.exe whose command line points at local-brain-worker.js
$workerProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*local-brain-worker*" }
foreach ($wp in $workerProcs) {
    Write-Host "  Killing PID $($wp.ProcessId) (brain-worker)" -ForegroundColor Yellow
    try { Stop-Process -Id $wp.ProcessId -Force -ErrorAction Stop } catch {}
}

if (-not $dashListeners -and -not $workerProcs) {
    Write-Host "  Nothing to reap. Clean slate." -ForegroundColor Gray
}

# Brief settle so the OS releases the sockets before next dev tries to bind.
Start-Sleep -Milliseconds 400

# Kill any existing psmux session
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
