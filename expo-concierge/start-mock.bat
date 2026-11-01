@echo off
REM Try the screen without GRYPHON / TTS (mock responses)
cd /d %~dp0
start "concierge-mock" python serve.py --mock
timeout /t 2 /nobreak >nul
start "" "http://localhost:8000/?debug"
