"""
OCR engine - Python port of GrimVault's preprocessor.cpp + paddle_recognizer.cpp.

No text-detection model: tooltip rows are segmented by pixel projection
(line_bands), then each row is fed alone to the PaddleOCR v5 recognizer.
The recognizer runs on ONNX Runtime (cv2.dnn cannot handle this model's
dynamic reshape on this OpenCV build); feeding strategy / preprocessing /
CTC decode are copied 1:1 from the C++ original.
"""

import os
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
import onnxruntime as ort

MODEL_HEIGHT = 48
MODEL_WIDTH = 320


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


def col_chunks(line):
    if line.size == 0:
        return []
    max_w = line.shape[0] * 13 // 2
    cols = line.shape[1]
    if cols <= max_w:
        return [(0, cols)]
    colsum = _bright_mask(line).astype(np.int32).sum(axis=0)
    chunks = []
    start = 0
    while cols - start > max_w:
        target = start + max_w
        floor = start + max_w * 3 // 5
        best_begin = -1
        best_end = -1
        min_word_gap = max(5, line.shape[0] // 5)
        gap_end = target
        while gap_end > floor:
            while gap_end > floor and colsum[gap_end - 1] > 0:
                gap_end -= 1
            end = gap_end
            while gap_end > floor and colsum[gap_end - 1] == 0:
                gap_end -= 1
            if end - gap_end >= min_word_gap:
                best_begin = gap_end
                best_end = end
                break
        cut = (best_begin + best_end) // 2 if best_begin >= 0 else target
        chunks.append((start, cut))
        start = cut
    if start < cols:
        chunks.append((start, cols))
    return chunks


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


def _preprocess(input_img):
    if input_img.ndim == 3 and input_img.shape[2] == 4:
        bgr = cv2.cvtColor(input_img, cv2.COLOR_BGRA2BGR)
    elif input_img.ndim == 3 and input_img.shape[2] == 3:
        bgr = input_img
    else:
        bgr = cv2.cvtColor(input_img, cv2.COLOR_GRAY2BGR)

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    hist = np.bincount(gray.ravel(), minlength=256)
    pixels = gray.shape[0] * gray.shape[1]

    def percentile(numer, denom):
        target = pixels * numer // denom
        cum = np.cumsum(hist)
        return int(min(np.searchsorted(cum, target, side="left"), 255))

    background = percentile(1, 2)
    foreground = percentile(49, 50)
    span = max(24, foreground - background)
    vals = np.arange(256, dtype=np.float32)
    normalized = np.clip((vals - background) / span, 0.0, 1.0)
    lut = np.round(255.0 * np.sqrt(normalized)).astype(np.uint8)
    gray = cv2.LUT(gray, lut)
    bgr = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

    scale = MODEL_HEIGHT / bgr.shape[0]
    w = min(MODEL_WIDTH, max(1, int(round(bgr.shape[1] * scale))))
    resized = cv2.resize(bgr, (w, MODEL_HEIGHT), interpolation=cv2.INTER_CUBIC)
    canvas = np.zeros((MODEL_HEIGHT, MODEL_WIDTH, 3), dtype=np.uint8)
    canvas[:, 0:w] = resized

    rgb = canvas[:, :, ::-1].astype(np.float32)
    normed = rgb / 127.5 - 1.0
    return normed.transpose(2, 0, 1)[np.newaxis, ...]


def _ctc_decode(mat, dictionary):
    classes = mat.shape[1]
    best_i = mat.argmax(axis=1)
    best_v = mat.max(axis=1)
    result = []
    conf_sum = 0.0
    conf_n = 0
    last = -1
    for t in range(best_i.shape[0]):
        bi = int(best_i[t])
        if bi != 0 and bi != last:
            di = bi - 1
            if 0 <= di < len(dictionary):
                result.append(dictionary[di])
                conf_sum += float(best_v[t])
                conf_n += 1
            elif bi == classes - 1:
                result.append(" ")
                conf_sum += float(best_v[t])
                conf_n += 1
        last = bi
    confidence = conf_sum / conf_n if conf_n else 0.0
    return "".join(result), confidence


class ChineseOCR:
    def __init__(self, model_path, dict_path):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 2
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            model_path, sess_options=opts, providers=["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name
        with open(dict_path, encoding="utf-8") as f:
            self.dictionary = [ln.rstrip(" \r\n\t") for ln in f]
        # Row-level parallelism: each text row is recognized concurrently.
        # intra*workers <= cpu_count avoids oversubscription on small CPUs
        # (4 cores -> 2 workers, 8 -> 4, 20 -> 6), so it stays safe everywhere.
        cpu = os.cpu_count() or 4
        self._workers = max(1, min(cpu // 2, 6))
        self._pool = ThreadPoolExecutor(max_workers=self._workers)

    def read_line(self, line_img):
        if line_img is None or line_img.size == 0:
            return "", 0.0
        blob = _preprocess(line_img)
        out = self.session.run(None, {self.input_name: blob})[0]
        return _ctc_decode(out[0], self.dictionary)

    def read(self, region):
        if region is None or region.size == 0:
            return ""
        h, w = region.shape[:2]
        if w > 24 and h > 24:
            region = region[6:h - 6, 6:w - 6]

        bands = line_bands(region)
        if not bands:
            return ""

        # Plan every recognizer chunk across surviving bands, keeping the
        # (line, position) order so results reassemble correctly afterwards.
        lines_chunks = []
        band_index = 0
        for y0, y1 in bands:
            raw_line = region[y0:y1, :]
            is_rule = is_horizontal_rule(raw_line)
            if band_index == 0 and is_rule and raw_line.shape[0] <= 20:
                continue
            is_title = band_index == 0
            if not is_title and is_rule:
                continue
            band_index += 1
            if is_title:
                raw_line = trim_title_rule(raw_line)
            line = trim_cols(raw_line)
            if line.size == 0:
                continue
            chunks = [line[:, x0:x1] for x0, x1 in col_chunks(line) if x1 - x0 >= 1]
            if chunks:
                lines_chunks.append(chunks)

        if not lines_chunks:
            return ""

        flat = []
        index = []
        for li, chunks in enumerate(lines_chunks):
            for ci, c in enumerate(chunks):
                index.append((li, ci))
                flat.append(c)

        # Recognize all chunks concurrently (single chunk skips the pool).
        if len(flat) == 1:
            outs = [self.read_line(flat[0])]
        else:
            outs = list(self._pool.map(self.read_line, flat))

        line_texts = [""] * len(lines_chunks)
        for (li, _ci), (text, _conf) in zip(index, outs):
            if not text:
                continue
            if line_texts[li]:
                line_texts[li] += " "
            line_texts[li] += text

        return "\n".join(t for t in line_texts if t)
