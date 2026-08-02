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


class SortOrderItem(BaseModel):
    field: str
    direction: str = "desc"


class SortOrderUpdate(BaseModel):
    order: List[SortOrderItem]


class SortSpeedUpdate(BaseModel):
    value: float


SPEED_PRESETS = {
    "slow": 0.4,
    "medium": 0.2,
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
    value = float(settings_manager.get("sortSpeed", 0.2))
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
    )


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
        "character_id": state["character_id"],
        "stash_id": state["stash_id"],
        "result": state["result"],
        "error": state["error"],
    }


@router.get("/order")
def get_sort_order():
    from dnd.items.item import Item
    return {"order": Item.sort_order}


@router.post("/order")
def update_sort_order(body: SortOrderUpdate):
    from dnd.items.item import Item
    from dnd.settings import settings_manager
    new_order = [{"field": o.field, "direction": o.direction} for o in body.order]
    normalized = Item.normalize_sort_order(new_order)
    Item.sort_order = Item.copy_sort_order(normalized)
    settings_manager.update({"stashSortOrder": normalized}, persist=True)
    return {"success": True, "order": normalized}
