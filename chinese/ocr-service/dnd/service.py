import logging
import socket
import threading
from typing import List, Optional

import psutil

logger = logging.getLogger(__name__)

_stash_manager = None
_packet_capture = None
_capture_lock = threading.Lock()
_sort_lock = threading.Lock()
_sort_state = {
    "running": False,
    "character_id": None,
    "stash_id": None,
    "cancel_event": None,
    "thread": None,
    "result": None,
    "error": None,
}


def detect_default_interface() -> str:
    """Detect the network interface used for internet egress.

    Opens a throwaway UDP socket toward a public address and reads back the
    local IP the OS would route through, then matches that IP to an interface.
    Falls back to the first non-loopback IPv4 interface, then 'Ethernet'.
    """
    local_ip: Optional[str] = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        local_ip = None

    first_fallback: Optional[str] = None
    try:
        for name, addrs in psutil.net_if_addrs().items():
            for addr in addrs:
                if addr.family != socket.AF_INET:
                    continue
                if local_ip and addr.address == local_ip:
                    return name
                if first_fallback is None and "loopback" not in name.lower():
                    first_fallback = name
    except Exception as exc:
        logger.debug(f"Interface enumeration failed: {exc}")

    return first_fallback or "Ethernet"


def list_interfaces() -> List[dict]:
    """Return all network interfaces that have an IPv4 address."""
    default_ip: Optional[str] = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        default_ip = s.getsockname()[0]
        s.close()
    except Exception:
        default_ip = None

    stats = {}
    try:
        stats = psutil.net_if_stats()
    except Exception:
        stats = {}

    result: List[dict] = []
    try:
        for name, addrs in psutil.net_if_addrs().items():
            ip = None
            for addr in addrs:
                if addr.family == socket.AF_INET:
                    ip = addr.address
                    break
            if not ip:
                continue
            st = stats.get(name)
            result.append({
                "name": name,
                "ip": ip,
                "is_up": bool(st.isup) if st else False,
                "is_default": ip == default_ip,
            })
    except Exception as exc:
        logger.debug(f"Interface listing failed: {exc}")

    result.sort(key=lambda x: (not x["is_default"], not x["is_up"], x["name"]))
    return result


def get_stash_manager():
    global _stash_manager
    if _stash_manager is None:
        from dnd.stash.stash_manager import StashManager
        from dnd.appdirs import resource_path
        _stash_manager = StashManager(
            resource_path(''),
            defer_loading=False,
        )
    return _stash_manager


def _handle_character(message):
    from dnd.stash.character import save_packet_data
    from dnd.appdirs import get_characters_dir
    import os

    saved = save_packet_data(message)
    if saved:
        try:
            char_data = message.characterDataBase
            char_id = str(char_data.characterId)
            file_path = os.path.join(get_characters_dir(), f"{char_id}.json")
            mgr = get_stash_manager()
            mgr.current_character_id = char_id
            mgr.update_single_character(char_id, file_path)
            from dnd import events
            events.broadcast({"type": "character_updated", "character_id": char_id})
        except Exception as e:
            logger.error(f"Incremental cache update failed, falling back to force_reload: {e}")
            get_stash_manager().force_reload()
    return saved


