#!/usr/bin/env python3
"""Export a trained detector to the artifacts the app would actually ship.

ONNX is required: `eval.py` scores the ONNX file, never the PyTorch weights, so
that the numbers in the report describe the thing a phone runs. TFLite fp16 is
attempted when the family supports it — RF-DETR's exporter has a `tflite` path,
but it pulls optional converter dependencies, so a failure here is recorded and
does not fail the ONNX export.

Weights are downloaded from R2 at runtime (epic #5346), so the export is judged on
file size as well as accuracy: anything over about 25 MB is a slow first launch on
a phone connection.
"""

from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path

from common import DEFAULT_THREADS, cap_threads, load_config

MAX_COMMITTABLE_BYTES = 15 * 1024 * 1024  # the repo's ceiling for a committed fixture


def find_checkpoint(checkpoint_dir: Path) -> Path:
    candidates = sorted(checkpoint_dir.rglob("*.pth")) + sorted(checkpoint_dir.rglob("*.ckpt"))
    preferred = [c for c in candidates if "ema" in c.name.lower() or "best" in c.name.lower()]
    chosen = (preferred or candidates)
    if not chosen:
        raise SystemExit(f"no checkpoint under {checkpoint_dir}; run train.py first")
    return chosen[0]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--checkpoint", help="explicit checkpoint path; defaults to the config's run directory")
    parser.add_argument("--pretrained", action="store_true", help="export the released COCO weights, untrained")
    parser.add_argument("--formats", default="onnx", help="comma separated: onnx,tflite")
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS)
    args = parser.parse_args()

    cap_threads(args.threads)
    config = load_config(args.config)

    from train import build_model

    if args.pretrained:
        model = build_model(config.family, config.variant, config.resolution)
        provenance = "released COCO weights (untrained on holds)"
    else:
        checkpoint = Path(args.checkpoint) if args.checkpoint else find_checkpoint(config.checkpoint_dir)
        import rfdetr

        variant_class = getattr(rfdetr, __import__("train").RFDETR_VARIANTS[config.variant])
        model = variant_class(pretrain_weights=str(checkpoint), resolution=config.resolution)
        provenance = str(checkpoint)

    artifact_dir = config.onnx_path.parent
    artifact_dir.mkdir(parents=True, exist_ok=True)

    results: dict[str, dict] = {}
    for fmt in [f.strip() for f in args.formats.split(",") if f.strip()]:
        started = time.time()
        try:
            model.export(
                output_dir=str(artifact_dir),
                format=fmt,
                shape=(config.resolution, config.resolution),
                batch_size=1,
                verbose=False,
                **({"quantization": "fp16"} if fmt == "tflite" else {}),
            )
        except Exception as error:  # noqa: BLE001 — the point is to record which formats fail
            results[fmt] = {"ok": False, "error": f"{type(error).__name__}: {error}"}
            print(f"{fmt}: FAILED — {type(error).__name__}: {error}")
            continue

        produced = sorted(p for p in artifact_dir.iterdir() if p.suffix.lstrip(".") == fmt)
        if fmt == "onnx" and produced and produced[0] != config.onnx_path:
            shutil.copy2(produced[0], config.onnx_path)
            produced = [config.onnx_path]
        results[fmt] = {
            "ok": True,
            "seconds": round(time.time() - started, 1),
            "files": [
                {
                    "path": str(path.relative_to(artifact_dir)),
                    "bytes": path.stat().st_size,
                    "committable": path.stat().st_size < MAX_COMMITTABLE_BYTES,
                }
                for path in produced
            ],
        }
        for entry in results[fmt]["files"]:
            print(f"{fmt}: {entry['path']} {entry['bytes'] / 1e6:.1f} MB")

    summary = {"config": config.name, "provenance": provenance, "resolution": config.resolution, "formats": results}
    (artifact_dir / "export-summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    return 0 if results.get("onnx", {}).get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
