#!/usr/bin/env python3
"""Build `ml/holds/fixtures/` — the committed inputs the SW-06 Node tests run on.

Only redistributable images may land here. The frames come from "The Way Up"
(Zenodo 10.5281/zenodo.15196867, CC BY 4.0), which permits redistribution with
attribution; the attribution lives in `fixtures/README.md` and in the COCO
`info.attribution` field, and must reach the app's licences screen if anything
trained on this data ships.

Photos collected through `POST /api/spray-wall-test-data` may only be added here
when the uploader's `consent.redistribute` is true.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

HOLDS_DIR = Path(__file__).resolve().parent.parent
DEFAULT_ATTRIBUTION = (
    "See each image record's `licence`, `author` and `page_url`. Wikimedia Commons photos are "
    "reused under their stated CC licence; frames from The Way Up (Zenodo 10.5281/zenodo.15196867) "
    "are CC BY 4.0."
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=str(HOLDS_DIR / ".data" / "coco" / "valid"))
    parser.add_argument("--out", default=str(HOLDS_DIR / "fixtures" / "images"))
    parser.add_argument("--count", type=int, default=3)
    parser.add_argument("--long-side", type=int, default=1024, help="downscale so the repo stays small")
    args = parser.parse_args()

    from PIL import Image

    source, out = Path(args.source), Path(args.out)
    payload = json.loads((source / "_annotations.coco.json").read_text())

    # Spread the picks across clips so the fixtures are not three frames of the
    # same second of video.
    # Group by clip when the source is video frames, otherwise by photo, so the
    # picks are spread across distinct scenes either way.
    by_clip: dict[str, list[dict]] = {}
    for image in payload["images"]:
        by_clip.setdefault(image.get("clip") or image["file_name"], []).append(image)
    picks: list[dict] = []
    round_index = 0
    while len(picks) < args.count and any(by_clip.values()):
        for clip_images in by_clip.values():
            if len(picks) >= args.count:
                break
            # Spread the frame indices too, so three fixtures are not three
            # consecutive frames of the same second of video.
            offset = (len(clip_images) // (args.count + 1)) * (round_index + 1)
            if offset < len(clip_images):
                picks.append(clip_images[offset])
        round_index += 1
        if round_index > args.count:
            break

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    by_image: dict[int, list[dict]] = {}
    for annotation in payload["annotations"]:
        by_image.setdefault(annotation["image_id"], []).append(annotation)

    images: list[dict] = []
    annotations: list[dict] = []
    for image in picks:
        with Image.open(source / image["file_name"]) as handle:
            handle = handle.convert("RGB")
            scale = min(1.0, args.long_side / max(handle.size))
            if scale < 1.0:
                handle = handle.resize((round(handle.width * scale), round(handle.height * scale)), Image.LANCZOS)
            image_id = len(images) + 1
            file_name = image["file_name"]
            handle.save(out / file_name, quality=85)
            images.append(
                {
                    "id": image_id,
                    "file_name": file_name,
                    "width": handle.width,
                    "height": handle.height,
                    # Attribution travels with the image, because a fixture that
                    # loses its credit is a fixture nobody may redistribute.
                    **{
                        key: image[key]
                        for key in ("licence", "author", "page_url", "tags", "clip")
                        if image.get(key)
                    },
                }
            )
        for annotation in by_image.get(image["id"], []):
            annotations.append(
                {
                    "id": len(annotations) + 1,
                    "image_id": image_id,
                    "category_id": 1,
                    "bbox": [round(value * scale, 2) for value in annotation["bbox"]],
                    "area": round(annotation["area"] * scale * scale, 2),
                    "iscrowd": 0,
                }
            )

    (out / "_annotations.coco.json").write_text(
        json.dumps(
            {
                "info": {"description": "SW-01 hold-detection fixtures", "attribution": DEFAULT_ATTRIBUTION},
                "licenses": [],
                "categories": [{"id": 1, "name": "hold", "supercategory": "hold"}],
                "images": images,
                "annotations": annotations,
            },
            indent=2,
        )
    )
    total = sum(path.stat().st_size for path in out.iterdir())
    print(f"{len(images)} fixtures, {len(annotations)} holds, {total / 1024:.0f} KB in {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
