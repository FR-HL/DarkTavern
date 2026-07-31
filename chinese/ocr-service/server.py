"""
GrimVault Chinese Extension - OCR Service
==========================================
Local HTTP server that provides Chinese OCR + translation for GrimVault.
Uses the SAME approach as GrimVault: screen capture → DNN tooltip detection → OCR.
No DLL injection, no game process interaction - pure screen reading.

Open Source Project: https://github.com/DarkerDB/GrimVault (original)
Chinese Edition fork with RapidOCR (ONNX Runtime) for Chinese game text support.

Translation Sources:
  - Official Weblate: https://localization.darkanddarker.com/languages/zh_Hans/
  - Community DB: https://dnd.nfuwow.com/
  - DarkerDB API: https://api.darkerdb.com/v1/items (956 English item names)
  - Game: Dark and Darker by Ironmace

Tech Stack:
  - Screen Capture: mss (same region as GrimVault's ScreenCaptureLite/WGC)
  - Tooltip Detection: YOLO DNN (tooltip.onnx, 640x640, confidence 0.90)
  - OCR: RapidOCR + ONNX Runtime (PP-OCRv4 models, Chinese + English)
  - Translation: Keyword mapping table (Chinese → English)

Endpoints:
  POST /scan           - Full scan: capture → detect → OCR → translate
  POST /translate      - Translate Chinese text to English
  POST /mapping/add    - Add custom mapping
  POST /mapping/remove - Remove custom mapping
  GET  /mapping/list   - List all mappings
  GET  /health         - Health check
"""

import json
import logging
import os
import sys
import time

from flask import Flask, jsonify, request

# Add parent dir to path for imports
sys.path.insert(0, os.path.dirname(__file__))

from capture import capture_game_window, find_game_window, get_window_rect, get_monitor_info
from detect import TooltipDetector
from ocr_engine_rapid import ChineseOCR
from translator import Translator

# --- Configuration ---

# Path to the same tooltip.onnx model used by GrimVault
TOOLTIP_MODEL_PATH = os.environ.get(
    "GRIMVAULT_TOOLTIP_MODEL",
    os.path.join(
        os.path.dirname(__file__),
        "..", "..", "resources", "models", "tooltip.onnx",
    ),
)

# Mapping files directory
MAPPING_DIR = os.environ.get(
    "GRIMVAULT_MAPPING_DIR",
    os.path.join(os.path.dirname(__file__), "..", "mapping"),
)

# Server port
PORT = int(os.environ.get("GRIMVAULT_OCR_PORT", "19528"))

# --- Logging ---

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("grimvault-chinese")

# --- Application ---

app = Flask(__name__)

# Global instances (initialized on startup)
detector = None
ocr = None
translator = None


def initialize():
    """Initialize all components."""
    global detector, ocr, translator

    logger.info("Initializing Chinese OCR Extension...")

    # Resolve tooltip model path
    model_path = os.path.abspath(TOOLTIP_MODEL_PATH)

    # Also check GrimVault installation directory
    if not os.path.exists(model_path):
        # Try common installation paths
        candidates = [
            os.path.join(os.path.dirname(__file__), "..", "..", "models", "tooltip.onnx"),
            os.path.expandvars(
                r"%LOCALAPPDATA%\Programs\GrimVault\resources\models\tooltip.onnx"
            ),
            os.path.expandvars(
                r"%PROGRAMFILES%\GrimVault\GrimVault Chinese Edition\native\models\tooltip.onnx"
            ),
        ]
        for candidate in candidates:
            if os.path.exists(candidate):
                model_path = candidate
                break

    if not os.path.exists(model_path):
        logger.error(f"Tooltip model not found at: {model_path}")
        logger.error("Set GRIMVAULT_TOOLTIP_MODEL environment variable to the correct path")
        sys.exit(1)

    logger.info(f"Loading tooltip detection model: {model_path}")
    detector = TooltipDetector(model_path)

    logger.info("Initializing RapidOCR (Chinese + English)...")
    ocr = ChineseOCR()

    logger.info(f"Loading translation mappings from: {MAPPING_DIR}")
    translator = Translator(MAPPING_DIR)

    mapping_count = len(translator.get_all_mappings())
    logger.info(f"Loaded {mapping_count} translation mappings")

    # Warmup: run a dummy OCR to pre-load all internal models and avoid first-scan delay
    logger.info("Warming up OCR engine (first inference)...")
    try:
        import numpy as np
        dummy = np.zeros((48, 320, 3), dtype=np.uint8)
        ocr.read(dummy)
        logger.info("OCR warmup complete - ready for fast inference")
    except Exception as e:
        logger.warning(f"OCR warmup failed (non-critical): {e}")

    logger.info("Initialization complete!")


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({
        "status": "ok",
        "version": "1.0.0",
        "model_loaded": detector is not None,
        "ocr_loaded": ocr is not None,
        "mappings": len(translator.get_all_mappings()) if translator else 0,
    })


