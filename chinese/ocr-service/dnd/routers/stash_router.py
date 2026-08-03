import json
import logging
import os
from fastapi import APIRouter, Response, WebSocket
from pydantic import BaseModel
from dnd.appdirs import get_characters_dir
from dnd.items.icon_pak import canonical_icon_path, icon_store

logger = logging.getLogger(__name__)
router = APIRouter()

_EQUIPMENT_SLOTS = None


class StashSwitchRequest(BaseModel):
    stash_id: str
    character_id: str = ""


def _load_equipment_slots():
    """Equipment page slot layout (slot id -> grid position/size)."""
    global _EQUIPMENT_SLOTS
    if _EQUIPMENT_SLOTS is not None:
        return _EQUIPMENT_SLOTS
    try:
        from dnd.appdirs import resource_path
        with open(resource_path('equipment_slots.json'), 'r', encoding='utf-8') as f:
            raw = json.load(f)
        slots = raw.get('equipment_slots', {})
        _EQUIPMENT_SLOTS = {
            str(k): {
                'name': v.get('name', ''),
                'x': int(v.get('x', 0)),
                'y': int(v.get('y', 0)),
                'w': int(v.get('w', 1)),
                'h': int(v.get('h', 1)),
            }
            for k, v in slots.items()
        }
    except Exception as exc:
        logger.warning("Failed to load equipment_slots.json: %s", exc)
        _EQUIPMENT_SLOTS = {}
    return _EQUIPMENT_SLOTS


def _stash_dimensions(stash_id):
    try:
        sid = int(stash_id)
    except (ValueError, TypeError):
        return 12, 20
    if sid == 2:
        return 10, 5
    if sid == 3:
        return 8, 8
    return 12, 20


def _stash_label(stash_id):
    try:
        sid = int(stash_id)
    except (ValueError, TypeError):
        return f"仓库 {stash_id}"

    fixed = {
        0: "无", 1: "箱子", 2: "背包", 3: "装备", 4: "仓库",
    }
    if sid in fixed:
        return fixed[sid]
    if 5 <= sid <= 9:
        return f"仓库 {sid - 4}"
    if 20 <= sid <= 29:
        return f"赛季共享 {sid - 19}"
    if 30 <= sid <= 39:
        return f"共享仓库 {sid - 29}"
    if 100 <= sid <= 102:
        return f"装备方案 {sid - 99}"
    return f"仓库 {sid}"


