import logging
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional, List

logger = logging.getLogger(__name__)
router = APIRouter()


class SortStartRequest(BaseModel):
    character_id: str
    stash_id: str
    pack_mode: Optional[bool] = None
    stack_mode: Optional[bool] = None
    include_inventory: bool = False
    group_mode: Optional[str] = None


class CharacterOnlyRequest(BaseModel):
    character_id: str


class CrossSortRequest(BaseModel):
    character_id: str
    config: dict = {}


class SortGroupModeUpdate(BaseModel):
    mode: str = "none"


class SortOrderItem(BaseModel):
    field: str
    direction: str = "desc"


class SortOrderUpdate(BaseModel):
    order: List[SortOrderItem]


class SortSpeedUpdate(BaseModel):
    value: float


SPEED_PRESETS = {
    "slow": 0.4,
    "medium": 0.1,
    "instant": 0.0,
}


def _preset_for_value(value: float) -> str:
    if value <= 0.05:
        return "instant"
    if value <= 0.25:
        return "medium"
    return "slow"


@router.get("/speed")
def get_sort_speed():
    from dnd.settings import settings_manager
    value = float(settings_manager.get("sortSpeed", 0.1))
    return {"value": value, "preset": _preset_for_value(value)}


@router.post("/speed")
def update_sort_speed(body: SortSpeedUpdate):
    from dnd.settings import settings_manager
    value = max(0.0, float(body.value))
    settings_manager.update({"sortSpeed": value}, persist=True)
    return {"success": True, "value": value, "preset": _preset_for_value(value)}


@router.get("/uipi-status")
def sort_uipi_status():
    """Report whether Windows would block simulated mouse input.

    ``blocked`` is True when the game runs elevated (admin) while this
    tool does not — in that case the sorter's mouse moves are silently
    discarded by Windows and the sort appears to do nothing.
    """
    from dnd import uipi
    return uipi.check_uipi_status()


@router.post("/start")
def sort_start(body: SortStartRequest):
    from dnd import uipi
    from dnd.service import start_sort

    status = uipi.check_uipi_status()
    if status["blocked"]:
        return {
            "success": False,
            "error": (
                "检测到游戏以管理员权限运行，而 DarkTavern 不是管理员。"
                "Windows 会拦截鼠标模拟输入，整理将无效。"
                "请以管理员身份运行 DarkTavern（右键→以管理员身份运行），"
                "或取消游戏的管理员权限后重试。"
            ),
            "uipi": status,
        }

    return start_sort(
        character_id=body.character_id,
        stash_id=body.stash_id,
        pack_mode=body.pack_mode,
        stack_mode=body.stack_mode,
        include_inventory=body.include_inventory,
        group_mode=body.group_mode,
    )


@router.post("/sort-all")
def sort_all_start(body: CharacterOnlyRequest):
    from dnd import uipi
    from dnd.service import start_sort_all

    status = uipi.check_uipi_status()
    if status["blocked"]:
        return {
            "success": False,
            "error": (
                "检测到游戏以管理员权限运行，而 DarkTavern 不是管理员。"
                "Windows 会拦截鼠标模拟输入，整理将无效。"
                "请以管理员身份运行 DarkTavern（右键→以管理员身份运行），"
                "或取消游戏的管理员权限后重试。"
            ),
            "uipi": status,
        }
    return start_sort_all(character_id=body.character_id)


@router.post("/merge-stacks")
def merge_stacks_start(body: CharacterOnlyRequest):
    from dnd import uipi
    from dnd.service import start_merge_stacks

    status = uipi.check_uipi_status()
    if status["blocked"]:
        return {
            "success": False,
            "error": (
                "检测到游戏以管理员权限运行，而 DarkTavern 不是管理员。"
                "Windows 会拦截鼠标模拟输入，合并将无效。"
                "请以管理员身份运行 DarkTavern（右键→以管理员身份运行），"
                "或取消游戏的管理员权限后重试。"
            ),
            "uipi": status,
        }
    return start_merge_stacks(character_id=body.character_id)


@router.post("/cross")
def cross_sort_start(body: CrossSortRequest):
    from dnd import uipi
    from dnd.service import start_cross_sort

    status = uipi.check_uipi_status()
    if status["blocked"]:
        return {
            "success": False,
            "error": (
                "检测到游戏以管理员权限运行，而 DarkTavern 不是管理员。"
                "Windows 会拦截鼠标模拟输入，整理将无效。"
                "请以管理员身份运行 DarkTavern（右键→以管理员身份运行），"
                "或取消游戏的管理员权限后重试。"
            ),
            "uipi": status,
        }
    return start_cross_sort(character_id=body.character_id, config=body.config or {})


