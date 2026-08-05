import logging
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional

logger = logging.getLogger(__name__)
router = APIRouter()


class CaptureSettingsUpdate(BaseModel):
    interface: Optional[str] = None
    port_low: Optional[int] = None
    port_high: Optional[int] = None
    wireshark_path: Optional[str] = None


@router.post("/start")
def capture_start():
    from dnd.service import get_packet_capture
    from dnd.settings import detect_wireshark_installation
    capture = get_packet_capture()
    if capture.is_active():
        return {"success": True, "message": "Already running", "running": True}
    if not (getattr(capture, "tshark_path", None) or detect_wireshark_installation()):
        return {
            "success": False,
            "running": False,
            "error": "未找到 TShark。请先安装 Wireshark（安装时保持勾选 TShark 组件），装完重启 冒险者侍从。",
        }
    result = capture.start_capture_switch()
    return {"success": result, "running": capture.is_active()}


@router.post("/stop")
def capture_stop():
    from dnd.service import get_packet_capture
    capture = get_packet_capture()
    if not capture.is_active():
        return {"success": True, "message": "Already stopped", "running": False}
    capture.stop_capture_switch()
    return {"success": True, "running": capture.is_active()}


@router.post("/restart")
def capture_restart():
    from dnd.service import get_packet_capture
    capture = get_packet_capture()
    capture.stop_capture_switch(persist_running_state=True)
    capture.start_capture_switch()
    return {"success": True, "running": capture.is_active()}


@router.get("/status")
def capture_status():
    from dnd.service import get_packet_capture
    from dnd.settings import settings_manager, detect_wireshark_installation
    capture = get_packet_capture()
    return {
        "running": capture.is_active(),
        "interface": capture.interface,
        "port_range": {"low": capture.port_range[0], "high": capture.port_range[1]},
        "wireshark_path": settings_manager.get("wiresharkPath", ""),
        "tshark_path": getattr(capture, "tshark_path", "") or "",
        "tshark_detected": detect_wireshark_installation(),
        "mode": getattr(capture, "capture_mode", "direct"),
        "proxy_port": getattr(capture, "active_proxy_port", None),
    }


@router.get("/interfaces")
def capture_interfaces():
    from dnd.service import list_interfaces, get_packet_capture
    capture = get_packet_capture()
    return {
        "interfaces": list_interfaces(),
        "selected": capture.interface,
    }


@router.get("/diagnose")
def capture_diagnose():
    from dnd.service import diagnose_capture
    return diagnose_capture()


@router.post("/settings")
def capture_update_settings(body: CaptureSettingsUpdate):
    from dnd.service import get_packet_capture
    from dnd.settings import settings_manager, resolve_tshark_executable

    capture = get_packet_capture()
    updates = {}
    need_restart = False
    was_running = capture.is_active()

    if body.interface is not None and body.interface != capture.interface:
        capture.interface = body.interface
        updates["interface"] = body.interface
        need_restart = True

    if body.port_low is not None and body.port_high is not None:
        new_range = (body.port_low, body.port_high)
        if new_range != capture.port_range:
            capture.port_range = new_range
            updates["port_range"] = new_range
            need_restart = True

    if body.wireshark_path is not None:
        resolved = resolve_tshark_executable(body.wireshark_path)
        # Always persist the user's pick (even when it does not resolve yet —
        # e.g. Wireshark was moved/updated after the dialog) so the next
        # backend start can retry it instead of silently dropping it.
        updates["wiresharkPath"] = body.wireshark_path
        if resolved:
            capture.set_wireshark_path(body.wireshark_path)
            need_restart = True

    if updates:
        settings_manager.update(updates, persist=True)

    if need_restart and was_running:
        capture.stop_capture_switch(persist_running_state=True)
        capture.start_capture_switch()

    from dnd.settings import detect_wireshark_installation as _detect
    return {
        "success": True,
        "running": capture.is_active(),
        "interface": capture.interface,
        "port_range": {"low": capture.port_range[0], "high": capture.port_range[1]},
        "tshark_path": getattr(capture, "tshark_path", "") or "",
        "tshark_ok": bool(getattr(capture, "tshark_path", "")),
        "tshark_detected": _detect(),
    }
