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
