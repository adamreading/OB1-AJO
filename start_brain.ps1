# Open Brain: Unified Startup Script
# This script starts the Dashboard and the Local Brain Worker in one command.

$ProjectRoot = Get-Location

Write-Host ""
Write-Host "Open Brain Pro: Powering up..." -ForegroundColor Cyan

# 1. Check for Ollama
Write-Host "Checking Ollama status..." -ForegroundColor Gray
$OllamaCheck = curl.exe -s http://localhost:11434/api/tags
if ($null -eq $OllamaCheck) {
    Write-Host "Warning: Ollama not detected at http://localhost:11434" -ForegroundColor Yellow
    Write-Host "Please start Ollama manually for background classification and entity extraction to work." -ForegroundColor Gray
} else {
    Write-Host "Ollama is online." -ForegroundColor Green
}

# 2. Start Dashboard
Write-Host ""
Write-Host "Launching Dashboard (Next.js) on Port 3010..." -ForegroundColor Cyan
$DashboardPath = Join-Path $ProjectRoot "dashboards\open-brain-dashboard-next"
Start-Process powershell.exe -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "cd '$DashboardPath'; `$env:PORT=3010; npm.cmd run dev"

# 3. Start Local Brain Worker
Write-Host "Starting Local Brain Worker (classification + entity graph extraction)..." -ForegroundColor Cyan
$WorkerPath = Join-Path $ProjectRoot "scripts\local-brain-worker.js"
Start-Process powershell.exe -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "cd '$ProjectRoot'; node --env-file=.env '$WorkerPath'"

# 4. Start Plaud Webhook Handler
Write-Host "Starting Plaud Webhook Handler (port 4001)..." -ForegroundColor Cyan
$WebhookPath = Join-Path $ProjectRoot "scripts\plaud-webhook.js"
Start-Process powershell.exe -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "cd '$ProjectRoot'; node --env-file=.env '$WebhookPath'"

# 5. Start Applaud (Plaud sync + webhook trigger)
Write-Host "Starting Applaud (Plaud recorder sync)..." -ForegroundColor Cyan
$ApplaudPath = "C:\Users\JoannaThompson\projects\applaud"
Start-Process powershell.exe -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "cd '$ApplaudPath'; pnpm start"

Write-Host ""
Write-Host "Everything is starting up!" -ForegroundColor Green
Write-Host "------------------------------------------------"
Write-Host "Dashboard:    http://localhost:3010"
Write-Host "Applaud UI:   http://127.0.0.1:44471"
Write-Host "AI Worker:    Running in background window"
Write-Host "Plaud Webhook: http://127.0.0.1:4001/webhook"
Write-Host "------------------------------------------------"
Write-Host "Close this window to keep the others running."
