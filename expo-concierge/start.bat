@echo off
REM ---- Edit these 3 lines for your environment ----
set GRYPHON_URL=http://localhost/v1
set GRYPHON_KEY=app-Jxx20nDIDnRlhK6kFA4eQUmG
set TTS_URL=http://localhost:8080/v1
REM --------------------------------------------------
cd /d %~dp0
start "concierge-server" python serve.py
timeout /t 2 /nobreak >nul
start "" http://localhost:8000/
