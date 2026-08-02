"""Server-push events (WebSocket) for DnD Tools.

The packet parser runs on worker threads, so push helpers are thread-safe:
``broadcast()`` may be called from any thread; it schedules the actual send
on the uvicorn event loop (``main_loop``, set at startup via lifespan).
"""

import asyncio
import json
import logging

from fastapi import WebSocket

logger = logging.getLogger("darktavern-dnd")

main_loop: "asyncio.AbstractEventLoop | None" = None
_clients: "set[WebSocket]" = set()


async def _push(payload: dict) -> None:
    if not _clients:
        return
    raw = json.dumps(payload, ensure_ascii=False)
    dead = []
    for ws in list(_clients):
        try:
            await ws.send_text(raw)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _clients.discard(ws)


def broadcast(payload: dict) -> None:
    """Push an event to every connected client. Safe to call from any thread."""
    loop = main_loop
    if loop is None or loop.is_closed():
        return
    try:
        asyncio.run_coroutine_threadsafe(_push(payload), loop)
    except RuntimeError:
        logger.debug("broadcast: event loop not available, event dropped")


async def handle_socket(ws: WebSocket) -> None:
    """Serve a single WebSocket client. Messages from the client are ignored
    except as a way to detect disconnects."""
    await ws.accept()
    _clients.add(ws)
    try:
        while True:
            try:
                await ws.receive_text()
            except Exception:
                break
    finally:
        _clients.discard(ws)
