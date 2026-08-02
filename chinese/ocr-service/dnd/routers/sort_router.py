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


@router.post("/start")
def sort_start(body: SortStartRequest):
    from dnd.service import start_sort
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
