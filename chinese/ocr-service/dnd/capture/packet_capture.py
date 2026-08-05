import os
import sys
import subprocess
import asyncio
import tempfile
import glob
import logging
import socket
import psutil
import struct
import json
import threading
import time
import importlib
from datetime import datetime
from typing import Tuple, Optional, List, Dict, Any, Set
from concurrent.futures import TimeoutError as FutureTimeout
from collections import deque
from google.protobuf.json_format import MessageToDict

import pyshark

from dnd.appdirs import get_capture_state_file, is_frozen
from dnd.settings import settings_manager, resolve_tshark_executable
from dnd.capture.capture_utils import patch_asyncio, patch_pyshark, finalize_asyncio_subprocess
from dnd.capture.memory_guard import MemoryGuard

# Apply patches
patch_asyncio()
patch_pyshark()

logger = logging.getLogger(__name__)

# Determine paths
current_dir = os.path.dirname(os.path.abspath(__file__))
dnd_root = os.path.abspath(os.path.join(current_dir, ".."))
protos_path = os.path.join(dnd_root, "protos")

# Ensure the protos path is on sys.path
if protos_path not in sys.path:
    sys.path.insert(0, protos_path)

# Dynamically load protos
# ─── Proto loading & automatic mapping ───────────────────────────────────────
# Loads all *_pb2.py modules, injects their public symbols into globals(),
# then builds PROTO_MAP — a Dict[int, type] that maps every PacketCommand
# enum value to its protobuf message class.  This eliminates per-packet
# name guessing and gives O(1) lookups at capture time.

def _load_protos():
    loaded_protos = {}
    if not os.path.exists(protos_path):
        logger.warning(f"Protos path not found: {protos_path}")
        return loaded_protos

    for filename in os.listdir(protos_path):
        if not filename.endswith("_pb2.py"):
            continue

        module_name = filename[:-3]
        full_name = f"dnd.protos.{module_name}"
        file_path = os.path.join(protos_path, filename)

        try:
            spec = importlib.util.spec_from_file_location(full_name, file_path)
            if spec and spec.loader:
                module = importlib.util.module_from_spec(spec)
                sys.modules[full_name] = module
                spec.loader.exec_module(module)

                # Bring public names into globals() — other code may rely on this
                for attr in dir(module):
                    if not attr.startswith("_"):
                        globals()[attr] = getattr(module, attr)
                        loaded_protos[attr] = getattr(module, attr)
        except Exception as e:
            logger.error(f"Failed to load proto {filename}: {e}")
    return loaded_protos

_loaded_proto_symbols = _load_protos()

# Import PacketCommand after dynamic loading
try:
    from dnd.protos import _PacketCommand_pb2
except ImportError:
    # Frozen (PyInstaller) builds may not resolve the dnd.protos package from
    # the PYZ archive; the dynamic loader above already registered every
    # *_pb2 module in sys.modules, so fall back to that first.
    _PacketCommand_pb2 = sys.modules.get('dnd.protos._PacketCommand_pb2')
    if _PacketCommand_pb2 is None:
        logger.error("Could not import _PacketCommand_pb2. Ensure protos are generated and path is correct.")


def _build_proto_map() -> Dict[int, Any]:
    """Build a mapping of PacketCommand int → protobuf message class.

    Iterates every value in the PacketCommand enum and attempts to match it
    to a loaded proto class using the standard naming conventions:
      1. "S" + command_name  (e.g. S2C_ALIVE_RES → SS2C_ALIVE_RES)
      2. command_name as-is  (fallback)

    Only classes that have a ``ParseFromString`` method (i.e. real protobuf
    messages) are included.
    """
    proto_map: Dict[int, Any] = {}
    if not _PacketCommand_pb2:
        return proto_map

    g = globals()
    skipped_prefixes = ('MIN_', 'MAX_', 'PACKET_NONE')
    mapped = 0
    unmapped_names: List[str] = []

    for value in _PacketCommand_pb2.PacketCommand.values():
        try:
            name = _PacketCommand_pb2.PacketCommand.Name(value)
        except (ValueError, KeyError):
            continue
        if name.startswith(skipped_prefixes):
            continue

        # Try naming candidates
        for candidate in ("S" + name, name):
            cls = g.get(candidate)
            if cls is not None and callable(getattr(cls, 'ParseFromString', None)):
                proto_map[value] = cls
                mapped += 1
                break
        else:
            unmapped_names.append(name)

    total = mapped + len(unmapped_names)
    logger.info(
        f"Proto map built: {mapped}/{total} packet types have proto classes "
        f"({len(unmapped_names)} unmapped)"
    )
    if unmapped_names:
        logger.debug(f"Unmapped packet types: {', '.join(sorted(unmapped_names))}")

    return proto_map


# Module-level map — built once at import time
PROTO_MAP: Dict[int, Any] = _build_proto_map()

# Configure subprocess to hide console windows when in executable mode
if is_frozen():
    original_popen = subprocess.Popen
    
    def hidden_popen(*args, **kwargs):
        if os.name == 'nt':
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0  # SW_HIDE
            kwargs['startupinfo'] = startupinfo
        return original_popen(*args, **kwargs)
    
    subprocess.Popen = hidden_popen


def _format_hexdump(data: bytes, width: int = 16) -> List[str]:
    lines: List[str] = []
    if width <= 0:
        width = 16

    for offset in range(0, len(data), width):
        chunk = data[offset:offset + width]
        hex_bytes = ' '.join(f"{byte:02X}" for byte in chunk)
        ascii_repr = ''.join(chr(byte) if 32 <= byte <= 126 else '.' for byte in chunk)
        pad = (width - len(chunk)) * 3
        lines.append(f"{offset:04X}  {hex_bytes}{' ' * pad}  {ascii_repr}")

    return lines

