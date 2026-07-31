"""
Chinese to English translator for Dark and Darker game text.
Uses a mapping table approach for accurate game-specific translations.
"""

import json
import os
import re
from difflib import SequenceMatcher


class Translator:
    def __init__(self, mapping_dir):
        self.mapping_dir = mapping_dir
        self.items = {}
        self.attributes = {}
        self.keywords = {}
        self.custom = {}
        self.reverse_items = {}

        self.load_mappings()

    def load_mappings(self):
        """Load all mapping files."""
        self._load_json("items.json", self.items)
        self._load_json("attributes.json", self.attributes)
        self._load_json("keywords.json", self.keywords)
        self._load_json("custom.json", self.custom)
        self.reverse_items = {v: k for k, v in self.items.items()}

    def _load_json(self, filename, target):
        path = os.path.join(self.mapping_dir, filename)
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    target.update(data)
            except (json.JSONDecodeError, IOError):
                pass

    def save_custom(self):
        path = os.path.join(self.mapping_dir, "custom.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.custom, f, ensure_ascii=False, indent=2)

    def add_custom_mapping(self, chinese, english):
        self.custom[chinese] = english
        self.save_custom()

    def remove_custom_mapping(self, chinese):
        if chinese in self.custom:
            del self.custom[chinese]
            self.save_custom()

    def get_all_mappings(self):
        combined = {}
        combined.update(self.keywords)
        combined.update(self.attributes)
        combined.update(self.items)
        combined.update(self.custom)
        return combined

    def translate_text(self, chinese_text):
        """
        Translate Chinese tooltip text to clean English for DarkerDB API.
        Only outputs lines that are fully or mostly English - API can't parse Chinese.
        """
        if not chinese_text:
            return ""

        all_mappings = self.get_all_mappings()
        lines = chinese_text.strip().split("\n")
        translated_lines = []

        for i, line in enumerate(lines):
            line = line.strip()
            if not line:
                continue

            translated = self._translate_line(line, all_mappings, is_first_line=(i == 0))
            if not translated:
                continue

            # Strip Chinese chars + fullwidth punctuation + special quotes from all lines
            cleaned = re.sub(r'[\u4e00-\u9fff\uff00-\uffef\u3000-\u303f（）【】「」『』〔〕\u201c\u201d\u2018\u2019]+', '', translated).strip()
            # Clean up leftover spaces from stripped chars
            cleaned = re.sub(r'\s+', ' ', cleaned).strip()

            # First line (item name) must always be kept
            if i == 0:
                if cleaned:
                    translated_lines.append(cleaned)
                continue

            # Skip empty or still-dirty lines
            if not cleaned:
                continue

            translated_lines.append(cleaned)

        return "\n".join(translated_lines)

    def _is_mostly_chinese(self, text):
        """Check if text is mostly Chinese characters (untranslated description)."""
        if not text:
            return False
        chinese_chars = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
        total_chars = sum(1 for c in text if not c.isspace())
        if total_chars == 0:
            return False
        return chinese_chars / total_chars > 0.5

    def _translate_line(self, line, mappings, is_first_line=False):
        """Translate a single line of tooltip text."""
        if not line:
            return ""

        # 1. Exact full-line match (highest priority)
        if line in mappings:
            return mappings[line]

        # 2. For first line, try fuzzy item name match
        if is_first_line:
            item_match = self._fuzzy_match_item(line)
            if item_match:
                return item_match

        # 3. Try "label: value" pattern (e.g., "稀有度：普通")
        colon_match = re.match(r"^(.+?)[:：]\s*(.+)$", line)
        if colon_match:
            full_line = line.replace("：", ":")
            # Try full line match with normalized colon
            if full_line in mappings:
                return mappings[full_line]
            if line in mappings:
                return mappings[line]

            # Try matching label and value separately
            label = colon_match.group(1).strip()
            value = colon_match.group(2).strip()

            translated_label = mappings.get(label, label)
            translated_value = mappings.get(value, value)

            # If either part was translated, return combined
            if translated_label != label or translated_value != value:
                return f"{translated_label}: {translated_value}"

        # 4. Try stat pattern: "+3 力量" or "移动速度-10"
        stat_match = re.match(r"^([+\-]?\d+\.?\d*%?)\s*(.+)$", line)
        if stat_match:
            value = stat_match.group(1)
            stat_name = stat_match.group(2).strip()
            # Try exact match first, then without spaces (OCR may insert spaces)
            stat_name_nospace = stat_name.replace(" ", "")
            if stat_name in mappings:
                return f"{value} {mappings[stat_name]}"
            if stat_name_nospace in mappings:
                return f"{value} {mappings[stat_name_nospace]}"

        # Reverse pattern: "力量+3"
        stat_match2 = re.match(r"^(.+?)([+\-]\d+\.?\d*%?)$", line)
        if stat_match2:
            stat_name = stat_match2.group(1).strip()
            stat_name_nospace = stat_name.replace(" ", "")
            value = stat_match2.group(2)
            if stat_name in mappings:
                return f"{mappings[stat_name]}{value}"
            if stat_name_nospace in mappings:
                return f"{mappings[stat_name_nospace]}{value}"

        # 5. Substring replacement (longest match first)
        translated = line
        replacements_made = False
        for cn, en in sorted(mappings.items(), key=lambda x: -len(x[0])):
            if len(cn) >= 2 and cn in translated:
                translated = translated.replace(cn, en)
                replacements_made = True

        if replacements_made:
            return translated

        # 6. No translation found, return original
        return line

    def _fuzzy_match_item(self, text, threshold=0.7):
        """Fuzzy match against item names."""
        all_mappings = self.get_all_mappings()
        best_match = None
        best_score = 0

        for cn, en in all_mappings.items():
            score = SequenceMatcher(None, text, cn).ratio()
            if score > best_score and score >= threshold:
                best_score = score
                best_match = en

        return best_match

    def get_unmapped_terms(self, chinese_text):
        """Find Chinese terms that don't have translations."""
        all_mappings = self.get_all_mappings()
        lines = chinese_text.strip().split("\n")
        unmapped = []

        for line in lines:
            line = line.strip()
            if not line:
                continue

            # Check if this line has any mapping
            if line in all_mappings:
                continue

            # Check if any mapping key is in this line
            has_mapping = False
            for cn in all_mappings:
                if cn in line:
                    has_mapping = True
                    break

            if not has_mapping:
                # Remove numbers/punctuation to get pure text
                text_only = re.sub(r"[+\-\d.%：:\s()（）]+", "", line)
                if text_only and len(text_only) > 1:
                    unmapped.append(line)

        return unmapped
