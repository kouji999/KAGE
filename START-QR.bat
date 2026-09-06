@echo off
title KAGE - QR Pairing
cd /d "%~dp0"
echo ============================================================
echo  KAGE QR DISPLAY - buat scan ulang kalau session logged out
echo  (Jalankan START-KAGE.bat dulu di window lain)
echo ============================================================
echo.
"C:\Program Files\nodejs\node.exe" "C:\Users\raso8\KAGE\node_modules\tsx\dist\cli.mjs" scripts\qr-display.ts
pause
