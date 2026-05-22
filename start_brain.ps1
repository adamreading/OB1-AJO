# Open Brain: Unified Startup Script (psmux edition)
# Starts the 4 services Open Brain needs locally in a 2x2 Windows Terminal
# layout. Plaud ingestion now runs locally again via Applaud + plaud-webhook
# (curator edition) — see scripts/plaud-webhook.js.
#
# Pre-launch: runs recipes/brain-smoke-test (via scripts/smoke-gate.mjs) as
# a sanity check on the deployed Edge Functions + DB schema. Use -SkipSmoke
# to bypass when iterating quickly. The gate is informational only — it
# prints what's broken and pauses 4s so you can read it, then continues so
# you can still launch and investigate locally.

param(
    [switch]$SkipSmoke
)

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

# ─── Pre-launch smoke test gate ─────────────────────────────────────────
# Probes the deployed Edge Functions, DB schema, RLS, and access-key
# enforcement BEFORE we relaunch the local panes. Skipped with -SkipSmoke.
# If MCP_ACCESS_KEY isn't in .env (it lives as a Supabase secret) the
# auth-related categories show as setup errors but the schema checks
# still run, so we always see *something* useful.
if (-not $SkipSmoke) {
    $SmokeGate = Join-Path $ProjectRoot "scripts\smoke-gate.mjs"
    if (Test-Path $SmokeGate) {
        Write-Host ""
        Write-Host "Pre-launch smoke test..." -ForegroundColor Cyan
        $smokeStart = Get-Date
        & node.exe --env-file=.env $SmokeGate
        $smokeCode = $LASTEXITCODE
        $smokeDur = [int]((Get-Date) - $smokeStart).TotalSeconds
        if ($smokeCode -eq 0) {
            Write-Host "  Smoke OK ($smokeDur s)." -ForegroundColor Green
        } elseif ($smokeCode -eq 2) {
            Write-Host "  Smoke setup-error ($smokeDur s) — missing env var; check above. Continuing in 4s..." -ForegroundColor Yellow
            Start-Sleep -Seconds 4
        } else {
            Write-Host "  Smoke FAIL ($smokeDur s) — see above. Continuing in 4s; Ctrl+C to abort..." -ForegroundColor Red
            Start-Sleep -Seconds 4
        }
    } else {
        Write-Host "  (smoke-gate.mjs not found — skipping)" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "Launching all services in Windows Terminal (2x2)..." -ForegroundColor Cyan
Write-Host "------------------------------------------------"
Write-Host "TOP-LEFT:     Dashboard     http://localhost:3010 (and via Tailscale)"
Write-Host "TOP-RIGHT:    Plaud Webhook http://127.0.0.1:4001/webhook (curator edition)"
Write-Host "BOTTOM-LEFT:  Brain Worker"
Write-Host "BOTTOM-RIGHT: Applaud       http://127.0.0.1:44471"
Write-Host "------------------------------------------------"

$DashboardPath = Join-Path $ProjectRoot "dashboards\open-brain-dashboard-next"
$WorkerPath    = Join-Path $ProjectRoot "scripts\local-brain-worker.js"
$WebhookPath   = Join-Path $ProjectRoot "scripts\plaud-webhook.js"
$ApplaudPath   = "C:\Users\JoannaThompson\projects\Applaud"

# ─── Reap leftover services before launching ───────────────────────────
# Closing a psmux window with X does NOT always kill the child node
# processes — they get reparented to the session leader and survive,
# locking port 3010 (next dev), port 4001 (plaud-webhook), and
# double-running the brain worker / Applaud. Identify and kill them by
# purpose before psmux respawns the panes.
Write-Host ""
Write-Host "Reaping any leftover services..." -ForegroundColor Gray

# 1) Anything listening on dashboard / webhook ports (old primaries)
$portsToReap = @(3010, 4001, 44471)
$portListeners = @()
foreach ($p in $portsToReap) {
    $listeners = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $listeners) {
        try {
            $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
            Write-Host "  Killing PID $($proc.Id) ($($proc.ProcessName)) on :$p" -ForegroundColor Yellow
            Stop-Process -Id $proc.Id -Force -ErrorAction Stop
            $portListeners += $proc.Id
        } catch {}
    }
}

# 2) Any node.exe whose command line matches our four services. We match
# broadly because next dev + Applaud both spawn many forked workers that
# aren't bound to a port but hold file handles open.
$allNode = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue

$dashProcs    = $allNode | Where-Object { $_.CommandLine -and ($_.CommandLine -like "*open-brain-dashboard-next*" -or $_.CommandLine -like "*next dev*") }
$webhookProcs = $allNode | Where-Object { $_.CommandLine -and $_.CommandLine -like "*plaud-webhook*" }
$workerProcs  = $allNode | Where-Object { $_.CommandLine -and $_.CommandLine -like "*local-brain-worker*" }
$applaudProcs = $allNode | Where-Object { $_.CommandLine -and ($_.CommandLine -like "*projects\Applaud*" -or $_.CommandLine -like "*projects/Applaud*") }

foreach ($dp in $dashProcs)    { Write-Host "  Killing PID $($dp.ProcessId) (dashboard next dev)" -ForegroundColor Yellow; try { Stop-Process -Id $dp.ProcessId -Force -ErrorAction Stop } catch {} }
foreach ($wh in $webhookProcs) { Write-Host "  Killing PID $($wh.ProcessId) (plaud-webhook)" -ForegroundColor Yellow; try { Stop-Process -Id $wh.ProcessId -Force -ErrorAction Stop } catch {} }
foreach ($wp in $workerProcs)  { Write-Host "  Killing PID $($wp.ProcessId) (brain-worker)" -ForegroundColor Yellow; try { Stop-Process -Id $wp.ProcessId -Force -ErrorAction Stop } catch {} }
foreach ($ap in $applaudProcs) { Write-Host "  Killing PID $($ap.ProcessId) (applaud)" -ForegroundColor Yellow; try { Stop-Process -Id $ap.ProcessId -Force -ErrorAction Stop } catch {} }

if (-not $portListeners -and -not $dashProcs -and -not $webhookProcs -and -not $workerProcs -and -not $applaudProcs) {
    Write-Host "  Nothing to reap. Clean slate." -ForegroundColor Gray
}

# Brief settle so the OS releases the sockets before next dev tries to bind.
Start-Sleep -Milliseconds 400

# Kill any existing psmux session
& $psmux kill-session -t "open-brain" 2>$null

# Step 1: Create session — pane 0 is top-left (Dashboard), capture its ID
& $psmux new-session -d -s "open-brain" -x 220 -y 50
$pane0 = (& $psmux list-panes -t "open-brain" -F "#{pane_id}")[0]

# Step 2: Split right from pane 0 — creates top-right (Plaud Webhook), capture its ID
& $psmux split-window -h -t "open-brain:0.0"
$pane1 = (& $psmux list-panes -t "open-brain" -F "#{pane_id}" | Where-Object { $_ -ne $pane0 })[0]

# Step 3: Split down from pane 0 — creates bottom-left (Brain Worker)
& $psmux split-window -v -t $pane0

# Step 4: Split down from pane 1 — creates bottom-right (Applaud)
& $psmux split-window -v -t $pane1

# Step 5: Get all pane IDs in order
$panes = & $psmux list-panes -t "open-brain" -F "#{pane_id}"

# Step 6: Send commands to each pane by ID
& $psmux send-keys -t $panes[0] "cd '$DashboardPath'; `$env:PORT=3010; `$env:HOST='0.0.0.0'; npm.cmd run dev" Enter
& $psmux send-keys -t $panes[1] "cd '$ProjectRoot'; node --env-file=.env '$WebhookPath'" Enter
& $psmux send-keys -t $panes[2] "cd '$ProjectRoot'; node --env-file=.env '$WorkerPath'" Enter
& $psmux send-keys -t $panes[3] "cd '$ApplaudPath'; pnpm start" Enter

# Open Windows Terminal fullscreen and attach
& $wt --maximized $ps -NoExit -Command "& '$psmux' attach-session -t 'open-brain'"
