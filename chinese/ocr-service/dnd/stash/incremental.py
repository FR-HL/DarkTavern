"""Apply incremental inventory/stash updates captured from the game.

Full character snapshots arrive via ``S2C_LOBBY_CHARACTER_INFO_RES`` only,
so moving an item in-game produces no snapshot. The game instead pushes
incremental messages (single item update / full container list / stash
info). This module applies those increments to the character's on-disk
packet JSON (same format as ``character.py: save_packet_data``), so the
regular load pipeline (``StashManager.update_single_character``) picks the
changes up.

Incremental messages carry no character id; callers must pass the
"current" character (the one last seen in a full snapshot).
"""

import copy
import json
import logging
import os

from dnd.appdirs import get_characters_dir

logger = logging.getLogger(__name__)


def _base_of(payload):
    if not isinstance(payload, dict):
        return None
    base = payload.get("characterDataBase")
    return base if isinstance(base, dict) else None


def _storage_entries(base):
    storages = base.get("CharacterStorageInfos")
    return storages if isinstance(storages, list) else []


def _container_for(base, inventory_id):
    """Return the item list (a mutable python list) holding this container."""
    try:
        inv = str(int(inventory_id))
    except (TypeError, ValueError):
        return None
    for entry in _storage_entries(base):
        try:
            key = str(int(entry.get("inventoryId", -1)))
        except (TypeError, ValueError):
            continue
        if key == inv:
            items = entry.get("CharacterStorageItemList")
            if not isinstance(items, list):
                items = []
                entry["CharacterStorageItemList"] = items
            return items
    items = base.get("CharacterItemList")
    if not isinstance(items, list):
        items = []
        base["CharacterItemList"] = items
    return items


def _match_index(items, item):
    uid = item.get("itemUniqueId")
    if uid is not None:
        for idx, it in enumerate(items):
            if str(it.get("itemUniqueId")) == str(uid):
                return idx
    inv = item.get("inventoryId")
    slot = item.get("slotId")
    if inv is not None and slot is not None:
        for idx, it in enumerate(items):
            if (str(it.get("inventoryId")) == str(inv)
                    and str(it.get("slotId")) == str(slot)):
                return idx
    return -1


def _find_item(payload, unique_id, inventory_id=None, slot_id=None):
    """Locate an item by unique id (falling back to container+slot) and
    return (container_list, index) so callers can mutate it."""
    base = _base_of(payload)
    if base is None:
        return None, -1
    candidates = []
    for entry in _storage_entries(base):
        candidates.append(entry.get("CharacterStorageItemList") or [])
    candidates.append(base.get("CharacterItemList") or [])
    for items in candidates:
        if not isinstance(items, list):
            continue
        for idx, it in enumerate(items):
            if unique_id is not None and str(it.get("itemUniqueId")) == str(unique_id):
                return items, idx
    if inventory_id is not None and slot_id is not None:
        for items in candidates:
            if not isinstance(items, list):
                continue
            for idx, it in enumerate(items):
                if (str(it.get("inventoryId")) == str(inventory_id)
                        and str(it.get("slotId")) == str(slot_id)):
                    return items, idx
    return None, -1


def apply_move(payload, unique_id, src_inventory_id, src_slot_id, dst_inventory_id, dst_slot_id):
    """C2S_INVENTORY_MOVE_REQ: relocate an item to a new container/slot."""
    base = _base_of(payload)
    if base is None or dst_inventory_id is None:
        return False
    src_items, idx = _find_item(payload, unique_id, src_inventory_id, src_slot_id)
    if src_items is None or idx < 0:
        return False
    item = src_items.pop(idx)
    item["inventoryId"] = int(dst_inventory_id)
    item["slotId"] = int(dst_slot_id)
    dst_items = _container_for(base, dst_inventory_id)
    if dst_items is None:
        return False
    _remove(dst_items, {"inventoryId": int(dst_inventory_id), "slotId": int(dst_slot_id)})
    dst_items.append(item)
    return True


def apply_swap(payload, src, dst):
    """C2S_INVENTORY_SWAP_REQ: exchange positions of two items.

    src/dst: dicts with itemUniqueId / inventoryId / slotId (src may also
    carry newSlotId/newInventoryId for the swapped destination).
    """
    base = _base_of(payload)
    if base is None:
        return False
    src_items, src_idx = _find_item(payload, src.get("itemUniqueId"), src.get("inventoryId"), src.get("slotId"))
    dst_items, dst_idx = _find_item(payload, dst.get("itemUniqueId"), dst.get("inventoryId"), dst.get("slotId"))
    if src_items is None or src_idx < 0 or dst_items is None or dst_idx < 0:
        return False
    if src_items is dst_items:
        # Same container: pop the higher index first so indices stay valid.
        if src_idx > dst_idx:
            src_item = src_items.pop(src_idx)
            dst_item = dst_items.pop(dst_idx)
        else:
            dst_item = dst_items.pop(dst_idx)
            src_item = src_items.pop(src_idx)
    else:
        src_item = src_items.pop(src_idx)
        dst_item = dst_items.pop(dst_idx)

    dst_inv = dst.get("newInventoryId")
    if dst_inv is None:
        dst_inv = dst_item.get("inventoryId")
    dst_slot = dst.get("newSlotId")
    if dst_slot is None:
        dst_slot = dst_item.get("slotId")

    src_inv = src.get("inventoryId")
    src_slot = src.get("slotId")

    dst_item["inventoryId"] = int(src_inv)
    dst_item["slotId"] = int(src_slot)
    src_item["inventoryId"] = int(dst_inv)
    src_item["slotId"] = int(dst_slot)

    dst_items.append(src_item)
    src_items.append(dst_item)
    return True