def _read_positive_float_env(var_name: str, default: float) -> float:
    raw_value = os.environ.get(var_name)
    if raw_value is None:
        return default
    try:
        value = float(raw_value)
    except (TypeError, ValueError):
        return default
    if value <= 0:
        return default
    return value


GAME_PROCESS_NAMES = ("DungeonCrawler.exe", "DarkAndDarker.exe")


def is_game_process(process_name: Optional[str]) -> bool:
    """Case-insensitive game process name match (tolerates .exe / variants)."""
    if not process_name:
        return False
    name = process_name.lower()
    for game in GAME_PROCESS_NAMES:
        base = game.lower()
        if base.endswith(".exe"):
            base = base[:-4]
        if name == base or name == base + ".exe" or name.startswith(base):
            return True
    return False


def detect_game_proxy_port(retries: int = 2) -> Optional[int]:
    """Detect a game accelerator's local proxy port.

    When the game routes through a local accelerator (e.g. GIAcceler), the game
    process opens ESTABLISHED TCP connections to 127.0.0.1:<proxy_port>. The
    game's plaintext protocol packets flow over the loopback interface to that
    proxy port, so capturing there (instead of a physical NIC) yields the data.

    Returns the proxy port (most common one if several), or None when the game
    is not running or has no loopback connection (i.e. a direct connection).
    Retries a few times to ride out transient connection states.
    """
    from collections import Counter
    for _ in range(max(1, retries + 1)):
        proxy_ports: Counter = Counter()
        try:
            for proc in psutil.process_iter(['name']):
                try:
                    if not is_game_process(proc.info.get('name')):
                        continue
                    conn_fn = getattr(proc, 'net_connections', None) or proc.connections
                    for conn in conn_fn(kind='tcp'):
                        raddr = getattr(conn, 'raddr', None)
                        status = getattr(conn, 'status', None)
                        if not raddr or raddr[0] != '127.0.0.1':
                            continue
                        # Count active/established connections; ignore listener
                        # sockets and fully-closed ones (transient states like
                        # SYN_SENT still indicate an accelerator in use).
                        if status in ('LISTEN', 'CLOSED', 'CLOSE_WAIT', 'LAST_ACK'):
                            continue
                        proxy_ports[raddr[1]] += 1
                except (psutil.Error, OSError):
                    continue
        except Exception as exc:
            logger.debug(f"Game proxy port detection failed: {exc}")
            return None

        if proxy_ports:
            return proxy_ports.most_common(1)[0][0]
        time.sleep(1.0)
    return None


def detect_game_capture_point(exclude_proxy_port: Optional[int] = None):
    """Locate where the game's plaintext traffic actually flows.

    Returns a tuple ``(mode, interface, display_filter, proxy_port)``:
      * ("accelerator", iface, "tcp.port == <proxy>", proxy) — local proxy: either
        loopback (127.0.0.1) or a proxy listening on one of the machine's NIC IPs
        (common for TUN-style accelerators)
      * ("direct", iface, "tcp.port >= lo and tcp.port <= hi", None) — NIC derived
        from the game's real connections (physical or virtual adapters)
      * (None, None, None, None) — game not running / connections unreadable

    ``exclude_proxy_port`` lets callers retry after a candidate proxy port
    failed its traffic probe (avoids looping on the same misdetection).
    """
    try:
        local_ips = set()
        for _, addrs in psutil.net_if_addrs().items():
            for addr in addrs:
                if addr.family == socket.AF_INET:
                    local_ips.add(addr.address)
    except Exception:
        local_ips = {'127.0.0.1'}
    logger.info(f"[capture-detect] 本机 IPv4: {sorted(local_ips)}")

    game_conns = []          # (laddr_ip, laddr_port, raddr_ip, raddr_port, status)
    proxy_ports: set = set()
    try:
        for proc in psutil.process_iter(['name']):
            try:
                if not is_game_process(proc.info.get('name')):
                    continue
                logger.info(f"[capture-detect] 游戏进程: {proc.info.get('name')} PID={proc.pid}")
                conn_fn = getattr(proc, 'net_connections', None) or proc.connections
                for conn in conn_fn(kind='tcp'):
                    laddr = getattr(conn, 'laddr', None)
                    raddr = getattr(conn, 'raddr', None)
                    status = getattr(conn, 'status', None)
                    if status in ('LISTEN', 'CLOSED', 'CLOSE_WAIT', 'LAST_ACK'):
                        continue
                    if not laddr or not raddr:
                        continue
                    game_conns.append((laddr[0], laddr[1], raddr[0], raddr[1], status))
                    logger.info(
                        f"[capture-detect] 连接 {laddr[0]}:{laddr[1]} -> {raddr[0]}:{raddr[1]} ({status})"
                    )
                    # A connection to a *local* address means a local proxy
                    # (accelerator) sits in front of the game. This includes
                    # NIC IPs: same-machine traffic never hits the physical
                    # NIC, it loops back internally, so capture on loopback.
                    if raddr[0] == '127.0.0.1' or raddr[0] in local_ips:
                        proxy_ports.add(raddr[1])
                        logger.info(f"[capture-detect] 判定本地代理端口: {raddr[0]}:{raddr[1]}")
            except (psutil.Error, OSError):
                continue
    except Exception as exc:
        logger.debug(f"Game capture point detection failed: {exc}")
        return None, None, None, None

    if not game_conns:
        logger.info("[capture-detect] 未找到游戏活跃 TCP 连接")
        return None, None, None, None

    if exclude_proxy_port:
        proxy_ports -= set(exclude_proxy_port) if isinstance(exclude_proxy_port, (list, set, tuple)) else {exclude_proxy_port}

    # Local proxy accelerator wins: capture the game<->proxy traffic on the
    # loopback interface (same-machine traffic is invisible on the NIC).
    if proxy_ports:
        f = ' or '.join(f'tcp.port == {p}' for p in sorted(proxy_ports))
        logger.info(f"[capture-detect] 采用加速器模式: loopback, 代理端口 {sorted(proxy_ports)}")
        return 'accelerator', None, f, sorted(proxy_ports)

    # Direct / virtual-NIC mode: derive the interface from the game's local IPs
    # and the port range from the actual local ports in use.
    local_ports = sorted({p for _, p, _, _, _ in game_conns})
    local_ips_used = {ip for ip, _, _, _, _ in game_conns}
    if not local_ports:
        return None, None, None, None

    iface = _find_interface_for_ips(local_ips_used)
    lo, hi = local_ports[0], local_ports[-1]
    logger.info(f"[capture-detect] 采用直连模式: iface={iface}, 端口范围 {lo}-{hi}")
    return 'direct', iface, f'tcp.port >= {lo} and tcp.port <= {hi}', None


