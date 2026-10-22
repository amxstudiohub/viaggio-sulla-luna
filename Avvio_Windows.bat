@echo off
REM ============================================================
REM  CISLUNAR 2030 - Avvio del simulatore su Windows
REM  Doppio clic su questo file: parte un mini-server locale
REM  e il simulatore si apre nel browser predefinito.
REM ============================================================
cd /d "%~dp0"
set PORT=8137

where python >nul 2>nul
if not errorlevel 1 goto :python
where py >nul 2>nul
if not errorlevel 1 goto :py
where node >nul 2>nul
if not errorlevel 1 goto :node
echo.
echo   NESSUN RUNTIME TROVATO (serve Python oppure Node.js).
echo   Installane uno gratuito e rilancia questo file:
echo     - Python:  https://www.python.org/downloads/
echo     - Node.js: https://nodejs.org/
echo   (con Python spunta la voce "Add to PATH" in installazione)
echo.
pause
goto :eof

:python
echo   [OK] Python - server su http://localhost:%PORT%  (Ctrl+C per fermare)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%"
python -m http.server %PORT%
goto :eof

:py
echo   [OK] Python (py) - server su http://localhost:%PORT%  (Ctrl+C per fermare)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%"
py -m http.server %PORT%
goto :eof

:node
echo   [OK] Node.js - server su http://localhost:%PORT%  (Ctrl+C per fermare)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%"
node server_node.cjs
goto :eof
