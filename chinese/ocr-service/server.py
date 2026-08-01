"""
DarkTavern OCR Service
======================
Local HTTP server providing Chinese OCR + translation for DarkTavern.
Screen capture → DNN tooltip detection → OCR → translate.
No DLL injection, no game process interaction - pure screen reading.

Forked from: https://github.com/DarkerDB/GrimVault (original)

Translation Sources:
  - Official Weblate: https://localization.darkanddarker.com/languages/zh_Hans/
  - Community DB: https://dnd.nfuwow.com/
  - DarkerDB API: https://api.darkerdb.com/v1/items

Tech Stack:
  - Screen Capture: mss
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
  GET  /window         - Game window bounds + monitor info

NOTE on sync vs async:
  Every route below is a plain `def` (NOT `async def`) on purpose. OCR / capture /
  detection are CPU-bound blocking work with no awaitable gap, so FastAPI runs them
  in its threadpool. Writing them as `async def` would pin the single event loop and
  freeze the whole service (even /health) while a scan runs.
"""

import json
import logging
import os
import re
import sys
import time

import cv2

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# Add parent dir to path for imports
sys.path.insert(0, os.path.dirname(__file__))

from capture import capture_game_window, find_game_window, get_window_rect, get_monitor_info
from detect import TooltipDetector
from ocr_engine_rapid import ChineseOCR
from translator import Translator

# --- Configuration ---

# Path to tooltip.onnx model
TOOLTIP_MODEL_PATH = os.environ.get(
    "DARKTAVERN_TOOLTIP_MODEL",
    os.path.join(
        os.path.dirname(__file__),
        "..", "..", "models", "tooltip.onnx",
    ),
)

# Mapping files directory
MAPPING_DIR = os.environ.get(
    "DARKTAVERN_MAPPING_DIR",
    os.path.join(os.path.dirname(__file__), "..", "mapping"),
)

# Server port
PORT = int(os.environ.get("DARKTAVERN_OCR_PORT", "19528"))

# RapidOCR (PP-OCRv4) ships its own detection + recognition models; no external model paths needed.

# --- Logging ---

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("darktavern-ocr")

# --- Application ---

app = FastAPI(title="DarkTavern OCR Service", version="1.0.0")

# Global instances (initialized on startup)
detector = None
ocr = None
translator = None


# --- Request bodies ---

class TranslateReq(BaseModel):
    text: str


class MappingAddReq(BaseModel):
    chinese: str
    english: str


class MappingRemoveReq(BaseModel):
    chinese: str


def initialize():
    """Initialize all components."""
    global detector, ocr, translator

    logger.info("Initializing Chinese OCR Extension...")

    # Resolve tooltip model path
    model_path = os.path.abspath(TOOLTIP_MODEL_PATH)

    if not os.path.exists(model_path):
        candidates = [
            os.path.join(os.path.dirname(__file__), "..", "..", "models", "tooltip.onnx"),
            os.path.expandvars(
                r"%LOCALAPPDATA%\Programs\DarkTavern\resources\models\tooltip.onnx"
            ),
            os.path.expandvars(
                r"%PROGRAMFILES%\DarkTavern\native\models\tooltip.onnx"
            ),
        ]
        for candidate in candidates:
            if os.path.exists(candidate):
                model_path = candidate
                break

    if not os.path.exists(model_path):
        logger.error(f"Tooltip model not found at: {model_path}")
        logger.error("Set DARKTAVERN_TOOLTIP_MODEL environment variable to the correct path")
        sys.exit(1)

    logger.info(f"Loading tooltip detection model: {model_path}")
    detector = TooltipDetector(model_path)

    logger.info("Initializing OCR recognizer (RapidOCR / PP-OCRv4)...")
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


@app.get("/health")
def health():
    """Health check endpoint."""
    return {
        "status": "ok",
        "version": "1.0.0",
        "model_loaded": detector is not None,
        "ocr_loaded": ocr is not None,
        "mappings": len(translator.get_all_mappings()) if translator else 0,
    }


# ---- scan cache: skip detect / OCR when the tooltip region is unchanged ----

_SCAN_CACHE = {"rect": None, "hash": None, "tooltip": None}
_SCAN_STATS = {"hits": 0, "misses": 0}