def _c2s_item_handler(kind):
    """Build a handler for client-initiated inventory requests (MOVE/SWAP/
    MERGE). These carry the full target data (server confirmations are empty
    messages), so they are the only way to see real-time item movement."""
    from dnd.stash.incremental import apply_character_update, apply_move, apply_swap, apply_merge

    def _info(pb):
        if pb is None:
            return None
        return {
            "itemUniqueId": getattr(pb, "itemUniqueId", None),
            "inventoryId": getattr(pb, "inventoryId", None),
            "slotId": getattr(pb, "slotId", None),
        }

    def _commit(char_id, payload, changed):
        if not changed:
            return
        try:
            import os
            from dnd.appdirs import get_characters_dir
            from dnd.stash.incremental import apply_character_update
            file_path = os.path.join(get_characters_dir(), f"{char_id}.json")
            with open(file_path, "w", encoding="utf-8") as f:
                import json
                json.dump(payload, f, ensure_ascii=False)
            mgr = get_stash_manager()
            mgr.update_single_character(char_id, file_path)
            from dnd import events
            events.broadcast({"type": "character_updated", "character_id": char_id})
        except Exception as e:
            logger.error(f"C2S handler {kind} commit failed: {e}")

    def handler(message):
        mgr = get_stash_manager()
        char_id = getattr(mgr, "current_character_id", None)
        if not char_id:
            return
        try:
            import os
            import json as _json
            from dnd.appdirs import get_characters_dir
            path = os.path.join(get_characters_dir(), f"{char_id}.json")
            if not os.path.isfile(path):
                return
            with open(path, "r", encoding="utf-8") as f:
                payload = _json.load(f)

            if kind == "move":
                src = _info(getattr(message, "srcInfo", None))
                changed = apply_move(
                    payload,
                    src.get("itemUniqueId") if src else None,
                    src.get("inventoryId") if src else None,
                    src.get("slotId") if src else None,
                    getattr(message, "dstInventoryId", None),
                    getattr(message, "dstSlotId", None),
                )
            elif kind == "swap":
                src = _info(getattr(message, "srcInfo", None))
                dst = _info(getattr(message, "dstInfo", None))
                swap_infos = list(getattr(message, "swapInfos", []) or [])
                if swap_infos and src:
                    first = swap_infos[0]
                    f_dst = _info(getattr(first, "dstInfo", None))
                    if f_dst and str(f_dst.get("itemUniqueId")) == str(src.get("itemUniqueId")):
                        src["newSlotId"] = getattr(first, "newSlotId", None)
                        src["newInventoryId"] = getattr(first, "newInventoryId", None)
                changed = apply_swap(payload, src or {}, dst or {})
            elif kind == "merge":
                src = _info(getattr(message, "srcInfo", None))
                dst = _info(getattr(message, "dstInfo", None))
                changed = apply_merge(payload, src or {}, dst or {})
            else:
                return
            _commit(char_id, payload, changed)
        except Exception as e:
            logger.error(f"C2S handler {kind} failed: {e}")

    return handler


def _incremental_handler(kind, items_field, old_items_field=None):
    """Build a packet handler that applies an incremental inventory update."""
    from google.protobuf.json_format import MessageToDict
    from dnd.stash.incremental import apply_character_update

    def handler(message):
        mgr = get_stash_manager()
        char_id = getattr(mgr, "current_character_id", None)
        if not char_id:
            return
        try:
            items = list(getattr(message, items_field, []) or [])
            if not items:
                return
            old_items = None
            if old_items_field:
                old_items = list(getattr(message, old_items_field, []) or [])
            result = int(getattr(message, "result", 0) or 0)
            dicts = [MessageToDict(i, preserving_proto_field_name=False) for i in items]
            old_dicts = [MessageToDict(i, preserving_proto_field_name=False) for i in old_items] if old_items else None
            if apply_character_update(char_id, kind, dicts, old_items=old_dicts, result=result):
                import os
                from dnd.appdirs import get_characters_dir
                file_path = os.path.join(get_characters_dir(), f"{char_id}.json")
                mgr.update_single_character(char_id, file_path)
                from dnd import events
                events.broadcast({"type": "character_updated", "character_id": char_id})
        except Exception as e:
            logger.error(f"Incremental handler {kind} failed: {e}")

    return handler