@router.post("/cancel")
def sort_cancel():
    from dnd.service import cancel_sort
    return cancel_sort()


@router.get("/status")
def sort_status():
    from dnd.service import get_sort_state
    state = get_sort_state()
    return {
        "running": state["running"],
        "kind": state.get("kind", "single"),
        "character_id": state["character_id"],
        "stash_id": state["stash_id"],
        "result": state["result"],
        "error": state["error"],
        "sort_all_total": state.get("sort_all_total", 0),
        "sort_all_current": state.get("sort_all_current", 0),
        "sort_all_label": state.get("sort_all_label", ""),
        "sort_all_results": state.get("sort_all_results", []),
        "cross_steps": state.get("cross_steps", []),
        "cross_step_index": state.get("cross_step_index", 0),
        "cross_step_label": state.get("cross_step_label", ""),
        "cross_results": state.get("cross_results", []),
    }


@router.get("/order")
def get_sort_order():
    from dnd.items.item import Item
    return {"order": Item.sort_order}


@router.get("/group-mode")
def get_sort_group_mode():
    from dnd.settings import settings_manager
    mode = str(settings_manager.get('sortGroupMode', 'none') or 'none')
    return {"mode": mode}


@router.post("/group-mode")
def update_sort_group_mode(body: SortGroupModeUpdate):
    from dnd.settings import settings_manager
    mode = body.mode if body.mode in ("none", "category", "sized", "neat") else "none"
    settings_manager.update({"sortGroupMode": mode}, persist=True)
    return {"success": True, "mode": mode}


@router.post("/order")
def update_sort_order(body: SortOrderUpdate):
    from dnd.items.item import Item
    from dnd.settings import settings_manager
    new_order = [{"field": o.field, "direction": o.direction} for o in body.order]
    normalized = Item.normalize_sort_order(new_order)
    Item.sort_order = Item.copy_sort_order(normalized)
    settings_manager.update({"stashSortOrder": normalized}, persist=True)
    return {"success": True, "order": normalized}


@router.get("/preview")
def sort_preview(character_id: str, stash_id: str):
    import json as _json
    from pathlib import Path as _Path
    from dnd.items.item import Item
    from dnd.sort.sorter import LayoutPlanner
    from dnd.stash.storage import Storage
    from dnd.settings import settings_manager
    from dnd.service import get_stash_manager
    from dnd.appdirs import get_base_path

    mgr = get_stash_manager()
    char = mgr.characters_cache.get(str(character_id))
    if not char:
        return {"error": "Character not found"}
    stash_raw = char.get('stashes', {}).get(str(stash_id))
    if stash_raw is None:
        return {"error": "Stash not found"}
    stash_obj = stash_raw if isinstance(stash_raw, list) else stash_raw.get('items', [])

    storage = Storage(int(stash_id), stash_obj)
    items = list(storage.pq)
    if not items:
        return {"items": [], "width": 0, "height": 0}

    en_to_cn: dict[str, str] = {}
    try:
        mapping_path = _Path(get_base_path()) / "chinese" / "mapping" / "items.json"
        with open(mapping_path, "r", encoding="utf-8") as f:
            cn_to_en = _json.load(f)
        en_to_cn = {v: k for k, v in cn_to_en.items()}
    except Exception:
        pass

    group_mode = str(settings_manager.get('sortGroupMode', 'none') or 'none')

    comparator = None
    if Item.sort_order:
        comparator = Item.build_sort_comparator(Item.sort_order)

    planner = LayoutPlanner(storage.width, storage.height, stash=storage)
    try:
        if group_mode == "sized":
            plan = planner.build_sized_groups(items, comparator=comparator)
        elif group_mode == "neat":
            plan = planner.build_neat_groups(items, comparator=comparator)
        elif group_mode == "category":
            plan = planner.build_grouped(items, comparator=comparator)
        else:
            plan = planner.build(items, comparator=comparator)
    except Exception:
        plan = planner.build(items)

    result = []
    for itm in items:
        pos = plan.positions.get(id(itm))
        if pos:
            cn_name = en_to_cn.get(itm.name, itm.name or "")
            result.append({
                "x": pos.x, "y": pos.y,
                "width": itm.width, "height": itm.height,
                "name": cn_name,
            })
    return {"items": result, "width": storage.width, "height": storage.height}