_SKIP_PATTERNS = ["Item Statistics", "ItemStatistics", "Powered by DarkerDB",
                  "DarkerDB.com", "Market:", "Vendor:", "Density:", "Demand:"]

_RARITY_MAP = {
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

_SKIP_PREFIXES = [
    "栏位类别", "Slot Type", "防具类别", "护甲类别", "Armor Type",
    "战利品状态", "Loot Status", "手持类别", "Hand Type",
    "武器类别", "Weapon Type", "武器类型",
    "辅助道具类别", "Utility", "杂项类别", "Misc Type",
    "职业要求", "Class Requirement",
    "稀有度", "Rare度", "Rarity",
    "配饰类别", "Accessory",
]


def _region_hash(img):
    """Mean-hash of a region: resize to 32x32 gray, threshold by its mean.
    Returns the 1024-bit pattern as bytes. Binarization + the coarse resize
    average out per-frame anti-alias jitter; compare with _hash_match so a
    few flipped bits (animation / resampling) still count as identical."""
    if img is None or img.size == 0:
        return None
    g = img
    if g.ndim == 3 and g.shape[2] == 4:
        g = cv2.cvtColor(g, cv2.COLOR_BGRA2GRAY)
    elif g.ndim == 3 and g.shape[2] == 3:
        g = cv2.cvtColor(g, cv2.COLOR_BGR2GRAY)
    g = cv2.resize(g, (32, 32), interpolation=cv2.INTER_AREA)
    return (g > g.mean()).tobytes()


def _hash_match(a, b, tol=40):
    """True if two region hashes differ in at most tol of 1024 bits."""
    if a is None or b is None or len(a) != len(b):
        return False
    diff = 0
    for x, y in zip(a, b):
        diff += bin(x ^ y).count("1")
        if diff > tol:
            return False
    return True


def _clamp_box(screenshot, box):
    tx, ty, tw, th = box
    tx = max(0, tx)
    ty = max(0, ty)
    tw = min(tw, screenshot.shape[1] - tx)
    th = min(th, screenshot.shape[0] - ty)
    if tw <= 0 or th <= 0:
        return None
    return tx, ty, tw, th


def _process_box(region, tx, ty, tw, th):
    """OCR + translate one tooltip region. Returns tooltip dict or None."""
    chinese_text = ocr.read(region)
    if not chinese_text:
        return None
    if any(p in chinese_text for p in _SKIP_PATTERNS):
        return None

    english_text = translator.translate_text(chinese_text)
    unmapped = translator.get_unmapped_terms(chinese_text)

    chinese_lines = chinese_text.strip().split("\n")
    chinese_item_name = chinese_lines[0].strip() if chinese_lines else ""

    rarity = "Common"
    for line in chinese_lines:
        l = line.strip()
        if "稀有度" in l or "Rare度" in l or "Rarity" in l:
            colon_match = re.search(r'[：:]\s*(.+)', l)
            if colon_match:
                rarity = _RARITY_MAP.get(colon_match.group(1).strip(), rarity)

    display_lines = []
    for i, line in enumerate(chinese_lines):
        l = line.strip()
        if not l or i == 0:
            continue
        if any(l.startswith(p) or p in l for p in _SKIP_PREFIXES):
            continue
        if not re.search(r'[+\-]?\d', l):
            continue
        display_lines.append(l)

    return {
        "text": english_text,
        "original_text": chinese_text,
        "chinese_item_name": chinese_item_name,
        "rarity": rarity,
        "display_lines": display_lines,
        "reverse_attributes": {v: k for k, v in translator.attributes.items()},
        "reverse_keywords": {v: k for k, v in translator.keywords.items()},
        "x": tx,
        "y": ty,
        "width": tw,
        "height": th,
        "unmapped_terms": unmapped,
    }


@app.post("/scan")
def scan():
    """
    Scan pipeline with region-content caching. Coordinates are
    screenshot-relative and stay valid while the window is not resized
    (a resize changes the crop and therefore misses the hash).

    1. Capture game window.
    2. FAST path: re-crop the cached rect from the fresh frame; identical
       pixels mean the tooltip neither moved nor changed -> return cached
       result, skipping detect + OCR + translate.
    3. Detect tooltips (DNN).
    4. CONTENT reuse: a detected box whose pixels match the cache reuses the
       cached OCR/translate at the new coordinates -> skip OCR + translate.
    5. Otherwise run full OCR + translate and cache the result.
    """
    start_time = time.time()

    screenshot, bounds = capture_game_window()
    if screenshot is None:
        return JSONResponse({"error": "Game window not found"}, status_code=404)
    capture_time = time.time()

    cache = _SCAN_CACHE

    if cache["rect"] is not None and cache["hash"] is not None:
        cb = _clamp_box(screenshot, cache["rect"])
        if cb is not None:
            cx, cy, cw, ch = cb
            if _hash_match(_region_hash(screenshot[cy:cy + ch, cx:cx + cw]), cache["hash"]):
                _SCAN_STATS["hits"] += 1
                logger.info("Scan cache FAST hit")
                return {"tooltip": cache["tooltip"]}

    tooltips = detector.find_tooltips(screenshot)
    if not tooltips:
        return {"tooltip": None}
    detect_time = time.time()

    for tooltip_box in tooltips:
        cb = _clamp_box(screenshot, tooltip_box)
        if cb is None:
            continue
        tx, ty, tw, th = cb
        region = screenshot[ty:ty + th, tx:tx + tw]
        rh = _region_hash(region)

        if _hash_match(rh, cache["hash"]) and cache["tooltip"] is not None:
            reused = dict(cache["tooltip"])
            reused.update(x=tx, y=ty, width=tw, height=th)
            cache["rect"] = (tx, ty, tw, th)
            cache["tooltip"] = reused
            _SCAN_STATS["hits"] += 1
            logger.info("Scan cache CONTENT hit")
            return {"tooltip": reused}

        tooltip = _process_box(region, tx, ty, tw, th)
        if tooltip is None:
            continue
        ocr_time = time.time()
        logger.info(
            f"Scan complete in {(ocr_time - start_time)*1000:.0f}ms "
            f"(capture: {(capture_time - start_time)*1000:.0f}ms, "
            f"detect: {(detect_time - capture_time)*1000:.0f}ms, "
            f"ocr+translate: {(ocr_time - detect_time)*1000:.0f}ms)"
        )
        cache["rect"] = (tx, ty, tw, th)
        cache["hash"] = rh
        cache["tooltip"] = tooltip
        _SCAN_STATS["misses"] += 1
        return {"tooltip": tooltip}

    return {"tooltip": None}


@app.post("/translate")
def translate(req: TranslateReq):
    """Translate Chinese text to English."""
    chinese_text = req.text
    english_text = translator.translate_text(chinese_text)
    unmapped = translator.get_unmapped_terms(chinese_text)

    return {
        "original": chinese_text,
        "translated": english_text,
        "unmapped_terms": unmapped,
    }


@app.post("/mapping/add")
def add_mapping(req: MappingAddReq):
    """Add a custom Chinese → English mapping."""
    translator.add_custom_mapping(req.chinese, req.english)

    return {
        "status": "ok",
        "chinese": req.chinese,
        "english": req.english,
    }


@app.post("/mapping/remove")
def remove_mapping(req: MappingRemoveReq):
    """Remove a custom mapping."""
    translator.remove_custom_mapping(req.chinese)

    return {"status": "ok"}


@app.get("/mapping/list")
def list_mappings():
    """List all mappings (built-in + custom)."""
    return {
        "items": translator.items,
        "attributes": translator.attributes,
        "keywords": translator.keywords,
        "custom": translator.custom,
        "total": len(translator.get_all_mappings()),
    }


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


@app.get("/window")
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
        return {"found": False}

    bounds = get_window_rect(hwnd)
    monitor = get_monitor_info(hwnd)
    if not bounds or not monitor:
        return {"found": False}

    try:
        focused = (win32gui.GetForegroundWindow() == hwnd)
    except Exception:
        focused = False

    monitor = dict(monitor)
    monitor["scale"] = _get_dpi_scale(hwnd)

    return {
        "found": True,
        "visible": True,
        "focused": focused,
        "bounds": bounds,
        "monitor": monitor,
    }


if __name__ == "__main__":
    import uvicorn

    initialize()

    logger.info(f"Starting Chinese OCR service on port {PORT}")
    logger.info(f"Health check: http://localhost:{PORT}/health")
    logger.info(f"API docs:     http://localhost:{PORT}/docs")

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
