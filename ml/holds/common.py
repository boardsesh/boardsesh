"""Shared pieces of the hold-detection spike: configs, tiling, NMS, matching.

Offline only. Nothing here ships to the app; the on-device runtime is TypeScript
plus a native inference library (see RUNTIME.md). This module exists so that
`train.py`, `export.py` and `eval.py` all agree on one tiling and post-processing
contract, which SW-06 later re-implements in TypeScript and checks against
`fixtures/expected-detections.json`.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np

HOLDS_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = HOLDS_DIR / "configs.json"

# The VM this spike runs on has no GPU and has fallen over under concurrent heavy
# processes, so every entry point caps its own thread pool rather than trusting
# the default (one thread per core).
DEFAULT_THREADS = int(os.environ.get("HOLDS_THREADS", "8"))


def cap_threads(threads: int = DEFAULT_THREADS) -> None:
    """Pin BLAS/OpenMP/torch thread counts before any heavy import does work."""
    for var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
        os.environ.setdefault(var, str(threads))
    try:
        import torch

        torch.set_num_threads(threads)
    except ImportError:
        pass


@dataclass(frozen=True)
class TileGrid:
    """How one photo is cut up before it reaches the detector."""

    rows: int
    cols: int
    overlap: float  # fraction of the tile's side that neighbouring tiles share

    @property
    def untiled(self) -> bool:
        return self.rows == 1 and self.cols == 1


@dataclass(frozen=True)
class DetectorConfig:
    """One evaluable configuration: a model family/variant plus a tiling scheme."""

    name: str
    family: str
    variant: str
    resolution: int  # the square side the model itself consumes
    long_side: int  # the side the photo is resized to before tiling
    tiles: TileGrid
    score_threshold: float
    nms_iou: float
    produces_masks: bool
    num_classes: int = 1
    notes: str = ""
    train: dict[str, Any] = field(default_factory=dict)

    @property
    def onnx_path(self) -> Path:
        return HOLDS_DIR / ".data" / "artifacts" / self.name / "model.onnx"

    @property
    def checkpoint_dir(self) -> Path:
        return HOLDS_DIR / ".data" / "runs" / self.name


def load_configs(path: Path | None = None) -> dict[str, DetectorConfig]:
    raw = json.loads((path or DEFAULT_CONFIG_PATH).read_text())
    configs: dict[str, DetectorConfig] = {}
    for name, entry in raw["configs"].items():
        tiles = entry.get("tiles", {"rows": 1, "cols": 1, "overlap": 0.0})
        configs[name] = DetectorConfig(
            name=name,
            family=entry["family"],
            variant=entry["variant"],
            resolution=int(entry["resolution"]),
            long_side=int(entry["long_side"]),
            tiles=TileGrid(int(tiles["rows"]), int(tiles["cols"]), float(tiles.get("overlap", 0.0))),
            score_threshold=float(entry.get("score_threshold", 0.3)),
            nms_iou=float(entry.get("nms_iou", 0.5)),
            produces_masks=bool(entry.get("produces_masks", False)),
            num_classes=int(entry.get("num_classes", 1)),
            notes=entry.get("notes", ""),
            train=entry.get("train", {}),
        )
    return configs


def load_config(name: str, path: Path | None = None) -> DetectorConfig:
    configs = load_configs(path)
    if name not in configs:
        raise SystemExit(f"unknown config {name!r}; known: {', '.join(sorted(configs))}")
    return configs[name]


# --------------------------------------------------------------------------- #
# Geometry
# --------------------------------------------------------------------------- #


def tile_boxes(width: int, height: int, grid: TileGrid) -> list[tuple[int, int, int, int]]:
    """Return the (x0, y0, x1, y1) crop windows for a grid, in image pixels.

    Tiles overlap by `grid.overlap` of a tile side so a hold sitting on a seam is
    whole in at least one tile. The last row/column is clamped to the image edge,
    so the windows cover the image exactly with no padding.
    """
    if grid.untiled:
        return [(0, 0, width, height)]

    windows: list[tuple[int, int, int, int]] = []
    tile_w = int(round(width / grid.cols * (1.0 + grid.overlap)))
    tile_h = int(round(height / grid.rows * (1.0 + grid.overlap)))
    step_x = max(1, (width - tile_w) // max(1, grid.cols - 1)) if grid.cols > 1 else width
    step_y = max(1, (height - tile_h) // max(1, grid.rows - 1)) if grid.rows > 1 else height

    for row in range(grid.rows):
        for col in range(grid.cols):
            x0 = min(col * step_x, max(0, width - tile_w))
            y0 = min(row * step_y, max(0, height - tile_h))
            windows.append((x0, y0, min(x0 + tile_w, width), min(y0 + tile_h, height)))
    return windows


def box_iou_matrix(boxes_a: np.ndarray, boxes_b: np.ndarray) -> np.ndarray:
    """IoU of every box in A against every box in B. Both are (N, 4) xyxy."""
    if boxes_a.size == 0 or boxes_b.size == 0:
        return np.zeros((len(boxes_a), len(boxes_b)), dtype=np.float32)

    area_a = np.clip(boxes_a[:, 2] - boxes_a[:, 0], 0, None) * np.clip(boxes_a[:, 3] - boxes_a[:, 1], 0, None)
    area_b = np.clip(boxes_b[:, 2] - boxes_b[:, 0], 0, None) * np.clip(boxes_b[:, 3] - boxes_b[:, 1], 0, None)

    left = np.maximum(boxes_a[:, None, 0], boxes_b[None, :, 0])
    top = np.maximum(boxes_a[:, None, 1], boxes_b[None, :, 1])
    right = np.minimum(boxes_a[:, None, 2], boxes_b[None, :, 2])
    bottom = np.minimum(boxes_a[:, None, 3], boxes_b[None, :, 3])

    inter = np.clip(right - left, 0, None) * np.clip(bottom - top, 0, None)
    union = area_a[:, None] + area_b[None, :] - inter
    return np.where(union > 0, inter / union, 0.0).astype(np.float32)


def nms(boxes: np.ndarray, scores: np.ndarray, iou_threshold: float) -> list[int]:
    """Plain greedy non-maximum suppression. Class-agnostic: a hold is a hold."""
    if boxes.size == 0:
        return []
    order = np.argsort(-scores)
    keep: list[int] = []
    while order.size > 0:
        best = int(order[0])
        keep.append(best)
        if order.size == 1:
            break
        ious = box_iou_matrix(boxes[best][None, :], boxes[order[1:]])[0]
        order = order[1:][ious <= iou_threshold]
    return keep


def greedy_match(
    pred_boxes: np.ndarray,
    pred_scores: np.ndarray,
    gt_boxes: np.ndarray,
    iou_threshold: float = 0.5,
) -> tuple[int, int, int]:
    """Match predictions to ground truth at an IoU threshold.

    Highest-scoring prediction claims its best free ground-truth box, COCO-style.
    Returns (true positives, false positives, false negatives).
    """
    if len(gt_boxes) == 0:
        return 0, len(pred_boxes), 0
    if len(pred_boxes) == 0:
        return 0, 0, len(gt_boxes)

    ious = box_iou_matrix(pred_boxes, gt_boxes)
    claimed = np.zeros(len(gt_boxes), dtype=bool)
    true_positives = 0
    for pred_index in np.argsort(-pred_scores):
        candidates = np.where(~claimed, ious[pred_index], -1.0)
        best_gt = int(np.argmax(candidates))
        if candidates[best_gt] >= iou_threshold:
            claimed[best_gt] = True
            true_positives += 1
    false_positives = len(pred_boxes) - true_positives
    false_negatives = int((~claimed).sum())
    return true_positives, false_positives, false_negatives


def prf(true_positives: int, false_positives: int, false_negatives: int) -> tuple[float, float, float]:
    precision = true_positives / (true_positives + false_positives) if true_positives + false_positives else 0.0
    recall = true_positives / (true_positives + false_negatives) if true_positives + false_negatives else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return precision, recall, f1


# --------------------------------------------------------------------------- #
# Splits
# --------------------------------------------------------------------------- #


def split_by_image(image_ids: Sequence[int], holdout_fraction: float, seed: int = 20260914) -> tuple[list[int], list[int]]:
    """Hold out whole photos, never individual holds.

    Splitting by hold would put holds from the same wall on both sides and make
    every number a lie: the model would have seen that exact wall, lighting and
    hold set during training.
    """
    rng = np.random.default_rng(seed)
    ordered = list(image_ids)
    rng.shuffle(ordered)
    cut = max(1, int(round(len(ordered) * holdout_fraction)))
    return sorted(ordered[cut:]), sorted(ordered[:cut])


def percentile(values: Iterable[float], pct: float) -> float:
    array = np.asarray(list(values), dtype=np.float64)
    return float(np.percentile(array, pct)) if array.size else 0.0