def get_packet_capture():
    global _packet_capture
    with _capture_lock:
        if _packet_capture is None:
            from dnd.capture.packet_capture import PacketCapture
            from dnd.settings import settings_manager, resolve_tshark_executable, detect_wireshark_installation
            from dnd.protos import _PacketCommand_pb2
            import os

            interface = settings_manager.get('interface') or os.getenv('CAPTURE_INTERFACE') or detect_default_interface()
            port_low = int(os.getenv('CAPTURE_PORT_LOW', 20200))
            port_high = int(os.getenv('CAPTURE_PORT_HIGH', 20300))
            wireshark_path = settings_manager.get('wiresharkPath') or detect_wireshark_installation()

            capture = PacketCapture(
                interface=interface,
                port_range=(port_low, port_high),
                wireshark_path=resolve_tshark_executable(wireshark_path),
            )
            capture.capture_info = {
                _PacketCommand_pb2.PacketCommand.S2C_LOBBY_CHARACTER_INFO_RES: _handle_character,
                _PacketCommand_pb2.PacketCommand.S2C_INVENTORY_SINGLE_UPDATE_RES: _incremental_handler(
                    "single", "newItem", "oldItem"),
                _PacketCommand_pb2.PacketCommand.S2C_INVENTORY_ALL_UPDATE_RES: _incremental_handler(
                    "all", "inventoryItems"),
                _PacketCommand_pb2.PacketCommand.S2C_INVENTORY_INFO_RES: _incremental_handler(
                    "info", "inventoryItems"),
                _PacketCommand_pb2.PacketCommand.S2C_STORAGE_INFO_RES: _incremental_handler(
                    "storage", "storageItems"),
                _PacketCommand_pb2.PacketCommand.C2S_INVENTORY_MOVE_REQ: _c2s_item_handler("move"),
                _PacketCommand_pb2.PacketCommand.C2S_INVENTORY_SWAP_REQ: _c2s_item_handler("swap"),
                _PacketCommand_pb2.PacketCommand.C2S_INVENTORY_MERGE_REQ: _c2s_item_handler("merge"),
                _PacketCommand_pb2.PacketCommand.C2S_INVENTORY_SINGLE_UPDATE_REQ: _incremental_handler(
                    "single", "newItem", "oldItem"),
                _PacketCommand_pb2.PacketCommand.C2S_INVENTORY_ALL_UPDATE_REQ: _incremental_handler(
                    "all", "inventoryItems"),
            }
            _packet_capture = capture
        return _packet_capture


def get_sort_state():
    with _sort_lock:
        return dict(_sort_state)


def start_sort(character_id: str, stash_id: str, pack_mode: Optional[bool] = None,
               stack_mode: Optional[bool] = None, include_inventory: bool = False):
    from dnd.settings import settings_manager

    if pack_mode is None:
        pack_mode = bool(settings_manager.get('stashPackMode', False))
    if stack_mode is None:
        stack_mode = bool(settings_manager.get('stashStackMode', False))

    with _sort_lock:
        if _sort_state["running"]:
            return {"success": False, "error": "Sort already in progress"}

        cancel_event = threading.Event()
        _sort_state.update({
            "running": True,
            "character_id": character_id,
            "stash_id": stash_id,
            "cancel_event": cancel_event,
            "thread": None,
            "result": None,
            "error": None,
        })

    def _run():
        try:
            mgr = get_stash_manager()
            result = mgr.sort_stash(
                character_id=character_id,
                stash_id=stash_id,
                cancel_event=cancel_event,
                pack_mode=pack_mode,
                stack_mode=stack_mode,
                include_inventory=include_inventory,
            )
            if isinstance(result, tuple):
                if len(result) == 3:
                    success, message, _summary = result
                else:
                    success, message = result
            else:
                success, message = bool(result), None
            with _sort_lock:
                _sort_state["result"] = {"success": success, "message": message}
                _sort_state["running"] = False
        except Exception as exc:
            logger.error(f"Sort failed: {exc}", exc_info=True)
            with _sort_lock:
                _sort_state["error"] = str(exc)
                _sort_state["running"] = False

    t = threading.Thread(target=_run, daemon=True, name="SortWorker")
    with _sort_lock:
        _sort_state["thread"] = t
    t.start()
    return {"success": True}


def cancel_sort():
    with _sort_lock:
        if not _sort_state["running"]:
            return {"success": False, "error": "No sort in progress"}
        ev = _sort_state["cancel_event"]
    if ev:
        ev.set()
    return {"success": True}


