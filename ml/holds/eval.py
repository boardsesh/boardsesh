#!/usr/bin/env python3
"""Score an EXPORTED detector on a held-out split of whole photos.

Deliberately never touches the PyTorch weights. The report's numbers have to
describe the artifact a phone downloads from R2 and runs, including whatever the
exporter changed on the way out, so everything here goes through onnxruntime.

What it measures, per config:
  * precision / recall / F1 at box IoU 0.5, over the held-out photos
  * the same at mask IoU 0.5 when both sides have masks
  * per-photo CPU latency (p50 / p95) at the config's resolution and tiling
  * peak resident memory of the process
  * "corrections": false positives plus misses as a share of the real holds —
    what a user has to fix by hand in the hold editor. A box that is present but
    badly placed is NOT counted: at IoU 0.5 it is already a false positive plus a
    miss, and a hold the user only has to nudge is not counted at all. So the
    number is a proxy for effort, not a count of taps.

    Both a micro rate (all corrections over all holds, which is what the reported
    tables quote) and a macro mean over photos are written out; they differ
    whenever photos carry very different hold counts.

Matching is class-agnostic: there is one class, `hold`.
"""

from __future__ import annotations

import argparse
import json
import resource
import sys
import time
from dataclasses import replace
from pathlib import Path

import numpy as np
from PIL import Image

from common import (
    DEFAULT_THREADS,
    HOLDS_DIR,
    DetectorConfig,
    cap_threads,
    greedy_match,
    load_config,
    nms,
    percentile,
    prf,
    tile_boxes,
)


# --------------------------------------------------------------------------- #
# ONNX plumbing
# --------------------------------------------------------------------------- #


class OnnxDetector:
    """One ONNX session plus the RF-DETR output convention.

    RF-DETR emits two tensors: boxes as normalised cxcywh and per-query class
    logits. Neither is named consistently across exporter versions, so they are
    identified by shape (the one whose last dimension is 4 is the boxes) rather
    than by name.
    """

    def __init__(self, model_path: Path, resolution: int, threads: int) -> None:
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(model_path), options, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.resolution = resolution
        # RF-DETR normalises with the ImageNet statistics.
        self.mean = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(3, 1, 1)
        self.std = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(3, 1, 1)

    def preprocess(self, tile: Image.Image) -> np.ndarray:
        resized = tile.convert("RGB").resize((self.resolution, self.resolution), Image.BILINEAR)
        array = np.asarray(resized, dtype=np.float32).transpose(2, 0, 1) / 255.0
        return ((array - self.mean) / self.std)[None, ...]

    def run(self, tile: Image.Image) -> tuple[np.ndarray, np.ndarray]:
        """Return (boxes in tile pixels as xyxy, scores)."""
        outputs = self.session.run(None, {self.input_name: self.preprocess(tile)})

        boxes_raw = next((o for o in outputs if o.ndim == 3 and o.shape[-1] == 4), None)
        logits = next((o for o in outputs if o.ndim == 3 and o.shape[-1] != 4), None)
        if boxes_raw is None or logits is None:
            shapes = [o.shape for o in outputs]
            raise SystemExit(f"unexpected ONNX output shapes {shapes}; decoder needs updating")

        scores = 1.0 / (1.0 + np.exp(-logits[0]))  # sigmoid; RF-DETR uses focal loss, not softmax
        best = scores.max(axis=1)

        centre_x, centre_y, width, height = boxes_raw[0].T
        tile_w, tile_h = tile.size
        boxes = np.stack(
            [
                (centre_x - width / 2) * tile_w,
                (centre_y - height / 2) * tile_h,
                (centre_x + width / 2) * tile_w,
                (centre_y + height / 2) * tile_h,
            ],
            axis=1,
        ).astype(np.float32)
        return boxes, best.astype(np.float32)


def detect(detector: OnnxDetector, photo: Image.Image, config: DetectorConfig) -> tuple[np.ndarray, np.ndarray]:
    """Run the full config — resize, tile, merge — over one photo."""
    scale = config.long_side / max(photo.size)
    working = photo.resize((max(1, round(photo.width * scale)), max(1, round(photo.height * scale))), Image.BILINEAR)

    all_boxes: list[np.ndarray] = []
    all_scores: list[np.ndarray] = []
    for x0, y0, x1, y1 in tile_boxes(working.width, working.height, config.tiles):
        boxes, scores = detector.run(working.crop((x0, y0, x1, y1)))
        keep = scores >= config.score_threshold
        if not keep.any():
            continue
        boxes = boxes[keep] + np.array([x0, y0, x0, y0], dtype=np.float32)
        all_boxes.append(boxes)
        all_scores.append(scores[keep])

    if not all_boxes:
        return np.zeros((0, 4), dtype=np.float32), np.zeros((0,), dtype=np.float32)

    merged_boxes = np.concatenate(all_boxes)
    merged_scores = np.concatenate(all_scores)
    kept = nms(merged_boxes, merged_scores, config.nms_iou)
    # Back into the original photo's pixel coordinates, which is what the ground
    # truth and the hold editor both use.
    return merged_boxes[kept] / scale, merged_scores[kept]


