# Open Brain: Unified Startup Script
# This script starts the Dashboard and the Local AI Worker (Categorization) in one command.

$ProjectRoot = Get-Location

Write-Host "`n🧠 Open Brain Pro: Powering up..." -ForegroundColor Cyan

# 1. Check for Ollama
Write-Host "📡 Checking Ollama status..." -ForegroundColor Gray
$OllamaCheck = curl.exe -s http://localhost:11434/api/tags
if ($null -eq $OllamaCheck) {
    Write-Host "⚠️ Warning: Ollama not detected at http://localhost:11434" -ForegroundColor Yellow
    Write-Host "Please start Ollama manually for background categorization to work." -ForegroundColor Gray
} else {
    Write-Host "✅ Ollama is online." -ForegroundColor Green
}

# 2. Start Dashboard
Write-Host "`n🚀 Launching Dashboard (Next.js)..." -ForegroundColor Cyan
$DashboardPath = Join-Path $ProjectRoot "dashboards\open-brain-dashboard-next"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$DashboardPath'; npm run dev"

# 3. Start Local Brain Worker
Write-Host "⚙️ Starting Local Brain Worker (AI Categorizer)..." -ForegroundColor Cyan
$WorkerPath = Join-Path $ProjectRoot "scripts\local-brain-worker.js"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$ProjectRoot'; node --env-file=.env '$WorkerPath'"

Write-Host "`n✨ Everything is starting up!" -ForegroundColor Green
Write-Host "------------------------------------------------"
Write-Host "Dashboard:  http://localhost:3010"
Write-Host "AI Worker:  Running in background window"
Write-Host "------------------------------------------------"
Write-Host "Close this window to stop monitoring, but keep the other two open to stay powered up.`n"
