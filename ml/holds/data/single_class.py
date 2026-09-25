#!/usr/bin/env python3
"""Collapse a multi-category COCO dataset into the single `hold` class.

The Roboflow climbing-holds set separates holds from volumes. Boardsesh does not:
a volume is something you pull on or stand on, the renderer draws it the same way,
and the spray-wall corpus was labelled with volumes as holds. Training on two
classes would teach a distinction the product then has to throw away.

Images are symlinked, not copied — the source dataset is 371 MB and there is no
reason to have two of it.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

HOLDS_DIR = Path(__file__).resolve().parent.parent


def convert(source: Path, target: Path, limit: int | None) -> dict[str, int]:
    payload = json.loads((source / "_annotations.coco.json").read_text())

    images = payload["images"]
    if limit and len(images) > limit:
        # Evenly spaced rather than the first N: a Roboflow export is ordered by
        # upload, so the head of the list is one photographer's session.
        stride = len(images) / limit
        images = [images[int(index * stride)] for index in range(limit)]
    kept = {image["id"] for image in images}

    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)

    for image in images:
        source_image = source / image["file_name"]
        if source_image.exists():
            (target / image["file_name"]).symlink_to(source_image.resolve())

    annotations = [
        {**annotation, "category_id": 1}
        for annotation in payload["annotations"]
        if annotation["image_id"] in kept and annotation.get("bbox", [0, 0, 0, 0])[2] > 1
    ]
    (target / "_annotations.coco.json").write_text(
        json.dumps(
            {
                "info": payload.get("info", {}),
                "licenses": payload.get("licenses", []),
                "categories": [{"id": 1, "name": "hold", "supercategory": "hold"}],
                "images": images,
                "annotations": annotations,
            }
        )
    )
    return {"images": len(images), "boxes": len(annotations)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="a COCO root with train/valid/test subdirectories")
    parser.add_argument("--target", required=True)
    parser.add_argument("--limit-train", type=int, help="cap the training split; CPU training is slow")
    args = parser.parse_args()

    for split in ("train", "valid", "test"):
        source_split = Path(args.source) / split
        if not source_split.exists():
            continue
        summary = convert(source_split, Path(args.target) / split, args.limit_train if split == "train" else None)
        print(f"{split}: {summary['images']} images, {summary['boxes']} holds")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
