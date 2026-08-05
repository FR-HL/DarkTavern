import logging
import os
import socket
import threading
from typing import List, Optional

import psutil

logger = logging.getLogger(__name__)

_stash_manager = None
_packet_capture = None
_capture_lock = threading.Lock()
_sort_lock = threading.Lock()
# Character id of the most recent S2C_LOBBY_CHARACTER_INFO_RES snapshot —
# the game only pushes full snapshots when entering the character-select
# / lobby flow, so this is the character currently being played.
last_snapshot_character_id: Optional[str] = None
# Stash id of the most recent S2C_STORAGE_INFO_RES — the game requests the
# stash contents every time the player switches stash tabs in-game, so this
# tracks which stash the player currently has open.
last_snapshot_stash_id: Optional[str] = None
_sort_state = {
    "running": False,
    "kind": "single",  # single / all / merge
    "character_id": None,
    "stash_id": None,
    "cancel_event": None,
    "thread": None,
    "result": None,
    "error": None,
    "sort_all_total": 0,
    "sort_all_current": 0,
    "sort_all_label": "",
    "sort_all_results": [],
}

# ── In-game stash switch detection via global mouse click hook ──
# The game does not send packets when the player clicks stash tabs, so we
# listen for left-clicks landing inside a stash tab selector area: clicking
# a tab IS the switch. The pixel-feature scanner (see macros) remains as a
# fallback for non-mouse input.
_mouse_listener = None
_mouse_listener_lock = threading.Lock()
_MOUSE_TAB_HIT_RATIO = 0.45  # < 0.5 so neighbouring tabs never overlap


def _on_mouse_click(x, y, button, pressed):
    """pynput mouse callback — must never raise (a crash here kills the host
    process), so the whole body is guarded."""
    try:
        if not pressed or not hasattr(button, "name") or button.name != "left":
            return
        _handle_stash_tab_click(x, y)
    except Exception:
        logger.debug("mouse hook: click handler error", exc_info=True)


def _handle_stash_tab_click(x, y):
    global last_snapshot_stash_id
    from dnd.sort import macros

    owned = []
    if last_snapshot_character_id:
        try:
            mgr = get_stash_manager()
            char_data = mgr.characters_cache.get(last_snapshot_character_id) or {}
            owned = list(char_data.get("stashes", {}).keys())
        except Exception:
            owned = []
    mapping = macros.build_dynamic_tab_mapping(owned)
    if not mapping:
        return

    positions = macros.get_stash_tab_positions()
    spacing = float(macros.stash_tab_spacing or 45.0)
    hit = spacing * _MOUSE_TAB_HIT_RATIO

    for i, pos in enumerate(positions[:len(mapping)]):
        if abs(x - pos.x) <= hit and abs(y - pos.y) <= hit:
            stash_id = str(mapping[i])
            if stash_id == last_snapshot_stash_id:
                return
            last_snapshot_stash_id = stash_id
            logger.info("In-game stash switched (mouse click): %s", stash_id)
            from dnd import events
            events.broadcast({"type": "stash_switched", "stash_id": stash_id})
            return


def start_mouse_listener():
    """Start the global left-click listener (one-shot, idempotent)."""
    global _mouse_listener
    with _mouse_listener_lock:
        if _mouse_listener is not None:
            return
        try:
            from pynput import mouse
            _mouse_listener = mouse.Listener(on_click=_on_mouse_click)
            _mouse_listener.daemon = True
            _mouse_listener.start()
            logger.info("Mouse click listener started (in-game stash detection)")
        except Exception as exc:
            _mouse_listener = None
            logger.warning("Mouse click listener unavailable: %s", exc)


def stop_mouse_listener():
    """Stop the global left-click listener (idempotent)."""
    global _mouse_listener
    with _mouse_listener_lock:
        if _mouse_listener is None:
            return
        try:
            _mouse_listener.stop()
        except Exception:
            pass
        _mouse_listener = None


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
    global last_snapshot_character_id
    from dnd.stash.character import save_packet_data
    from dnd.appdirs import get_characters_dir
    import os

    saved = save_packet_data(message)
    if saved:
        try:
            char_data = message.characterDataBase
            char_id = str(char_data.characterId)
            last_snapshot_character_id = char_id
            file_path = os.path.join(get_characters_dir(), f"{char_id}.json")
            mgr = get_stash_manager()
            mgr.update_single_character(char_id, file_path)
            from dnd import events
            events.broadcast({"type": "character_updated", "character_id": char_id})
        except Exception as e:
            logger.error(f"Incremental cache update failed, falling back to force_reload: {e}")
            get_stash_manager().force_reload()
    return saved