@app.route("/scan", methods=["POST"])
def scan():
    """
    Full scan pipeline - mirrors GrimVault's getTooltip() flow:
    1. Capture game window screenshot
    2. Detect tooltip bounding boxes (same DNN model)
    3. OCR each tooltip region (PaddleOCR Chinese)
    4. Translate to English
    5. Return translated text + coordinates

    Returns same structure as GrimVault's native getTooltip():
    {text, x, y, width, height}
    """
    start_time = time.time()

    # Step 1: Capture game window (same as GrimVault's Screen::Capture)
    screenshot, bounds = capture_game_window()

    if screenshot is None:
        return jsonify({"error": "Game window not found"}), 404

    capture_time = time.time()

    # Step 2: Detect tooltips (same as GrimVault's Screen::FindTooltips)
    tooltips = detector.find_tooltips(screenshot)

    if not tooltips:
        return jsonify({"tooltip": None}), 200

    detect_time = time.time()

    # Step 3 & 4: OCR + Translate each tooltip
    # Same as GrimVault: iterate tooltips, skip "Item Statistics" ones
    for tooltip_box in tooltips:
        tx, ty, tw, th = tooltip_box

        # Clamp to screenshot bounds
        tx = max(0, tx)
        ty = max(0, ty)
        tw = min(tw, screenshot.shape[1] - tx)
        th = min(th, screenshot.shape[0] - ty)

        if tw <= 0 or th <= 0:
            continue

        # Extract tooltip region
        region = screenshot[ty : ty + th, tx : tx + tw]

        # OCR the region
        chinese_text = ocr.read(region)

        if not chinese_text:
            continue

        # Skip GrimVault's own overlay tooltip
        skip_patterns = ["Item Statistics", "ItemStatistics", "Powered by DarkerDB",
                         "DarkerDB.com", "Market:", "Vendor:", "Density:", "Demand:"]
        if any(p in chinese_text for p in skip_patterns):
            continue

        # Translate Chinese → English
        english_text = translator.translate_text(chinese_text)

        # Find unmapped terms for potential manual mapping
        unmapped = translator.get_unmapped_terms(chinese_text)

        ocr_time = time.time()

        logger.info(
            f"Scan complete in {(ocr_time - start_time)*1000:.0f}ms "
            f"(capture: {(capture_time - start_time)*1000:.0f}ms, "
            f"detect: {(detect_time - capture_time)*1000:.0f}ms, "
            f"ocr+translate: {(ocr_time - detect_time)*1000:.0f}ms)"
        )

        # Extract Chinese item name and rarity
        chinese_lines = chinese_text.strip().split("\n")
        chinese_item_name = chinese_lines[0].strip() if chinese_lines else ""

        # Detect rarity from OCR text
        rarity = "Common"
        rarity_map = {
            "粗糙": "Poor", "劣质": "Poor",
            "普通": "Common",
            "非凡": "Uncommon", "优秀": "Uncommon",
            "稀有": "Rare", "罕见": "Rare",
            "史诗": "Epic",
            "传说": "Legendary", "传奇": "Legendary",
            "独特": "Unique",
            "神器": "Artifact",
            "命名神器": "Artifact",
        }
        for line in chinese_lines:
            l = line.strip()
            # Extract the value part after colon (e.g. "稀有度：史诗" → "史诗")
            if "稀有度" in l or "Rare度" in l or "Rarity" in l:
                import re as _re2
                colon_match = _re2.search(r'[：:]\s*(.+)', l)
                if colon_match:
                    rarity_value = colon_match.group(1).strip()
                    for cn_r, en_r in rarity_map.items():
                        if cn_r == rarity_value:
                            rarity = en_r
                            break

        # Filter display lines: only keep stat lines (e.g. "+3 力量", "移动速度-10")
        # Skip metadata: slot type, armor type, loot status, hand type, class req, descriptions
        skip_prefixes = [
            "栏位类别", "Slot Type", "防具类别", "护甲类别", "Armor Type",
            "战利品状态", "Loot Status", "手持类别", "Hand Type",
            "武器类别", "Weapon Type", "武器类型",
            "辅助道具类别", "Utility", "杂项类别", "Misc Type",
            "职业要求", "Class Requirement",
            "稀有度", "Rare度", "Rarity",
            "配饰类别", "Accessory",
        ]
        display_lines = []
        import re as _re
        for i, line in enumerate(chinese_lines):
            l = line.strip()
            if not l or i == 0:
                continue
            if any(l.startswith(p) or p in l for p in skip_prefixes):
                continue
            # Only keep lines with numeric values (stat lines like "+3 力量", "移动速度-10")
            if not _re.search(r'[+\-]?\d', l):
                continue
            display_lines.append(l)

        # Build reverse attribute mapping
        reverse_attributes = {v: k for k, v in translator.attributes.items()}
        reverse_keywords = {v: k for k, v in translator.keywords.items()}

        return jsonify({
            "tooltip": {
                "text": english_text,
                "original_text": chinese_text,
                "chinese_item_name": chinese_item_name,
                "rarity": rarity,
                "display_lines": display_lines,
                "reverse_attributes": reverse_attributes,
                "reverse_keywords": reverse_keywords,
                "x": tx,
                "y": ty,
                "width": tw,
                "height": th,
                "unmapped_terms": unmapped,
            }
        })

    return jsonify({"tooltip": None}), 200


