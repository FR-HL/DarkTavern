"""Npcap capture-driver health check.

tshark alone cannot capture: on Windows it needs the Npcap kernel driver.
When Npcap is missing, ``tshark -D`` exits with code 13
(WS_EXIT_PCAP_ERROR in Wireshark's ws_exit_codes.h) and every LiveCapture
attempt fails. This module detects that state so the UI can guide the user
to install Npcap instead of failing silently.

Detection follows the official Npcap developer guide:
- install-time: presence of ``%ProgramFiles%\\Npcap\\NPFInstall.exe``
- functional: ``tshark -D`` lists interfaces (exit 0, non-empty output)
"""

import logging
import os
import subprocess
import time
from typing import Optional

logger = logging.getLogger(__name__)

# WS_EXIT_NO_INTERFACES / WS_EXIT_PCAP_ERROR (Wireshark ws_exit_codes.h)
EXIT_NO_INTERFACES = 12
EXIT_PCAP_ERROR = 13

_OK_TTL = 300.0
_BAD_TTL = 30.0

_cache = {"result": None, "ts": 0.0, "tshark_path": None}


def _npcap_installed() -> bool:
    """Detect an existing Npcap install regardless of custom install dirs.

    Checks (per the official Npcap developer guide):
    - %ProgramFiles%\\Npcap\\NPFInstall.exe (documented install-time marker)
    - %SystemRoot%\\System32\\Npcap\\wpcap.dll (DLLs always land here)
    - HKLM\\SYSTEM\\CurrentControlSet\\Services\\npcap (driver service)
    """
    program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    markers = [
        os.path.join(program_files, "Npcap", "NPFInstall.exe"),
        os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "Npcap", "wpcap.dll"),
    ]
    for marker in markers:
        if os.path.isfile(marker):
            return True
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Services\npcap"):
            return True
    except OSError:
        pass
    except Exception as exc:
        logger.debug(f"npcap registry check failed: {exc}")
    return False


def _probe(tshark_path: Optional[str]) -> dict:
    installed = _npcap_installed()

    if not tshark_path:
        return {
            "ok": False,
            "installed": installed,
            "loopback": False,
            "exit_code": None,
            "detail": "未找到 TShark，无法抓包。请先安装 Wireshark 或在上方选择 tshark 路径。",
        }

    try:
        result = subprocess.run(
            [tshark_path, "-D"],
            capture_output=True, timeout=10,
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "installed": installed,
            "loopback": False,
            "exit_code": None,
            "detail": "抓包驱动响应超时。请重启电脑后重试；若仍失败，重新安装 Npcap。",
        }
    except Exception as exc:
        logger.debug(f"npcap probe failed: {exc}")
        return {
            "ok": False,
            "installed": installed,
            "loopback": False,
            "exit_code": None,
            "detail": "抓包驱动检测失败。请重启电脑后重试；若仍失败，重新安装 Npcap。",
        }

    stdout = (result.stdout or b"").decode("utf-8", errors="replace")
    if result.returncode == 0 and stdout.strip():
        loopback = "loopback" in stdout.lower()
        detail = ""
        if not loopback:
            detail = "未检测到回环抓包接口：Npcap 版本过旧，请重新安装最新版 Npcap（加速器场景需要）。"
        return {
            "ok": True,
            "installed": True,
            "loopback": loopback,
            "exit_code": 0,
            "detail": detail,
        }

    if result.returncode in (EXIT_NO_INTERFACES, EXIT_PCAP_ERROR) or not stdout.strip():
        if installed:
            detail = "Npcap 已安装但驱动未正常工作。请重启电脑后重试；若仍失败，重新安装 Npcap。"
        else:
            detail = "未检测到抓包驱动（Npcap），抓包功能不可用。请下载安装 Npcap，安装完成后点「重新检测」。"
        return {
            "ok": False,
            "installed": installed,
            "loopback": False,
            "exit_code": result.returncode,
            "detail": detail,
        }

    stderr = (result.stderr or b"").decode("utf-8", errors="replace").strip()
    logger.warning(f"Unexpected tshark -D result: exit={result.returncode} stderr={stderr[:300]}")
    return {
        "ok": False,
        "installed": installed,
        "loopback": False,
        "exit_code": result.returncode,
        "detail": "抓包驱动检测异常。请重启电脑后重试；若仍失败，重新安装 Npcap。",
    }


def check_npcap(tshark_path: Optional[str], force: bool = False) -> dict:
    """Return Npcap driver health, cached to avoid spawning tshark on every poll."""
    now = time.time()
    cached = _cache["result"]
    if cached is not None and not force and _cache["tshark_path"] == tshark_path:
        ttl = _OK_TTL if cached.get("ok") else _BAD_TTL
        if now - _cache["ts"] < ttl:
            return cached

    result = _probe(tshark_path)
    _cache["result"] = result
    _cache["ts"] = now
    _cache["tshark_path"] = tshark_path
    if not result["ok"]:
        logger.warning(f"Npcap check failed: exit={result['exit_code']} installed={result['installed']}")
    return result
