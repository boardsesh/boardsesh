# Hold detection — offline spike harness (SW-01, issue #5434)

Finds climbing holds in a photo of a spray wall. Offline only: nothing in this
directory ships. The app gets two things out of it — an exported model file it
downloads from R2 at runtime, and the post-processing contract that SW-06
re-implements in TypeScript and checks against `fixtures/expected-detections.json`.

Read `RUNTIME.md` for the React Native side (which inference library builds on
Expo SDK 57 / RN 0.86).

## The rules this harness is built around

- **Apache-2.0 model families only** (epic #5346, decided 2026-09-14): RF-DETR,
  YOLOX, D-FINE, RT-DETR. Ultralytics code and weights are AGPL-3.0 and must
  never be installed in this repo — not in `requirements.txt`, not ad hoc. If an
  AGPL detector turns out to be the only thing that works, it lives in the
  separate microservice repo (#5451) and only its results cross the wire.
- **No CC BY-NC training data.** `data/fetch.py` refuses to download a source
  whose licence is non-commercial, unstated or blank. CC BY / CC BY-SA sources
  must be credited on the app's licences screen.
- **The exported artifact is what gets scored.** `eval.py` loads ONNX through
  onnxruntime and never touches the PyTorch weights, so the reported numbers
  describe the file a phone runs, including whatever the exporter changed.
- **Splits are by photo, never by hold.** Two holds off the same wall on opposite
  sides of the split would inflate every number: the model has already seen that
  wall, its lighting and its hold set.

## Layout

```
ml/holds/
  configs.json      the evaluable configurations (family, variant, resolution, tiling)
  common.py         tiling, NMS, IoU matching, splits — shared by train/export/eval
  data/sources.json    corpus registry; every entry carries an explicit licence
  data/fetch.py        download the public sources (refuses NC / unlicensed ones)
  data/scrape_commons.py  pull real wall photos + licences from Wikimedia Commons
  data/label_tool.py   grid / render / merge — the hand-labelling loop
  data/wayup.py        frame The Way Up videos into COCO, split by participant
  data/make_fixtures.py promote labelled photos into the committed fixtures
  data/to_coco.py      convert a labelled source into one COCO set, split by photo
  data/tile_coco.py    cut a COCO set into the tiles a tiled config will see
  train.py          one pipeline; the config picks the model family
  export.py         ONNX (required) and TFLite fp16 (attempted, recorded either way)
  eval.py           score the exported ONNX on the held-out photos
  fixtures/         committed inputs + expected detections for the SW-06 Node tests
  .data/            downloads, scraped photos, labels, checkpoints, exports —
                    gitignored, never committed
  .venv/            gitignored
```

## Setup

```bash
cd ml/holds
python3 -m venv .venv && . .venv/bin/activate
pip install --index-url https://download.pytorch.org/whl/cpu torch==2.14.0 torchvision==0.29.0
pip install -r requirements.txt
```

This box has no GPU and has fallen over under concurrent heavy jobs. **Run one
training or evaluation at a time** and keep the thread cap: every entry point
honours `HOLDS_THREADS` (default 8) and pins OMP/MKL/torch to it.

## Reproducing every number in the report

```bash
cd ml/holds && . .venv/bin/activate

# 1. Corpus. --list prints the registry with each licence and whether it is usable;
#    --only <name> prints the fetch steps for one source.
python data/fetch.py --list
python data/fetch.py --only wayup

# 2a. The public bootstrap corpus (The Way Up). Splits by participant, so a
#     held-out frame is a camera setup the model never trained on.
python data/wayup.py --root <extracted Way Up tree> --out .data/coco \
  --every 45 --frames-per-clip 24 --holdout-participants p10

# 2b. Or a hand-labelled corpus (the Discord spray-wall photos), split by photo.
python data/to_coco.py --source spraywall-discord:.data/spraywall-discord:coco

# 3. Train. Tiled configs tile the dataset first (cached in .data/coco-tiles-*).
#    --max-train-images keeps a CPU run inside a sane wall clock; it symlinks an
#    evenly spaced subset rather than copying anything.
python train.py --config nano-tiled-1024 --epochs 2 --max-train-images 400

# 4. Export. ONNX is required; TFLite is attempted and the result recorded.
python export.py --config nano-tiled-1024 --formats onnx,tflite

# 5. Score the EXPORTED artifact on the held-out photos.
python eval.py --config nano-tiled-1024 --split valid
python eval.py --config medium-untiled-1280 --split valid
```

Every `eval.py` run writes `.data/artifacts/<config>/eval.json` with the
per-photo breakdown behind the summary it prints.

### The two-minute fixture check

`eval.py` runs end to end on the committed fixtures in a few seconds. This is what
a reviewer runs; it needs no dataset download and no training, only the exported
ONNX (which is not committed — see `fixtures/README.md` for why, and for the two
commands that regenerate it):

```bash
cd ml/holds && . .venv/bin/activate
python eval.py --config nano-tiled-1024 --dataset fixtures --split images \
  --out fixtures/eval-nano.json --write-fixtures fixtures/expected-detections.json
```

Measured wall clock on the spike box: **2.6 s** for three photos, well inside the
two-minute budget.

## Measured so far

Two corpora, because they disagree and the disagreement is the finding.

- **Real walls** — 28 hand-labelled photos, 1,308 holds, from Wikimedia Commons
  (see "The real-wall evaluation corpus" below). This is the one that matters:
  it is the kind of photo a user would take.
- **The Way Up held-out split** — 48 frames, 1,272 holds, participant p10, an
  unseen camera setup. Same wall the model trained on, new viewpoint.

Both configs were trained only on The Way Up. Numbers are at each config's best
score threshold, found by the sweep below.

### Real walls — the number to read

| | `nano-tiled-1024` | `medium-untiled-1280` |
| --- | --- | --- |
| Score threshold | 0.05 | 0.05 |
| Precision | 0.366 | 0.554 |
| Recall | 0.450 | 0.634 |
| **F1 @ box IoU 0.5** | **0.403** | **0.592** |
| Latency per photo, 8 CPU threads | p50 **0.865 s**, p95 0.881 s | p50 **0.503 s**, p95 0.561 s |
| Peak process RSS | 486 MB | 651 MB |
| Corrections / real holds | 1.47 | 1.02 (0.79 at threshold 0.08) |
| Exported ONNX | 107.6 MB fp32 | 120.6 MB fp32 |

### The Way Up held-out split — and why it misleads

| | `nano-tiled-1024` | `medium-untiled-1280` |
| --- | --- | --- |
| Score threshold | 0.3 | 0.3 |
| **F1 @ box IoU 0.5** | **0.483** | **0.085** |
| Recall | 0.546 | 0.050 |

Read the two tables together and the trap is obvious. On The Way Up, tiling looks
like everything and the bigger model looks broken (0.483 vs 0.085). On real walls
the ranking **inverts** (0.403 vs 0.592). The Way Up is portrait video of a narrow
wall strip, so downscaling to one 576 px square throws its holds away; a real wall
photo is framed on the wall, the holds are a larger share of the frame, and one
untiled pass sees them fine.

So: **do not decide the tiling question on The Way Up.** Both configs are worth
carrying into SW-02 and re-measuring on the real corpus once it is big enough to
train on.

### Thresholds move F1 by 40 points

`eval.py --score-threshold` exists because the first real-wall run scored **F1
0.003** at the configs' default 0.3 and looked like total failure. It was not
failure, it was calibration: two epochs leaves a model under-confident, and the
same weights score 0.403 at 0.05.

Real-wall corpus, `nano-tiled-1024`:

| Threshold | Precision | Recall | F1 | Corrections / holds |
| --- | --- | --- | --- | --- |
| 0.02 | 0.136 | 0.691 | 0.227 | 7.17 |
| **0.05** | 0.366 | 0.450 | **0.403** | 1.47 |
| 0.08 | 0.471 | 0.243 | 0.321 | 1.06 |
| 0.15 | 0.503 | 0.065 | 0.115 | 1.01 |
| 0.30 | 0.154 | 0.002 | 0.003 | 1.01 |

And the best threshold is **not the same across corpora** — 0.05 on real walls,
0.3 on The Way Up, where 0.05 collapses precision to 0.077. A single shipped
constant will be wrong for somebody's wall, which is an argument for the
confidence slider the epic already decided on (#5441), not against it.

Reproduce exactly:

```bash
python data/wayup.py --root <extracted Way Up tree> --out .data/coco \
  --every 45 --frames-per-clip 24 --holdout-participants p10
python train.py  --config nano-tiled-1024 --epochs 2 --max-train-images 400
python export.py --config nano-tiled-1024 --formats onnx
python eval.py   --config nano-tiled-1024 --split valid                       # The Way Up
python eval.py   --config nano-tiled-1024 --dataset .data/realwall-coco \
  --split valid --score-threshold 0.05                                        # real walls
```

What these numbers are **not**: a verdict on the product. Both models were trained
for under half an hour on one climbing wall with about 53 distinct holds, and were
never shown a spray wall. 0.592 against a gate of 0.80, from that, is encouraging
rather than damning — but the gate needs a corpus that has spray walls in it.

Mask IoU is **not reported**: neither corpus has mask ground truth, so there is
nothing to score `nano-tiled-1024-classical-mask` or `seg-nano-tiled-1024`
against. `eval.py` computes it as soon as a corpus with `segmentation` arrives.

## The real-wall evaluation corpus

`data/scrape_commons.py` pulls climbing-wall photos from Wikimedia Commons —
keyless, and the only large source whose per-file licence is machine readable, so
every photo is traceable. Non-commercial and no-derivatives licences are refused,
not warned about. Everything lands in the gitignored `.data/realwall/` with a
`sources.csv` (file name, Commons title, file page URL, licence, author,
dimensions, orientation, how it was found, fetch date). **Scraped photos are never
committed**; only a CC-licensed one with its attribution recorded may be promoted
into `fixtures/`.

103 candidates were fetched and triaged by hand; **28 were labelled completely**
and 31 rejected. The rejects matter as much as the keeps: a photo where only half
the holds can be enumerated is marked `usable: false`, because a partial label
charges the detector for holds nobody labelled. One dense spray wall was labelled
in part and carries `"partial": true`, which keeps the work on disk and out of the
scored set.

Corpus at a glance: 28 photos, 1,308 holds, portrait and landscape, tagged
`sparse` 20, `bright` 16, `angled` 15, `volumes` 8, `dense` 4, `tape` 4,
`wood-on-wood` 4, `overhang` 4, `low-light` 3, `spray-wall` 1.

One `spray-wall` photo is one too few. That is the gap the Discord collection is
meant to close, and it is why the verdict on #5346 is inconclusive rather than a
pass or a fail.

```bash
python data/scrape_commons.py --limit 110            # fetch + sources.csv
python data/label_tool.py grid   --image .data/realwall/images/<name>.jpg
#   ... write .data/realwall/labels/<name>.json ...
python data/label_tool.py render --image .data/realwall/images/<name>.jpg \
  --labels .data/realwall/labels/<name>.json         # look, fix, repeat
python data/label_tool.py merge --split valid        # -> .data/realwall-coco/valid
```

### What hand-labelling could not do

Holds between about 18 and 45 px can be boxed **and checked**: the box and the
hold are both visible in the rendered overlay, which caught real mistakes. Below
about 15 px the drawn outline covers the hold entirely and the check step stops
telling you anything. Dense far-wall sections were therefore left out rather than
guessed. Any future labelling pass on dense walls needs a verification render at
4x or more with the index labels suppressed.

## The public bootstrap corpus, and why it is not enough

The only hold dataset that is **keyless, permissively licensed and box-annotated**
is *The Way Up* (Zenodo 10.5281/zenodo.15196867, CC BY 4.0). What it actually
contains, because the shape of it decides what its numbers mean:

- 22 clips at 720×1280 of **one indoor route wall**, **two routes** (22 and 31
  holds), re-shot by eleven participants from slightly different camera setups.
- 583 boxes, about **53 distinct physical holds** in the whole release.
- Boxes are per clip — the camera shifts between recordings, so one clip's
  annotation is not valid for another's frames.
- Climbers occlude the holds they are on. Those holds stay labelled, so some of
  what looks like a miss is a hold behind a knee.

So `data/wayup.py` splits **by participant**, which is the strongest split the
source allows, and a held-out frame is still the same 53 holds from a new
viewpoint. A number measured on it says "the pipeline runs and learns something",
not "this will work on your garage wall". Treat it as a harness bootstrap.

Everything larger is behind a login. `data/sources.json` records the exact
unblock steps for each (a free Roboflow account reaches 120,528 CC BY 4.0 boxes;
a Kaggle token reaches the only per-hold masks).

## Corpus protocol

The spike's public sources only bootstrap the harness. The corpus the gate should
be decided on is **real spray-wall photos**, collected through
`POST /api/spray-wall-test-data` (added in this PR) into the `private` R2 bucket
under `spray-wall-test-data/<ISO-timestamp>-<uuid>/`, one folder per photo with
`image.jpg` and `metadata.json`.

What the corpus needs, per issue #5434:

- at least 20 photos, and realistically many more before a number means anything
- both portrait and landscape
- mixed lighting: gym fluorescents, a garage bulb, daylight through a door
- at least 3 hard cases: wood-on-wood holds, a dense section, volumes, tape

`metadata.json` records the uploader's consent. Only a photo whose
`consent.redistribute` is true may become a committed fixture; everything else
stays in the private bucket.

Pull the collected photos down for labelling with the AWS CLI against the private
bucket (credentials as in `docs/user-media-storage.md`):

```bash
aws s3 sync s3://$R2_PRIVATE_BUCKET/spray-wall-test-data/ .data/spraywall-discord/ \
  --endpoint-url "$R2_ENDPOINT"
```

Label every hold as a box (a mask is a bonus), export COCO, and put it through
`data/to_coco.py`.

## Licences

See `data/sources.json` for the machine-readable registry — that file, not this
table, is what `data/fetch.py` enforces.

| Component | Licence | Where it ends up |
| --- | --- | --- |
| `rfdetr` (code and released weights) | Apache-2.0 | fine-tuned weights ship to the app |
| `torch` / `torchvision` | BSD-3 + Apache-2.0 | offline only |
| `onnxruntime` (Python) | MIT | offline only |
| `pycocotools` | BSD-2 | offline only |
| `scipy`, `numpy` | BSD-3 | offline only |
| `pillow` | MIT-CMU | offline only |
| Wikimedia Commons wall photos (the evaluation corpus) | per file: CC BY-SA 4.0 / 3.0 / 2.0, CC BY 4.0 / 3.0 / 2.0, CC0, public domain — **no NC, no ND** | evaluation only, gitignored; a photo promoted to `fixtures/` carries its licence, author and file page in the COCO record |
| The Way Up (Zenodo 10.5281/zenodo.15196867) | **CC BY 4.0** | training data + the committed fixtures — **must be credited on the app licences screen** if anything trained on it ships |
| CS152-SSL label set | CC BY 4.0 | labels are keyless; the images need a free Roboflow account |
| xiaoxiae gym masks | CC BY-SA 4.0 | the only per-hold masks found; images need a Kaggle token |
| Spray-wall photos from Discord | uploader consent, per photo | private bucket; fixtures only with `consent.redistribute` |

Nothing AGPL is installed, imported or vendored here.

## Export formats

| Format | RF-DETR | Result on this box |
| --- | --- | --- |
| ONNX | native (`format="onnx"`) | works, 2-4 s, 107.6 MB fp32 at 384 px |
| TFLite fp16 | `format="tflite"` | **not produced** — needs the `rfdetr[tflite]` extra (onnx2tf + ai_edge_litert), which was not installed here. `export.py` records the failure and still writes the ONNX. |
| ExecuTorch `.pte` | `format="executorch"`, a `backend=` is required | not attempted |
| CoreML | `format="coreml"` | not attempted |

Worth knowing for SW-02: RF-DETR's exporter has first-party TFLite, ExecuTorch
and CoreML paths, so the model family does not lock us into one runtime. What it
does do is **weigh a lot** — 107.6 MB of fp32 ONNX for the smallest variant, four
times the ~25 MB that makes a first launch on a phone connection tolerable. Half
of that is the 91-class COCO head the fine-tune kept; a single-class head plus
fp16 is the first thing to measure, and if that is not enough, the answer is a
different Apache-2.0 family (YOLOX-nano is an order of magnitude smaller) rather
than a smaller RF-DETR.
