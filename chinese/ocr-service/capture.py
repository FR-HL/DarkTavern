"""
Screen capture module.
Uses mss for fast screen capture + win32gui for game window detection.
No DLL injection, pure screen capture.
"""

import ctypes
import ctypes.wintypes
import numpy as np

import mss
import win32gui
import win32con
import win32api



GAME_WINDOW_TITLE = "Dark and Darker  "


def find_game_window():
    """Find the game window by title."""
    hwnd = win32gui.FindWindow(None, GAME_WINDOW_TITLE)

    if not hwnd:
        # Try without trailing spaces
        hwnd = win32gui.FindWindow(None, "Dark and Darker")

    if not hwnd or not win32gui.IsWindowVisible(hwnd):
        return None

    return hwnd


def get_window_rect(hwnd):
    """Get window bounds."""
    try:
        rect = win32gui.GetWindowRect(hwnd)
        return {
            "x": rect[0],
            "y": rect[1],
            "width": rect[2] - rect[0],
            "height": rect[3] - rect[1],
        }
    except Exception:
        return None


def get_monitor_info(hwnd):
    """Get monitor info for the window."""
    try:
        monitor = win32api.MonitorFromWindow(hwnd, win32con.MONITOR_DEFAULTTONEAREST)
        info = win32api.GetMonitorInfo(monitor)
        work_area = info["Work"]
        return {
            "x": work_area[0],
            "y": work_area[1],
            "width": work_area[2] - work_area[0],
            "height": work_area[3] - work_area[1],
        }
    except Exception:
        return None


def capture_game_window():
    """
    Capture the game window region from screen.
    Returns numpy array (BGR format) or None.
    """
    hwnd = find_game_window()

    if not hwnd:
        return None, None

    bounds = get_window_rect(hwnd)

    if not bounds:
        return None, None

    with mss.mss() as sct:
        region = {
            "left": bounds["x"],
            "top": bounds["y"],
            "width": bounds["width"],
            "height": bounds["height"],
        }

        screenshot = sct.grab(region)

        # Convert to numpy array (BGRA)
        img = np.array(screenshot)

        # Convert BGRA to BGR
        if img.shape[2] == 4:
            img = img[:, :, :3]

        return img, bounds


def capture_region(x, y, width, height):
    """Capture a specific screen region. Returns BGR numpy array."""
    with mss.mss() as sct:
        region = {
            "left": x,
            "top": y,
            "width": width,
            "height": height,
        }

        screenshot = sct.grab(region)
        img = np.array(screenshot)

        if img.shape[2] == 4:
            img = img[:, :, :3]

        return img
