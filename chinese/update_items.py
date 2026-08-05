"""
Fetch all items from DarkerDB API and generate items.json mapping file.
Run this script to update the item name database.
Usage: python update_items.py
"""

import json
import os
import sys
import urllib.request
import time

API_BASE = "https://api.darkerdb.com/v1"
MAPPING_DIR = os.path.join(os.path.dirname(__file__), "..", "mapping")


def fetch_all_items():
    """Fetch all items from DarkerDB API (paginated)."""
    all_items = []
    page = 1
    limit = 50

    print("Fetching items from DarkerDB API...")

    while True:
        url = f"{API_BASE}/items?page={page}&limit={limit}"
        print(f"  Page {page}...", end=" ", flush=True)

        try:
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "AdventurersSquire/1.0")

            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))

            items = data.get("body", [])

            if not items:
                print("empty, done.")
                break

            all_items.extend(items)
            print(f"{len(items)} items")

            page += 1
            time.sleep(0.2)  # Rate limiting

        except Exception as e:
            print(f"error: {e}")
            break

    return all_items


def extract_unique_names(items):
    """Extract unique item names (deduplicated by name)."""
    seen = set()
    names = []

    for item in items:
        name = item.get("name", "").strip()
        if name and name not in seen:
            seen.add(name)
            names.append(name)

    names.sort()
    return names


def main():
    items = fetch_all_items()
    print(f"\nTotal items fetched: {len(items)}")

    names = extract_unique_names(items)
    print(f"Unique item names: {len(names)}")

    # Load existing items.json to preserve user translations
    items_path = os.path.join(MAPPING_DIR, "items.json")
    existing = {}

    if os.path.exists(items_path):
        try:
            with open(items_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
            print(f"Loaded {len(existing)} existing translations")
        except Exception:
            pass

    # Create mapping: for items without Chinese translation,
    # use empty string as placeholder (user fills in via Mapping Editor)
    mapping = {}

    for name in names:
        # Check if we have an existing translation (by English name in values)
        found_cn = None
        for cn, en in existing.items():
            if en == name:
                found_cn = cn
                break

        if found_cn:
            mapping[found_cn] = name
        # Don't add untranslated items - they'll be handled by fuzzy matching

    # Also keep all existing custom translations
    mapping.update(existing)

    # Save
    os.makedirs(MAPPING_DIR, exist_ok=True)

    with open(items_path, "w", encoding="utf-8") as f:
        json.dump(mapping, f, ensure_ascii=False, indent=2)

    print(f"\nSaved {len(mapping)} mappings to: {items_path}")

    # Also save the English names list for reference
    ref_path = os.path.join(MAPPING_DIR, "english_items_reference.json")
    with open(ref_path, "w", encoding="utf-8") as f:
        json.dump(names, f, indent=2)

    print(f"Saved {len(names)} English names to: {ref_path}")
    print("\nDone! Use the Mapping Editor in Adventurer's Squire to add Chinese translations.")


if __name__ == "__main__":
    main()
