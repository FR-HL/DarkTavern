import json
import os
import sys
import time
import urllib.request

API_BASE = "https://api.darkerdb.com/v2"
API_KEY = os.environ.get("DARKERDB_API_KEY", "")
MAPPING_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mapping")


def log(msg):
    print(msg, flush=True)


def fetch_all(endpoint, extra_params=""):
    rows = []
    cursor = None
    base = f"{API_BASE}/{endpoint}?limit=200&condense=true{extra_params}"

    while True:
        url = f"{base}&cursor={cursor}" if cursor else base
        data = None

        for attempt in range(5):
            try:
                req = urllib.request.Request(url)
                req.add_header("X-Api-Key", API_KEY)
                req.add_header("User-Agent", "AdventurersSquire/1.0")
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                break
            except Exception as e:
                log(f"  retry {attempt + 1}/5: {e}")
                time.sleep(2 * (attempt + 1))

        if data is None:
            log(f"  FAILED after 5 retries, stopping at {len(rows)} rows")
            break

        body = data.get("body", [])
        rows.extend(body)
        log(f"  {endpoint}: {len(rows)} rows...")

        cursor = (data.get("pagination") or {}).get("next")
        if not cursor:
            break
        time.sleep(0.12)

    return rows


def build_mapping(zh_rows, en_rows):
    en_by_id = {}
    for row in en_rows:
        rid = row.get("id")
        name = row.get("name", "").strip()
        if rid and name:
            en_by_id[rid] = name

    mapping = {}
    for row in zh_rows:
        rid = row.get("id")
        zh_name = row.get("name", "").strip()
        if not rid or not zh_name:
            continue
        en_name = en_by_id.get(rid)
        if en_name and en_name != zh_name:
            mapping[zh_name] = en_name

    return mapping


def main():
    if not API_KEY:
        print("ERROR: set DARKERDB_API_KEY env var first, e.g.")
        print('  set DARKERDB_API_KEY=your_key && python sync_mappings.py')
        sys.exit(1)

    os.makedirs(MAPPING_DIR, exist_ok=True)

    log("=== Fetching items (zh-Hans) ===")
    items_zh = fetch_all("items", "&locale=zh-Hans")
    log("=== Fetching items (en) ===")
    items_en = fetch_all("items", "&locale=en")

    items_map = build_mapping(items_zh, items_en)
    log(f"Items: {len(items_map)} new mappings from API")

    items_path = os.path.join(MAPPING_DIR, "items.json")
    existing_items = {}
    if os.path.exists(items_path):
        with open(items_path, "r", encoding="utf-8") as f:
            existing_items = json.load(f)
        log(f"Items: {len(existing_items)} existing entries loaded")

    merged_items = {**existing_items, **items_map}
    merged_items = dict(sorted(merged_items.items(), key=lambda x: x[0]))

    with open(items_path, "w", encoding="utf-8") as f:
        json.dump(merged_items, f, ensure_ascii=False, indent=2)
    log(f"Items: saved {len(merged_items)} total -> items.json")

    log("")
    log("=== Fetching attributes (zh-Hans) ===")
    attrs_zh = fetch_all("attributes", "&locale=zh-Hans")
    log("=== Fetching attributes (en) ===")
    attrs_en = fetch_all("attributes", "&locale=en")

    attrs_map = build_mapping(attrs_zh, attrs_en)
    log(f"Attributes: {len(attrs_map)} new mappings from API")

    attrs_path = os.path.join(MAPPING_DIR, "attributes.json")
    existing_attrs = {}
    if os.path.exists(attrs_path):
        with open(attrs_path, "r", encoding="utf-8") as f:
            existing_attrs = json.load(f)
        log(f"Attributes: {len(existing_attrs)} existing entries loaded")

    merged_attrs = {**existing_attrs, **attrs_map}
    merged_attrs = dict(sorted(merged_attrs.items(), key=lambda x: x[0]))

    with open(attrs_path, "w", encoding="utf-8") as f:
        json.dump(merged_attrs, f, ensure_ascii=False, indent=2)
    log(f"Attributes: saved {len(merged_attrs)} total -> attributes.json")

    log("")
    log("Done!")


if __name__ == "__main__":
    main()
