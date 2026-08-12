"""Market listing (自动上架) router: coordinate calibration + sell flow."""
import logging
import threading
from typing import List, Optional

from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()

# Human-readable labels for the calibration UI, keyed by anchor name.
ANCHOR_LABELS = {
    "topbar_trade": "顶部栏 · 交易行",
    "market_btn": "交易行页 · 市场按钮",
    "mylist_tab": "市场页 · 我的列表",
    "price_input": "价格输入框",
    "sell_list_btn": "上架物品按钮",
    "confirm_btn": "确认弹窗 · 确认按钮",
}

# All anchors have layout defaults now (calibration optional).
_LAYOUT_ANCHORS = tuple(ANCHOR_LABELS.keys())

# In-memory calibration buffer: anchor key → {"x": int, "y": int}.
_calibration_buffer = {}

# ── Sell flow state ──
_sell_lock = threading.Lock()
_sell_state = {
    "running": False,
    "total": 0,
    "current": 0,
    "cancel_event": None,
    "thread": None,
    "result": None,
    "error": None,
}


class CalibrationRecordRequest(BaseModel):
    key: str


class SellItem(BaseModel):
    stash_id: str = ""
    x: int = 0
    y: int = 0
    w: int = 1
    h: int = 1
    price: int = 0


class SellRequest(BaseModel):
    items: List[SellItem] = []


class MarketSettingsRequest(BaseModel):
    sell_speed: Optional[str] = None


# ── Settings ──

@router.get("/settings")
def get_market_settings():
    """上架相关设置（sellSpeed 供 seller 读取）。"""
    from dnd.settings import settings_manager
    return {"sell_speed": settings_manager.get("sellSpeed", "normal")}


@router.post("/settings")
def update_market_settings(body: MarketSettingsRequest):
    from dnd.settings import settings_manager
    if body.sell_speed in ("fast", "normal", "slow"):
        settings_manager.update({"sellSpeed": body.sell_speed}, persist=True)
        logger.info("Market sell speed set to %s", body.sell_speed)
    return {"sell_speed": settings_manager.get("sellSpeed", "normal")}


# ── Calibration ──

@router.get("/calibration")
def calibration_status():
    """Return the market anchor list with saved / pending positions."""
    from dnd.sort import macros

    saved = {}
    try:
        cal = macros.settings_manager.get("calibrationOverride") or {}
        saved = cal.get("marketPositions") or {}
    except Exception:
        pass

    anchors = []
    for key, label in ANCHOR_LABELS.items():
        anchors.append({
            "key": key,
            "label": label,
            "has_default": key in _LAYOUT_ANCHORS,
            "saved": saved.get(key),
            "pending": _calibration_buffer.get(key),
        })
    return {"anchors": anchors, "saved": saved}


@router.post("/calibration/arm")
def calibration_arm(body: CalibrationRecordRequest):
    """Arm a one-shot capture: the next left-click inside the game window is
    recorded as the location of ``key``.

    The user clicks the「记录」button in the app, moves the mouse to the
    in-game target, then clicks there — that click's coordinates are used.
    Blocks until the click arrives (or a timeout elapses).
    """
    from dnd import service

    key = body.key
    if key not in ANCHOR_LABELS:
        return {"success": False, "error": "unknown_key"}

    service.start_mouse_listener()
    try:
        pos = service.capture_next_click(timeout=60.0)
    except Exception as exc:
        logger.warning("market calibration: capture failed: %s", exc)
        return {"success": False, "error": "capture_failed"}
    if pos is None:
        return {"success": False, "error": "timeout", "detail": "60 秒内未检测到游戏内点击，请重试"}

    x, y = pos
    _calibration_buffer[key] = {"x": x, "y": y}
    return {"success": True, "key": key, "x": x, "y": y}


@router.post("/calibration/save")
def calibration_save():
    """Persist the recorded anchor positions into calibrationOverride."""
    from dnd.sort import macros

    if not _calibration_buffer:
        return {"success": False, "error": "nothing_recorded"}

    cal = macros.settings_manager.get("calibrationOverride") or {}
    cal = dict(cal)
    positions = dict(cal.get("marketPositions") or {})
    positions.update(_calibration_buffer)
    cal["marketPositions"] = positions
    macros.settings_manager.update({"calibrationOverride": cal})
    logger.info("Market calibration saved: %s", positions)
    return {"success": True, "saved": positions}


@router.post("/calibration/reset")
def calibration_reset():
    """Clear the saved market calibration."""
    from dnd.sort import macros

    _calibration_buffer.clear()
    try:
        cal = macros.settings_manager.get("calibrationOverride") or {}
        if cal:
            cal.pop("marketPositions", None)
            macros.settings_manager.update({"calibrationOverride": cal})
    except Exception:
        pass
    return {"success": True}


# ── Sell flow ──

@router.post("/sell")
def start_sell(body: SellRequest):
    """Start listing the given items in a background worker."""
    from dnd.market.seller import sell_items

    items = [item.model_dump() for item in body.items]
    if not items:
        return {"success": False, "error": "no_items"}

    logger.info("Market sell start: %d items", len(items))

    with _sell_lock:
        if _sell_state["running"]:
            return {"success": False, "error": "sell_already_running"}
        cancel_event = threading.Event()
        _sell_state.update({
            "running": True,
            "total": len(items),
            "current": 0,
            "cancel_event": cancel_event,
            "thread": None,
            "result": None,
            "error": None,
        })

    def _progress(current, total):
        with _sell_lock:
            _sell_state["current"] = current
            _sell_state["total"] = total

    def _run():
        try:
            result = sell_items(items, cancel_event=cancel_event, progress=_progress)
            with _sell_lock:
                _sell_state["result"] = result
                _sell_state["running"] = False
        except Exception as exc:
            logger.error("Market sell failed: %s", exc, exc_info=True)
            with _sell_lock:
                _sell_state["error"] = str(exc)
                _sell_state["running"] = False

    t = threading.Thread(target=_run, daemon=True, name="MarketSeller")
    with _sell_lock:
        _sell_state["thread"] = t
    t.start()
    return {"success": True}


@router.get("/status")
def sell_status():
    with _sell_lock:
        return {
            "running": _sell_state["running"],
            "total": _sell_state["total"],
            "current": _sell_state["current"],
            "result": _sell_state["result"],
            "error": _sell_state["error"],
        }


@router.post("/cancel")
def cancel_sell():
    with _sell_lock:
        if not _sell_state["running"]:
            return {"success": False, "error": "no_sell_in_progress"}
        ev = _sell_state["cancel_event"]
        logger.info("Market sell cancel requested")
    if ev:
        ev.set()
    return {"success": True}
