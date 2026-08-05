@echo off
rem Run npm run dev with administrator rights (UAC prompt will appear).
rem Needed because the game runs elevated and Windows blocks mouse
rem simulation from non-elevated processes.
powershell -NoProfile -Command "Start-Process -FilePath 'cmd' -ArgumentList '/k cd /d \"%~dp0\" && npm run dev' -Verb RunAs"
