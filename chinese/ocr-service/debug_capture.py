# -*- coding: utf-8 -*-
"""一次性抓包诊断脚本 —— 输出定位游戏真实流量端口所需的全部信息。

用法（游戏开着、加速器开着）：
    ocr_env\\Scripts\\python.exe chinese\\ocr-service\\debug_capture.py
"""
import os
import shutil
import socket
import subprocess
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import psutil
from dnd.capture.packet_capture import (
    is_game_process,
    detect_game_capture_point,
)


def find_tshark():
    candidates = [
        os.environ.get('TSHARK', ''),
        r'C:\Program Files\Wireshark\tshark.exe',
        r'D:\Program Files\Wireshark\tshark.exe',
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    found = shutil.which('tshark')
    return found or 'tshark'


def grab(tshark, iface, filter_, secs=10, count=100):
    """抓指定过滤器的包，返回 'srcport\tdstport' 行列表（空列表=无流量）。"""
    try:
        r = subprocess.run(
            [tshark, '-i', iface, '-f', filter_, '-a', f'duration:{secs}',
             '-T', 'fields', '-e', 'tcp.srcport', '-e', 'tcp.dstport', '-c', str(count)],
            capture_output=True, timeout=secs + 15,
        )
        return (r.stdout or b'').decode('utf-8', 'replace').splitlines()
    except Exception as e:
        return [f'ERR {e}']


def grab_udp(tshark, iface, secs=10, count=200):
    try:
        r = subprocess.run(
            [tshark, '-i', iface, '-f', 'udp', '-a', f'duration:{secs}',
             '-T', 'fields', '-e', 'udp.srcport', '-c', str(count)],
            capture_output=True, timeout=secs + 15,
        )
        return (r.stdout or b'').decode('utf-8', 'replace').splitlines()
    except Exception as e:
        return [f'ERR {e}']


def main():
    tshark = find_tshark()
    print(f'[tshark] {tshark}')

    # 1. 本机接口
    print('\n===== 1. 本机接口与 IP =====')
    iface_ips = {}
    for iface, addrs in psutil.net_if_addrs().items():
        for a in addrs:
            if a.family == socket.AF_INET:
                iface_ips.setdefault(iface, []).append(a.address)
                print(f'  {iface}: {a.address}')

    # 2. 游戏进程
    print('\n===== 2. 游戏进程 =====')
    games = [p for p in psutil.process_iter(['name', 'pid'])
             if is_game_process(p.info.get('name'))]
    for g in games:
        print(f"  {g.info['name']}  PID={g.info['pid']}")
    if not games:
        print('  !! 未检测到游戏进程 —— 请先启动游戏再运行')
        return

    # 3. 游戏全部连接（TCP + UDP，含状态）
    print('\n===== 3. 游戏 TCP/UDP 连接 =====')
    for g in games:
        try:
            for c in g.net_connections(kind='inet'):
                l = f"{c.laddr[0]}:{c.laddr[1]}" if c.laddr else '-'
                r = f"{c.raddr[0]}:{c.raddr[1]}" if c.raddr else '-'
                print(f"  {c.family.name:8s} {l:>22s} -> {r:<22s} {c.status}")
        except Exception as e:
            print(f'  读取失败: {e}')

    # 4. 自动判定结果
    print('\n===== 4. 自动判定（detect_game_capture_point）=====')
    print(' ', detect_game_capture_point())

    # 5. 候选端口逐个试抓（游戏本地端口 + 本机目标端口）
    print('\n===== 5. 候选端口试抓（各 5 秒）=====')
    ports = set()
    local_ips = {ip for ips in iface_ips.values() for ip in ips}
    for g in games:
        try:
            for c in g.net_connections(kind='tcp'):
                if c.laddr:
                    ports.add(c.laddr[1])
                if c.raddr and (c.raddr[0] == '127.0.0.1' or c.raddr[0] in local_ips):
                    ports.add(c.raddr[1])
        except Exception:
            pass
    default_iface = next(iter(iface_ips), '以太网')
    for port in sorted(ports):
        lines = grab(tshark, default_iface, f'tcp port {port}', 5, 5)
        status = f'有流量（{len(lines)} 包）' if lines and not lines[0].startswith('ERR') else ('无流量' if lines else '无流量')
        print(f'  tcp port {port}: {status}')

    # 6. 全量 TCP 端口统计（找真实端口范围）
    print(f'\n===== 6. 全部 TCP 流量端口统计（{default_iface}，10 秒）=====')
    lines = grab(tshark, default_iface, 'tcp', 10, 500)
    cnt = Counter()
    for ln in lines:
        parts = ln.split('\t')
        if len(parts) >= 2 and parts[0].isdigit():
            cnt[int(parts[0])] += 1
    if cnt:
        for port, n in cnt.most_common(20):
            print(f'  srcport {port}: {n} 包')
    else:
        print('  10 秒内无任何 TCP 包 —— 流量可能走虚拟网卡/其它接口')

    # 7. 全量 UDP 端口统计
    print('\n===== 7. 全部 UDP 端口统计（10 秒）=====')
    udp_lines = grab_udp(tshark, default_iface, 10, 200)
    cnt2 = Counter(x for x in udp_lines if x.isdigit())
    if cnt2:
        for port, n in cnt2.most_common(15):
            print(f'  udp srcport {port}: {n}')
    else:
        print('  10 秒内无 UDP 包')

    # 8. 其它接口试抓（虚拟网卡常见接口名）
    print('\n===== 8. 其它接口 10 秒 TCP 流量检查 =====')
    for iface in iface_ips:
        if iface == default_iface:
            continue
        lines = grab(tshark, iface, 'tcp', 10, 100)
        real = [ln for ln in lines if not ln.startswith('ERR')]
        print(f'  {iface}: {"有流量 " + str(len(real)) + " 包" if real else "无流量/接口不可用"}')

    print('\n===== 完成 =====')
    print('把上面全部输出复制发回，即可定位游戏真实流量端口与接口。')


if __name__ == '__main__':
    main()
