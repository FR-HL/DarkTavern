@echo off
rem Build ocr-service.exe (PyInstaller onedir) for electron-builder packaging.
rem Output: dist\ocr-service\  (consumed by electron-builder.yml extraFiles)
cd /d "%~dp0"

set PY="%~dp0..\..\ocr_env\Scripts\python.exe"
if not exist %PY% (
    echo [ERROR] ocr_env not found. Run first:
    echo   py -3.11 -m venv ocr_env
    echo   ocr_env\Scripts\python -m pip install -r requirements.txt
    exit /b 1
)

%PY% -m pip show pyinstaller >nul 2>&1 || %PY% -m pip install pyinstaller

%PY% -m PyInstaller --noconfirm --clean --name ocr-service ^
  --collect-all rapidocr_onnxruntime ^
  --collect-all onnxruntime ^
  --collect-submodules uvicorn ^
  --collect-submodules google.protobuf ^
  --hidden-import pyshark ^
  --hidden-import pyshark.capture.live_capture ^
  --hidden-import pygetwindow ^
  --hidden-import pynput ^
  --hidden-import pynput.keyboard._win32 ^
  --hidden-import pynput.mouse._win32 ^
  --hidden-import keyboard ^
  --hidden-import sklearn.utils._cython_blas ^
  server.py

if errorlevel 1 (
    echo [ERROR] PyInstaller build failed
    exit /b 1
)
echo [OK] dist\ocr-service\ocr-service.exe built
