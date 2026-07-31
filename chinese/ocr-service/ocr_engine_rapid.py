"""
OCR engine - uses RapidOCR (ONNX Runtime) for Chinese + English text recognition.
Drop-in replacement for PaddleOCR version. Same interface, same accuracy (PP-OCRv4 models).
"""

import cv2
from rapidocr_onnxruntime import RapidOCR


class ChineseOCR:
    def __init__(self):
        """
        Initialize RapidOCR with Chinese + English support.
        Uses PP-OCRv4 models (same as PaddleOCR) via ONNX Runtime.
        """
        self.ocr = RapidOCR(
            text_score=0.3,             # Same as PaddleOCR drop_score=0.3
            use_det=True,
            use_cls=False,              # Same as use_angle_cls=False
            use_rec=True,
            det_db_thresh=0.3,          # Same threshold
            det_db_box_thresh=0.5,      # Same threshold
            intra_op_num_threads=2,     # Use 2 threads to reduce CPU spike
        )

    def read(self, image):
        """
        Read text from an image (BGR numpy array).
        Returns the full text as a single string with newlines.
        """
        if image is None or image.size == 0:
            return ""

        # Resize large images to speed up OCR
        h, w = image.shape[:2]
        max_dim = 800
        if max(h, w) > max_dim:
            scale = max_dim / max(h, w)
            image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)

        try:
            results, _ = self.ocr(image)
        except Exception:
            return ""

        if not results:
            return ""

        # RapidOCR returns: [[box, text, confidence], ...]
        # Sort by Y position (top to bottom), then X (left to right)
        lines = []
        for result in results:
            box = result[0]
            text = result[1]
            confidence = result[2]

            y_pos = min(p[1] for p in box)
            x_pos = min(p[0] for p in box)

            lines.append((y_pos, x_pos, text, confidence))

        lines.sort(key=lambda l: (l[0], l[1]))

        # Group lines that are on the same row (similar Y position)
        grouped_lines = []
        current_group = []
        last_y = None
        y_threshold = 15

        for y, x, text, conf in lines:
            if last_y is not None and abs(y - last_y) > y_threshold:
                if current_group:
                    current_group.sort(key=lambda l: l[1])
                    grouped_lines.append(
                        " ".join(item[2] for item in current_group)
                    )
                    current_group = []

            current_group.append((y, x, text, conf))
            last_y = y

        if current_group:
            current_group.sort(key=lambda l: l[1])
            grouped_lines.append(
                " ".join(item[2] for item in current_group)
            )

        return "\n".join(grouped_lines)

    def read_with_details(self, image):
        """
        Read text with position and confidence details.
        """
        if image is None or image.size == 0:
            return []

        try:
            results, _ = self.ocr(image)
        except Exception:
            return []

        if not results:
            return []

        details = []
        for result in results:
            box = result[0]
            text = result[1]
            confidence = result[2]

            details.append({
                "text": text,
                "box": box,
                "confidence": confidence,
            })

        return details
