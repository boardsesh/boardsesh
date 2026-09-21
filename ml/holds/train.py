#!/usr/bin/env python3
"""Train one hold detector. One pipeline; the config picks the model family.

Apache-2.0 families only (epic #5346, 2026-09-14). The only family wired up today
is RF-DETR (`rfdetr`, Apache-2.0, weights Apache-2.0). YOLOX / D-FINE / RT-DETR
are the sanctioned alternatives if RF-DETR disappoints; add them as another branch
of `build_model`, not as a second script. Ultralytics is AGPL-3.0 and must never
be installed in this repo.

Device defaults to `--device auto` (cuda, then mps, then cpu). The box this was
written on has no GPU, so it trains on CPU on purpose and is slow: it has also
fallen over under concurrent heavy jobs, so run one training at a time there. On
an Apple Silicon Mac, `--device mps` (or the auto default) uses the GPU instead —
see the README's "macOS (Apple Silicon)" section for the full run.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from common import DEFAULT_THREADS, HOLDS_DIR, DetectorConfig, cap_threads, load_config
from data.tile_coco import clip_polygon_to_tile

RFDETR_VARIANTS = {
    "nano": "RFDETRNano",
    "small": "RFDETRSmall",
    "medium": "RFDETRMedium",
    "seg-nano": "RFDETRSegNano",
    "seg-small": "RFDETRSegSmall",
}

# torch device name -> the PyTorch Lightning `accelerator` kwarg rfdetr's own
# `RFDETR.train()` would derive from a `device="..."` string (see
# `rfdetr.detr.RFDETR._resolve_trainer_device_kwargs`): "cuda" maps to Lightning's
# "gpu", "mps" and "cpu" pass through unchanged.
ACCELERATOR_BY_DEVICE = {"cpu": "cpu", "mps": "mps", "cuda": "gpu"}


def resolve_device(requested: str) -> tuple[str, str]:
    """Return (device_name, lightning_accelerator) for a `--device` value.

    `auto` prefers cuda, then Apple Silicon's mps, then cpu. An explicit `cuda`
    or `mps` request fails fast with a plain-language reason instead of letting
    Lightning discover the missing backend deep inside `model.train()`.
    """
    import torch

    if requested == "auto":
        if torch.cuda.is_available():
            return "cuda", ACCELERATOR_BY_DEVICE["cuda"]
        if torch.backends.mps.is_available():
            return "mps", ACCELERATOR_BY_DEVICE["mps"]
        return "cpu", ACCELERATOR_BY_DEVICE["cpu"]

    if requested == "cuda" and not torch.cuda.is_available():
        raise SystemExit(
            "--device cuda requested but torch.cuda.is_available() is False. "
            "No CUDA GPU (or no CUDA-enabled torch build) on this machine — use --device cpu, "
            "or --device mps on an Apple Silicon Mac."
        )
    if requested == "mps" and not torch.backends.mps.is_available():
        raise SystemExit(
            "--device mps requested but torch.backends.mps.is_available() is False. "
            "mps needs macOS 12.3+ on Apple Silicon (or an AMD GPU) and a torch build with MPS "
            "support — the PyPI torch/torchvision wheels the README's macOS section installs, not "
            "the +cpu wheel this box uses. Use --device cpu here instead."
        )
    return requested, ACCELERATOR_BY_DEVICE[requested]


def build_model(family: str, variant: str, resolution: int, num_classes: int = 1):
    if family != "rfdetr":
        raise SystemExit(
            f"family {family!r} is not wired up. Apache-2.0 families only: rfdetr, yolox, dfine, rtdetr."
        )
    import rfdetr

    if variant not in RFDETR_VARIANTS:
        raise SystemExit(f"unknown rfdetr variant {variant!r}; known: {', '.join(RFDETR_VARIANTS)}")
    # num_classes rebuilds the classification head rather than keeping RF-DETR's
    # 90-class COCO one. There is one class here, `hold`, and the unused 89 are
    # roughly half the exported file — which is the difference between a model a
    # phone downloads on a gym connection and one it does not.
    return getattr(rfdetr, RFDETR_VARIANTS[variant])(resolution=resolution, num_classes=num_classes)


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


TILE_SOURCE_FILENAME = "source.json"


def tiled_dataset_dir(config: DetectorConfig, dataset_dir: Path) -> Path:
    """Where the tiles cut from `dataset_dir` for `config` live.

    The SOURCE dataset's name is part of the directory name, not just the tiling
    geometry: two corpora tiled the same way are two different corpora, and a
    cache keyed on geometry alone silently trains `--dataset .data/roboflow-1class`
    on whatever was tiled first and records the wrong dataset in train-summary.json.
    """
    grid = config.tiles
    source_name = dataset_dir.resolve().name
    return (
        HOLDS_DIR
        / ".data"
        / f"{source_name}-tiles-{grid.rows}x{grid.cols}-{grid.overlap}-{config.long_side}"
    )


def tile_source_record(config: DetectorConfig, dataset_dir: Path) -> dict[str, object]:
    """The provenance stamp written beside a tiled dataset and checked before reuse."""
    grid = config.tiles
    return {
        "source": str(dataset_dir.resolve()),
        "rows": grid.rows,
        "cols": grid.cols,
        "overlap": grid.overlap,
        "long_side": config.long_side,
    }


def validate_mask_training_dataset(config: DetectorConfig, dataset_dir: Path) -> None:
    """Reject missing mask targets before constructing an RF-DETR segmentation model."""
    if config.family != "rfdetr" or not config.variant.startswith("seg-"):
        return

    for split in ("train", "valid", "test"):
        annotation_path = dataset_dir / split / "_annotations.coco.json"
        if not annotation_path.exists():
            if split == "train":
                raise SystemExit(f"{config.name}: missing training annotations at {annotation_path}")
            continue
        payload = json.loads(annotation_path.read_text())
        annotations = payload["annotations"]
        if split == "train" and not annotations:
            raise SystemExit(f"{config.name}: mask training needs annotated holds in {annotation_path}")
        images = {image["id"]: image for image in payload["images"]}
        for annotation in annotations:
            try:
                image = images[annotation["image_id"]]
                width, height = image["width"], image["height"]
                if width <= 0 or height <= 0:
                    raise ValueError("image dimensions must be positive")
                polygons = clip_polygon_to_tile(annotation.get("segmentation"), 1, 0, 0, width, height)
                if not polygons:
                    raise ValueError("missing or empty polygon mask")
            except (KeyError, TypeError, ValueError) as error:
                raise SystemExit(
                    f"{config.name} requires a usable polygon mask for every hold: "
                    f"{annotation_path}, annotation {annotation.get('id', '?')}: {error}. "
                    "Use a fully polygon-labelled corpus; box-only labels cannot train a mask model. "
                    "After correcting source labels, rebuild any tiled cache generated without masks."
                ) from error


def prepare_dataset(config: DetectorConfig, dataset_dir: Path) -> Path:
    """Return the directory the trainer should read, tiling it first when needed."""
    validate_mask_training_dataset(config, dataset_dir)
    if config.tiles.untiled:
        return dataset_dir

    grid = config.tiles
    tiled_dir = tiled_dataset_dir(config, dataset_dir)
    expected_source = tile_source_record(config, dataset_dir)
    source_path = tiled_dir / TILE_SOURCE_FILENAME
    if (tiled_dir / "train" / "_annotations.coco.json").exists():
        recorded = json.loads(source_path.read_text()) if source_path.exists() else None
        if recorded == expected_source:
            validate_mask_training_dataset(config, tiled_dir)
            print(f"reusing tiled dataset {tiled_dir}")
            return tiled_dir
        raise SystemExit(
            f"{tiled_dir} holds tiles from a different source than {dataset_dir.resolve()}\n"
            f"  recorded: {json.dumps(recorded)}\n"
            f"  wanted:   {json.dumps(expected_source)}\n"
            "Delete that directory to re-tile. Training on it as-is would train the wrong corpus."
        )

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
    validate_mask_training_dataset(config, tiled_dir)
    source_path.write_text(json.dumps(expected_source, indent=2) + "\n")
    return tiled_dir


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--dataset", default=str(HOLDS_DIR / ".data" / "coco"))
    parser.add_argument("--epochs", type=int, help="override the config's epoch count")
    parser.add_argument(
        "--batch-size",
        type=int,
        help=(
            "override the config's batch size. Configs are tuned for this box's CPU RAM; a GPU or "
            "an Apple Silicon Mac's unified memory can usually go much higher — see the README's "
            "'macOS (Apple Silicon)' batch-size guidance. Halve it on an MPS 'out of memory' error."
        ),
    )
    parser.add_argument(
        "--grad-accum-steps",
        type=int,
        help=(
            "override the config's gradient accumulation. The effective batch is batch_size x "
            "grad_accum_steps and the configs are tuned to keep it at 8-16 on tiny CPU batches; a "
            "GPU box raising --batch-size should lower this in step (e.g. --batch-size 16 "
            "--grad-accum-steps 1) so the optimizer still sees the same effective batch."
        ),
    )
    parser.add_argument(
        "--resume",
        help=(
            "resume a run from a Lightning checkpoint: a path, or 'last' for the config's own "
            "last.ckpt. Forwarded to rfdetr's `resume`, i.e. trainer.fit(ckpt_path=...)."
        ),
    )
    parser.add_argument("--max-train-images", type=int, help="cap the training set, for a quick smoke run")
    parser.add_argument(
        "--threads",
        type=int,
        default=DEFAULT_THREADS,
        help="CPU thread cap (OMP/MKL/BLAS + torch intra-op). Only meaningful for --device cpu.",
    )
    parser.add_argument(
        "--device",
        choices=["auto", "cpu", "mps", "cuda"],
        default="auto",
        help=(
            "auto (default) picks cuda, then Apple Silicon's mps, then cpu. Pass mps explicitly on "
            "a Mac, or cpu to force this box's original behaviour."
        ),
    )
    args = parser.parse_args()

    cap_threads(args.threads)
    device_name, accelerator = resolve_device(args.device)
    config = load_config(args.config)
    dataset_dir = prepare_dataset(config, Path(args.dataset))
    if args.max_train_images:
        dataset_dir = cap_train_split(dataset_dir, args.max_train_images)
        validate_mask_training_dataset(config, dataset_dir)

    train_config = dict(config.train)
    if args.epochs is not None:
        train_config["epochs"] = args.epochs
    if args.batch_size is not None:
        train_config["batch_size"] = args.batch_size
    if args.grad_accum_steps is not None:
        train_config["grad_accum_steps"] = args.grad_accum_steps
    if args.resume:
        resume_path = config.checkpoint_dir / "last.ckpt" if args.resume == "last" else Path(args.resume)
        if not resume_path.exists():
            raise SystemExit(f"--resume: no checkpoint at {resume_path}")
        train_config["resume"] = str(resume_path)

    output_dir = config.checkpoint_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"config       {config.name} ({config.family}/{config.variant} @ {config.resolution}px, {config.num_classes} class)")
    print(f"dataset      {dataset_dir}")
    print(f"train config {json.dumps({**train_config, 'device': device_name, 'accelerator': accelerator})}")

    model = build_model(config.family, config.variant, config.resolution, config.num_classes)

    started = time.time()
    model.train(
        dataset_dir=str(dataset_dir),
        output_dir=str(output_dir),
        accelerator=accelerator,
        devices=1,
        num_workers=2,
        tensorboard=False,
        wandb=False,
        early_stopping=False,
        **train_config,
    )
    elapsed = time.time() - started

    # The summary is a shareable artifact: keep the resume checkpoint repo-relative
    # so a committed copy does not embed this machine's home directory layout. A
    # checkpoint OUTSIDE the repo stays absolute — pass --resume last (or an
    # in-repo path) when the summary is destined for results/.
    summary_train_config = dict(train_config)
    if "resume" in summary_train_config:
        resume_value = Path(summary_train_config["resume"])
        if resume_value.is_absolute() and resume_value.is_relative_to(HOLDS_DIR):
            summary_train_config["resume"] = str(resume_value.relative_to(HOLDS_DIR))
    summary = {
        "config": config.name,
        "dataset": str(dataset_dir),
        "device": device_name,
        "accelerator": accelerator,
        "train_config": summary_train_config,
        "wall_clock_seconds": round(elapsed, 1),
        "output_dir": str(output_dir),
    }
    (output_dir / "train-summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