@app.route("/translate", methods=["POST"])
def translate():
    """Translate Chinese text to English."""
    data = request.get_json()

    if not data or "text" not in data:
        return jsonify({"error": "Missing 'text' field"}), 400

    chinese_text = data["text"]
    english_text = translator.translate_text(chinese_text)
    unmapped = translator.get_unmapped_terms(chinese_text)

    return jsonify({
        "original": chinese_text,
        "translated": english_text,
        "unmapped_terms": unmapped,
    })


@app.route("/mapping/add", methods=["POST"])
def add_mapping():
    """Add a custom Chinese → English mapping."""
    data = request.get_json()

    if not data or "chinese" not in data or "english" not in data:
        return jsonify({"error": "Missing 'chinese' or 'english' field"}), 400

    translator.add_custom_mapping(data["chinese"], data["english"])

    return jsonify({
        "status": "ok",
        "chinese": data["chinese"],
        "english": data["english"],
    })


@app.route("/mapping/remove", methods=["POST"])
def remove_mapping():
    """Remove a custom mapping."""
    data = request.get_json()

    if not data or "chinese" not in data:
        return jsonify({"error": "Missing 'chinese' field"}), 400

    translator.remove_custom_mapping(data["chinese"])

    return jsonify({"status": "ok"})


@app.route("/mapping/list", methods=["GET"])
def list_mappings():
    """List all mappings (built-in + custom)."""
    return jsonify({
        "items": translator.items,
        "attributes": translator.attributes,
        "keywords": translator.keywords,
        "custom": translator.custom,
        "total": len(translator.get_all_mappings()),
    })


def _get_dpi_scale(hwnd):
    """Get DPI scale factor for the window (1.0 at 100% scaling)."""
    try:
        import ctypes
        dpi = ctypes.windll.user32.GetDpiForWindow(hwnd)
        if dpi and dpi > 0:
            return dpi / 96.0
    except Exception:
        pass
    return 1.0


@app.route("/window", methods=["GET"])
def window_info():
    """
    Return game window bounds / monitor / visibility so the Electron shell
    can follow the game window (replaces the old C++ window hooks).
    Response shape matches what pin.js / main.js expect from getGameWindow /
    the WinEventHook callback: {bounds, monitor, visible, focused}.
    """
    import win32gui

    hwnd = find_game_window()
    if not hwnd:
        return jsonify({"found": False})

    bounds = get_window_rect(hwnd)
    monitor = get_monitor_info(hwnd)
    if not bounds or not monitor:
        return jsonify({"found": False})

    try:
        focused = (win32gui.GetForegroundWindow() == hwnd)
    except Exception:
        focused = False

    monitor = dict(monitor)
    monitor["scale"] = _get_dpi_scale(hwnd)

    return jsonify({
        "found": True,
        "visible": True,
        "focused": focused,
        "bounds": bounds,
        "monitor": monitor,
    })


if __name__ == "__main__":
    initialize()

    logger.info(f"Starting Chinese OCR service on port {PORT}")
    logger.info(f"Health check: http://localhost:{PORT}/health")

    app.run(
        host="127.0.0.1",
        port=PORT,
        debug=False,
        threaded=True,
    )