def apply_merge(payload, src, dst):
    """C2S_INVENTORY_MERGE_REQ: fold src item count into dst item, remove src."""
    base = _base_of(payload)
    if base is None:
        return False
    src_items, src_idx = _find_item(payload, src.get("itemUniqueId"), src.get("inventoryId"), src.get("slotId"))
    dst_items, dst_idx = _find_item(payload, dst.get("itemUniqueId"), dst.get("inventoryId"), dst.get("slotId"))
    if src_items is None or src_idx < 0 or dst_items is None or dst_idx < 0:
        return False
    if src_items is dst_items and src_idx > dst_idx:
        src_item = src_items.pop(src_idx)
        dst_item = dst_items[dst_idx]
    else:
        src_item = src_items.pop(src_idx)
        dst_idx = dst_idx - 1 if src_items is dst_items else dst_idx
        dst_item = dst_items[dst_idx]
    dst_item["itemCount"] = int(dst_item.get("itemCount", 1)) + int(src_item.get("itemCount", 1))
    contents = src_item.get("itemContentsCount")
    if contents:
        dst_item["itemContentsCount"] = int(dst_item.get("itemContentsCount", 0)) + int(contents)
    return True


def _remove(items, item):
    idx = _match_index(items, item)
    if idx >= 0:
        items.pop(idx)
        return True
    return False


def _upsert(items, item):
    idx = _match_index(items, item)
    if idx >= 0:
        items[idx] = copy.deepcopy(item)
    else:
        items.append(copy.deepcopy(item))


def _replace_container(base, inventory_id, new_items):
    try:
        inv = str(int(inventory_id))
    except (TypeError, ValueError):
        return False
    for entry in _storage_entries(base):
        try:
            key = str(int(entry.get("inventoryId", -1)))
        except (TypeError, ValueError):
            continue
        if key == inv:
            entry["CharacterStorageItemList"] = copy.deepcopy(new_items)
            return True
    keep = []
    for it in base.get("CharacterItemList", []):
        try:
            key = str(int(it.get("inventoryId", -1)))
        except (TypeError, ValueError):
            keep.append(it)
            continue
        if key != inv:
            keep.append(it)
    keep.extend(copy.deepcopy(new_items))
    base["CharacterItemList"] = keep
    return True


def apply_single_update(payload, old_items, new_items):
    """SINGLE_UPDATE semantics: remove old items, insert/update new ones."""
    base = _base_of(payload)
    if base is None:
        return False
    changed = False
    for item in old_items or []:
        if item.get("inventoryId") is None:
            continue
        items = _container_for(base, item["inventoryId"])
        if items is not None and _remove(items, item):
            changed = True
    for item in new_items or []:
        if item.get("inventoryId") is None:
            continue
        items = _container_for(base, item["inventoryId"])
        if items is None:
            continue
        _upsert(items, item)
        changed = True
    return changed


def apply_grouped_replace(payload, items):
    """ALL_UPDATE / INFO / STORAGE_INFO semantics: replace each container
    with the incoming full item list for that inventory id."""
    base = _base_of(payload)
    if base is None:
        return False
    grouped = {}
    for item in items or []:
        if item.get("inventoryId") is None:
            continue
        grouped.setdefault(str(int(item["inventoryId"])), []).append(item)
    if not grouped:
        return False
    changed = False
    for inv, group in grouped.items():
        if _replace_container(base, inv, group):
            changed = True
    return changed


def apply_character_update(char_id, kind, items, old_items=None, result=None):
    """Load the character's packet JSON, apply one increment, write it back.

    Args:
        char_id: current character id (increments carry no id).
        kind: 'single' | 'all' | 'info' | 'storage'.
        items: new items (newItem / inventoryItems / storageItems).
        old_items: old items (only for 'single').
        result: message result field ('storage' only applies when OK_SEND_DATA).
    Returns True if the file was rewritten.
    """
    path = os.path.join(get_characters_dir(), f"{char_id}.json")
    if not os.path.isfile(path):
        return False
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception as exc:
        logger.warning("incremental: failed to read %s: %s", path, exc)
        return False
    if _base_of(payload) is None:
        return False

    if kind == "single":
        changed = apply_single_update(payload, old_items, items)
    elif kind in ("all", "info", "storage"):
        if kind == "storage" and result not in (None, 1):
            return False
        changed = apply_grouped_replace(payload, items)
    else:
        return False

    if not changed:
        return False
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
    except Exception as exc:
        logger.error("incremental: failed to write %s: %s", path, exc)
        return False
    logger.info("incremental: applied %s update to %s", kind, char_id)
    return True