def diagnose_capture() -> dict:
    """Build a snapshot of the game's network topology for the UI.

    Traces: game process -> local accelerator proxy (loopback) -> accelerator
    process -> accelerator's outbound (external) connections, plus where the
    capture is (or would be) listening.
    """
    from collections import Counter
    from dnd.capture.packet_capture import (
        GAME_PROCESS_NAMES, find_loopback_interface,
    )
    from dnd.settings import settings_manager, detect_wireshark_installation

    result = {
        "game": {"running": False, "process": None, "pid": None},
        "accelerator": {
            "detected": False, "proxy_port": None,
            "process": None, "pid": None, "connections": [],
        },
        "external": [],
        "capture": {
            "mode": "direct", "interface": None,
            "proxy_port": None, "filter": None,
            "running": False, "tshark_ok": False,
        },
    }

    def _conns(proc):
        fn = getattr(proc, "net_connections", None) or proc.connections
        return fn(kind="tcp")

    # ── Find the game process ──
    game_proc = None
    try:
        for proc in psutil.process_iter(["name", "pid"]):
            if proc.info.get("name") in GAME_PROCESS_NAMES:
                game_proc = proc
                break
    except Exception as exc:
        logger.debug(f"diagnose: game process scan failed: {exc}")

    proxy_port = None
    if game_proc is not None:
        result["game"] = {
            "running": True,
            "process": game_proc.info.get("name"),
            "pid": game_proc.pid,
        }
        # Game's loopback connections -> accelerator proxy port
        proxy_ports = Counter()
        try:
            for conn in _conns(game_proc):
                raddr, laddr = getattr(conn, "raddr", None), getattr(conn, "laddr", None)
                if raddr and raddr[0] == "127.0.0.1" and getattr(conn, "status", "") == "ESTABLISHED":
                    proxy_ports[raddr[1]] += 1
                    result["accelerator"]["connections"].append({
                        "local_port": laddr[1] if laddr else None,
                        "proxy_port": raddr[1],
                    })
        except Exception as exc:
            logger.debug(f"diagnose: game connection read failed: {exc}")

        if proxy_ports:
            proxy_port = proxy_ports.most_common(1)[0][0]
            result["accelerator"]["detected"] = True
            result["accelerator"]["proxy_port"] = proxy_port

            # Find the accelerator process listening on that proxy port, and
            # its outbound (external) connections — where data really goes.
            try:
                for conn in psutil.net_connections(kind="tcp"):
                    laddr = getattr(conn, "laddr", None)
                    if (laddr and laddr[1] == proxy_port
                            and getattr(conn, "status", "") == "LISTEN" and conn.pid):
                        aproc = psutil.Process(conn.pid)
                        result["accelerator"]["process"] = aproc.name()
                        result["accelerator"]["pid"] = conn.pid
                        try:
                            for ac in _conns(aproc):
                                ar = getattr(ac, "raddr", None)
                                al = getattr(ac, "laddr", None)
                                if (ar and ar[0] != "127.0.0.1"
                                        and getattr(ac, "status", "") == "ESTABLISHED"):
                                    result["external"].append({
                                        "local": f"{al[0]}:{al[1]}" if al else "",
                                        "remote": f"{ar[0]}:{ar[1]}",
                                    })
                        except Exception as exc:
                            logger.debug(f"diagnose: accelerator connection read failed: {exc}")
                        break
            except Exception as exc:
                logger.debug(f"diagnose: accelerator process lookup failed: {exc}")

    # ── Where the capture listens (predicted from current detection) ──
    cap = {
        "mode": "accelerator" if proxy_port else "direct",
        "proxy_port": proxy_port,
        "running": False,
        "tshark_ok": bool(detect_wireshark_installation()),
    }
    if proxy_port:
        cap["interface"] = find_loopback_interface(detect_wireshark_installation() or None)
        cap["filter"] = f"tcp.srcport == {proxy_port}"
    else:
        iface = settings_manager.get("interface") or detect_default_interface()
        cap["interface"] = iface
        lo = int(os.getenv("CAPTURE_PORT_LOW", 20200))
        hi = int(os.getenv("CAPTURE_PORT_HIGH", 20300))
        cap["filter"] = f"tcp.srcport >= {lo} and tcp.srcport <= {hi}"
    result["capture"] = cap

    # Actual running-capture state, if a capture object already exists.
    if _packet_capture is not None:
        try:
            result["capture"]["running"] = _packet_capture.is_active()
            result["capture"]["mode"] = getattr(_packet_capture, "capture_mode", cap["mode"])
            result["capture"]["proxy_port"] = getattr(_packet_capture, "active_proxy_port", proxy_port)
        except Exception:
            pass

    return result
