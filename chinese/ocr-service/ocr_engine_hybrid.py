"""
OCR engine — HYBRID (档2): old engine's fast numpy line-segmentation +
RapidOCR's dynamic-width v4 recognizer.

Why: the old per-line Paddle rec model is FIXED at 320 px wide, so long blue
affix lines had to be hard-sliced (col_chunks) and got corrupted. RapidOCR's
recognizer resizes each line to its true aspect ratio (no 320 cap, no slicing)
so long lines stay intact. We keep the old engine's detector-free, cls-free,
pure-numpy row segmentation (the fast part) and only swap the recognizer.

Result target: speed ~ old engine (no det/cls), quality = intact blue lines.
"""

from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import os

import cv2
import numpy as np
from onnxruntime import InferenceSession, SessionOptions, GraphOptimizationLevel, ExecutionMode

import rapidocr_onnxruntime as _rapid
from rapidocr_onnxruntime.ch_ppocr_rec import TextRecognizer

_PKG = Path(_rapid.__file__).resolve().parent
_REC_CFG = {
    "model_path": str(_PKG / "models" / "ch_PP-OCRv4_rec_infer.onnx"),
    "rec_img_shape": [3, 48, 320],
    "rec_batch_num": 6,
    "intra_op_num_threads": 1,
    "inter_op_num_threads": 1,
    "use_cuda": False,
    "use_dml": False,
}


# ---- pure-numpy row segmentation (copied verbatim from the old engine) ----

def _bright_mask(input_img):
    if input_img.ndim == 3 and input_img.shape[2] == 4:
        gray = cv2.cvtColor(input_img, cv2.COLOR_BGRA2GRAY)
    elif input_img.ndim == 3 and input_img.shape[2] == 3:
        gray = cv2.cvtColor(input_img, cv2.COLOR_BGR2GRAY)
    else:
        gray = input_img
    hist = np.bincount(gray.ravel(), minlength=256)
    midpoint = gray.shape[0] * gray.shape[1] // 2
    cum = np.cumsum(hist)
    bg = int(np.searchsorted(cum, midpoint, side="left"))
    bg = min(bg, 255)
    threshold = int(np.clip(bg + 18, 24, 72))
    _, bright = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY)
    return bright


def _has_long_run(row, minimum):
    run = 0
    for v in row:
        if v:
            run += 1
            if run > minimum:
                return True
        else:
            run = 0
    return False


def line_bands(crop):
    if crop.size == 0 or crop.shape[1] < 6:
        return []
    bright = _bright_mask(crop)
    cols = bright.shape[1]
    margin = min(cols // 2 - 1, max(2, cols // 25))
    if margin < 0 or cols - margin <= margin:
        return []
    interior = bright[:, margin:cols - margin]
    rowsum = interior.astype(np.int32).sum(axis=1)
    min_ink = interior.shape[1] * 255 // 50

    bands = []
    top = -1
    end = -1
    gap = 0
    rows = crop.shape[0]

    def flush():
        nonlocal top, end, gap
        if top >= 0 and end - top >= 6:
            bands.append((max(0, top - 2), min(rows, end + 3)))
        top = -1
        end = -1
        gap = 0

    for y in range(rowsum.shape[0]):
        if rowsum[y] > min_ink:
            if top < 0:
                top = y
            end = y
            gap = 0
        elif top >= 0:
            gap += 1
            if gap > 3:
                flush()
    flush()
    return bands


def trim_cols(line):
    if line.size == 0:
        return line
    colsum = _bright_mask(line).astype(np.int32).sum(axis=0)
    join_gap = max(4, line.shape[0] // 2)
    groups = []
    group_begin = -1
    last_ink = -1
    for x in range(colsum.shape[0]):
        if colsum[x] > 0:
            if group_begin < 0:
                group_begin = x
            elif x - last_ink > join_gap:
                groups.append((group_begin, last_ink + 1))
                group_begin = x
            last_ink = x
    if group_begin >= 0:
        groups.append((group_begin, last_ink + 1))
    if not groups:
        return line

    x0 = groups[0][0]
    x1 = groups[-1][1]
    if len(groups) > 1:
        min_w = max(6, line.shape[0])
        first = next((g for g in groups if g[1] - g[0] >= min_w), None)
        last = next((g for g in reversed(groups) if g[1] - g[0] >= min_w), None)
        if first is not None and last is not None:
            x0 = first[0]
            x1 = last[1]
    x0 = max(0, x0 - 4)
    x1 = min(line.shape[1], x1 + 4)
    return line[:, x0:x1]


def is_horizontal_rule(line):
    if line.size == 0 or line.shape[1] < line.shape[0] * 8:
        return False
    mask = _bright_mask(line)
    for y in range(mask.shape[0]):
        if _has_long_run(mask[y], mask.shape[1] // 3):
            return True
    return False


def trim_title_rule(line):
    if line.size == 0 or line.shape[0] < 8:
        return line
    mask = _bright_mask(line)
    cols = mask.shape[1]
    for y in range(4, mask.shape[0]):
        if not _has_long_run(mask[y], cols // 3):
            continue
        cut = y
        while cut > 0 and cv2.countNonZero(mask[cut - 1]) > cols // 8:
            cut -= 1
        if cut >= 6:
            return line[0:cut]
    return line


class ChineseOCR:
    def __init__(self):
        self.rec = TextRecognizer(_REC_CFG)
        opts = SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        opts.graph_optimization_level = GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.execution_mode = ExecutionMode.ORT_PARALLEL
        opts.enable_mem_pattern = False
        self.rec.session.session = InferenceSession(
            _REC_CFG["model_path"], sess_options=opts,
            providers=["CPUExecutionProvider"],
        )
        cpu = os.cpu_count() or 4
        self._workers = max(2, cpu)
        self._pool = ThreadPoolExecutor(max_workers=self._workers)
        dummy = np.zeros((48, 200, 3), dtype=np.uint8)
        self.rec([dummy, dummy])

    def _rec_one(self, crop):
        res, _ = self.rec(crop)
        return res[0][0] if res else ""

    def read(self, region):
        if region is None or region.size == 0:
            return ""
        h, w = region.shape[:2]
        if w > 24 and h > 24:
            region = region[6:h - 6, 6:w - 6]

        bands = line_bands(region)
        if not bands:
            return ""

        # One crop per surviving text row. NO col_chunks: each row stays whole
        # so the dynamic-width recognizer never slices a long blue line.
        line_crops = []
        for band_index, (y0, y1) in enumerate(bands):
            raw_line = region[y0:y1, :]
            is_rule = is_horizontal_rule(raw_line)
            if band_index == 0 and is_rule and raw_line.shape[0] <= 20:
                continue
            is_title = band_index == 0
            if not is_title and is_rule:
                continue
            if is_title:
                raw_line = trim_title_rule(raw_line)
            line = trim_cols(raw_line)
            if line.size == 0:
                continue
            line_crops.append(line)

        if not line_crops:
            return ""

        if len(line_crops) == 1:
            texts = [self._rec_one(line_crops[0])]
        else:
            texts = list(self._pool.map(self._rec_one, line_crops))
        return "\n".join(t for t in texts if t)
