# Open Brain: Unified Startup Script (psmux edition)
# Starts all 4 services in a 2x2 layout inside Windows Terminal (fullscreen).

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
Write-Host "Launching all services in Windows Terminal (2x2)..." -ForegroundColor Cyan
Write-Host "------------------------------------------------"
Write-Host "TOP-LEFT:     Dashboard     http://localhost:3010"
Write-Host "TOP-RIGHT:    Plaud Webhook http://127.0.0.1:4001/webhook"
Write-Host "BOTTOM-LEFT:  Brain Worker"
Write-Host "BOTTOM-RIGHT: Applaud       http://127.0.0.1:44471"
Write-Host "------------------------------------------------"

$DashboardPath = Join-Path $ProjectRoot "dashboards\open-brain-dashboard-next"
$WorkerPath    = Join-Path $ProjectRoot "scripts\local-brain-worker.js"
$WebhookPath   = Join-Path $ProjectRoot "scripts\plaud-webhook.js"
$ApplaudPath   = "C:\Users\JoannaThompson\projects\applaud"

# Kill any existing session
& $psmux kill-session -t "open-brain" 2>$null

# Step 1: Create session — pane 0 is top-left (Dashboard), capture its ID
& $psmux new-session -d -s "open-brain" -x 220 -y 50
$pane0 = (& $psmux list-panes -t "open-brain" -F "#{pane_id}")[0]

# Step 2: Split right from pane 0 — creates top-right (Webhook), capture its ID
& $psmux split-window -h -t "open-brain:0.0"
$pane1 = (& $psmux list-panes -t "open-brain" -F "#{pane_id}" | Where-Object { $_ -ne $pane0 })[0]

# Step 3: Split down from pane 0 — creates bottom-left (Brain Worker)
& $psmux split-window -v -t $pane0

# Step 4: Split down from pane 1 — creates bottom-right (Applaud)
& $psmux split-window -v -t $pane1

# Step 5: Get all pane IDs in order
$panes = & $psmux list-panes -t "open-brain" -F "#{pane_id}"

# Step 6: Send commands to each pane by ID
& $psmux send-keys -t $panes[0] "cd '$DashboardPath'; `$env:PORT=3010; npm.cmd run dev" Enter
& $psmux send-keys -t $panes[1] "cd '$ProjectRoot'; node --env-file=.env '$WebhookPath'" Enter
& $psmux send-keys -t $panes[2] "cd '$ProjectRoot'; node --env-file=.env '$WorkerPath'" Enter
& $psmux send-keys -t $panes[3] "cd '$ApplaudPath'; pnpm start" Enter

# Open Windows Terminal fullscreen and attach
& $wt --maximized $ps -NoExit -Command "& '$psmux' attach-session -t 'open-brain'"