# Hold-detection fixtures

Committed inputs for the Node parity tests in SW-06 (#5439). The TypeScript
post-processing — tiling, NMS, box→ring — has to agree with the Python that
produced `expected-detections.json`, or the app and the harness will disagree
about what the same model saw.

## What is here

- `images/` — three real climbing-wall photos plus `_annotations.coco.json` with
  166 hand-labelled hold boxes. Each image record carries its `licence`, `author`
  and `page_url`.
- `expected-detections.json` — what the exported model produced on those three
  photos, with the tiling, threshold and resolution inline so a TypeScript
  implementation can reproduce them without reading `configs.json`.
- `eval-nano.json` — the scored result of that same run, for reference.

## Licence and attribution

All three photos are from Wikimedia Commons and may be redistributed:

| File | Licence | Author | Source |
| --- | --- | --- | --- |
| `1.jpg` | CC BY-SA 4.0 | Vivaystn | [Commons](https://commons.wikimedia.org/wiki/File:1%D8%AA%D8%B3%D9%84%D9%82.JPG) |
| `1035th-survey-and-design-detachment-soldier-creates-rock-climbing-wall.jpg` | Public domain | U.S. Army photo by Sgt. Ricky Sturgis | [Commons](https://commons.wikimedia.org/wiki/File:1035th_Survey_and_Design_Detachment_Soldier_creates_rock_climbing_wall_in_Afghanistan_140310-A-ZZ999-518.jpg) |
| `2008-08-05-evan-daniel-climbing-at-vertical-edge.jpg` | CC BY-SA 4.0 | Ildar Sagdejev (Specious) | [Commons](https://commons.wikimedia.org/wiki/File:2008-08-05_Evan_Daniel_climbing_at_Vertical_Edge.jpg) |

The two CC BY-SA photos need that credit wherever they are shown. The hold boxes
are ours, drawn by hand for this spike.

**Adding a spray-wall photo here** requires `consent.redistribute` to be true in
the uploader's `metadata.json` from `POST /api/spray-wall-test-data`. Photos
without that consent stay in the private bucket and never reach this directory.
Scraped photos that are not CC-licensed never reach it either.

## The model

The exported ONNX is **not committed** — RF-DETR nano is about 108 MB as fp32
ONNX, far over this repo's 15 MB ceiling, and the app downloads weights from R2
at runtime anyway (epic #5346). It is not published to R2 yet; SW-02 owns that.

Regenerate the exact artifact these expectations came from:

```bash
cd ml/holds && . .venv/bin/activate
python train.py  --config nano-tiled-1024 --epochs 2 --max-train-images 400
python export.py --config nano-tiled-1024 --formats onnx
python eval.py   --config nano-tiled-1024 --dataset fixtures --split images \
  --score-threshold 0.05 \
  --out fixtures/eval-nano.json --write-fixtures fixtures/expected-detections.json
```

`expected-detections.json` records the model file name and the settings it was
produced under. Detections are float coordinates from a CPU ONNX run, so a parity
test should compare with a tolerance (a box within about 1 px, a score within
about 1e-3), not for exact equality.

A CPU training run is not bit-reproducible, so a fresh `train.py` will not give
byte-identical detections. The parity contract is **TypeScript vs Python on the
same ONNX file**, not run-to-run equality — regenerate the expectations whenever
the model is retrained.
