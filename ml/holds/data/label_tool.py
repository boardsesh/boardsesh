#!/usr/bin/env python3
"""Hand-labelling aid for the real-wall evaluation corpus.

There is no labelling GUI on this box, and the corpus has to be labelled by eye,
so the loop is: look at a gridded copy of the photo, write boxes into a JSON
file, render them back over the photo, look again, fix. `grid` and `render` are
the two halves of that loop; `merge` turns the finished per-photo JSON files into
one COCO set that `eval.py` can score.

Label file format, one per photo, in `labels/<image stem>.json`:

    {
      "file_name": "some-wall.jpg",
      "usable": true,
      "notes": "dense, wood-on-wood section top left",
      "tags": ["dense", "wood-on-wood"],
      "boxes": [[x, y, w, h], ...]
    }

`usable: false` marks a photo that is not a wall-with-holds at all (a portrait of
a climber, a route from 30 m away, a diagram). Those are excluded from the corpus
rather than labelled with zero holds, which would poison precision.

`"partial": true` marks a photo where only part of the wall could be labelled
honestly — usually because the far holds are 6-15 px, small enough that a drawn
box covers the hold and the check step stops telling you anything. Those are kept
on disk (the work is real) but left out of the scored corpus by default, because
every detection in the unlabelled region would be charged as a false positive.
`--include-partial` merges them anyway.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

HOLDS_DIR = Path(__file__).resolve().parent.parent


def draw_grid(image, step: int):
    from PIL import ImageDraw

    canvas = image.copy()
    draw = ImageDraw.Draw(canvas)
    for x in range(0, canvas.width, step):
        draw.line([(x, 0), (x, canvas.height)], fill=(0, 255, 255), width=1)
        draw.text((x + 2, 2), str(x), fill=(0, 255, 255))
    for y in range(0, canvas.height, step):
        draw.line([(0, y), (canvas.width, y)], fill=(255, 0, 255), width=1)
        draw.text((2, y + 2), str(y), fill=(255, 0, 255))
    return canvas


def command_grid(args) -> int:
    from PIL import Image

    source = Path(args.image)
    with Image.open(source) as handle:
        gridded = draw_grid(handle.convert("RGB"), args.step)
    destination = Path(args.out or source.with_name(f"{source.stem}-grid.jpg"))
    gridded.save(destination, quality=88)
    print(f"{destination} ({gridded.width}x{gridded.height}, grid every {args.step}px)")
    return 0


def command_render(args) -> int:
    from PIL import Image, ImageDraw

    label = json.loads(Path(args.labels).read_text())
    source = Path(args.image)
    with Image.open(source) as handle:
        canvas = handle.convert("RGB")
    draw = ImageDraw.Draw(canvas)
    for index, (x, y, width, height) in enumerate(label.get("boxes", [])):
        draw.rectangle([x, y, x + width, y + height], outline=(255, 40, 40), width=3)
        draw.text((x + 3, y + 3), str(index), fill=(255, 255, 0))
    destination = Path(args.out or source.with_name(f"{source.stem}-labelled.jpg"))
    canvas.save(destination, quality=88)
    print(f"{destination}: {len(label.get('boxes', []))} boxes")
    return 0


def command_merge(args) -> int:
    from PIL import Image

    corpus = Path(args.corpus)
    images_dir = corpus / "images"
    labels_dir = corpus / "labels"
    out_dir = Path(args.out)

    attribution: dict[str, dict] = {}
    sources_path = corpus / "sources.csv"
    if sources_path.exists():
        with sources_path.open() as handle:
            for row in csv.DictReader(handle):
                attribution[row["file_name"]] = row

    images: list[dict] = []
    annotations: list[dict] = []
    pending: list[tuple[str, Path]] = []
    skipped = 0
    for label_path in sorted(labels_dir.glob("*.json")):
        label = json.loads(label_path.read_text())
        if not label.get("usable", True):
            skipped += 1
            continue
        if label.get("partial") and not args.include_partial:
            # A photo where only part of the wall could be labelled would charge
            # every detection in the unlabelled region as a false positive, so it
            # is kept on disk and left out of the scored corpus.
            skipped += 1
            continue
        boxes = label.get("boxes") or []
        if not boxes:
            skipped += 1
            continue
        file_name = label.get("file_name") or f"{label_path.stem}.jpg"
        source_image = images_dir / file_name
        if not source_image.exists():
            print(f"  missing image for {label_path.name}")
            continue
        with Image.open(source_image) as handle:
            width, height = handle.size
        row = attribution.get(file_name, {})
        image_id = len(images) + 1
        pending.append((file_name, source_image))
        images.append(
            {
                "id": image_id,
                "file_name": file_name,
                "width": width,
                "height": height,
                "licence": row.get("licence"),
                "author": row.get("author"),
                "page_url": row.get("page_url"),
                "tags": label.get("tags", []),
                "notes": label.get("notes", ""),
            }
        )
        for x, y, box_width, box_height in boxes:
            annotations.append(
                {
                    "id": len(annotations) + 1,
                    "image_id": image_id,
                    "category_id": 1,
                    "bbox": [round(float(x), 2), round(float(y), 2), round(float(box_width), 2), round(float(box_height), 2)],
                    "area": round(float(box_width) * float(box_height), 2),
                    "iscrowd": 0,
                }
            )

    # Optionally cut the corpus in half by photo. The point is the score
    # threshold: picking it on the same photos the F1 is reported on flatters the
    # number, so `tune` is where the sweep runs and `eval` is what gets published.
    if args.halves:
        assignments = [("tune" if index % 2 == 0 else "eval") for index in range(len(images))]
    else:
        assignments = [args.split] * len(images)

    written: dict[str, tuple[list[dict], list[dict]]] = {}
    for image, assignment, (file_name, source_image) in zip(images, assignments, pending):
        split_images, split_annotations = written.setdefault(assignment, ([], []))
        new_id = len(split_images) + 1
        split_images.append({**image, "id": new_id})
        for annotation in annotations:
            if annotation["image_id"] != image["id"]:
                continue
            split_annotations.append({**annotation, "id": len(split_annotations) + 1, "image_id": new_id})
        (out_dir / assignment).mkdir(parents=True, exist_ok=True)
        (out_dir / assignment / file_name).write_bytes(source_image.read_bytes())

    for split_name, (split_images, split_annotations) in written.items():
        (out_dir / split_name / "_annotations.coco.json").write_text(
            json.dumps(
                {
                    "info": {
                        "description": "Boardsesh real-wall hold-detection evaluation corpus (SW-01)",
                        "attribution": "Per-image licence, author and source page in each image record and in sources.csv.",
                    },
                    "licenses": [],
                    "categories": [{"id": 1, "name": "hold", "supercategory": "hold"}],
                    "images": split_images,
                    "annotations": split_annotations,
                },
                indent=2,
            )
        )
        tags: dict[str, int] = {}
        for image in split_images:
            for tag in image.get("tags", []):
                tags[tag] = tags.get(tag, 0) + 1
        print(f"{split_name}: {len(split_images)} photos, {len(split_annotations)} holds -> {out_dir / split_name}")
        print("  tags:", ", ".join(f"{tag}={count}" for tag, count in sorted(tags.items())) or "none")
    print(f"{skipped} skipped as unusable or partial")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    grid = sub.add_parser("grid", help="write a coordinate-gridded copy of a photo")
    grid.add_argument("--image", required=True)
    grid.add_argument("--step", type=int, default=100)
    grid.add_argument("--out")
    grid.set_defaults(func=command_grid)

    render = sub.add_parser("render", help="draw a label file's boxes over its photo")
    render.add_argument("--image", required=True)
    render.add_argument("--labels", required=True)
    render.add_argument("--out")
    render.set_defaults(func=command_render)

    merge = sub.add_parser("merge", help="merge the per-photo label files into a COCO split")
    merge.add_argument("--corpus", default=str(HOLDS_DIR / ".data" / "realwall"))
    merge.add_argument("--out", default=str(HOLDS_DIR / ".data" / "realwall-coco"))
    merge.add_argument("--split", default="valid")
    merge.add_argument(
        "--halves",
        action="store_true",
        help="write `tune` and `eval` splits instead of one: sweep the threshold on tune, report on eval",
    )
    merge.add_argument(
        "--include-partial",
        action="store_true",
        help="also merge labels flagged partial (only part of the wall was labelled); skews precision",
    )
    merge.set_defaults(func=command_merge)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