def _find_interface_for_ips(ips: set) -> Optional[str]:
    """Return the interface that owns one of the given IPv4 addresses."""
    try:
        for iface, addrs in psutil.net_if_addrs().items():
            for addr in addrs:
                if addr.family == socket.AF_INET and addr.address in ips:
                    return iface
    except Exception as exc:
        logger.debug(f"Interface lookup failed: {exc}")
    return None


def find_loopback_interface(tshark_path: Optional[str]) -> str:
    """Find the Npcap loopback capture interface name via ``tshark -D``."""
    import re
    fallback = "Adapter for loopback traffic capture"
    if not tshark_path:
        return fallback
    try:
        result = subprocess.run(
            [tshark_path, '-D'],
            capture_output=True, timeout=10,
        )
        stdout = (result.stdout or b'').decode('utf-8', errors='replace')
        for line in stdout.splitlines():
            if 'loopback' not in line.lower():
                continue
            match = re.search(r'\((.*)\)', line)
            if match:
                return match.group(1)
            parts = line.strip().split()
            if parts:
                return parts[-1]
    except Exception as exc:
        logger.debug(f"Loopback interface detection failed: {exc}")
    return fallback


def probe_interface_port(tshark_path: Optional[str], iface: Optional[str], display_filter: str, timeout: float = 8.0) -> bool:
    """Verify a candidate proxy filter actually carries traffic on an interface.

    Some local connections (anti-cheat, game helpers) look like a proxy but
    carry no game traffic; capturing there would silently yield nothing.
    Returns True only when at least one packet matching the filter is seen.

    Note: tshark exits 0 even on -a duration timeout with zero packets, so
    success is judged by non-empty stdout (frame numbers), not exit code.
    """
    if not tshark_path:
        return False
    if not iface:
        iface = find_loopback_interface(tshark_path)
    try:
        result = subprocess.run(
            [tshark_path, '-i', iface,
             '-Y', display_filter,
             '-T', 'fields', '-e', 'frame.number',
             '-c', '1', '-a', f'duration:{int(timeout)}'],
            capture_output=True, timeout=timeout + 10,
        )
        return bool((result.stdout or b'').strip())
    except Exception as exc:
        logger.debug(f"Interface probe failed: {exc}")
        return False


# Backward-compatible alias
def probe_loopback_port(tshark_path: Optional[str], proxy_port: int, timeout: float = 8.0) -> bool:
    return probe_interface_port(tshark_path, None, f'tcp.port == {proxy_port}', timeout)


class _StreamState:
    """Per-TCP-stream reassembly buffer for the game's length-framed protocol.

    The game opens several TCP connections to the (accelerator) server. Each is
    an independent byte stream, so they must be reassembled separately — mixing
    their bytes into one buffer corrupts the length framing.
    """
    __slots__ = ("data", "expected_length", "expected_proto")

    def __init__(self):
        self.data = b""
        self.expected_length = None
        self.expected_proto = None


