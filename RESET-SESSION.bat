@echo off
title KAGE - Reset Session (re-pair QR)
cd /d "%~dp0"
echo ============================================================
echo  KAGE RESET SESSION
echo  Ini MATIIN bot + hapus sesi WhatsApp lama (auth folder).
echo  Setelah selesai: jalankan START-KAGE.bat lalu SCAN QR ULANG.
echo ============================================================
echo.
choice /C YN /M "Lanjut reset? (Y/N)"
if errorlevel 2 exit /b

echo [1/3] matiin instance KAGE...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*KAGE*index.ts*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/3] backup + hapus folder auth...
if exist auth (
  ren auth auth-backup-%RANDOM% 2>nul
)

echo [3/3] selesai. Sekarang jalankan START-KAGE.bat dan SCAN QR-nya.
echo.
pause