# --------------------------------------------------------------------------- #
# Classical in-box segmentation (the "box-only detector is fine" config)
# --------------------------------------------------------------------------- #


def segment_in_box(photo: Image.Image, box: np.ndarray) -> np.ndarray | None:
    """Guess a hold silhouette inside a detection box, with no learned masks.

    The wall behind a hold is whatever colour dominates the box's border ring, so
    pixels far from that colour are the hold. Largest connected component wins.
    Good enough for a cosmetic outline; the renderer falls back to a ring anyway.
    """
    from scipy import ndimage

    x0, y0, x1, y1 = (int(round(v)) for v in box)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(photo.width, x1), min(photo.height, y1)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None

    crop = np.asarray(photo.convert("RGB").crop((x0, y0, x1, y1)), dtype=np.float32)
    border = np.concatenate([crop[0], crop[-1], crop[:, 0], crop[:, -1]])
    wall_colour = np.median(border, axis=0)

    distance = np.linalg.norm(crop - wall_colour, axis=2)
    threshold = float(np.percentile(distance, 60))
    foreground = distance > max(threshold, 12.0)

    labelled, count = ndimage.label(foreground)
    if count == 0:
        return None
    sizes = ndimage.sum(foreground, labelled, range(1, count + 1))
    largest = int(np.argmax(sizes)) + 1
    mask = np.zeros((photo.height, photo.width), dtype=bool)
    mask[y0:y1, x0:x1] = labelled == largest
    return mask


def polygon_mask(segmentation, height: int, width: int) -> np.ndarray | None:
    if not segmentation:
        return None
    from pycocotools import mask as mask_utils

    if isinstance(segmentation, dict):
        return mask_utils.decode(segmentation).astype(bool)
    rles = mask_utils.frPyObjects(segmentation, height, width)
    return mask_utils.decode(mask_utils.merge(rles)).astype(bool)


def mask_iou(a: np.ndarray, b: np.ndarray) -> float:
    union = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum() / union) if union else 0.0


# --------------------------------------------------------------------------- #


def _portable_model_path(model_path: Path) -> str:
    """Record the model relative to ml/holds when it lives there, so a committed
    fixture never carries one machine's checkout layout."""
    try:
        return str(model_path.resolve().relative_to(HOLDS_DIR))
    except ValueError:
        return model_path.name


