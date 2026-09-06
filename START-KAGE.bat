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
"C:\Program Files\nodejs\node.exe" "C:\Users\raso8\KAGE\node_modules\tsx\dist\cli.mjs" src\index.ts
pause
