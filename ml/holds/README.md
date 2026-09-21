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
  data/scrape_commons.py   pull climbing-wall photos + licences from Wikimedia Commons
  data/scrape_spraywalls.py pull spray-wall photos from Flickr feeds and the web
  data/single_class.py  collapse a multi-category COCO set into one `hold` class
  data/label_tool.py   grid / render / merge — the hand-labelling loop
                       (`merge --halves` writes a `tune` and an `eval` split so the
                       score threshold is chosen on photos the F1 is not reported on)
  data/wayup.py        frame The Way Up videos into COCO, split by participant
  data/make_fixtures.py promote labelled photos into the committed fixtures
  data/to_coco.py      convert a labelled source into one COCO set, split by photo
  data/tile_coco.py    cut a COCO set into the tiles a tiled config will see
  train.py          one pipeline; the config picks the model family
  export.py         ONNX (required), `--shrink fp16,int8`, TFLite if its extra is installed
  eval.py           score the exported ONNX on the held-out photos
  publish_model.py  build + validate a manifest, upload it and the weights to R2 (see "Publishing a model")
  model-manifest.schema.json   the manifest contract publish_model.py validates against
  test_publish_model.py        pytest for publish_model.py — --dry-run only, no R2 needed
  test_train.py                pytest for the tiled-dataset cache (no training, no torch)
  test_tile_coco.py            polygon clipping and tiled-annotation propagation (Pillow + NumPy)
  test_fetch.py                pytest for data/fetch.py's missing-SDK message
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
pip install roboflow   # only for data/fetch.py's Roboflow download; not pinned
```

This box has no GPU and has fallen over under concurrent heavy jobs. **Run one
training or evaluation at a time** and keep the thread cap: every entry point
honours `HOLDS_THREADS` (default 8) and pins OMP/MKL/torch to it.

### macOS (Apple Silicon)

Same `requirements.txt`, different torch install: skip the `+cpu` wheel index
entirely and take the plain PyPI wheels, which bundle Metal (MPS) support.

```bash
cd ml/holds
python3 -m venv .venv && . .venv/bin/activate
pip install torch==2.14.0 torchvision==0.29.0
pip install -r requirements.txt
pip install roboflow   # only for data/fetch.py's Roboflow download; not pinned
```

`train.py --device auto` (the default) then picks `mps` on its own; pass
`--device mps` explicitly to fail fast instead of silently falling back to cpu
if something about the environment is off. `--device cpu` still works and is
the thing to reach for if `mps` misbehaves — see the caveat below.

### Full run

The retrain the report above describes used 600 of 3,876 available train-split
photos for one epoch on this CPU box. A full run — the whole train split, the
usual RF-DETR fine-tuning recipe of ~10 epochs — is estimated at ~37 hours here;
on an M5 Max it should take a small fraction of that. Recipe, on the Mac:

```bash
cd ml/holds && . .venv/bin/activate

# 1. Corpus: the CC BY 4.0 Roboflow set, collapsed to one class.
ROBOFLOW_API_KEY=$(cat ~/.config/roboflow/api-key) \
  python data/fetch.py --only roboflow-climbing-holds-and-volumes
python data/single_class.py --source .data/roboflow-climbing-holds-and-volumes \
  --target .data/roboflow-1class

# 2. Train on the FULL train split — no --max-train-images — for 10 epochs.
python train.py --config medium-untiled-1280 --device mps --epochs 10 \
  --dataset .data/roboflow-1class

# 3. Export, shrunk to int8 (what would ship).
python export.py --config medium-untiled-1280 --formats onnx --shrink int8

# 4. Score the exported artifact on the spray-wall eval split, threshold
#    chosen on `tune` first (see "Reproducing every number" above for how the
#    spray-wall corpus's tune/eval halves are built). The sweep must run against
#    the SAME int8 file the final number is reported on — quantization shifts
#    score calibration, so a threshold tuned on the fp32 model.onnx (eval.py's
#    default when --model is omitted) is tuned on the wrong artifact.
for t in 0.05 0.10 0.15 0.20 0.30 0.40 0.50 0.60 0.70; do
  python eval.py --config medium-untiled-1280 --dataset .data/spraywall-coco \
    --split tune --score-threshold $t \
    --model .data/artifacts/medium-untiled-1280/model-int8.onnx \
    --out .data/artifacts/medium-untiled-1280/eval-tune-$t.json
