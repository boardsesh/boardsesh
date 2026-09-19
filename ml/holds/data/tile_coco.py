#!/usr/bin/env python3
"""Cut a COCO dataset into the tiles a tiled config will see at inference time.

A detector trained on whole 4000 px photos and then run on 512 px tiles sees holds
at a completely different scale, so a tiled config trains on tiles. The grid here
is the same `tile_boxes` the evaluator uses, so train-time and test-time crops
line up exactly.

A ground-truth box is kept for a tile when at least `--min-visible` of its area
survives the crop; a hold clipped to a sliver would otherwise teach the model to
call a corner of a hold a whole hold.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common import TileGrid, tile_boxes  # noqa: E402


def clip_polygon_to_tile(segmentation, scale: float, x0: float, y0: float, x1: float, y1: float):
    """Clip a COCO polygon to one tile, returned in tile-local coordinates.

    Sutherland-Hodgman against the four tile edges. The clip region is a
    rectangle — convex — so the algorithm is exact here, and it keeps this file
    dependency-free rather than pulling shapely in for one crop.

    Without this a tiled config silently trains its mask head on empty
    polygons: the boxes survive the crop and the outlines do not.
    """
    if not segmentation:
        return []

    def clip_edge(points, inside, intersect):
        if not points:
            return []
        output = []
        previous = points[-1]
        for current in points:
            if inside(current):
                if not inside(previous):
                    output.append(intersect(previous, current))
                output.append(current)
            elif inside(previous):
                output.append(intersect(previous, current))
            previous = current
        return output

    def cut(points, axis, bound, keep_greater):
        def inside(point):
            return point[axis] >= bound if keep_greater else point[axis] <= bound

        def intersect(a, b):
            span = b[axis] - a[axis]
            t = 0.0 if span == 0 else (bound - a[axis]) / span
            other = 1 - axis
            crossed = [0.0, 0.0]
            crossed[axis] = bound
            crossed[other] = a[other] + t * (b[other] - a[other])
            return (crossed[0], crossed[1])

        return clip_edge(points, inside, intersect)

    clipped_rings = []
    for ring in segmentation:
        points = [(ring[i] * scale, ring[i + 1] * scale) for i in range(0, len(ring) - 1, 2)]
        if len(points) < 3:
            continue
        for axis, bound, keep_greater in ((0, x0, True), (0, x1, False), (1, y0, True), (1, y1, False)):
            points = cut(points, axis, bound, keep_greater)
            if not points:
                break
        if len(points) < 3:
            continue
        clipped_rings.append([round(value, 2) for point in points for value in (point[0] - x0, point[1] - y0)])
    return clipped_rings


def tile_split(source: Path, target: Path, grid: TileGrid, min_visible: float, long_side: int) -> dict[str, int]:
    annotation_path = source / "_annotations.coco.json"
    payload = json.loads(annotation_path.read_text())

    by_image: dict[int, list[dict]] = {}
    for annotation in payload["annotations"]:
        by_image.setdefault(annotation["image_id"], []).append(annotation)

    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)

    images: list[dict] = []
    annotations: list[dict] = []

    for image in payload["images"]:
        image_path = source / image["file_name"]
        if not image_path.exists():
            continue
        with Image.open(image_path) as opened:
            handle = opened.convert("RGB")
            # Resize to the same long side the evaluator uses before tiling, so a
            # hold is the same number of pixels at training time and at test time.
            scale = long_side / max(handle.size)
            if scale != 1.0:
                handle = handle.resize((max(1, round(handle.width * scale)), max(1, round(handle.height * scale))), Image.BILINEAR)
            width, height = handle.size
            for tile_index, (x0, y0, x1, y1) in enumerate(tile_boxes(width, height, grid)):
                kept: list[dict] = []
                for annotation in by_image.get(image["id"], []):
                    box_x, box_y, box_w, box_h = (v * scale for v in annotation["bbox"])
                    clipped_x0 = max(box_x, x0)
                    clipped_y0 = max(box_y, y0)
                    clipped_x1 = min(box_x + box_w, x1)
                    clipped_y1 = min(box_y + box_h, y1)
                    clipped_w = clipped_x1 - clipped_x0
                    clipped_h = clipped_y1 - clipped_y0
                    if clipped_w <= 1 or clipped_h <= 1:
                        continue
                    original_area = max(box_w * box_h, 1e-6)
                    if (clipped_w * clipped_h) / original_area < min_visible:
                        continue
                    kept.append(
                        {
                            "bbox": [clipped_x0 - x0, clipped_y0 - y0, clipped_w, clipped_h],
                            "area": clipped_w * clipped_h,
                            "segmentation": clip_polygon_to_tile(
                                annotation.get("segmentation"), scale, x0, y0, x1, y1
                            ),
                        }
                    )
                if not kept:
                    continue

                tile_id = len(images) + 1
                file_name = f"{Path(image['file_name']).stem}-t{tile_index}.jpg"
                handle.crop((x0, y0, x1, y1)).save(target / file_name, quality=92)
                images.append(
                    {
                        "id": tile_id,
                        "file_name": file_name,
                        "width": x1 - x0,
                        "height": y1 - y0,
                        "parent_image_id": image["id"],
                        "tile_index": tile_index,
                    }
                )
                for entry in kept:
                    annotations.append(
                        {
                            "id": len(annotations) + 1,
                            "image_id": tile_id,
                            "category_id": 1,
                            "bbox": [round(v, 2) for v in entry["bbox"]],
                            "area": round(entry["area"], 2),
                            "segmentation": entry["segmentation"],
                            "iscrowd": 0,
                        }
                    )

    (target / "_annotations.coco.json").write_text(
        json.dumps(
            {
                "info": payload.get("info", {}),
                "licenses": payload.get("licenses", []),
                "categories": payload["categories"],
                "images": images,
                "annotations": annotations,
            }
        )
    )
    return {"tiles": len(images), "holds": len(annotations)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="a COCO dataset root with train/valid/test subdirectories")
    parser.add_argument("--target", required=True)
    parser.add_argument("--rows", type=int, default=2)
    parser.add_argument("--cols", type=int, default=2)
    parser.add_argument("--overlap", type=float, default=0.15)
    parser.add_argument("--min-visible", type=float, default=0.5)
    parser.add_argument("--long-side", type=int, default=1024, help="resize each photo to this long side before tiling")
    args = parser.parse_args()

    grid = TileGrid(args.rows, args.cols, args.overlap)
    for split in ("train", "valid", "test"):
        source_split = Path(args.source) / split
        if not source_split.exists():
            continue
        summary = tile_split(source_split, Path(args.target) / split, grid, args.min_visible, args.long_side)
        print(f"{split}: {summary['tiles']} tiles, {summary['holds']} holds")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
