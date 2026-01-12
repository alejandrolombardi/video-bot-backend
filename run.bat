@echo off
cd /d "%~dp0"
node generate.mjs
echo.
echo Proceso terminado. Presiona una tecla para salir...
pause >nul