done
python eval.py --config medium-untiled-1280 --dataset .data/spraywall-coco \
  --split eval --score-threshold <best of the sweep> \
  --model .data/artifacts/medium-untiled-1280/model-int8.onnx \
  --out .data/artifacts/medium-untiled-1280/eval-full-run.json
```

**Batch size**: `configs.json`'s `medium-untiled-1280` ships `batch_size: 2` for
this box's CPU RAM. 128 GB of unified memory has room for far more — try
`--batch-size 32` and step down if training is slow to start, and **halve it**
on an `mps` "out of memory" (or the process silently stalling) rather than
retrying the same number. `--threads` / `HOLDS_THREADS` only matter for
`--device cpu`; they do nothing for `mps` compute (data loading still uses
some CPU threads regardless of device).

**MPS status (2026-09-15)**: this path has now run in anger — the full-run
results below all come from `--device mps` on an M5 Max. Two things bit and
their fixes are in "The full run (M5 Max, 2026-09-15)" under *Training notes*:
the allocator pool stalls training after the first validation unless the batch
stays at 8 with the watermark ratios capped, and nano cannot train at a 1024 px
input (quadratic attention; use 768). If `mps` misbehaves in some new way,
`--device cpu` on the same Mac still runs the full pipeline.

**What to hand back**: the `eval-*.json` files (`eval.py`'s `--out`, with the
per-photo breakdown) from the `tune` sweep and the final `eval` split score,
plus the int8 ONNX itself. The int8 export is 28-33 MB depending on config —
over this repo's 15 MB ceiling — so it does not get committed; it goes to R2
under `models/hold-detector/<version>/` instead — see "Publishing a model"
below (`docs/user-media-storage.md` has the bucket/credential contract).

## Publishing a model

`publish_model.py` (SW-01, issue #5434) is the only thing in `ml/holds/` that
talks to R2. Given a config and a version tag, it builds `manifest.json`,
validates it against `model-manifest.schema.json`, and uploads it plus the
exported ONNX weights to `models/hold-detector/<version>/` in the public
`media` bucket (`docs/user-media-storage.md`). Nothing else in this directory
uploads anything.

**Weights are immutable per version; the manifest is the only mutable
pointer.** `models/hold-detector/1.2.0/model-int8.onnx`, once published, is
never rewritten — a new export gets a new version tag. The manifest at a given
version *can* be re-published deliberately (`--force`), which is why weight
files upload before the manifest: a reader can never see a manifest pointing
at a weight file that hasn't landed yet.

### Env vars

Same `MEDIA_*` prefix the backend uses for the same bucket
(`packages/backend/src/storage/bucket-config.ts`, `docs/user-media-storage.md`)
— this script never falls back to bare `AWS_*`, so a typo'd prefix fails loudly
instead of silently publishing into the wrong bucket:

```
MEDIA_S3_BUCKET_NAME          selects real-upload mode; absent = --dry-run by default
MEDIA_AWS_ENDPOINT_URL        (or MEDIA_AWS_ENDPOINT_URL_S3)
MEDIA_AWS_REGION              (or MEDIA_AWS_DEFAULT_REGION; defaults to `auto`)
MEDIA_AWS_ACCESS_KEY_ID
MEDIA_AWS_SECRET_ACCESS_KEY
MEDIA_S3_FORCE_PATH_STYLE     optional, defaults false
MEDIA_PUBLIC_BASE_URL         optional; only used to print the resulting manifest URL
MEDIA_DISABLE_ACL             optional; defaults true for an R2 endpoint
```

### Command

```bash
cd ml/holds && . .venv/bin/activate
pip install boto3 jsonschema  # publish_model.py's only non-stdlib deps; no torch/onnxruntime needed

export MEDIA_S3_BUCKET_NAME=boardsesh-user-media
export MEDIA_AWS_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com
export MEDIA_AWS_ACCESS_KEY_ID=… MEDIA_AWS_SECRET_ACCESS_KEY=…
export MEDIA_PUBLIC_BASE_URL=https://media.boardsesh.com

python publish_model.py \
  --config medium-untiled-1280 --version 2026.09.15 \
  --threshold 0.20 --sweep 0.05,0.08,0.12,0.2 \
  --dataset "Roboflow climbing-holds-and-volumes v14, 600 photos" \
  --training-licence "CC BY 4.0" --epochs 1 --trained-on cpu --date 2026-09-14 \
  --eval-json .data/artifacts/medium-untiled-1280/eval-full-run.json
