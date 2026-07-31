"""
Tooltip detection module using YOLO DNN (tooltip.onnx).
- Model input size: 640x640
- Confidence threshold: 0.90
- NMS threshold: 0.50
"""

import cv2
import numpy as np


MODEL_WIDTH = 640
MODEL_HEIGHT = 640
MINIMUM_OBJECT_CONFIDENCE = 0.90
NMS_SCORE_THRESHOLD = 0.45
NMS_THRESHOLD = 0.50
MODEL_OBJECTS = ["Tooltip"]


class TooltipDetector:
    def __init__(self, model_path):
        """Load the tooltip.onnx detection model."""
        self.net = cv2.dnn.readNetFromONNX(model_path)

        try:
            if cv2.cuda.getCudaEnabledDeviceCount() > 0:
                self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_CUDA)
                self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CUDA)
            else:
                self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
                self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
        except (AttributeError, cv2.error):
            self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
            self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)

    def find_tooltips(self, screenshot):
        """
        Find tooltip bounding boxes in screenshot.
        Returns list of (x, y, w, h) tuples or empty list.
        """
        if screenshot is None or screenshot.size == 0:
            return []

        # Convert BGRA to BGR if needed
        if len(screenshot.shape) == 3 and screenshot.shape[2] == 4:
            screenshot = cv2.cvtColor(screenshot, cv2.COLOR_BGRA2BGR)

        # Pad to square
        max_dim = max(screenshot.shape[0], screenshot.shape[1])
        resized = np.zeros((max_dim, max_dim, 3), dtype=np.uint8)
        resized[: screenshot.shape[0], : screenshot.shape[1]] = screenshot


        blob = cv2.dnn.blobFromImage(
            resized,
            1 / 255.0,
            (MODEL_WIDTH, MODEL_HEIGHT),
            (0, 0, 0),
            True,
            False,
        )

        self.net.setInput(blob)
        outputs = self.net.forward(self.net.getUnconnectedOutLayersNames())

        # Post-processing
        output = outputs[0]
        rows = output.shape[2]
        dimensions = output.shape[1]

        output = output.reshape(dimensions, rows).T

        x_scale = resized.shape[1] / MODEL_WIDTH
        y_scale = resized.shape[0] / MODEL_HEIGHT

        class_ids = []
        confidences = []
        boxes = []

        for i in range(rows):
            row = output[i]
            classes_scores = row[4:]

            max_score = np.max(classes_scores)
            class_id = np.argmax(classes_scores)

            if max_score > MINIMUM_OBJECT_CONFIDENCE:
                confidences.append(float(max_score))
                class_ids.append(int(class_id))

                x, y, w, h = row[0], row[1], row[2], row[3]

                left = int((x - 0.5 * w) * x_scale)
                top = int((y - 0.5 * h) * y_scale)
                width = int(w * x_scale)
                height = int(h * y_scale)

                boxes.append([left, top, width, height])

        if not boxes:
            return []

        # NMS
        indices = cv2.dnn.NMSBoxes(
            boxes, confidences, NMS_SCORE_THRESHOLD, NMS_THRESHOLD
        )

        if len(indices) == 0:
            return []

        tooltips = []
        for idx in indices:
            if isinstance(idx, (list, np.ndarray)):
                idx = idx[0]
            tooltips.append(tuple(boxes[idx]))

        return tooltips