def _handle_storage_info(message):
    """Detect which stash the player opened in-game.

    The game sends S2C_STORAGE_INFO_RES (the requested stash's items) every
    time a stash tab is switched, so the dominant inventoryId among the
    returned items tells us the stash the player currently has open.
    """
    global last_snapshot_stash_id
    try:
        items = message.storageItems or []
        counts = {}
        for item in items:
            inv_id = item.inventoryId
            if inv_id:
                counts[inv_id] = counts.get(inv_id, 0) + 1
        if not counts:
            return
        stash_id = str(max(counts, key=counts.get))
        if stash_id == last_snapshot_stash_id:
            return
        last_snapshot_stash_id = stash_id
        logger.info("In-game stash switched (detected): %s", stash_id)
        from dnd import events
        events.broadcast({"type": "stash_switched", "stash_id": stash_id})
    except Exception as e:
        logger.debug("Failed to detect stash switch: %s", e)


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
                _PacketCommand_pb2.PacketCommand.S2C_STORAGE_INFO_RES: _handle_storage_info,
            }
            _packet_capture = capture
        return _packet_capture


def get_sort_state():
    with _sort_lock:
        return dict(_sort_state)


def start_sort(character_id: str, stash_id: str,
                stack_mode: Optional[bool] = None, include_inventory: bool = False,
                group_mode: Optional[str] = None, keep_in_place: Optional[bool] = None):
    from dnd.settings import settings_manager

    if stack_mode is None:
        stack_mode = bool(settings_manager.get('stashStackMode', False))
    if group_mode is None:
        group_mode = str(settings_manager.get('sortGroupMode', 'none') or 'none')
    if keep_in_place is None:
        keep_in_place = bool(settings_manager.get('sortKeepInPlace', True))

    with _sort_lock:
        if _sort_state["running"]:
            return {"success": False, "error": "Sort already in progress"}

        cancel_event = threading.Event()
        _sort_state.update({
            "running": True,
            "kind": "single",
            "character_id": character_id,
            "stash_id": stash_id,
            "cancel_event": cancel_event,
            "thread": None,
            "result": None,
            "error": None,
            "sort_all_total": 0,
            "sort_all_current": 0,
            "sort_all_label": "",
            "sort_all_results": [],
        })

    def _run():
        try:
            mgr = get_stash_manager()
            result = mgr.sort_stash(
                character_id=character_id,
                stash_id=stash_id,
                cancel_event=cancel_event,
                stack_mode=stack_mode,
                include_inventory=include_inventory,
                group_mode=group_mode,
                keep_in_place=keep_in_place,
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


def _resolve_sort_options(stack_mode, group_mode):
    from dnd.settings import settings_manager
    if stack_mode is None:
        stack_mode = bool(settings_manager.get('stashStackMode', False))
    if group_mode is None:
        group_mode = str(settings_manager.get('sortGroupMode', 'none') or 'none')
    return stack_mode, group_mode


def start_sort_all(character_id: str,
                   stack_mode: Optional[bool] = None, group_mode: Optional[str] = None):
    """Sort every stash of a character in turn (in-game tab order, skipping
    empty stashes). Inventory items are merged into the first stash only.
    """
    stack_mode, group_mode = _resolve_sort_options(stack_mode, group_mode)

    with _sort_lock:
        if _sort_state["running"]:
            return {"success": False, "error": "Sort already in progress"}
        cancel_event = threading.Event()
        _sort_state.update({
            "running": True,
            "kind": "all",
            "character_id": character_id,
            "stash_id": None,
            "cancel_event": cancel_event,
            "thread": None,
            "result": None,
            "error": None,
            "sort_all_total": 0,
            "sort_all_current": 0,
            "sort_all_label": "",
            "sort_all_results": [],
        })

    def _run():
        try:
            from dnd.stash.storage import StashType
            from dnd.sort import macros
            mgr = get_stash_manager()
            char = mgr.characters_cache.get(str(character_id))
            stashes = (char or {}).get("stashes", {})
            owned_ids = [
                s for s in stashes.keys()
                if int(s) not in (StashType.BAG.value, StashType.EQUIPMENT.value)
            ]
            macros.build_dynamic_tab_mapping(owned_ids)
            tab_order = [str(s) for s in macros.TAB_TYPE_ORDER if str(s) in stashes]
            tab_order = [s for s in tab_order if stashes.get(s)]  # skip empty
            # Skip locked stashes (user opts them out of full-stash sorting).
            from dnd.settings import settings_manager as _sm
            _locked = set(int(x) for x in (_sm.get("lockedStashes", []) or []))
            if _locked:
                tab_order = [s for s in tab_order if int(s) not in _locked]
            with _sort_lock:
                _sort_state["sort_all_total"] = len(tab_order)

            results = []
            from dnd.routers.stash_router import _stash_label
            for i, stash_id in enumerate(tab_order):
                if cancel_event.is_set():
                    break
                label = _stash_label(stash_id)
                with _sort_lock:
                    _sort_state["sort_all_current"] = i + 1
                    _sort_state["sort_all_label"] = label
                try:
                    r = mgr.sort_stash(
                        character_id=str(character_id),
                        stash_id=str(stash_id),
                        cancel_event=cancel_event,
                        stack_mode=stack_mode,
                        group_mode=group_mode,
                        include_inventory=(i == 0),
                    )
                    if isinstance(r, tuple) and len(r) >= 2:
                        ok = bool(r[0])
                        msg = str(r[1]) if r[1] else ("整理完成" if ok else "整理失败")
                    else:
                        ok, msg = bool(r), ("整理完成" if r else "整理失败")
                except Exception as exc:
                    logger.warning("Sort-all stash %s failed: %s", stash_id, exc)
                    ok, msg = False, str(exc)
                results.append({
                    "stash_id": stash_id, "label": label,
                    "success": ok, "message": msg,
                })
            with _sort_lock:
                _sort_state["sort_all_results"] = results
                _sort_state["result"] = {
                    "success": True,
                    "message": f"全仓库整理完成：{sum(1 for r in results if r['success'])}/{len(results)} 个仓库成功",
                }
                _sort_state["running"] = False
        except Exception as exc:
            logger.error(f"Sort-all failed: {exc}", exc_info=True)
            with _sort_lock:
                _sort_state["error"] = str(exc)
                _sort_state["running"] = False

    t = threading.Thread(target=_run, daemon=True, name="SortAllWorker")
    with _sort_lock:
        _sort_state["thread"] = t
    t.start()
    return {"success": True}


def start_merge_stacks(character_id: str):
    """Merge stackable items across all stashes of a character."""
    with _sort_lock:
        if _sort_state["running"]:
            return {"success": False, "error": "Sort already in progress"}
        cancel_event = threading.Event()
        _sort_state.update({
            "running": True,
            "kind": "merge",
            "character_id": character_id,
            "stash_id": None,
            "cancel_event": cancel_event,
            "thread": None,
            "result": None,
            "error": None,
            "sort_all_total": 0,
            "sort_all_current": 0,
            "sort_all_label": "",
            "sort_all_results": [],
            "cross_steps": [],
            "cross_step_index": 0,
            "cross_step_label": "",
            "cross_results": [],
        })

    def _run():
        try:
            mgr = get_stash_manager()
            ok, msg, _ = mgr.merge_stacks_across_stashes(
                character_id=str(character_id),
                cancel_event=cancel_event,
            )
            with _sort_lock:
                _sort_state["result"] = {"success": bool(ok), "message": msg}
                _sort_state["running"] = False
        except Exception as exc:
            logger.error(f"Stack merge failed: {exc}", exc_info=True)
            with _sort_lock:
                _sort_state["error"] = str(exc)
                _sort_state["running"] = False

    t = threading.Thread(target=_run, daemon=True, name="MergeStacksWorker")
    with _sort_lock:
        _sort_state["thread"] = t
    t.start()
    return {"success": True}


def _cross_step_labels(config: dict) -> list:
    labels = []
    if config.get("merge"):
        labels.append("堆叠合并")
    if config.get("clear_bag"):
        labels.append("背包清空")
    if config.get("evacuate"):
        labels.append("腾空仓库")
    if config.get("categorize"):
        labels.append("归类整理")
    if config.get("repack"):
        labels.append("全局重排")
    if config.get("arrange"):
        labels.append("仓内整理")
    return labels


def start_cross_sort(character_id: str, config: dict):
    """Run the configurable cross-stash organisation."""
    with _sort_lock:
        if _sort_state["running"]:
            return {"success": False, "error": "Sort already in progress"}
        cancel_event = threading.Event()
        steps = _cross_step_labels(config or {})
        _sort_state.update({
            "running": True,
            "kind": "cross",
            "character_id": character_id,
            "stash_id": None,
            "cancel_event": cancel_event,
            "thread": None,
            "result": None,
            "error": None,
            "sort_all_total": 0,
            "sort_all_current": 0,
            "sort_all_label": "",
            "sort_all_results": [],
            "cross_steps": steps,
            "cross_step_index": 0,
            "cross_step_label": "",
            "cross_results": [],
        })

    def _run():
        try:
            mgr = get_stash_manager()

            def _progress(label):
                with _sort_lock:
                    _sort_state["cross_step_label"] = label
                    try:
                        _sort_state["cross_step_index"] = _sort_state["cross_steps"].index(label) + 1
                    except ValueError:
                        _sort_state["cross_step_index"] = 0

            ok, msg, results = mgr.cross_sort(
                character_id=str(character_id),
                config=config or {},
                cancel_event=cancel_event,
                progress_cb=_progress,
            )
            with _sort_lock:
                _sort_state["cross_results"] = results or []
                _sort_state["result"] = {"success": bool(ok), "message": msg}
                _sort_state["running"] = False
        except Exception as exc:
            logger.error(f"Cross sort failed: {exc}", exc_info=True)
            with _sort_lock:
                _sort_state["error"] = str(exc)
                _sort_state["running"] = False

    t = threading.Thread(target=_run, daemon=True, name="CrossSortWorker")
    with _sort_lock:
        _sort_state["thread"] = t
    t.start()
    return {"success": True}


def diagnose_capture() -> dict:
    """Build a snapshot of the game's network topology for the UI.

    Traces: game process -> local accelerator proxy (loopback) -> accelerator
    process -> accelerator's outbound (external) connections, plus where the
    capture is (or would be) listening.
    """
    from collections import Counter
    from dnd.capture.packet_capture import (
        GAME_PROCESS_NAMES, find_loopback_interface, is_game_process,
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
            if is_game_process(proc.info.get("name")):
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