```

`--eval-json` and `--training-json` accept a JSON file instead of (or on top
of) the individual flags — see `python publish_model.py --help`. Add
`--include-fp32` to also publish the fp32 weights alongside int8.

### Dry run

Without `MEDIA_S3_BUCKET_NAME` set, the script defaults to `--dry-run`: it
builds and prints the same manifest but writes the tree to a local directory
(`.data/publish/<config>/<version>` by default) instead of uploading. Pass
`--dry-run` explicitly to test locally even with real credentials present.

```bash
python publish_model.py \
  --config nano-tiled-1024 --version 2026.09.15-test --dry-run \
  --dataset "The Way Up, 400 tiles" --training-licence "CC BY 4.0" \
  --epochs 2 --trained-on cpu --date 2026-09-14
```

Both modes refuse to overwrite an existing version (an existing local
directory in dry-run mode, an existing R2 object in real mode) unless `--force`
is passed. In real mode `--force` covers the **manifest only**: weight files are
served `public, max-age=31536000, immutable`, so an already-published file with
the same sha256 is skipped and one with different bytes stops the publish and
asks for a new `--version` — a cached client would otherwise keep bytes that no
longer match the manifest's checksum. A weight file published before this script
stamped checksums is hashed in place first, and an identical one has its metadata
stamped (bytes untouched) so the repair path stays open for older versions.

Credentials are never printed or logged by either mode.

`--eval-json` takes an `eval.py` results file (`.data/artifacts/<config>/eval.json`)
as well as a manifest-shaped one: `box.f1` and `correction_rate_micro` are read
into the manifest's `sprayEvalF1` and `weightedCorrectionsPerHold`, and the file's
`split` is recorded alongside them. A file with none of those keys is an error
rather than a manifest that silently ships without its `eval` section, and so is
one whose own `config`, `model` or `score_threshold` disagrees with what is being
published — a tune-sweep run or another config's run must not be presented as this
export's held-out number at the shipped threshold.

### How the manifest gets consumed

`model-manifest.schema.json` is the contract: `schemaVersion`, `version`,
`family`, `config`, the ONNX `input`/`outputs` shape (letterbox mode,
normalization, box format, sigmoid activation — the same conventions
`eval.py`'s `OnnxDetector` decodes), `thresholds`, a `files` list with
per-file `sha256` for integrity checking after download, `training`
provenance (and its data licence, which the app's licences screen must
credit), optional `eval` numbers, and the weights' own `licence`
(`Apache-2.0` — every config in `configs.json` is an Apache-2.0 family).

Every new publication includes `inference`: the photo's long-side resize,
tile rows/columns/overlap and cross-tile NMS IoU. Publisher validation requires
that plan even for an untiled full-frame pass. The shared schema leaves it
optional for legacy version-1 manifests; absence does not establish how an older
model was trained or evaluated. Segmentation exports also describe their mask
tensor and require interpolation before thresholding.

The recognition service (`packages/hold-detector/src/manifest.ts`) reads this
contract and verifies the weights' byte count and SHA-256. Current deployment
and exposure gates are in `docs/spray-recognition-rollout.md`; the earlier phone
inference runtime has been superseded.

### Lightweight preprocessing and publisher checks

With pytest, Pillow, NumPy, boto3 and jsonschema installed from the pinned
requirements, run from `ml/holds`:

```sh
vp exec python -m pytest test_tile_coco.py test_publish_model.py test_train.py test_fetch.py -q
```

These checks use generated images and model bytes; they do not train a model,
download a corpus or publish objects. COCO polygon masks are clipped into every
retained tile. RLE masks are rejected explicitly and must be converted to polygon
annotations before using this preprocessing path.

RF-DETR `seg-*` training requires a usable polygon for every annotated hold in
train, validation and test splits. The default Way Up corpus is box-only and
cannot train a mask model; choose a fully polygon-labelled corpus with
`--dataset`. Mixed box/polygon labels, empty masks and stale tiled caches are
rejected before model construction. Source labels and prepared/cached tiles
are both checked, including the capped training subset. Ordinary box models
and box models with classical postprocessing can still use box-only labels.

## Reproducing every number in the report

```bash
cd ml/holds && . .venv/bin/activate

# 1. Corpus. --list prints the registry with each licence and whether it is usable;
#    --only <name> fetches one source (or prints its manual steps).
python data/fetch.py --list
ROBOFLOW_API_KEY=$(cat ~/.config/roboflow/api-key) \
  python data/fetch.py --only roboflow-climbing-holds-and-volumes
