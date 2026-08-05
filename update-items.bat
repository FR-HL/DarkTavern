@echo off
cd /d "%~dp0"
"%~dp0ocr_env\Scripts\python.exe" "%~dp0chinese\ocr-service\scripts\update_items.py" %*
pause
