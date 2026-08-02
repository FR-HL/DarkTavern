import logging
import os
from fastapi import APIRouter
from dnd.appdirs import get_characters_dir

logger = logging.getLogger(__name__)
router = APIRouter()


def _stash_dimensions(stash_id):
    try:
        sid = int(stash_id)
    except (ValueError, TypeError):
        return 12, 20
    if sid == 2:
        return 10, 5
    if sid == 3:
        return 8, 7
    return 12, 20


def _to_roman(n):
    pairs = [(10, 'X'), (9, 'IX'), (5, 'V'), (4, 'IV'), (1, 'I')]
    out = ''
    for v, s in pairs:
        while n >= v:
            out += s
            n -= v
    return out


def _stash_label(stash_id):
    try:
        sid = int(stash_id)
    except (ValueError, TypeError):
        return f"仓库 {stash_id}"

    fixed = {
        0: "无", 1: "箱子", 2: "背包", 3: "装备", 4: "仓库",
        20: "赛季共享", 30: "共享仓库",
    }
    if sid in fixed:
        return fixed[sid]
    if 5 <= sid <= 9:
        return f"仓库 +{_to_roman(sid - 4)}"
    if 21 <= sid <= 29:
        return f"赛季共享 +{_to_roman(sid - 20)}"
    if 31 <= sid <= 39:
        return f"共享仓库 +{_to_roman(sid - 30)}"
    if 100 <= sid <= 102:
        return f"装备方案 {sid - 99}"
    return f"仓库 {sid}"


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
        item_list = []
        for item in items:
            item_id = item.get("itemId", "")
            item_db = item_data_manager.get_item_data(item_id)
            w = item_db.get("inventory_width", 1)
            h = item_db.get("inventory_height", 1)
            slot_id = item.get("slotId", 0)
            item_list.append({
                "name": item.get("name", "Unknown"),
                "item_id": item_id,
                "rarity": item_db.get("rarity", "Common"),
                "width": w,
                "height": h,
                "x": slot_id % width,
                "y": slot_id // width,
                "slot_id": slot_id,
                "quantity": item.get("itemCount", 1),
                "vendor_price": item.get("vendor_price", 0),
            })
        stashes_info[str(stash_id)] = {
            "label": _stash_label(stash_id),
            "width": width,
            "height": height,
            "items": item_list,
        }

    return {
        "id": character_id,
        "nickname": char_data.get("nickname", "Unknown"),
        "class": char_data.get("class", "Unknown"),
        "level": char_data.get("level", 0),
        "stashes": stashes_info,
    }


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