class PacketCapture:
    DEFAULT_TSHARK_MEMORY_LIMIT_MB = 500.0
    DEFAULT_TSHARK_MEMORY_CHECK_SEC = 15.0
    DEFAULT_TSHARK_MEMORY_RESTART_COOLDOWN_SEC = 120.0

    def __init__(self, interface: str = 'Ethernet', port_range: Tuple[int, int] = (20200, 20300), wireshark_path: Optional[str] = None):
        self.interface = interface
        self.port_range = port_range
        self.packet_data = b""
        self.logger = logging.getLogger(__name__)
        self.MAX_BUFFER_SIZE = 1024 * 1024  # 1MB
        self.expected_packet_length = None
        self.expected_proto_type = None
        # Per-TCP-stream reassembly buffers (keyed by tshark stream index).
        self._streams: Dict[Any, _StreamState] = {}
        self.running = False
        self.capture_thread: Optional[threading.Thread] = None
        self._cleanup_capture_on_exit = False
        self.capture_info: Dict[int, Any] = {}
        self._state_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._cleanup_lock = threading.Lock()
        self._cleanup_complete = threading.Event()
        self._cleanup_complete.set()
        self.STATE_FILE = get_capture_state_file()
        self.tshark_path = resolve_tshark_executable(wireshark_path) or resolve_tshark_executable(settings_manager.get('wiresharkPath'))
        self._apply_tshark_environment()
        self._user_requested_stop = False
        self._force_closing = False
        self._mode_recheck = False
        self._last_packet_ts = 0.0

        # Accelerator-aware capture state (set when capture_loop starts)
        self.capture_mode = None       # None until first capture session; then "direct"/"accelerator"
        self.active_proxy_port: Optional[int] = None
        
        # Memory Guard
        self._memory_guard: Optional[MemoryGuard] = None
        self._memory_guard_last_restart: float = 0.0
        self._memory_guard_restart_cooldown: float = self.DEFAULT_TSHARK_MEMORY_RESTART_COOLDOWN_SEC

        # Packet viewer storage
        self.captured_packets = deque(maxlen=1000)
        # Monotonic packet id counter for stable UI keys
        self._packet_id_counter = 0
        
        # Restore state
        self.saved_state = self._restore_state()
        self.was_running_before = self.saved_state.get('running', False)
        
        if self.was_running_before:
            self.logger.info("Previous session had capture running - restoring state")
            threading.Timer(0.1, self._delayed_start).start()
        else:
            self.logger.info("Previous session had capture stopped")

    def _delayed_start(self):
        self.start_capture_switch()

    def _apply_tshark_environment(self):
        if not self.tshark_path:
            return
        try:
            os.environ['PYSHARK_TSHARK_PATH'] = self.tshark_path
            bin_dir = os.path.dirname(self.tshark_path)
            if bin_dir and os.path.isdir(bin_dir):
                current_path = os.environ.get('PATH', '')
                segments = current_path.split(os.pathsep) if current_path else []
                if bin_dir not in segments:
                    os.environ['PATH'] = os.pathsep.join([bin_dir] + segments) if segments else bin_dir
        except Exception as exc:
            self.logger.debug(f"Failed to update environment for tshark: {exc}")

    def set_wireshark_path(self, wireshark_path: Optional[str]) -> bool:
        resolved = resolve_tshark_executable(wireshark_path)
        if resolved == self.tshark_path:
            return False
        self.tshark_path = resolved
        if self.tshark_path:
            self.logger.info(f"Using tshark at: {self.tshark_path}")
        else:
            self.logger.warning("Cleared custom tshark path; relying on system PATH")
        self._apply_tshark_environment()
        return True

    def _init_memory_guard(self):
        threshold_mb = _read_positive_float_env("DND_TSHARK_MEMORY_LIMIT_MB", self.DEFAULT_TSHARK_MEMORY_LIMIT_MB)
        check_interval = max(5.0, _read_positive_float_env("DND_TSHARK_MEMORY_CHECK_SEC", self.DEFAULT_TSHARK_MEMORY_CHECK_SEC))
        self._memory_guard_restart_cooldown = max(60.0, _read_positive_float_env("DND_TSHARK_MEMORY_RESTART_COOLDOWN_SEC", self.DEFAULT_TSHARK_MEMORY_RESTART_COOLDOWN_SEC))
        
        self._memory_guard = MemoryGuard(
            threshold_mb=threshold_mb,
            check_interval=check_interval,
            on_threshold_exceeded=self._on_memory_threshold_exceeded
        )

    def _start_memory_guard(self):
        if not self._memory_guard:
            self._init_memory_guard()
        if self._memory_guard:
            self._memory_guard.start()

    def _stop_memory_guard(self):
        if self._memory_guard:
            self._memory_guard.stop()

    def _on_memory_threshold_exceeded(self):
        # This runs in the MemoryGuard thread
        now = time.time()
        if now - self._memory_guard_last_restart < self._memory_guard_restart_cooldown:
            return

        self._memory_guard_last_restart = now
        self.logger.warning("Restarting capture due to memory threshold exceeded.")
        
        threading.Thread(
            target=self._restart_capture_due_to_memory,
            name="TsharkMemoryGuardRestart",
            daemon=True,
        ).start()

    def _restart_capture_due_to_memory(self):
        with self._state_lock:
            should_restart = self.running or (self.capture_thread is not None and self.capture_thread.is_alive())

        if not should_restart:
            return

        if self._user_requested_stop or self._force_closing:
            return

        try:
            self.stop_capture_switch(persist_running_state=True)
            time.sleep(1.0)
            self.start_capture_switch()
        except Exception as exc:
            self.logger.error(f"Failed to restart capture after memory guard stop: {exc}", exc_info=True)

    def should_auto_start(self):
        return self.was_running_before

    def parse_proto(self, packet_data, proto_type):
        """Deserialize a packet's payload using the pre-built PROTO_MAP."""
        message_class = PROTO_MAP.get(proto_type)
        if message_class is None:
            return None

        data = packet_data[8:]
        try:
            message = message_class()
            message.ParseFromString(data)
            return message
        except Exception as e:
            try:
                name = _PacketCommand_pb2.PacketCommand.Name(proto_type)
            except (ValueError, KeyError):
                name = str(proto_type)
            self.logger.debug(f"Failed to parse {name} via {message_class.__name__}: {e}")
            return None

    def get_local_ip(self) -> Optional[str]:
        for interface, addrs in psutil.net_if_addrs().items():
            if interface == self.interface:
                for addr in addrs:
                    if addr.family == socket.AF_INET:
                        return addr.address
        return None

    def validate_packet_header(self, length: int, proto_type: int, padding: int) -> bool:
        if not _PacketCommand_pb2:
            return False
        valid_packet_range = (8, 2 * 1024 * 1024)
        return (
            valid_packet_range[0] <= length <= valid_packet_range[1] and
            proto_type in _PacketCommand_pb2.PacketCommand.values() and 
            padding in [0, 256]
        )

    def process_packet(self, data: bytes, stream_key: Any = None) -> Optional[bool]:
        if len(data) == 0:
            return False

        if stream_key is None:
            stream_key = "default"
        st = self._streams.get(stream_key)
        if st is None:
            # Bound tracked streams: the game uses only a few connections, so a
            # large count means stale entries from closed connections — clear them.
            if len(self._streams) >= 64:
                self._streams.clear()
            st = _StreamState()
            self._streams[stream_key] = st

        st.data += data

        # Loop to process all complete game packets in this stream's buffer.
        # A single TCP segment may contain multiple back-to-back game packets.
        max_iterations = 50  # safety limit
        iterations = 0
        while iterations < max_iterations:
            iterations += 1
            current_size = len(st.data)

            if current_size == 0:
                break

            if current_size > self.MAX_BUFFER_SIZE:
                self.logger.warning(f"Stream {stream_key} buffer exceeded max size ({self.MAX_BUFFER_SIZE} bytes)")
                self._reset_stream(st)
                return False

            # Parse header if we haven't yet for this game packet
            if st.expected_length is None and current_size >= 8:
                try:
                    packet_length, proto_type, random_padding = struct.unpack('<IHH', st.data[:8])

                    packet_type_name = "Unknown"
                    if _PacketCommand_pb2 and proto_type in _PacketCommand_pb2._PACKETCOMMAND.values_by_number:
                        packet_type_name = _PacketCommand_pb2._PACKETCOMMAND.values_by_number[proto_type].name

                    if not self.validate_packet_header(packet_length, proto_type, random_padding):
                        self.logger.debug(f"Invalid packet on stream {stream_key}: {packet_type_name} (Type={proto_type}, Length={packet_length}, Padding={random_padding})")
                        self._reset_stream(st)
                        return False

                    self.logger.info(f"New packet: {packet_type_name} (Type={proto_type}, Length={packet_length}, Padding={random_padding})")

                    st.expected_length = packet_length
                    st.expected_proto = proto_type
                except struct.error:
                    self._reset_stream(st)
                    return False

            if st.expected_length and st.expected_proto:
                if current_size >= st.expected_length:
                    # We have enough data — extract this packet and keep the overflow
                    complete_packet = st.data[:st.expected_length]
                    overflow = st.data[st.expected_length:]

                    if current_size > st.expected_length:
                        self.logger.info(f"Splitting segment: {current_size} bytes = {st.expected_length} (packet) + {len(overflow)} (overflow)")

                    self.handle_packet(complete_packet, st.expected_proto)

                    # Reset state and continue with overflow data
                    st.expected_length = None
                    st.expected_proto = None
                    st.data = overflow
                    # Continue the loop to process overflow data
                    continue
                else:
                    # Need more data — wait for next TCP segment
                    if current_size % 8192 == 0:
                        self.logger.info(f"Accumulating: {current_size}/{st.expected_length}")
                    break
            else:
                # Need more data to parse the header
                break

        return False

    def reset_state(self) -> None:
        """Clear all per-stream reassembly buffers (and legacy attributes)."""
        self._streams.clear()
        self.packet_data = b""
        self.expected_packet_length = None
        self.expected_proto_type = None

    @staticmethod
    def _reset_stream(st: "_StreamState") -> None:
        st.data = b""
        st.expected_length = None
        st.expected_proto = None

    def _collect_capture_processes(self) -> List[psutil.Process]:
        try:
            parent = psutil.Process(os.getpid())
        except (psutil.Error, OSError) as err:
            self.logger.debug(f"Unable to inspect child processes: {err}")
            return []

        targets: List[psutil.Process] = []
        for child in parent.children(recursive=True):
            try:
                name = child.name().lower()
            except (psutil.Error, OSError):
                continue

            if 'tshark' in name or 'dumpcap' in name:
                targets.append(child)
        return targets

    def get_active_helper_pids(self) -> Set[int]:
        """Return the PIDs of any tshark/dumpcap helpers this process spawned."""
        return {proc.pid for proc in self._collect_capture_processes() if proc and proc.pid}

    def _terminate_capture_processes(self, timeout: float = 3.0) -> None:
        targets = self._collect_capture_processes()
        if not targets:
            return

        self.logger.info(f"Terminating {len(targets)} capture helper process(es)")

        for proc in targets:
            try:
                proc.terminate()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

        deadline = time.time() + timeout
        for proc in targets:
            remaining = max(0.0, deadline - time.time())
            try:
                proc.wait(timeout=remaining if remaining > 0 else 0.1)
            except (psutil.TimeoutExpired, psutil.NoSuchProcess):
                try:
                    proc.kill()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass

    def _save_state(self, running: bool):
        try:
            state = {
                "running": running,
                "timestamp": datetime.now().isoformat(),
                "interface": self.interface,
                "port_range": self.port_range
            }
            with open(self.STATE_FILE, "w") as f:
                json.dump(state, f, indent=2)
            self.logger.info(f"Saved capture state: running={running}")
        except Exception as e:
            self.logger.error(f"Failed to save capture state: {e}")

    def _restore_state(self) -> dict:
        try:
            if os.path.exists(self.STATE_FILE):
                with open(self.STATE_FILE, "r") as f:
                    state = json.load(f)
                    return state
            return {"running": False}
        except Exception as e:
            self.logger.error(f"Failed to restore capture state: {e}")
            return {"running": False}

    def capture_loop(self) -> None:
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            while not self._stop_event.is_set():
                self._mode_recheck = False
                self._last_packet_ts = time.time()
                self.logger.info("Initializing capture session")

                # Locate where the game's plaintext traffic flows. Priority:
                # 1. local proxy accelerator (loopback or NIC-bound, all of
                #    which live on the loopback path), verified to actually
                #    carry traffic
                # 2. NIC derived from the game's real connections (physical or
                #    virtual/TUN adapters) with the actual ports in use
                # 3. configured interface + default port range (fallback)
                mode, capture_iface, display_filter, proxy_ports = detect_game_capture_point()
                if mode == 'accelerator' and proxy_ports:
                    iface = capture_iface or find_loopback_interface(self.tshark_path)
                    # Same-machine ESTABLISHED connections to a local port are
                    # strong evidence of a proxy. The probe can miss when the
                    # game is idle (no packets within its window), so a failed
                    # probe only logs — we still adopt the loopback capture.
                    # The 60s no-traffic re-check covers genuine misdetections.
                    if not probe_interface_port(self.tshark_path, iface, display_filter):
                        self.logger.warning(
                            f"Proxy ports {sorted(proxy_ports)} temporarily idle (no packets seen), still using loopback capture"
                        )
                    self.capture_mode = 'accelerator'
                    self.active_proxy_port = set(proxy_ports) if isinstance(proxy_ports, (list, set, tuple)) else {proxy_ports}
                    capture_iface = iface
                    self.logger.info(
                        f"Accelerator detected — capturing '{capture_iface}', proxy ports {sorted(self.active_proxy_port)}"
                    )
                    self.logger.info(f"Display filter: {display_filter}")
                elif mode == 'direct' and capture_iface:
                    self.capture_mode = 'direct'
                    self.active_proxy_port = None
                    self.logger.info(f"Starting capture on interface: {capture_iface} (from game connections)")
                    self.logger.info(f"Display filter: {display_filter}")
                else:
                    self.capture_mode = 'direct'
                    self.active_proxy_port = None
                    capture_iface = self.interface
                    local_ip = self.get_local_ip()
                    if not local_ip:
                        self.logger.error(f"Could not find IP address for interface {self.interface}")
                        break
                    # Match both directions: game->server (ip.src == local,
                    # tcp.srcport in range) and server->game replies (ip.dst ==
                    # local, tcp.dstport in range).
                    display_filter = (
                        f'ip.addr == {local_ip} and '
                        f'tcp.port >= {self.port_range[0]} and '
                        f'tcp.port <= {self.port_range[1]}'
                    )
                    self.logger.info(f"Starting capture on interface: {self.interface}, IP: {local_ip} (fallback)")
                    self.logger.info(f"Display filter: {display_filter}")

                self._current_loop = loop
                try:
                    self._current_capture = pyshark.LiveCapture(
                        interface=capture_iface,
                        display_filter=display_filter,
                        eventloop=loop,
                        tshark_path=self.tshark_path
                    )

                    if hasattr(self._current_capture, "keep_packets"):
                        try:
                            self._current_capture.keep_packets = False
                            self.logger.debug("LiveCapture configured with keep_packets=False")
                        except Exception as keep_err:
                            self.logger.debug(f"Unable to set keep_packets flag: {keep_err}")
                except Exception as capture_error:
                    self.logger.error(f"Failed to create LiveCapture: {capture_error}")
                    if "tshark" in str(capture_error).lower():
                        self.logger.error("This appears to be a tshark-related issue. Make sure tshark is properly installed and accessible.")
                    break

                try:
                    for packet in self._current_capture.sniff_continuously():
                        if self._stop_event.is_set():
                            break
                        # On-demand accelerator re-check: only when the current
                        # mode yields no traffic for a while (e.g. accelerator
                        # was toggled after capture started). Zero overhead
                        # while packets are flowing.
                        if time.time() - self._last_packet_ts > 60 and not self._mode_recheck:
                            self.logger.info("No packets for 60s, re-checking accelerator state")
                            self._mode_recheck = True
                            break
                        if self._mode_recheck:
                            self.logger.info("Accelerator state changed, restarting capture session")
                            break
                        self._last_packet_ts = time.time()
                        if 'TCP' in packet and hasattr(packet.tcp, 'payload'):
                            # Reassemble each TCP stream independently — the game uses
                            # several connections and their bytes must not be mixed.
                            # Since we now capture both directions, upstream and
                            # downstream segments of the *same* connection are also
                            # split into separate buffers — interleaving them would
                            # corrupt reassembly for large packets.
                            stream_key = getattr(packet.tcp, 'stream', None)
                            if stream_key is None:
                                try:
                                    stream_key = f"{packet.tcp.srcport}-{packet.tcp.dstport}"
                                except Exception:
                                    stream_key = "default"
                            try:
                                srcport = int(packet.tcp.srcport)
                            except (ValueError, TypeError):
                                srcport = None
                            if self.active_proxy_port is not None:
                                is_downstream = srcport in self.active_proxy_port
                            else:
                                is_downstream = (
                                    srcport is not None
                                    and self.port_range[0] <= srcport <= self.port_range[1]
                                )
                            stream_key = f"{stream_key}-{'D' if is_downstream else 'U'}"
                            self.process_packet(packet.tcp.payload.binary_value, stream_key)
                except RuntimeError as e:
                    if "Event loop" in str(e) and "stopped" in str(e):
                        self.logger.info("Event loop stopped during capture, exiting cleanly")
                        break
                    else:
                        self.logger.error(f"Runtime error in capture loop: {e}", exc_info=True)
                        break
                except Exception as e:
                    self.logger.error(f"Fatal error in capture loop: {e}", exc_info=True)
                    break
                finally:
                    # Close only this session's capture (do not tear down the
                    # whole manager state — a new session may follow).
                    self._close_capture_session()
        except Exception as e:
            self.logger.error(f"Unhandled capture loop error: {e}", exc_info=True)
        finally:
            self._cleanup_capture()
            with self._state_lock:
                self.running = False
            self._stop_event.set()

    def _close_capture_session(self) -> None:
        """Close the current LiveCapture + its tshark children (no state change)."""
        capture = getattr(self, '_current_capture', None)
        self._current_capture = None
        if capture is None:
            return
        try:
            result = capture.close() if hasattr(capture, 'close') else None
            if asyncio.iscoroutine(result):
                try:
                    result.close()
                except Exception:
                    pass
        except Exception:
            pass
        finally:
            try:
                processes = getattr(capture, '_running_processes', None)
                if processes:
                    for proc in processes:
                        try:
                            if proc.poll() is None:
                                proc.terminate()
                        except Exception:
                            pass
            except Exception:
                pass
            
    def _cleanup_capture(self):
        if self._cleanup_complete.is_set():
            return

        if not self._cleanup_lock.acquire(blocking=False):
            return

        try:
            capture = getattr(self, '_current_capture', None)
            loop = getattr(self, '_current_loop', None)

            try:
                if capture:
                    try:
                        result = capture.close() if hasattr(capture, 'close') else None
                        if asyncio.iscoroutine(result):
                            cleanup_loop = asyncio.new_event_loop()
                            try:
                                cleanup_loop.run_until_complete(result)
                            finally:
                                cleanup_loop.close()
                    except Exception as sync_error:
                        self.logger.debug(f"capture.close raised {sync_error}; attempting async close")
                        try:
                            if hasattr(capture, 'close_async'):
                                async_result = capture.close_async()
                                if asyncio.iscoroutine(async_result):
                                    cleanup_loop = asyncio.new_event_loop()
                                    try:
                                        cleanup_loop.run_until_complete(async_result)
                                    finally:
                                        cleanup_loop.close()
                        except Exception as async_error:
                            self.logger.warning(f"Could not close capture async: {async_error}")
                    finally:
                        try:
                            processes = getattr(capture, '_running_processes', None)
                            if processes:
                                for proc in list(processes):
                                    try:
                                        finalize_asyncio_subprocess(proc, loop, self.logger)
                                    except Exception as proc_error:
                                        self.logger.debug(f"Unable to finalize subprocess cleanly: {proc_error}")

                                if hasattr(processes, 'clear'):
                                    processes.clear()
                                else:
                                    capture._running_processes = []
                        except Exception as proc_error:
                            self.logger.debug(f"Unable to clear running processes: {proc_error}")

                        try:
                            if hasattr(capture, 'eventloop'):
                                capture.eventloop = None
                        except Exception as loop_attr_error:
                            self.logger.debug(f"Unable to reset capture eventloop: {loop_attr_error}")
            except Exception as e:
                self.logger.error(f"Error during capture cleanup: {e}")
            finally:
                if hasattr(self, '_current_capture'):
                    del self._current_capture

                if loop:
                    try:
                        if not loop.is_closed():
                            try:
                                pending = list(asyncio.all_tasks(loop=loop))
                            except TypeError:
                                pending = list(asyncio.all_tasks())

                            for task in pending:
                                task.cancel()

                            if pending and not loop.is_running():
                                try:
                                    loop.run_until_complete(
                                        asyncio.gather(*pending, return_exceptions=True)
                                    )
                                except Exception as gather_error:
                                    self.logger.debug(f"Error awaiting pending tasks: {gather_error}")

                            try:
                                loop.call_soon_threadsafe(loop.stop)
                            except RuntimeError:
                                pass

                            if not loop.is_running():
                                try:
                                    if hasattr(loop, 'shutdown_asyncgens'):
                                        loop.run_until_complete(loop.shutdown_asyncgens())
                                except Exception as shutdown_error:
                                    self.logger.debug(f"Error during loop shutdown_asyncgens: {shutdown_error}")
                                loop.close()
                    except Exception as loop_error:
                        self.logger.warning(f"Error closing event loop: {loop_error}")
                    finally:
                        self._current_loop = None

                self.reset_state()
                self._terminate_capture_processes()

                temp_dir = tempfile.gettempdir()
                for pcap in glob.glob(os.path.join(temp_dir, '*.pcapng')):
                    try:
                        os.remove(pcap)
                        self.logger.info(f"Deleted temp capture file: {pcap}")
                    except Exception as file_error:
                        self.logger.warning(f"Could not delete {pcap}: {file_error}")
        finally:
            self._cleanup_complete.set()
            self._cleanup_lock.release()

    def is_active(self) -> bool:
        if self.running:
            return True
        if self.capture_thread and self.capture_thread.is_alive():
            return True
        return False

    def shutdown(self, persist_running_state: Optional[bool] = None):
        try:
            self.stop_capture_switch(persist_running_state=persist_running_state)
        except Exception as e:
            self.logger.error(f"Error during capture shutdown: {e}")

    def start_capture_switch(self) -> bool:
        with self._state_lock:
            if self.running and self.capture_thread and self.capture_thread.is_alive():
                self.logger.info("Capture already running, ignoring start request")
                return True

            self.running = True
            self._stop_event.clear()
            self._cleanup_capture_on_exit = True
            self._save_state(True)

            self.capture_thread = threading.Thread(target=self.capture_loop, daemon=True)
            self._cleanup_complete.clear()
            self.capture_thread.start()

        self._start_memory_guard()

        self.logger.info("Capture thread started")
        return True
        
    def stop_capture_switch(self, persist_running_state: Optional[bool] = None) -> bool:
        with self._state_lock:
            self._force_closing = True
            if not self.running and not (self.capture_thread and self.capture_thread.is_alive()):
                self.logger.info("Capture already stopped, ignoring stop request")
                return True

            self.running = False
            self._stop_event.set()
            persisted_flag = False if persist_running_state is None else bool(persist_running_state)
            self._save_state(persisted_flag)
            thread = self.capture_thread
            self._user_requested_stop = not persisted_flag

        self._stop_memory_guard()

        self._request_capture_shutdown(timeout=6.0)

        if thread and thread.is_alive():
            for timeout in [1.0, 3.0, 6.0]:
                self.logger.info(f"Waiting for capture thread to exit (timeout: {timeout}s)...")
                thread.join(timeout=timeout)
                if not thread.is_alive():
                    self.logger.info("Capture thread exited cleanly")
                    break
            if thread.is_alive():
                self.logger.warning("Capture thread still running after timeouts, forcing cleanup")

        if not self._cleanup_complete.wait(timeout=5.0):
            self.logger.warning("Timed out waiting for capture cleanup to finish")

        with self._state_lock:
            self.capture_thread = None
            self._cleanup_capture_on_exit = False
            self._force_closing = False

        self.logger.info("Capture switch turned OFF")
        return True

    def _request_capture_shutdown(self, timeout: float = 5.0) -> None:
        capture = getattr(self, '_current_capture', None)
        loop = getattr(self, '_current_loop', None)

        if not capture and not loop:
            return

        closed_via_loop = False

        if loop and not loop.is_closed():
            async def _close_and_stop():
                try:
                    if capture and hasattr(capture, 'close_async'):
                        try:
                            result = capture.close_async()
                        except Exception as close_err:
                            self.logger.debug(f"close_async failed: {close_err}")
                            result = None

                        if asyncio.iscoroutine(result):
                            await result
                    elif capture and hasattr(capture, 'close'):
                        maybe = capture.close()
                        if asyncio.iscoroutine(maybe):
                            await maybe
                finally:
                    loop.call_soon(loop.stop)

            try:
                future = asyncio.run_coroutine_threadsafe(_close_and_stop(), loop)
                future.result(timeout=timeout)
                closed_via_loop = True
            except FutureTimeout:
                self.logger.warning("Timed out waiting for capture loop to exit cleanly")
            except RuntimeError as runtime_err:
                self.logger.debug(f"Capture loop not running during shutdown request: {runtime_err}")
            except Exception as exc:
                self.logger.debug(f"Unexpected error during async capture shutdown: {exc}")

        if capture and not closed_via_loop:
            try:
                result = capture.close() if hasattr(capture, 'close') else None
                if asyncio.iscoroutine(result):
                    cleanup_loop = asyncio.new_event_loop()
                    try:
                        cleanup_loop.run_until_complete(result)
                    finally:
                        cleanup_loop.close()
            except Exception as close_error:
                self.logger.debug(f"Error closing capture synchronously: {close_error}")

        if loop and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(loop.stop)
            except RuntimeError:
                pass
            except Exception as stop_error:
                self.logger.debug(f"Unable to signal event loop stop: {stop_error}")

    def handle_packet(self, packet_data, proto_type):
        if not _PacketCommand_pb2:
            return

        try:
            name = _PacketCommand_pb2.PacketCommand.Name(proto_type)
        except (ValueError, KeyError):
            name = f"Unknown({proto_type})"

        try:
            message = self.parse_proto(packet_data, proto_type)

            # Store for packet viewer
            json_data = None
            parsed = False
            if message:
                parsed = True
                try:
                    json_data = MessageToDict(
                        message,
                        preserving_proto_field_name=True,
                        including_default_value_fields=True
                    )
                except TypeError:
                    json_data = MessageToDict(
                        message,
                        preserving_proto_field_name=True
                    )
                except Exception as dict_err:
                    self.logger.debug(f"MessageToDict failed for {name}: {dict_err}")

            # Assign a monotonically increasing id so UI can track items across refreshes
            self._packet_id_counter += 1
            has_handler = bool(self.capture_info and proto_type in self.capture_info)
            packet_info = {
                'id': self._packet_id_counter,
                'timestamp': datetime.utcnow().isoformat() + 'Z',
                'type': name,
                'proto_type': proto_type,
                'json': json_data,
                'raw_length': len(packet_data),
                'parsed': parsed,
                'handled': has_handler,
            }
            self.captured_packets.append(packet_info)

            if self.capture_info:
                if proto_type in self.capture_info:
                    self.logger.info(f"Parsing: {name} {proto_type}")
                    if message:
                        try:
                            self.capture_info[proto_type](message)
                        except Exception as handler_err:
                            self.logger.error(f"Handler error for {name} ({proto_type}): {handler_err}", exc_info=True)
                    else:
                        self.logger.warning(f"No proto message for handled type: {name} {proto_type}")
                else:
                    # Not an error — most packet types don't have app-level callbacks
                    self.logger.debug(f"Captured (no handler): {name} {proto_type} — {'parsed' if parsed else 'unparsed'}")
            elif not parsed:
                self.logger.debug(f"Captured but could not parse: {name} {proto_type}")

        except Exception as exc:
            self.logger.error(f"Unhandled error in handle_packet for {name} ({proto_type}): {exc}", exc_info=True)