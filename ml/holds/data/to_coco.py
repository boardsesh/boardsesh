#!/usr/bin/env python3
"""Convert every fetched source into one COCO dataset with a single `hold` class.

Output layout is what `rfdetr`'s trainer expects, so `train.py` needs no adapter:

    .data/coco/
      train/_annotations.coco.json  + the image files
      valid/_annotations.coco.json  + the image files
      test/_annotations.coco.json   + the image files   (== valid when --no-test)

The split is **by photo**, never by hold: two holds from the same wall must not
land on opposite sides of the split, or every metric is inflated by the model
having already seen that wall, its lighting and its hold set.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any, Iterator

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common import split_by_image  # noqa: E402

HOLDS_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = HOLDS_DIR / ".data"
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
CATEGORY = {"id": 1, "name": "hold", "supercategory": "hold"}


def iter_images(root: Path) -> Iterator[Path]:
    for path in sorted(root.rglob("*")):
        if path.suffix.lower() in IMAGE_SUFFIXES and path.is_file():
            yield path


# --------------------------------------------------------------------------- #
# Readers — each returns (image_path, [(x, y, w, h), ...], [polygon | None, ...])
# --------------------------------------------------------------------------- #


def read_coco_tree(root: Path) -> Iterator[tuple[Path, list[list[float]], list[Any]]]:
    """Any directory tree containing COCO json files next to their images."""
    for annotation_path in sorted(root.rglob("*.json")):
        try:
            payload = json.loads(annotation_path.read_text())
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if not isinstance(payload, dict) or "images" not in payload or "annotations" not in payload:
            continue

        by_image: dict[int, list[dict]] = {}
        for annotation in payload["annotations"]:
            by_image.setdefault(annotation["image_id"], []).append(annotation)

        for image in payload["images"]:
            image_path = annotation_path.parent / image["file_name"]
            if not image_path.exists():
                continue
            annotations = by_image.get(image["id"], [])
            boxes = [list(map(float, a["bbox"])) for a in annotations]
            polygons = [a.get("segmentation") or None for a in annotations]
            yield image_path, boxes, polygons


def read_yolo_tree(root: Path) -> Iterator[tuple[Path, list[list[float]], list[Any]]]:
    """YOLO layout: `images/x.jpg` with `labels/x.txt` holding cls cx cy w h (normalised)."""
    from PIL import Image

    for image_path in iter_images(root):
        parts = list(image_path.parts)
        if "images" not in parts:
            continue
        parts[len(parts) - 1 - parts[::-1].index("images")] = "labels"
        label_path = Path(*parts).with_suffix(".txt")
        if not label_path.exists():
            continue
        with Image.open(image_path) as handle:
            width, height = handle.size
        boxes: list[list[float]] = []
        for line in label_path.read_text().splitlines():
            fields = line.split()
            if len(fields) < 5:
                continue
            centre_x, centre_y, box_w, box_h = (float(v) for v in fields[1:5])
            boxes.append(
                [
                    (centre_x - box_w / 2) * width,
                    (centre_y - box_h / 2) * height,
                    box_w * width,
                    box_h * height,
                ]
            )
        yield image_path, boxes, [None] * len(boxes)


READERS = {"coco": read_coco_tree, "yolo": read_yolo_tree}


# --------------------------------------------------------------------------- #


def build(sources: list[tuple[str, Path, str]], holdout_fraction: float, seed: int, out_dir: Path) -> dict[str, Any]:
    images: list[dict[str, Any]] = []
    annotations: list[dict[str, Any]] = []
    source_paths: list[Path] = []

    for source_name, root, fmt in sources:
        reader = READERS[fmt]
        found = 0
        for image_path, boxes, polygons in reader(root):
            if not boxes:
                continue
            from PIL import Image

            with Image.open(image_path) as handle:
                width, height = handle.size
            image_id = len(images) + 1
            images.append(
                {
                    "id": image_id,
                    "file_name": f"{source_name}-{image_id:05d}{image_path.suffix.lower()}",
                    "width": width,
                    "height": height,
                    "source": source_name,
                }
            )
            source_paths.append(image_path)
            for box, polygon in zip(boxes, polygons):
                annotations.append(
                    {
                        "id": len(annotations) + 1,
                        "image_id": image_id,
                        "category_id": 1,
                        "bbox": [round(v, 2) for v in box],
                        "area": round(box[2] * box[3], 2),
                        "iscrowd": 0,
                        **({"segmentation": polygon} if polygon else {}),
                    }
                )
            found += 1
        print(f"[{source_name}] {found} annotated photos from {root}")

    if not images:
        raise SystemExit("no annotated photos found — check the source paths and formats")

    train_ids, valid_ids = split_by_image([image["id"] for image in images], holdout_fraction, seed)
    memberships = {"train": set(train_ids), "valid": set(valid_ids), "test": set(valid_ids)}

    for split, ids in memberships.items():
        split_dir = out_dir / split
        if split_dir.exists():
            shutil.rmtree(split_dir)
        split_dir.mkdir(parents=True)

        split_images = [image for image in images if image["id"] in ids]
        for image in split_images:
            index = next(i for i, candidate in enumerate(images) if candidate["id"] == image["id"])
            shutil.copy2(source_paths[index], split_dir / image["file_name"])

        payload = {
            "info": {"description": "Boardsesh spray-wall hold corpus (SW-01)", "version": "1"},
            "licenses": [],
            "categories": [CATEGORY],
            "images": split_images,
            "annotations": [a for a in annotations if a["image_id"] in ids],
        }
        (split_dir / "_annotations.coco.json").write_text(json.dumps(payload))
        print(f"  {split}: {len(split_images)} photos, {len(payload['annotations'])} holds")

    return {
        "photos": len(images),
        "holds": len(annotations),
        "train_photos": len(train_ids),
        "valid_photos": len(valid_ids),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        action="append",
        required=True,
        metavar="NAME:PATH:FORMAT",
        help="a fetched source, e.g. roboflow-holds:.data/roboflow-holds:coco (format: coco|yolo)",
    )
    parser.add_argument("--out", default=str(DATA_DIR / "coco"))
    parser.add_argument("--holdout-fraction", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=20260914)
    args = parser.parse_args()

    sources: list[tuple[str, Path, str]] = []
    for spec in args.source:
        name, path, fmt = spec.rsplit(":", 2)
        if fmt not in READERS:
            raise SystemExit(f"unknown format {fmt!r}; known: {', '.join(READERS)}")
        sources.append((name, Path(path), fmt))

    summary = build(sources, args.holdout_fraction, args.seed, Path(args.out))
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
