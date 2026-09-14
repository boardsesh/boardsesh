#!/usr/bin/env python3
"""Train one hold detector. One pipeline; the config picks the model family.

Apache-2.0 families only (epic #5346, 2026-09-14). The only family wired up today
is RF-DETR (`rfdetr`, Apache-2.0, weights Apache-2.0). YOLOX / D-FINE / RT-DETR
are the sanctioned alternatives if RF-DETR disappoints; add them as another branch
of `build_model`, not as a second script. Ultralytics is AGPL-3.0 and must never
be installed in this repo.

This runs on CPU. It is slow on purpose: the box it was written on has no GPU and
has fallen over under concurrent heavy jobs, so run one training at a time.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from common import DEFAULT_THREADS, HOLDS_DIR, cap_threads, load_config

RFDETR_VARIANTS = {
    "nano": "RFDETRNano",
    "small": "RFDETRSmall",
    "medium": "RFDETRMedium",
    "seg-nano": "RFDETRSegNano",
    "seg-small": "RFDETRSegSmall",
}


def build_model(family: str, variant: str, resolution: int):
    if family != "rfdetr":
        raise SystemExit(
            f"family {family!r} is not wired up. Apache-2.0 families only: rfdetr, yolox, dfine, rtdetr."
        )
    import rfdetr

    if variant not in RFDETR_VARIANTS:
        raise SystemExit(f"unknown rfdetr variant {variant!r}; known: {', '.join(RFDETR_VARIANTS)}")
    return getattr(rfdetr, RFDETR_VARIANTS[variant])(resolution=resolution)


def cap_train_split(dataset_dir: Path, limit: int) -> Path:
    """Keep at most `limit` training images, evenly spaced, leaving valid/test alone.

    CPU training is slow enough that the honest choice is fewer images and a
    finished run over more images and a killed one. Images are symlinked, not
    copied, so this costs nothing on disk.
    """
    import json

    capped_dir = dataset_dir.parent / f"{dataset_dir.name}-cap{limit}"
    for split in ("valid", "test"):
        link = capped_dir / split
        if not link.exists():
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to((dataset_dir / split).resolve(), target_is_directory=True)

    train_dir = capped_dir / "train"
    train_dir.mkdir(parents=True, exist_ok=True)
    payload = json.loads((dataset_dir / "train" / "_annotations.coco.json").read_text())
    images = payload["images"]
    if len(images) > limit:
        stride = len(images) / limit
        images = [images[int(index * stride)] for index in range(limit)]
    kept = {image["id"] for image in images}

    for image in images:
        link = train_dir / image["file_name"]
        if not link.exists():
            link.symlink_to((dataset_dir / "train" / image["file_name"]).resolve())
    (train_dir / "_annotations.coco.json").write_text(
        json.dumps({**payload, "images": images, "annotations": [a for a in payload["annotations"] if a["image_id"] in kept]})
    )
    print(f"capped train split to {len(images)} images at {capped_dir}")
    return capped_dir


def prepare_dataset(config, dataset_dir: Path) -> Path:
    """Return the directory the trainer should read, tiling it first when needed."""
    if config.tiles.untiled:
        return dataset_dir

    grid = config.tiles
    tiled_dir = HOLDS_DIR / ".data" / f"coco-tiles-{grid.rows}x{grid.cols}-{grid.overlap}-{config.long_side}"
    if (tiled_dir / "train" / "_annotations.coco.json").exists():
        print(f"reusing tiled dataset {tiled_dir}")
        return tiled_dir

    print(f"tiling {dataset_dir} -> {tiled_dir}")
    subprocess.run(
        [
            sys.executable,
            str(HOLDS_DIR / "data" / "tile_coco.py"),
            "--source", str(dataset_dir),
            "--target", str(tiled_dir),
            "--rows", str(grid.rows),
            "--cols", str(grid.cols),
            "--overlap", str(grid.overlap),
            "--long-side", str(config.long_side),
        ],
        check=True,
    )
    return tiled_dir


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--dataset", default=str(HOLDS_DIR / ".data" / "coco"))
    parser.add_argument("--epochs", type=int, help="override the config's epoch count")
    parser.add_argument("--batch-size", type=int)
    parser.add_argument("--max-train-images", type=int, help="cap the training set, for a quick smoke run")
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS)
    args = parser.parse_args()

    cap_threads(args.threads)
    config = load_config(args.config)
    dataset_dir = prepare_dataset(config, Path(args.dataset))
    if args.max_train_images:
        dataset_dir = cap_train_split(dataset_dir, args.max_train_images)

    train_config = dict(config.train)
    if args.epochs is not None:
        train_config["epochs"] = args.epochs
    if args.batch_size is not None:
        train_config["batch_size"] = args.batch_size

    output_dir = config.checkpoint_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"config       {config.name} ({config.family}/{config.variant} @ {config.resolution}px)")
    print(f"dataset      {dataset_dir}")
    print(f"train config {json.dumps(train_config)}")

    model = build_model(config.family, config.variant, config.resolution)

    started = time.time()
    model.train(
        dataset_dir=str(dataset_dir),
        output_dir=str(output_dir),
        accelerator="cpu",
        devices=1,
        num_workers=2,
        tensorboard=False,
        wandb=False,
        early_stopping=False,
        **train_config,
    )
    elapsed = time.time() - started

    summary = {
        "config": config.name,
        "dataset": str(dataset_dir),
        "train_config": train_config,
        "wall_clock_seconds": round(elapsed, 1),
        "output_dir": str(output_dir),
    }
    (output_dir / "train-summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
