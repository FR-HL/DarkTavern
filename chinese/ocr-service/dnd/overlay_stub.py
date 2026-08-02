from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)


class NullOverlaySession:
    """No-op overlay session.

    All methods swallow any positional/keyword arguments so callers written
    against the real SortOverlaySession (which uses keyword args like
    ``status=``) never raise a TypeError when the overlay is disabled.
    """
    finished: bool = True

    def wait_for_countdown(self, *args, **kwargs) -> bool:
        return True

    def update_status(self, *args, **kwargs) -> None:
        return None

    def add_log(self, *args, **kwargs) -> None:
        return None

    def finish(self, *args, **kwargs) -> None:
        return None

    def force_close(self, *args, **kwargs) -> None:
        return None

    def set_chip(self, *args, **kwargs) -> None:
        return None

    def update_sort_overview(self, *args, **kwargs) -> None:
        return None

    def update_progress(self, *args, **kwargs) -> None:
        return None


SortOverlaySession = NullOverlaySession


class _NullOverlayManager:
    enabled = False

    def begin_sort_session(self, countdown_seconds: float = 1.0, context: Optional[dict] = None) -> NullOverlaySession:
        return NullOverlaySession()

    def hide(self, **_kwargs) -> None:
        pass

    def show(self) -> None:
        pass


overlay_manager = _NullOverlayManager()


def register_overlay_logging() -> None:
    pass
