@echo off
title KAGE - Digital Shadow (087726681286)
cd /d "%~dp0"

echo ============================================================
echo  KAGE - Digital Shadow
echo  Bot WA : 087726681286
echo  Panel  : http://127.0.0.1:4660  (token: kage-local-token-4660)
echo  Stop   : tutup window ini / Ctrl+C
echo ============================================================
echo.

echo [1/2] matiin instance KAGE lama (kalau ada)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*KAGE*src\index.ts*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/2] start KAGE (code terbaru)...
echo.
"C:\Program Files\nodejs\node.exe" "C:\Users\raso8\KAGE\node_modules\tsx\dist\cli.mjs" src\index.ts
pause
