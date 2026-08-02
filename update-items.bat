@echo off
cd /d "%~dp0"
"D:\code\DarkTavern\ocr_env\Scripts\python.exe" "D:\code\DarkTavern\chinese\ocr-service\scripts\update_items.py" %*
pause
