@echo off
rem MetaZone Admin -- runs the admin site on this PC only (http://localhost:5173/). Close this window to stop it.
cd /d "%~dp0"
start "" http://localhost:5173/
where python >nul 2>&1 && (python -m http.server 5173 --bind 127.0.0.1) || (py -m http.server 5173 --bind 127.0.0.1)
