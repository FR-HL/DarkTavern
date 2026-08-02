#!/usr/bin/env python3
"""
Update assets/items.json and assets/icons.pak from the DarkerDB v2 API.

Usage:
    DARKERDB_API_KEY=your_key python update_items.py [--force-icons]

The API key is read from the DARKERDB_API_KEY environment variable
(or passed with --api-key). It is never hardcoded.
"""

import argparse
import concurrent.futures
import hashlib
import io
import json
import logging
import os
import sys
import time
import zipfile
from pathlib import Path
from typing import Dict, Optional

import requests

logger = logging.getLogger(__name__)

API_ITEMS_URL = "https://api.darkerdb.com/v2/items"
PAGE_SIZE = 200
MAX_PAGES = 100

# scripts/ -> ocr-service -> chinese -> <project root>
PROJECT_ROOT = Path(__file__).resolve().parents[3]
ASSETS_DIR = PROJECT_ROOT / "assets"
ITEMS_FILE = ASSETS_DIR / "items.json"
ICONS_PAK_FILE = ASSETS_DIR / "icons.pak"

DOWNLOAD_TIMEOUT = 20
ICON_WORKERS = 4          # 并发下载数（保守，避免触发限流）
ICON_DELAY = 0.25         # 每个图标请求后的间隔（秒）
PAGE_DELAY = 0.8          # items 分页请求间隔（秒）

# v2 返回枚举为小写 slug，与本地文件保持一致（首字母大写）
def title_enum(value: Optional[str]) -> Optional[str]:
    if not value:
        return value
    return "".join(p[:1].upper() + p[1:] for p in str(value).split("_"))


def envelope_to_raw(env_id: str) -> Optional[str]:
    """Convert 'id.item.adventurer_boots_1001' -> 'AdventurerBoots_1001'."""
    slug = env_id.rsplit(".", 1)[-1]
    parts = slug.split("_")
    if not parts:
        return None
    if parts[-1].isdigit():
        head = "".join(p[:1].upper() + p[1:] for p in parts[:-1])
        return f"{head}_{parts[-1]}"
    return "".join(p[:1].upper() + p[1:] for p in parts)


def normalize_record(item: Dict) -> Optional[Dict]:
    env_id = item.get("id")
    if not env_id:
        return None
    raw_id = envelope_to_raw(env_id)
    if not raw_id:
        return None

    record = dict(item)
    record["id"] = raw_id
    record["name"] = item.get("name") or ""
    record["rarity"] = title_enum(item.get("rarity"))
    record["slot_type"] = title_enum(item.get("slot_type"))
    record["item_type"] = title_enum(item.get("item_type"))
    record["armor_type"] = title_enum(item.get("armor_type"))
    record["iconHash"] = item.get("icon")
    icon_type = record["item_type"] or "Misc"
    record["iconPath"] = f"icons/{icon_type}/{raw_id}.webp"
    return record


def render_progress(current: int, total: int, prefix: str = "") -> None:
    if not total:
        return
    bar_length = 30
    filled = int(bar_length * current / total)
    bar = "#" * filled + "-" * (bar_length - filled)
    percent = int(current / total * 100)
    sys.stdout.write(f"\r{prefix}[{bar}] {percent:3d}% ({current}/{total})")
    sys.stdout.flush()
    if current >= total:
        sys.stdout.write("\n")


def http_get(url: str, headers: Dict, timeout: int = 30, retries: int = 3) -> requests.Response:
    """GET with simple retry/backoff for flaky connections."""
    last_exc = None
    for attempt in range(retries):
        try:
            return requests.get(url, headers=headers, timeout=timeout)
        except requests.RequestException as exc:
            last_exc = exc
            wait = 2 ** attempt
            logger.warning("Request failed (%s), retrying in %ds...", exc, wait)
            time.sleep(wait)
    raise last_exc


def fetch_all_items(headers: Dict) -> Dict[str, Dict]:
    """Fetch the full item catalog (paginated via cursor)."""
    records: Dict[str, Dict] = {}
    cursor = None
    page = 1
    while page <= MAX_PAGES:
        url = f"{API_ITEMS_URL}?limit={PAGE_SIZE}"
        if cursor:
            url += f"&cursor={cursor}"
        resp = http_get(url, headers)
        resp.raise_for_status()
        data = resp.json()

        for item in data.get("body") or []:
            record = normalize_record(item)
            if record:
                records[record["id"]] = record

        pagination = data.get("pagination") or {}
        total = pagination.get("total") or 0
        render_progress(len(records), total, prefix="Items: ")
        cursor = pagination.get("next")
        if not cursor:
            break
        page += 1
        time.sleep(PAGE_DELAY)

    logger.info("Total items fetched: %d", len(records))
    return records


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def load_existing_pak() -> Dict[str, bytes]:
    if not ICONS_PAK_FILE.exists():
        return {}
    try:
        with zipfile.ZipFile(ICONS_PAK_FILE, "r") as archive:
            return {name: archive.read(name) for name in archive.namelist()}
    except Exception as exc:
        logger.warning("Failed to read existing icons.pak: %s", exc)
        return {}


