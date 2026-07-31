**[中文](README_CN.md) | English**

# GrimVault Chinese Edition

A Chinese language extension for [GrimVault](https://github.com/DarkerDB/GrimVault), providing real-time item price checking for Dark and Darker with full Chinese game text support.

## Quick Start

1. Download the installer from [Releases](../../releases)
2. Run the installer, follow the prompts
3. Launch GrimVault Chinese Edition
4. Open Dark and Darker (Chinese language)
5. Hover over an item and press **mouse side button** to check price
6. Press **F5** to configure API Key and keybinding

> Get a free API Key from [DarkerDB.com](https://darkerdb.com/) for complete pricing data.

## Features

- **Chinese OCR** — RapidOCR (PP-OCRv4 + ONNX Runtime) for in-game Chinese text recognition
- **960+ Translations** — Items, attributes, and game terms auto-translated
- **Live Pricing** — Market, vendor, and per-slot value via DarkerDB API
- **Game Overlay** — Price info displayed directly on the game screen
- **Rarity Colors** — Item names colored by rarity (gray/white/green/blue/purple/gold/red)
- **Mapping Editor** — Built-in editor (F6) for viewing/editing translations
- **Custom Keybinding** — Any keyboard key or mouse button as scan trigger
- **Safe** — Screen capture only, no DLL injection or memory reading

## Hotkeys

| Key | Function |
|-----|----------|
| Mouse side button (default) | Scan item price |
| F5 | Settings (API Key, keybinding, scan mode) |
| F6 | Translation mapping editor |
| F7 | Debug mode |
| F8 | Clear overlay |

## How It Works

```
Screen Capture → Tooltip Detection (DNN) → Chinese OCR → Translation → DarkerDB API → Overlay
```

Same screen reading approach as the original GrimVault. No DLL injection, no memory reading.

## Building from Source

<details>
<summary>Click to expand build instructions</summary>

### Prerequisites

- Node.js 20+
- Python 3.11
- Visual Studio 2022+ with C++ Desktop Development workload
- [vcpkg](https://github.com/microsoft/vcpkg)

### Steps

```bash
# 1. C++ dependencies
vcpkg install cppwinrt:x64-windows directxtex:x64-windows directxtk:x64-windows opencv:x64-windows onnxruntime:x64-windows
git clone https://github.com/smasherprog/screen_capture_lite.git vendor/screen_capture_lite

# 2. Node.js dependencies
npm install --ignore-scripts

# 3. Build UI
npx vite build

# 4. Compile native module
node build-gyp.js

# 5. Python OCR environment
py -3.11 -m venv ocr_env
ocr_env\Scripts\pip install rapidocr-onnxruntime flask mss numpy opencv-python pywin32

# 6. Bundle OCR service as exe
cd chinese/ocr-service
..\..\ocr_env\Scripts\pyinstaller --noconfirm --onedir --name ocr-service ^
    --collect-all rapidocr_onnxruntime --collect-all onnxruntime --collect-all cv2 ^
    --hidden-import=win32gui --hidden-import=win32api --hidden-import=win32con ^
    --hidden-import=pywintypes --hidden-import=mss --hidden-import=flask --hidden-import=numpy ^
    server.py
cd ../..

# 7. Package installer
npx electron-builder --win --config.npmRebuild=false
```

</details>

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Desktop | Electron 33 |
| Native Module | C++ (OpenCV, ONNX Runtime, WGC) |
| Chinese OCR | RapidOCR + ONNX Runtime (PP-OCRv4) |
| Tooltip Detection | YOLO DNN (tooltip.onnx) |
| UI | Vue 3 + Tailwind CSS |
| Pricing API | DarkerDB |

## License

Fork of [GrimVault](https://github.com/DarkerDB/GrimVault) by DarkerDB, MIT License.

```
Copyright (c) 2025 DarkerDB (Original GrimVault)
Copyright (c) 2026 GrimVault Chinese Edition Contributors
```

## Acknowledgments

- [DarkerDB](https://darkerdb.com/) — Original GrimVault and pricing API
- [Ironmace](https://www.ironmace.com/) — Dark and Darker
- [RapidOCR](https://github.com/RapidAI/RapidOCR) — OCR engine
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) — PP-OCRv4 models
- [NFU Database](https://dnd.nfuwow.com/) — Chinese item translations
- [Dark and Darker Wiki](https://dnd.wiki/) — Dark and Darker Adventurer's Tavern