python data/single_class.py --source .data/roboflow-climbing-holds-and-volumes \
  --target .data/roboflow-1class
python data/fetch.py --only wayup

# 2a. The public bootstrap corpus (The Way Up). Splits by participant, so a
#     held-out frame is a camera setup the model never trained on.
python data/wayup.py --root <extracted Way Up tree> --out .data/coco \
  --every 45 --frames-per-clip 24 --holdout-participants p10

# 2b. Or a hand-labelled corpus (the Discord spray-wall photos), split by photo.
python data/to_coco.py --source spraywall-discord:.data/spraywall-discord:coco

# 3a. Train the BOOTSTRAP runs (The Way Up only — .data/coco, train.py's default
#     --dataset). Tiled configs tile the dataset first, cached per source corpus in
#     .data/<source>-tiles-<grid>-<long side>/. --max-train-images keeps a CPU run
#     inside a sane wall clock; it symlinks an evenly spaced subset rather than
#     copying anything, and for a tiled config it caps TILES, not photos.
python train.py --config nano-tiled-1024 --epochs 2 --max-train-images 400
python train.py --config medium-untiled-1280 --epochs 2 --max-train-images 300

# 3b. Train the CC BY retrains — the second and fourth columns of the spray-wall
#     table. --dataset is not optional here: without it these retrain the Way Up
#     bootstrap corpus again, and the caps are the table's own "Trained on" row.
python train.py --config nano-tiled-1024 --dataset .data/roboflow-1class \
  --epochs 1 --max-train-images 1400
python train.py --config medium-untiled-1280 --dataset .data/roboflow-1class \
  --epochs 1 --max-train-images 600

# 3c. The FULL-run columns (nano-untiled-1024 and medium-untiled-1280, all 3,876
#     train-split photos x 10 epochs) are a Mac job, not a CPU-box one: ~37 hours
#     here against a few hours on an M5 Max. Recipe: "Full run" above, with
#     --config nano-untiled-1024 as well as medium-untiled-1280.
python train.py --config nano-untiled-1024 --device mps --epochs 10 \
  --dataset .data/roboflow-1class

# 4 + 5. Export and score. Both live under .data/artifacts/<config>/, and every run
#        of one config writes the same directory — so export and score a config
#        before retraining it, or step 5 reports whichever run finished last.
python export.py --config nano-tiled-1024 --formats onnx,tflite
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
  --score-threshold 0.05 --model .data/artifacts/nano-tiled-1024/model-int8.onnx \
  --out /tmp/fixture-eval.json