def download_icon(record: Dict, existing: Dict[str, bytes], force: bool) -> tuple:
    """Download one item icon. Returns (icon_path, bytes_or_None, status)."""
    icon_path = record.get("iconPath")
    url = record.get("icon_url")
    if not icon_path or not url:
        return icon_path, None, "no-url"

    if not force and icon_path in existing and record.get("iconHash") == sha256_bytes(existing[icon_path]):
        return icon_path, None, "unchanged"

    try:
        resp = requests.get(url, timeout=DOWNLOAD_TIMEOUT)
        try:
            if resp.status_code != 200:
                return icon_path, None, f"http-{resp.status_code}"
            raw = resp.content
            if resp.headers.get("Content-Type", "").lower().find("webp") < 0:
                raw = _to_webp(raw)
            return icon_path, raw, "ok"
        finally:
            time.sleep(ICON_DELAY)
    except requests.RequestException as exc:
        logger.warning("Icon download failed for %s: %s", icon_path, exc)
        return icon_path, None, "error"


def _to_webp(raw: bytes) -> bytes:
    from PIL import Image

    image = Image.open(io.BytesIO(raw))
    if image.mode not in {"RGBA", "RGB"}:
        image = image.convert("RGBA")
    buffer = io.BytesIO()
    image.save(buffer, format="WEBP", quality=90, method=6)
    return buffer.getvalue()


def refresh_icons(records: Dict[str, Dict], existing: Dict[str, bytes], force: bool) -> Dict[str, bytes]:
    """Download changed/missing icons. Returns the new pak content map."""
    pak = dict(existing)
    tasks = list(records.values())

    with concurrent.futures.ThreadPoolExecutor(max_workers=ICON_WORKERS) as executor:
        futures = [executor.submit(download_icon, r, existing, force) for r in tasks]
        total = len(futures)
        done = 0
        for future in concurrent.futures.as_completed(futures):
            icon_path, payload, status = future.result()
            if payload is not None:
                pak[icon_path] = payload
            done += 1
            if done % 5 == 0 or done == total:
                render_progress(done, total, prefix="Icons: ")

    return pak


def write_pak(pak: Dict[str, bytes]) -> None:
    tmp = ICONS_PAK_FILE.with_suffix(".pak.tmp")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_BZIP2) as archive:
        for name in sorted(pak):
            archive.writestr(name, pak[name])
    tmp.replace(ICONS_PAK_FILE)
    logger.info("icons.pak written: %d entries, %.1f MB", len(pak), ICONS_PAK_FILE.stat().st_size / 1024 / 1024)


def update(force_icons: bool, api_key: str) -> bool:
    if not api_key:
        logger.error("DARKERDB_API_KEY is required")
        return False

    headers = {"X-Api-Key": api_key, "User-Agent": "DarkTavern-Updater/1.0"}

    records = fetch_all_items(headers)
    if not records:
        logger.error("No items fetched from API")
        return False

    logger.info("Loading existing icons.pak...")
    existing_pak = load_existing_pak()

    logger.info("Refreshing icons (force=%s)...", force_icons)
    new_pak = refresh_icons(records, existing_pak, force_icons)

    logger.info("Writing items.json (%d items)...", len(records))
    ITEMS_FILE.write_text(
        json.dumps(records, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    write_pak(new_pak)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Update items.json and icons.pak from DarkerDB API.")
    parser.add_argument("--force-icons", action="store_true", help="Re-download all icons.")
    parser.add_argument("--api-key", help="DarkerDB API key (or set DARKERDB_API_KEY env var).")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    api_key = args.api_key or os.environ.get("DARKERDB_API_KEY", "").strip()
    logger.info("DarkerDB Items Updater")
    logger.info("Items file: %s", ITEMS_FILE)
    logger.info("Icons pak:  %s", ICONS_PAK_FILE)

    ok = update(args.force_icons, api_key)
    if ok:
        logger.info("Update completed successfully! Restart the app to use the new data.")
        sys.exit(0)
    sys.exit(1)


if __name__ == "__main__":
    main()
