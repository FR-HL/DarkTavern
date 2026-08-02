from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)


class NullOverlaySession:
    finished: bool = True

    def wait_for_countdown(self) -> bool:
        return True

    def update_status(self, _subtitle: str, _status: str = "info") -> None:
        return None

    def add_log(self, _message: str) -> None:
        return None

    def finish(self, _success: bool = True, _message: Optional[str] = None) -> None:
        return None

    def force_close(self) -> None:
        return None

    def set_chip(
        self,
        _key: str,
        *,
        label: str,
        value: str,
        detail: str = "",
        status: str = "info",
        refresh: bool = True,
    ) -> None:
        return None

    def update_sort_overview(self, **_kwargs) -> None:
        return None

    def update_progress(self, _processed: int, _total: int) -> None:
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
