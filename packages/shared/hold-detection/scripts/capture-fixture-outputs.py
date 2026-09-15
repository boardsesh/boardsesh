#!/usr/bin/env python3
"""Capture the parity oracle: what the SW-01 model emitted for each fixture photo.

## Why the oracle is raw tensors and not the model

The exported int8 ONNX is 28.7 MB against this repo's 15 MB file ceiling
(`ml/holds/fixtures/README.md`), so the model cannot be committed and CI cannot
run it. What CI *can* run is the half `@boardsesh/hold-detection` owns — decode,
un-letterbox, tile merge, NMS, candidates — replayed from the model's recorded
output. That is what `src/__tests__/fixtures/<image>.outputs.json` holds: 300
queries of boxes and logits per tile, ~150 KB per photo, and the input
`src/__tests__/parity.test.ts` compares against
`ml/holds/fixtures/expected-detections.json`.

## Why this is Python and not an `onnxruntime-node` script

Two reasons, and the second one is the surprise.

1. Pillow's `resize` is an antialiased triangle filter whose support scales with
   the reduction factor, and it accumulates in 8-bit fixed point. `letterbox` in
   this package reimplements the filter, but a one-level channel difference is
   not something to bake into an oracle.
2. **`onnxruntime-node` 1.29 and the Python `onnxruntime` 1.30 do not agree on
   this model.** Measured on fixture `1.jpg`, tile 0: 280 of 300 query boxes
   differ by more than 0.01 in normalised units (median 0.40) and 294 of 300
   logits by more than 0.05 (median 0.77). The consequence, measured on a
   different photo — `2008-08-05-evan-daniel-climbing-at-vertical-edge.jpg`,
   whose Python run produces 44 detections — is 49 from a Node capture. Dynamic
   int8 quantisation puts a QGemm kernel in the hot path and those are build- and
   version-specific; float32 would be far closer.
   A Node capture would therefore pin TypeScript against a Python run that never
   happened. **SW-02 should expect the same on device**: the app's runtime will
   not reproduce the harness's numbers hold for hold, which is one more reason
   the score threshold is a slider rather than a shipped constant.

## Running it

Use the SW-01 spike's venv, which already has numpy, Pillow and onnxruntime:

    ml/holds/.venv/bin/python \
      packages/shared/hold-detection/scripts/capture-fixture-outputs.py \
      --model ml/holds/.data/artifacts/nano-tiled-1024/model-int8.onnx

It reads only `ml/holds/fixtures/`; it writes nothing inside `ml/`. Regenerate it
whenever the model is retrained, in the same pass as the Python expectations —
`ml/holds/fixtures/README.md` has that command.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[4]
PACKAGE_ROOT = Path(__file__).resolve().parents[1]

# `nano-tiled-1024` from ml/holds/configs.json — the config the committed
# expectations in ml/holds/fixtures/expected-detections.json were produced under.
RESOLUTION = 384
LONG_SIDE = 1024
ROWS, COLS, OVERLAP = 2, 2, 0.15

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(3, 1, 1)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(3, 1, 1)


def tile_boxes(width: int, height: int) -> list[tuple[int, int, int, int]]:
    """Verbatim `common.py:tile_boxes` for the nano-tiled grid."""
    tile_w = int(round(width / COLS * (1.0 + OVERLAP)))
    tile_h = int(round(height / ROWS * (1.0 + OVERLAP)))
    step_x = max(1, (width - tile_w) // max(1, COLS - 1))
    step_y = max(1, (height - tile_h) // max(1, ROWS - 1))
    windows = []
    for row in range(ROWS):
        for col in range(COLS):
            x0 = min(col * step_x, max(0, width - tile_w))
            y0 = min(row * step_y, max(0, height - tile_h))
            windows.append((x0, y0, min(x0 + tile_w, width), min(y0 + tile_h, height)))
    return windows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="the exported model-int8.onnx")
    parser.add_argument("--fixtures", default=str(REPO_ROOT / "ml" / "holds" / "fixtures"))
    parser.add_argument("--out", default=str(PACKAGE_ROOT / "src" / "__tests__" / "fixtures"))
    parser.add_argument("--threads", type=int, default=8)
    args = parser.parse_args()

    fixtures = Path(args.fixtures)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(args.model, options, providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name

    annotations = json.loads((fixtures / "images" / "_annotations.coco.json").read_text())

    for image_record in annotations["images"]:
        file_name = image_record["file_name"]
        photo = Image.open(fixtures / "images" / file_name).convert("RGB")
        scale = LONG_SIDE / max(photo.size)
        working = photo.resize(
            (max(1, round(photo.width * scale)), max(1, round(photo.height * scale))), Image.BILINEAR
        )

        tiles = []
        for x0, y0, x1, y1 in tile_boxes(working.width, working.height):
            crop = working.crop((x0, y0, x1, y1)).resize((RESOLUTION, RESOLUTION), Image.BILINEAR)
            array = np.asarray(crop, dtype=np.float32).transpose(2, 0, 1) / 255.0
            tensor = ((array - MEAN) / STD)[None, ...].astype(np.float32)

            outputs = session.run(None, {input_name: tensor})
            boxes = next(o for o in outputs if o.ndim == 3 and o.shape[-1] == 4)
            logits = next(o for o in outputs if o.ndim == 3 and o.shape[-1] != 4)
            tiles.append(
                {
                    "window": [x0, y0, x1, y1],
                    "boxesShape": list(boxes.shape),
                    # float32 carries ~9 significant decimal digits, so this is
                    # the shortest text that reads back as the same float.
                    "boxes": [float(f"{v:.9g}") for v in boxes.reshape(-1)],
                    "logitsShape": list(logits.shape),
                    "logits": [float(f"{v:.9g}") for v in logits.reshape(-1)],
                }
            )

        target = out / f"{file_name}.outputs.json"
        target.write_text(
            json.dumps(
                {
                    "generatedBy": "packages/shared/hold-detection/scripts/capture-fixture-outputs.py",
                    "fileName": file_name,
                    "width": photo.width,
                    "height": photo.height,
                    "resolution": RESOLUTION,
                    "longSide": LONG_SIDE,
                    "scale": scale,
                    "workingWidth": working.width,
                    "workingHeight": working.height,
                    "tiles": tiles,
                },
                indent=2,
            )
            + "\n"
        )
        print(f"wrote {target} ({len(tiles)} tiles)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
