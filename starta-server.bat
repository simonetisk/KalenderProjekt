@echo off
rem Startar franvarokalenderns server. Extra argument skickas vidare, t.ex.:  starta-server.bat -Port 8090
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" %*
pause