```

Two things that command deliberately does **not** do. It does not run at the
config's default 0.3 — that threshold scores 0.000 here and would read as a broken
harness (see the sweep below). And it does not pass `--write-fixtures`, so a
reviewer cannot overwrite the committed expectations with their own run.
Regenerating those is a deliberate act, and `fixtures/README.md` has that command.

Measured wall clock on the spike box: **2.6 s** for three photos, well inside the
two-minute budget.

## Measured so far

Three corpora, in order of how much they should count.

1. **Spray walls** — 61 photos collected from the open web, 54 labelled by hand.
   The product's actual subject. The scored set is the **21 photos labelled
   completely** (2,256 holds), split in half by photo: the score threshold is
   chosen on `tune` (11 photos) and every number below is reported on `eval`
   (10 photos, 964 holds), which the threshold never saw.
2. **General climbing walls** — 28 Wikimedia Commons photos, 1,308 holds. Gym
   lead walls and bouldering walls rather than spray walls.
3. **The Way Up held-out split** — 48 video frames of the one wall both models
   trained on, from an unseen camera setup.

Both models were trained **only** on The Way Up. Neither has ever seen a spray
wall in training, which is the single most important thing to know before reading
any of these numbers.

### Spray walls, held-out — the number that counts

Threshold picked on `tune`, F1 reported on `eval`. int8 weights, because int8 is
what would ship. Two training runs are shown: the original bootstrap (The Way Up,
one route wall) and the retrain on the **CC BY 4.0 Roboflow climbing-holds set**.

| | nano-tiled, bootstrap | nano-tiled, **CC BY** | medium-untiled, bootstrap | medium-untiled, **CC BY** | Gate |
| --- | --- | --- | --- | --- | --- |
| Trained on | 400 tiles of 1 wall | 1,400 tiles / ~350 photos | 300 frames of 1 wall | 600 photos | — |
| Threshold (from `tune`) | 0.05 | 0.05 | 0.08 | **0.20** | — |
| Precision | 0.274 | 0.228 | 0.504 | 0.514 | — |
| Recall | 0.461 | 0.419 | 0.533 | **0.612** | — |
| **F1 @ box IoU 0.5** | 0.344 | 0.295 | 0.518 | **0.559** | ≥ 0.80 ❌ |
| Corrections ÷ holds | 1.76 | 2.00 | 0.99 | **0.97** | ≤ 0.10 ❌ |
| Latency p50 / p95 | 0.560 / 0.596 s | 0.591 / 0.658 s | 0.365 / 0.398 s | **0.347 / 0.384 s** | ≤ 8 s on device ⚠️ |
| Peak RSS | **391 MB** | **391 MB** | 545 MB | 545 MB | < 500 MB |
| Artifact | 28.7 MB int8 | 28.7 MB int8 | 32.8 MB int8 | 32.8 MB int8 | — |

Both numbers come from the same 10 held-out spray-wall photos (964 holds) that
neither model, and neither threshold sweep, ever saw.

**The two configs moved in opposite directions**, which is the finding:

- **medium-untiled improved by 4.1 F1 points** on 600 photos and a single epoch of
  real hold data, almost all of it recall (0.533 → 0.612). It also became better
  calibrated: its best threshold moved from 0.08 to 0.20, which is what a model
  that has actually seen holds looks like.
- **nano-tiled got 4.9 points worse.** Not noise — the tiling is wrong for this
  data. The Roboflow photos are around 800 px on the long side, so cutting them
  2×2 at 1024 produces ~330 px tiles upscaled to 384: each hold gets bigger and
  the surrounding wall, which is what says "this is a hold and not a smudge",
  disappears. And a 1,400-tile budget is only ~350 distinct photos against
  medium's 600.

So the tiled small config is not simply trailing the big one — it is the option
that fails to benefit from better data at this photo scale. If SW-02 wants a
phone-sized model, the lever is a smaller architecture at full-frame resolution
(YOLOX-nano), not RF-DETR nano with tiles.

### The full run (M5 Max, 2026-09-15)

The full-dataset run the paragraph below asked for happened: all 3,876
train-split photos, 10 epochs, on an M5 Max's GPU (`--device mps`). Two configs
were trained; `nano-tiled-1024` was deliberately skipped, because the spike had
already shown 2×2 tiling hurts at this photo scale, and its replacement is the
new **`nano-untiled-1024`** config — the same nano weights given one full-frame
pass at 768 px instead of four 384 px tiles (768 and not 1024 because DINOv2
attention is quadratic in tokens: 1024-px training, which rfdetr's multi-scale
augmentation pushes to 1184, ran ~70× slower per step on MPS).

Protocol as always: threshold swept on the spray `tune` half **against the int8
artifact**, F1 reported once on `eval` (10 photos, 964 holds). Previous-run
columns are the 600-photo/1,400-tile CC BY retrains from the table above.

| | nano-untiled, **full** | medium-untiled, **full** | nano-tiled, CC BY | medium-untiled, CC BY | Gate |
| --- | --- | --- | --- | --- | --- |
| Trained on | 3,876 photos × 10 ep | 3,876 photos × 10 ep | 1,400 tiles × 1 ep | 600 photos × 1 ep | — |
| Threshold (from `tune`, int8) | 0.60 | 0.60 | 0.05 | 0.20 | — |
| Precision | 0.682 | 0.695 | 0.228 | 0.514 | — |
| Recall | 0.637 | 0.610 | 0.419 | 0.612 | — |
| **F1 @ box IoU 0.5** | **0.659** | 0.650 | 0.295 | 0.559 | ≥ 0.80 ❌ |
| Corrections ÷ holds | **0.660** | 0.658 | 2.00 | 0.97 | ≤ 0.10 ❌ |
| Weighted corr. (2·miss+FP) ÷ holds | **1.02** | 1.05 | — | — | ~0.5 (proposed) ❌ |
| Latency p50 / p95 (M5 Max CPU) | 0.166 / 0.187 s | 0.148 / 0.241 s | — | — | ≤ 8 s ✅ |
| Peak RSS (onnxruntime, macOS) | **987 MB** | 593 MB | — | — | < 500 MB ❌ |
| int8 artifact | 31.3 MB | 32.8 MB | 28.7 MB | 32.8 MB | — |
| Roboflow test split (in-domain) F1 | 0.908 | 0.893 | — | — | — |
| Train wall clock | 99 min | 78 min¹ | 39 min (CPU) | 34 min (CPU) | — |

¹ plus one 70-min epoch wasted on an MPS allocator stall before the batch/pool
fix (see below). Earlier peak-RSS numbers in this README were measured with a
Darwin `ru_maxrss` bug (bytes read as KB); the numbers in this table are correct
on both platforms.

What the full run settles:

- **Full-frame nano beats medium.** 0.659 vs 0.650, in a 31.3 MB artifact. It did
  not train faster: 99 min against medium's 78 min of useful time, because nano
  runs at 768 px where medium's own full-frame pass is cheaper per step. The
  spike's hypothesis — the lever is full-frame resolution, not model size — held:
  the same weights that scored 0.295 with tiles score 0.659 without them.
- **The dataset is exhausted.** Per-epoch scoring on the spray halves (the
  `results/full-run-2026-09-15-m5max/*/curve/` files — one file per epoch in
  which `checkpoint_best_ema.pth` changed, so a missing epoch number, like
  medium's 7, means the in-domain EMA metric did not improve that epoch and
  there was no new checkpoint to score) shows both configs
  plateauing by epoch 4–6 (medium 0.586 → 0.619, nano 0.590 → 0.615, fp32
  coarse-sweep numbers) and flat for the rest of the run, while the in-domain
  Roboflow test F1 reaches 0.89–0.91. The model has learned this dataset; the
  remaining gap to any gate is **domain shift to real spray walls**, and the
  fix is spray-wall training photos (the corpus protocol below), not more
  epochs or a bigger model.
- **Full training fixes calibration.** The tune-optimal threshold moved from
  0.05–0.20 to 0.60 on both configs, and F1-optimal and tap-optimal (weighted
  corrections) thresholds now coincide at 0.60.
- **Memory is the new on-device blocker for nano.** One 768 px full-frame pass
  through onnxruntime's CPU provider peaks at 987 MB — double the 500 MB gate —
  versus 391 MB for the tiled config it replaces. If SW-02 wants this accuracy
  on-device, the options are a tiled *inference* mode over full-frame-trained
  weights, a smaller input at eval time, or a runtime with a leaner memory plan
  (CoreML/NNAPI), all unmeasured here.

Training notes for whoever runs this next, all on the M5 Max: batch 16 with
default MPS watermarks stalled after the first epoch-end validation (the
allocator pool grew to ~100 GB and every step then blocked in a synchronous GPU
copy at ~2 min/step); batch 8 + `PYTORCH_MPS_HIGH_WATERMARK_RATIO=1.0
PYTORCH_MPS_LOW_WATERMARK_RATIO=0.5` ran clean at ~8.5 min/epoch, and
`train.py --resume last` recovered the stalled run without losing its finished
epoch. `HOLDS_THREADS` is irrelevant to MPS compute.

### What a full training run would need

(Answered above — kept for the record.) The retrain used **600 of the 3,876
train-split photos for one epoch** and took 34 minutes of CPU; nano took 39
minutes for 1,400 tiles. A run that actually exhausts the dataset — all 3,876
train-split photos, 10 epochs, the usual RF-DETR fine-tuning recipe — was
estimated at roughly 37 hours on those 8 CPU threads, or 1–2 hours on a GPU.
The M5 Max run above took 1.6–2.9 h per config, MPS quirks included.

### General climbing walls (Commons), and The Way Up

| | `nano-tiled-1024` | `medium-untiled-1280` |
| --- | --- | --- |
| Commons, 28 photos, best threshold 0.05 | 0.367 | **0.592** |
| The Way Up held-out, best threshold 0.3 | **0.483** | 0.085 |

The Commons threshold was picked on the same photos the F1 is reported on, so
those two numbers are optimistic — that is exactly why the spray-wall corpus is
split into `tune` and `eval`, and why the spray-wall table is the one to quote.

The Way Up row is the trap worth keeping. There, tiling looks like everything and
the bigger model looks broken. On both real-photo corpora the ranking **inverts**.
The Way Up is portrait video of a narrow wall strip, so downscaling to one 576 px
square throws its holds away; a real wall photo is framed on the wall and one
untiled pass sees the holds fine. **Do not settle the tiling question on a video
bootstrap corpus.**

### Thresholds move F1 by tens of points

`eval.py --score-threshold` exists because the first real-photo run scored **F1
0.003** at the configs' default 0.3 and looked like total failure. It was
calibration, not blindness: two epochs leaves a model under-confident.

`nano-tiled-1024` on the spray-wall `tune` half:

| Threshold | Precision | Recall | F1 |
| --- | --- | --- | --- |
| 0.02 | 0.156 | 0.615 | 0.249 |
| **0.05** | 0.320 | 0.487 | **0.386** |
| 0.08 | 0.427 | 0.331 | 0.373 |
| 0.12 | 0.502 | 0.200 | 0.286 |
| 0.20 | 0.571 | 0.074 | 0.132 |

`medium-untiled-1280` on the same half peaks at 0.08 (F1 0.553) and still scores
0.462 at 0.02 — it is the better-calibrated of the two as well as the better
detector. And the best threshold is **not the same across corpora**: 0.05 on the
Commons set, 0.3 on The Way Up, where 0.05 collapses precision to 0.077. A single
shipped constant will be wrong for somebody's wall, which argues for the
confidence slider already decided in #5441.

### Export size

| Artifact | `nano-tiled-1024` | `medium-untiled-1280` | Runs on the CPU provider? |
| --- | --- | --- | --- |
| fp32 ONNX | 107.6 MB | 120.6 MB | yes |
| fp16 ONNX | 54.1 MB | 60.6 MB | **no** |
| **int8 ONNX** (dynamic) | **28.7 MB** | **32.8 MB** | yes |

Three things this corrects or establishes:

- **The 90-class COCO head was never the problem.** An earlier note here guessed
  it was about half the file. Measured against the graph, the tensors carrying
  class dimensions are **0.000 MB**: RF-DETR nano is 30.1 M parameters because of
  its DINOv2 ViT backbone, and 30.1 M × 4 bytes is the whole 107.6 MB.
  `configs.json` now sets `num_classes: 1` anyway — it is correct modelling and it
  drops 89 dead logits from every inference — but it buys **no** file size.
- **RF-DETR's `quantization` argument is a no-op for `format="onnx"`.** Passing
  `fp16` returns a byte-identical fp32 file. `export.py --shrink` therefore
  converts the exported graph itself, with `onnxconverter-common` for fp16 and
  `onnxruntime.quantization.quantize_dynamic` for int8.
- **fp16 halves the file but will not load on ONNX Runtime's CPU provider**, with
  or without `keep_io_types` (mixed float/float16 `Conv`). It targets a
  float16-capable delegate — NNAPI, CoreML, GPU — so validating it needs a device,
  which is SW-02's job. int8 is the one that runs everywhere today.

Even int8 is 28.7 MB against a ~25 MB first-launch budget. Close, not under.

Exports are **opset 17, IR version 8**, with no custom operators. ONNX Runtime
Mobile has supported opset 17 since 1.13 and `.ort` conversion is optional — a
plain `.onnx` loads — and the ONNX-to-ExecuTorch path accepts the same graph.
Neither claim is device-verified here.

### Training, and what was deliberately not trained on

Bootstrap runs (The Way Up): `nano-tiled-1024` 400 tiles × 2 epochs, 21.6 min;
`medium-untiled-1280` 300 photos × 1 epoch, 19.8 min.

CC BY runs (Roboflow): `medium-untiled-1280` 600 photos × 1 epoch, **34.4 min**;
`nano-tiled-1024` 1,400 tiles × 1 epoch, **39.1 min**. CPU only, one process at a
time.

**The spray-wall corpus was not used for training, on purpose, for two reasons.**
It is the only held-out measurement of the thing we actually care about, and
training on it would destroy that. And most of it is not licensed for it: 41 of
the 61 photos are all-rights-reserved editorial photography. Evaluating a model
against a copyrighted photo on one machine is a different act from baking it into
weights that ship. The Commons set is CC and *could* be trained on, but it is the
only other clean evaluation set there is.

So the honest position is: there is still no corpus this model may both learn from
and be judged on. The Roboflow ask below is what fixes that.

Reproduce exactly:

```bash
python data/wayup.py --root <extracted Way Up tree> --out .data/coco \
  --every 45 --frames-per-clip 24 --holdout-participants p10
python train.py  --config nano-tiled-1024 --epochs 2 --max-train-images 400
python export.py --config nano-tiled-1024 --formats onnx --shrink fp16,int8

python data/scrape_spraywalls.py                       # or the manual collection below
python data/label_tool.py merge --corpus .data/spraywalls --out .data/spraywall-coco --halves
python eval.py --config medium-untiled-1280 --dataset .data/spraywall-coco --split tune \
  --score-threshold 0.08                               # sweep here
python eval.py --config medium-untiled-1280 --dataset .data/spraywall-coco --split eval \
  --score-threshold 0.08 --model .data/artifacts/medium-untiled-1280/model-int8.onnx
```

Mask IoU is **not reported**: no corpus here has mask ground truth, so the
box-plus-classical-segmentation config and the seg-nano config have nothing to be
scored against. `eval.py` computes it as soon as one arrives.

## The spray-wall evaluation corpus

61 photos of home and gym spray walls, collected from the open web because no
licensed one exists: Climbing Business Journal's "Home Wall of the Week" (39),
climbing blogs, build write-ups and gym sites (14), Flickr public feeds (8).
Reddit's JSON endpoints return 403 from this machine. Everything lands in the
gitignored `.data/spraywalls/` with a `sources.csv` recording the image URL, the
page it came from, the licence **exactly as stated** (`not stated` when there is
none), and the fetch date.

**These photos are evaluation only.** 41 of 61 are all-rights-reserved editorial
photography, 11 state no licence, and exactly one (a Commons image) is CC BY 4.0.
They are never committed, never redistributed, never used as training data, and
every one is traceable to its page so any of it can be removed on request. Nothing
from this corpus may enter `fixtures/`.

Labelling outcome: 21 photos labelled completely (2,256 holds), 33 labelled in
part and flagged `"partial": true` (2,093 holds), 7 rejected as unlabelable.
Tags across the 54 usable: `spray-wall` 45, `overhang` 42, `dense` 40, `home-wall`
37, `angled` 35, `bright` 29, `volumes` 22, `gym-wall` 17, `low-light` 16,
`sparse` 14, `wood-on-wood` 13, `tape` 8.

That 33-of-54 partial rate is the corpus's headline finding about itself. A spray
wall photographed whole puts most of its holds at 6-20 px, and below about 15 px a
drawn box covers the hold, so the check step stops telling you anything. Labellers
excluded those regions and named the bounds rather than guess. Which means: **the
hardest part of a spray wall is hard for a careful human at 1280 px too**, and a
user photographing their wall should be told to shoot closer or in two halves.

## The Commons evaluation corpus

`data/scrape_commons.py` pulls climbing-wall photos from Wikimedia Commons —
keyless, and the only large source whose per-file licence is machine readable, so
every photo is traceable. Non-commercial and no-derivatives licences are refused,
not warned about. Everything lands in the gitignored `.data/realwall/` with a
`sources.csv` (file name, Commons title, file page URL, licence, author,
dimensions, orientation, how it was found, fetch date). **Scraped photos are never
committed**; only a CC-licensed one with its attribution recorded may be promoted
into `fixtures/`, and the three committed fixtures come from here.

103 candidates were fetched and triaged by hand; **28 were labelled completely**
(1,308 holds) and 31 rejected. The rejects matter as much as the keeps: a photo
where only half the holds can be enumerated is marked `usable: false`, because a
partial label charges the detector for holds nobody labelled.

Corpus at a glance: 28 photos, portrait and landscape, tagged `sparse` 20,
`bright` 16, `angled` 15, `volumes` 8, `dense` 4, `tape` 4, `wood-on-wood` 4,
`overhang` 4, `low-light` 3, `spray-wall` 1. That last number is why the
spray-wall corpus above had to exist.

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
| `onnxconverter-common` | MIT | offline only — the fp16 conversion |
| Spray-wall photos (the primary evaluation corpus) | 41 of 61 **all rights reserved**, 11 `not stated`, 1 CC BY 4.0 | evaluation only, gitignored, never redistributed, **never training data**, never a fixture |
| Wikimedia Commons wall photos (the secondary evaluation corpus) | per file: CC BY-SA 4.0 / 3.0 / 2.0, CC BY 4.0 / 3.0 / 2.0, CC0, public domain — **no NC, no ND** | evaluation only, gitignored; a photo promoted to `fixtures/` carries its licence, author and file page in the COCO record |
| Roboflow `climbing-holds-and-volumes` v14 (the training set) | **CC BY 4.0** | fine-tuned weights would ship — **needs credit on the app licences screen** |
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
and CoreML paths, so the model family does not lock us into one runtime. Sizes,
the opset, and which precisions actually load are in **"Export size"** above.