@router.get("/icon/{path:path}")
def get_item_icon(path: str):
    stream = icon_store.stream(path)
    if stream is None:
        return Response(status_code=404)
    return Response(
        content=stream.read(),
        media_type="image/webp",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/characters")
def list_characters():
    from dnd.service import get_stash_manager
    mgr = get_stash_manager()
    characters = []
    for char_id, char_data in mgr.characters_cache.items():
        stashes = char_data.get("stashes", {})
        total_items = sum(len(v) for v in stashes.values() if isinstance(v, list))
        characters.append({
            "id": char_id,
            "nickname": char_data.get("nickname", "Unknown"),
            "class": char_data.get("class", "Unknown"),
            "level": char_data.get("level", 0),
            "stash_count": len(stashes),
            "total_items": total_items,
        })
    return {"characters": characters}


@router.post("/switch")
def switch_stash(body: StashSwitchRequest):
    """Click the corresponding stash tab in the game UI for a stash type.

    The in-game tab list only shows *owned* stashes, arranged in the fixed
    in-game type order (Storage, Purchased 1-5, Seasonal 1-2, Shared Stash),
    so the tab mapping is rebuilt dynamically from the character's owned
    stashes before clicking.

    Best-effort in-game tab switch: when the game window is missing, the
    tab mapping is unconfigured, or the stash type has no tab of its own
    (bag / equipment), the request is *skipped* — the caller should still
    switch the frontend display.
    """
    from dnd import uipi
    from dnd.sort import macros

    try:
        stash_type = int(body.stash_id)
    except (TypeError, ValueError):
        return {"success": False, "switched": False, "reason": "invalid_stash_id"}

    # Bag / equipment have no tab selectors in the game stash UI.
    if stash_type in (2, 3):
        return {"success": True, "switched": False, "reason": "no_tab"}

    # Rebuild the tab mapping for the character's owned stashes so the
    # clicked tab index matches the dynamic in-game tab list.
    owned = _owned_stash_ids(body.character_id)
    macros.build_dynamic_tab_mapping(owned)

    status = uipi.check_uipi_status()
    if status["blocked"]:
        return {
            "success": False,
            "switched": False,
            "reason": "uipi_blocked",
            "uipi": status,
        }

    if stash_type not in macros.STASH_TYPE_TO_TAB_INDEX:
        return {"success": True, "switched": False, "reason": "mapping_not_configured"}

    if not macros.force_activate_game_window():
        return {"success": True, "switched": False, "reason": "game_not_found"}

    try:
        if not macros.click_stash_tab(stash_type):
            return {"success": False, "switched": False, "reason": "click_failed"}
    except Exception as exc:
        logger.warning("In-game stash switch failed for type %s: %s", stash_type, exc)
        return {"success": False, "switched": False, "reason": "click_failed"}

    return {"success": True, "switched": True, "reason": ""}


def _owned_stash_ids(character_id: str):
    """Return the stash ids the given character actually owns.

    Falls back to the last captured character when no character_id is given.
    Returns an empty list when no character data is available — the caller
    then falls back to the default tab mapping.
    """
    try:
        from dnd import service
        if not character_id:
            character_id = service.last_snapshot_character_id or ""
        if not character_id:
            return []
        mgr = service.get_stash_manager()
        char_data = mgr.characters_cache.get(character_id)
        if not char_data:
            return []
        return list(char_data.get("stashes", {}).keys())
    except Exception:
        return []


@router.get("/current")
def current_character():
    """Currently active character (last snapshot seen by the packet capture)."""
    from dnd import service
    char_id = service.last_snapshot_character_id
    if not char_id:
        return {"current": None}
    mgr = service.get_stash_manager()
    char_data = mgr.characters_cache.get(char_id)
    if not char_data:
        return {"current": None}
    stashes = char_data.get("stashes", {})
    total_items = sum(len(v) for v in stashes.values() if isinstance(v, list))
    return {"current": {
        "id": char_id,
        "nickname": char_data.get("nickname", "Unknown"),
        "class": char_data.get("class", "Unknown"),
        "level": char_data.get("level", 0),
        "stash_count": len(stashes),
        "total_items": total_items,
        "updated_at": char_data.get("lastUpdate", ""),
    }}


@router.get("/character/{character_id}")
def get_character(character_id: str):
    from dnd.service import get_stash_manager
    from dnd.items.game_data import item_data_manager
    mgr = get_stash_manager()
    char_data = mgr.characters_cache.get(character_id)
    if not char_data:
        return {"error": "Character not found"}

    stashes_info = {}
    for stash_id, items in char_data.get("stashes", {}).items():
        width, height = _stash_dimensions(stash_id)
        equipment_slots = _load_equipment_slots() if str(stash_id) == "3" else None
        item_list = []
        for item in items:
            item_id = item.get("itemId", "")
            item_db = item_data_manager.get_item_data(item_id)
            w = item_db.get("inventory_width", 1)
            h = item_db.get("inventory_height", 1)
            slot_id = item.get("slotId", 0)
            if equipment_slots is not None:
                # Equipment page: slotId is a fixed gear slot id, not a grid
                # index — position items on their slot.
                slot = equipment_slots.get(str(slot_id))
                if slot is not None:
                    x, y, w, h = slot["x"], slot["y"], slot["w"], slot["h"]
                else:
                    x, y = 0, 0
                    logger.debug("Equipment item with unknown slot id: %s", slot_id)
            else:
                x, y = slot_id % width, slot_id // width
            item_list.append({
                "name": item.get("name", "Unknown"),
                "item_id": item_id,
                "rarity": item_db.get("rarity", "Common"),
                "icon": canonical_icon_path(item_db.get("iconPath")),
                "width": w,
                "height": h,
                "x": x,
                "y": y,
                "slot_id": slot_id,
                "quantity": item.get("itemCount", 1),
                "vendor_price": item.get("vendor_price", 0),
            })
        stash_entry = {
            "label": _stash_label(stash_id),
            "width": width,
            "height": height,
            "items": item_list,
        }
        if equipment_slots is not None:
            stash_entry["layout"] = "equipment"
            stash_entry["slots"] = [
                {"id": k, **v}
                for k, v in sorted(equipment_slots.items(), key=lambda kv: int(kv[0]))
            ]
        stashes_info[str(stash_id)] = stash_entry

    return {
        "id": character_id,
        "nickname": char_data.get("nickname", "Unknown"),
        "class": char_data.get("class", "Unknown"),
        "level": char_data.get("level", 0),
        "updated_at": char_data.get("lastUpdate", ""),
        "stashes": stashes_info,
    }


@router.websocket("/events")
async def stash_events(ws: WebSocket):
    import json
    from dnd import events, service

    async def _push_current(ws):
        current = service.last_snapshot_character_id
        if current:
            await ws.send_text(json.dumps(
                {"type": "current_character", "character_id": current},
                ensure_ascii=False,
            ))

    await events.handle_socket(ws, on_connect=_push_current)


@router.post("/clear")
def clear_characters():
    from dnd.service import get_stash_manager
    from pathlib import Path

    removed = []
    failed = []
    data_dir = Path(get_characters_dir())
    if data_dir.exists():
        for f in data_dir.glob("*.json"):
            try:
                f.unlink()
                removed.append(f.name)
            except OSError as exc:
                logger.warning("Failed to delete %s: %s", f.name, exc)
                failed.append(f.name)

    mgr = get_stash_manager()
    mgr.force_reload()

    return {
        "success": len(failed) == 0,
        "removed_count": len(removed),
        "failed_count": len(failed),
    }
