"""UIPI (User Interface Privilege Isolation) detection.

Windows silently drops simulated input (SendInput / mouse_event) that is
injected from a *non-elevated* process into an *elevated* (admin) window.
If the game runs as administrator while Adventurer's Squire runs normally, the
sorter's mouse moves will appear to do nothing.  This module detects that
condition so the UI can warn the user.

Detection is purely read-only (process enumeration + token elevation
queries); it never modifies or elevates anything.
"""

import logging
import ctypes
from ctypes import wintypes
from typing import Optional

import psutil

logger = logging.getLogger(__name__)

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TOKEN_QUERY = 0x0008
TokenElevation = 20

GAME_PROCESS_NAMES = ("DungeonCrawler", "DarkandDarker")


def _process_elevated(pid: int) -> Optional[bool]:
    """Return True if the process token is elevated, False if not, None if unknown."""
    try:
        kernel32 = ctypes.windll.kernel32
        advapi32 = ctypes.windll.advapi32

        h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not h:
            return None
        try:
            h_token = wintypes.HANDLE()
            if not advapi32.OpenProcessToken(h, TOKEN_QUERY, ctypes.byref(h_token)):
                return None
            try:
                class DWORD(ctypes.Structure):
                    _fields_ = [("v", ctypes.c_ulong)]

                d = DWORD()
                size = wintypes.DWORD()
                ok = advapi32.GetTokenInformation(
                    h_token, TokenElevation, ctypes.byref(d),
                    ctypes.sizeof(d), ctypes.byref(size),
                )
                if not ok:
                    return None
                return bool(d.v)
            finally:
                kernel32.CloseHandle(h_token)
        finally:
            kernel32.CloseHandle(h)
    except Exception:
        return None


def game_running_elevated() -> bool:
    """True if a running game process is elevated (admin)."""
    for proc in psutil.process_iter(["name"]):
        try:
            name = proc.info.get("name") or ""
            if any(name.lower().startswith(g.lower()) for g in GAME_PROCESS_NAMES):
                elevated = _process_elevated(proc.pid)
                if elevated:
                    return True
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return False


def tool_running_elevated() -> bool:
    """True if the current (OCR service) process is elevated."""
    return _process_elevated(ctypes.windll.kernel32.GetCurrentProcessId()) is True


def check_uipi_status() -> dict:
    """Return the UIPI situation for the frontend.

    ``blocked`` is True when simulated input from this tool would be
    discarded by Windows (game elevated, tool not elevated).
    """
    game = game_running_elevated()
    tool = tool_running_elevated()
    return {
        "game_elevated": game,
        "tool_elevated": tool,
        "blocked": game and not tool,
    }
