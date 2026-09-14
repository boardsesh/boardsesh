#!/usr/bin/env python3
"""Turn the Zenodo "The Way Up" release into a COCO hold dataset.

Source: https://zenodo.org/records/15196867 — CC BY 4.0, so it may be used here
and must be credited on the app's licences screen if anything trained on it
ships. It is climbing video: one indoor route wall, two routes (22 and 31 holds),
re-shot by eleven participants from slightly different camera setups. Each clip
carries one `routeAnnotation.json` whose boxes hold for the whole clip.

What that means for the numbers, stated here because it is easy to forget once
the metrics look like metrics:

* There are about 53 distinct physical holds in the entire dataset. A model
  trained on it learns *those holds on that wall*, not holds in general.
* Frames from one clip are near-duplicates, so the split is **by participant**
  (camera setup) — never by frame, and never by hold. Held-out frames still show
  the same physical holds from a new viewpoint, which is the strongest split the
  source allows and still weaker than a real held-out wall.
* Climbers occlude holds they are using. Those holds stay labelled, so some
  "misses" are the model being right about a hold that is behind a knee.

It is a harness bootstrap, not the corpus the on-device gate should be decided
on. That corpus is real spray-wall photos (see README, "Corpus protocol").
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

ATTRIBUTION = (
    "The Way Up (Zenodo 10.5281/zenodo.15196867), CC BY 4.0. "
    "Frames extracted for hold-detection training; boxes are the release's own routeAnnotation.json."
)


def clips(root: Path) -> list[tuple[str, Path, Path]]:
    """Every (clip id, video, annotation) triple that has both halves on disk."""
    found: list[tuple[str, Path, Path]] = []
    for annotation_path in sorted(root.rglob("*_routeAnnotation.json")):
        route = annotation_path.name.removesuffix("_routeAnnotation.json")
        video_path = annotation_path.parent / f"{route}.mp4"
        if video_path.exists():
            found.append((f"{annotation_path.parent.name}-{route}", video_path, annotation_path))
    return found


def read_boxes(annotation_path: Path) -> list[list[float]]:
    payload = json.loads(annotation_path.read_text())
    boxes: list[list[float]] = []
    for hold in payload.get("holds", []):
        top_left, bottom_right = hold["topLeftCorner"], hold["bottomRightCorner"]
        x0, y0 = float(min(top_left["x"], bottom_right["x"])), float(min(top_left["y"], bottom_right["y"]))
        x1, y1 = float(max(top_left["x"], bottom_right["x"])), float(max(top_left["y"], bottom_right["y"]))
        if x1 - x0 >= 2 and y1 - y0 >= 2:
            boxes.append([x0, y0, x1 - x0, y1 - y0])
    return boxes


def extract_frames(video_path: Path, every: int, limit: int) -> list:
    """Decode every `every`-th frame, at most `limit` of them. PyAV, no ffmpeg binary."""
    import av

    frames = []
    with av.open(str(video_path)) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        for index, frame in enumerate(container.decode(stream)):
            if index % every:
                continue
            frames.append(frame.to_image())
            if len(frames) >= limit:
                break
    return frames


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", required=True, help="the extracted Way Up tree (participant dirs)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--every", type=int, default=45, help="keep one frame in N")
    parser.add_argument("--frames-per-clip", type=int, default=12)
    parser.add_argument("--holdout-participants", default="", help="comma separated, e.g. p9,p10")
    args = parser.parse_args()

    root, out = Path(args.root), Path(args.out)
    found = clips(root)
    if not found:
        raise SystemExit(f"no clip/annotation pairs under {root}")

    holdout = {p.strip() for p in args.holdout_participants.split(",") if p.strip()}
    if not holdout:
        participants = sorted({clip_id.rsplit("-", 1)[0] for clip_id, _, _ in found})
        holdout = set(participants[-max(1, len(participants) // 5) :])
    print(f"held-out participants: {', '.join(sorted(holdout))}")

    splits: dict[str, dict] = {
        name: {"images": [], "annotations": [], "dir": out / name} for name in ("train", "valid", "test")
    }
    for split in splits.values():
        if split["dir"].exists():
            shutil.rmtree(split["dir"])
        split["dir"].mkdir(parents=True)

    for clip_id, video_path, annotation_path in found:
        participant = clip_id.rsplit("-", 1)[0]
        boxes = read_boxes(annotation_path)
        if not boxes:
            print(f"  {clip_id}: no boxes, skipped")
            continue
        frames = extract_frames(video_path, args.every, args.frames_per_clip)
        if not frames:
            print(f"  {clip_id}: no frames decoded, skipped")
            continue

        targets = ["valid", "test"] if participant in holdout else ["train"]
        for target in targets:
            split = splits[target]
            for frame_index, frame in enumerate(frames):
                image_id = len(split["images"]) + 1
                file_name = f"wayup-{clip_id}-f{frame_index:03d}.jpg"
                frame.save(split["dir"] / file_name, quality=88)
                split["images"].append(
                    {
                        "id": image_id,
                        "file_name": file_name,
                        "width": frame.width,
                        "height": frame.height,
                        "clip": clip_id,
                        "participant": participant,
                    }
                )
                for box in boxes:
                    split["annotations"].append(
                        {
                            "id": len(split["annotations"]) + 1,
                            "image_id": image_id,
                            "category_id": 1,
                            "bbox": [round(v, 2) for v in box],
                            "area": round(box[2] * box[3], 2),
                            "iscrowd": 0,
                        }
                    )
        print(f"  {clip_id}: {len(frames)} frames x {len(boxes)} holds -> {'/'.join(targets)}")

    for name, split in splits.items():
        (split["dir"] / "_annotations.coco.json").write_text(
            json.dumps(
                {
                    "info": {"description": "The Way Up, framed for hold detection (SW-01)", "attribution": ATTRIBUTION},
                    "licenses": [{"id": 1, "name": "CC BY 4.0", "url": "https://creativecommons.org/licenses/by/4.0/"}],
                    "categories": [{"id": 1, "name": "hold", "supercategory": "hold"}],
                    "images": split["images"],
                    "annotations": split["annotations"],
                }
            )
        )
        print(f"{name}: {len(split['images'])} frames, {len(split['annotations'])} holds")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