def evaluate(config: DetectorConfig, dataset_dir: Path, split: str, model_path: Path, threads: int, limit: int | None):
    annotations_path = dataset_dir / split / "_annotations.coco.json"
    if not annotations_path.exists():
        raise SystemExit(f"no annotations at {annotations_path}")
    payload = json.loads(annotations_path.read_text())

    by_image: dict[int, list[dict]] = {}
    for annotation in payload["annotations"]:
        by_image.setdefault(annotation["image_id"], []).append(annotation)

    detector = OnnxDetector(model_path, config.resolution, threads)
    wants_masks = config.produces_masks

    totals = {"tp": 0, "fp": 0, "fn": 0}
    mask_totals = {"tp": 0, "fp": 0, "fn": 0}
    latencies: list[float] = []
    per_photo: list[dict] = []
    fixtures: list[dict] = []

    images = payload["images"][: limit or None]
    for image in images:
        image_path = dataset_dir / split / image["file_name"]
        photo = Image.open(image_path).convert("RGB")

        started = time.perf_counter()
        boxes, scores = detect(detector, photo, config)
        elapsed = time.perf_counter() - started
        latencies.append(elapsed)

        ground_truth = by_image.get(image["id"], [])
        gt_boxes = np.array(
            [[a["bbox"][0], a["bbox"][1], a["bbox"][0] + a["bbox"][2], a["bbox"][1] + a["bbox"][3]] for a in ground_truth],
            dtype=np.float32,
        ).reshape(-1, 4)

        tp, fp, fn = greedy_match(boxes, scores, gt_boxes)
        totals["tp"] += tp
        totals["fp"] += fp
        totals["fn"] += fn

        if wants_masks:
            gt_masks = [polygon_mask(a.get("segmentation"), image["height"], image["width"]) for a in ground_truth]
            if any(mask is not None for mask in gt_masks):
                predicted_masks = [segment_in_box(photo, box) for box in boxes]
                claimed = [False] * len(gt_masks)
                mask_tp = 0
                for index in np.argsort(-scores):
                    predicted = predicted_masks[index]
                    if predicted is None:
                        continue
                    best_iou, best_index = 0.0, -1
                    for gt_index, gt_mask in enumerate(gt_masks):
                        if claimed[gt_index] or gt_mask is None:
                            continue
                        iou = mask_iou(predicted, gt_mask)
                        if iou > best_iou:
                            best_iou, best_index = iou, gt_index
                    if best_iou >= 0.5:
                        claimed[best_index] = True
                        mask_tp += 1
                mask_totals["tp"] += mask_tp
                # Only masks that were actually produced can be wrong. A detection
                # the segmenter declined to mask is not a mask false positive.
                mask_totals["fp"] += sum(1 for mask in predicted_masks if mask is not None) - mask_tp
                mask_totals["fn"] += sum(1 for gt_index, gt in enumerate(gt_masks) if gt is not None and not claimed[gt_index])

        corrections = fp + fn  # a misplaced box is already one of each
        per_photo.append(
            {
                "file_name": image["file_name"],
                "holds": len(ground_truth),
                "detections": int(len(boxes)),
                "tp": tp,
                "fp": fp,
                "fn": fn,
                "correction_rate": round(corrections / len(ground_truth), 4) if ground_truth else None,
                "seconds": round(elapsed, 3),
            }
        )
        fixtures.append(
            {
                "file_name": image["file_name"],
                "width": image["width"],
                "height": image["height"],
                "detections": [
                    {"box": [round(float(v), 2) for v in box], "score": round(float(score), 4)}
                    for box, score in zip(boxes, scores)
                ],
            }
        )

    precision, recall, f1 = prf(totals["tp"], totals["fp"], totals["fn"])
    rates = [entry["correction_rate"] for entry in per_photo if entry["correction_rate"] is not None]
    total_holds = sum(entry["holds"] for entry in per_photo)

    results = {
        "config": config.name,
        "model": _portable_model_path(model_path),
        "model_bytes": model_path.stat().st_size,
        "dataset": str(dataset_dir),
        "split": split,
        "photos": len(images),
        "holds": sum(entry["holds"] for entry in per_photo),
        "box": {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            **totals,
        },
        "latency_seconds": {
            "p50": round(percentile(latencies, 50), 3),
            "p95": round(percentile(latencies, 95), 3),
            "mean": round(float(np.mean(latencies)) if latencies else 0.0, 3),
        },
        # ru_maxrss is kilobytes on Linux but BYTES on macOS (getrusage(2) on Darwin).
        "peak_rss_mb": round(
            resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            / (1024 * 1024 if sys.platform == "darwin" else 1024),
            1,
        ),
        # Micro: every correction over every hold. This is the one the reports quote.
        "correction_rate_micro": round((totals["fp"] + totals["fn"]) / total_holds, 4) if total_holds else None,
        # Macro: the mean of the per-photo rates, which a photo with three holds can swing.
        "correction_rate_macro": round(float(np.mean(rates)), 4) if rates else None,
        "score_threshold": config.score_threshold,
        "threads": threads,
        "per_photo": per_photo,
    }
    if wants_masks and (mask_totals["tp"] or mask_totals["fn"]):
        mask_precision, mask_recall, mask_f1 = prf(mask_totals["tp"], mask_totals["fp"], mask_totals["fn"])
        results["mask"] = {
            "source": "classical in-box segmentation" if config.name.endswith("classical-mask") else "model",
            "precision": round(mask_precision, 4),
            "recall": round(mask_recall, 4),
            "f1": round(mask_f1, 4),
            **mask_totals,
        }
    return results, fixtures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--dataset", default=str(HOLDS_DIR / ".data" / "coco"))
    parser.add_argument("--split", default="valid")
    parser.add_argument("--model", help="explicit ONNX path; defaults to the config's exported artifact")
    parser.add_argument("--limit", type=int, help="score only the first N photos")
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS)
    parser.add_argument(
        "--score-threshold",
        type=float,
        help="override the config's threshold, to tell a badly calibrated model from a blind one",
    )
    parser.add_argument("--out", help="write the results JSON here")
    parser.add_argument("--write-fixtures", help="write expected-detections.json for the Node parity tests here")
    args = parser.parse_args()

    cap_threads(args.threads)
    config = load_config(args.config)
    if args.score_threshold is not None:
        config = replace(config, score_threshold=args.score_threshold)
    model_path = Path(args.model) if args.model else config.onnx_path
    if not model_path.exists():
        raise SystemExit(f"no exported model at {model_path}; run export.py first")

    results, fixtures = evaluate(config, Path(args.dataset), args.split, model_path, args.threads, args.limit)

    summary = {key: value for key, value in results.items() if key != "per_photo"}
    print(json.dumps(summary, indent=2))

    out_path = Path(args.out) if args.out else HOLDS_DIR / ".data" / "artifacts" / config.name / "eval.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(results, indent=2))
    print(f"\nwrote {out_path}")

    if args.write_fixtures:
        fixture_path = Path(args.write_fixtures)
        fixture_path.parent.mkdir(parents=True, exist_ok=True)
        fixture_path.write_text(
            json.dumps(
                {
                    "generatedBy": "ml/holds/eval.py",
                    "config": config.name,
                    "model": model_path.name,
                    "resolution": config.resolution,
                    "longSide": config.long_side,
                    "tiles": {"rows": config.tiles.rows, "cols": config.tiles.cols, "overlap": config.tiles.overlap},
                    "scoreThreshold": config.score_threshold,
                    "nmsIou": config.nms_iou,
                    "images": fixtures,
                },
                indent=2,
            )
        )
        print(f"wrote {fixture_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
