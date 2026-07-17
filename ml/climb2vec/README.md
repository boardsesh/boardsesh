# Climb2Vec — offline training & evaluation

Offline PyTorch/sklearn pipeline for the hold-geometry grade model (see
`../../docs/climb2vec.md`). The production `climb2vec-v1` workflow remains
unchanged. The Stage-3 morphology/relational path in this directory is a
pre-registered offline trial; it cannot produce a loadable artifact unless it
passes the incumbent comparison and the sealed test rule.

## Layout

- `dataset.py` — load the JSONL extract, split by climb (no angle leakage), build
  label-free geometry features + hold-identity, duplicate-holdset keys.
- `model.py` — the Deep Sets encoder: per-hold node MLP → masked mean/max/**sum**
  pool → angle → penultimate **embedding** → linear grade head; plus the
  placement-ID-free relational residual candidate.
- `evaluate.py` — the leakage-free eval: ridge + GBM + Deep Sets grade accuracy on
  held-out climbs, and similarity (duplicate retrieval + nearest-neighbour grade
  agreement). Writes `artifacts/results.json`.
- `stage3_dataset.py` — physical-problem splits, sealed Tension benchmarks,
  train-fold hold effects, incumbent/enhanced GBM features, and relational
  tensors.
- `stage3_experiment.py` — Runs 3–7 and their automatic kill/ship decisions.
- `training.py` — deterministic weighted-Huber training over a detached,
  cross-fitted GBM prediction.

## Leakage discipline

The per-hold `hd`/`fd` fields in the extract were fit on **all** grades, so the
Stage-3 path never consumes them. Every behavioral hold effect is refit inside
the relevant training partition. The residual model receives out-of-fold GBM
predictions and hold effects whose ridge fit did not see that physical problem.

The Stage-3 split key is `physicalKey`, not UUID. Kilter uses
`(layout_id, hold_fingerprint)`. Tension uses the lexicographically smaller of
the complete original/mirrored route signatures scoped to its product family.
MoonBoard uses the same route signature scoped to `layout_id`, because editions
reuse cell ids for different physical holds. STARTING, HAND, FINISH, and FOOT
remain distinct. Duplicate listings, mirrors, and every angle therefore stay
together.

Any physical problem containing a Tension benchmark is sealed completely. It
cannot fit hold effects, the GBM, the relational model, or choose the seed.
The encoder limit is 40 holds; any physical problem containing a zero-hold or

> 40-hold row is excluded and reported before splitting. No row is truncated.

## Run

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
pip install torch==2.13.0 --index-url https://download.pytorch.org/whl/cpu   # for Deep Sets

# 1. Rebuild deterministic per-hold morphology from committed transparent art.
vp run db:extract-hold-morphology --

# 2. Export Kilter + Tension frozen Stage-2 targets in one read-only,
# repeatable-read snapshot. Cold curated Tension benchmarks are retained for the
# sealed answer key even without a Stage-2 crowd target. Conflicting duplicate
# benchmark answers reject that whole physical problem and are recorded in
# data/stage3-train.jsonl.rejections.json.
vp run db:extract-training-matrix -- \
  --board=kilter,tension --target=stage2 \
  --morphology=ml/climb2vec/artifacts/hold-morphology-v1.jsonl \
  --out=ml/climb2vec/data/stage3-train.jsonl

# Score inputs are label-free and retain every UUID so a passing model can map
# pooled physical predictions back to aliases.
vp run db:extract-training-matrix -- \
  --board=kilter --score \
  --morphology=ml/climb2vec/artifacts/hold-morphology-v1.jsonl \
  --out=ml/climb2vec/data/kilter-stage3-score.jsonl
vp run db:extract-training-matrix -- \
  --board=tension --score \
  --morphology=ml/climb2vec/artifacts/hold-morphology-v1.jsonl \
  --out=ml/climb2vec/data/tension-stage3-score.jsonl
vp run db:extract-training-matrix -- \
  --board=moonboard --score \
  --morphology=ml/climb2vec/artifacts/hold-morphology-v1.jsonl \
  --out=ml/climb2vec/data/moonboard-stage3-score.jsonl

# 3. Run the complete five-run budget once. The command automatically stops
# after Run 4 or Run 6 when a kill threshold fails.
cd ml/climb2vec
python stage3_experiment.py \
  --data data/stage3-train.jsonl \
  --through-run=7 \
  --score data/kilter-stage3-score.jsonl \
  --score data/tension-stage3-score.jsonl \
  --score data/moonboard-stage3-score.jsonl

cd ../..
vp run db:evaluate-content-prior-shadow -- \
  --in=ml/climb2vec/artifacts/stage3-shadow-predictions.jsonl

# Only after offline + shadow approval: the artifact is intentionally combined,
# identified, and catalog-complete. Each loader invocation validates every line,
# selects one board by record.boardType, and atomically replaces that board.
# `vp node` is Vite+'s supported Node passthrough, keeping these maintenance
# commands inside the repository's sanctioned toolchain.
vp node --import tsx packages/db/scripts/load-content-model.ts \
  --board=kilter --model=climb2vec-relational-morphology-v1 \
  --in=ml/climb2vec/artifacts/stage3-shadow-predictions.jsonl
vp node --import tsx packages/db/scripts/load-content-model.ts \
  --board=tension --model=climb2vec-relational-morphology-v1 \
  --in=ml/climb2vec/artifacts/stage3-shadow-predictions.jsonl
vp node --import tsx packages/db/scripts/load-content-model.ts \
  --board=moonboard --model=climb2vec-relational-morphology-v1 \
  --in=ml/climb2vec/artifacts/stage3-shadow-predictions.jsonl

cd ml/climb2vec
python similarity_export.py \
  --content artifacts/stage3-shadow-predictions.jsonl \
  --out artifacts/stage3-similarity.jsonl
cd ../..
vp node --import tsx packages/db/scripts/load-similarity.ts \
  --board=kilter --model=climb2vec-relational-morphology-v1 \
  --in=ml/climb2vec/artifacts/stage3-similarity.jsonl
vp node --import tsx packages/db/scripts/load-similarity.ts \
  --board=tension --model=climb2vec-relational-morphology-v1 \
  --in=ml/climb2vec/artifacts/stage3-similarity.jsonl
vp node --import tsx packages/db/scripts/load-similarity.ts \
  --board=moonboard --model=climb2vec-relational-morphology-v1 \
  --in=ml/climb2vec/artifacts/stage3-similarity.jsonl

# Post-approval integration safety only: validate-only always refits coefficients
# in memory, and dry-run may do so when the frozen snapshot is stale. Do not run
# these against prod under the Stage-3 read-only/no-refit constraint.
vp run db:refresh-climb-grades -- --validate-only
vp run db:refresh-climb-grades -- --dry-run

# --through-run=4 or 6 is available for a cheap wiring audit. Do not run 4,
# then 6, then 7 on the real dataset: that repeats earlier fits and spends more
# than the pre-registered five-run budget.
```

Every reported error is in one Aurora difficulty integer step: one Font
sub-grade, roughly half a V-grade.

## Pre-registered decision rule

There are five registered run decisions, numbered 3–7.

- Run 4 must improve Kilter validation MAE over the incumbent-feature Run 3 GBM
  by at least `0.05` Aurora steps. Otherwise stop.
- Runs 5 and 6 use fixed seeds 13 and 29. Both must improve Kilter validation
  MAE over Run 4 by at least `0.05` Aurora steps. Otherwise stop.
- Run 7 refits the selected seed on train+validation, using internal two-fold
  cross-fitting for the residual target. It then opens the sealed test once and
  passes offline only if Kilter test MAE improves over the same-feature GBM by
  at least `0.05` Aurora steps and sealed Tension benchmark MAE regresses by no
  more than `0.01` Aurora steps.

Runs 5 and 6 share two train-fold GBMs. Run 7 owns the final enhanced-GBM refit,
two internal cross-fold GBMs, and the selected neural refit before it reads
either sealed answer key.
`contentSd` is held-out RMSE grouped by predicted grade band, matching the band
known when an unlabeled climb is scored.

Passing Run 7 means “eligible for the read-only shadow,” not “ship.” The shadow
requires usable predictions for at least 95% of eligible Kilter/Tension
backtest rows overall and on each board, then applies its
tail/head/grade-band/angle/no-shock/physical-problem checks. It does not report
current-traffic buckets as cold-tail evidence because every backtest truth row
currently has at least 50 ascents. The unchanged `--validate-only` and
`--dry-run` publish-path sanity checks follow. Those unchanged commands do not
measure content improvement because the protected production blend still uses
content only in its existing cold-tail branch.
No-shock and physical-problem consistency fail closed when the artifact has no
established row or checkable alias group; missing evidence cannot pass a ship
gate.

The Stage-3 score artifact contains one row for every eligible catalog
climb-angle. Supported rows carry the prior, uncertainty, and fixed-width
64-value embedding;
zero- or over-40-hold physical problems carry `supported:false` with null model
outputs. The identified loader verifies exact catalog coverage, validates the
record board/model, and atomically replaces one selected board, so a newly
unsupported cell cannot retain a stale prior. The incumbent `climb2vec-v1`
single-board schema remains an explicit legacy upsert mode for the existing
weekly workflow. That workflow retains each scored JSONL as an Actions artifact
for seven days before loading it, so a transient DB failure does not discard the
completed training run.

## Phase-1 feasibility result (Kilter, dev-DB extract: 29,748 obs, 80/20 by climb)

Grade accuracy on **held-out** climbs (label = crowd `difficulty_average`, in
Aurora difficulty units ≈ 2 per V-grade, so MAE 1.4 ≈ ~0.7 V-grade):

| model                    | exact | within ±1 unit | MAE      |
| ------------------------ | ----- | -------------- | -------- |
| ridge (linear content)   | 17.4% | 48.2%          | 1.93     |
| GBM (aggregate features) | 23.8% | 59.8%          | **1.42** |
| Deep Sets (Climb2Vec)    | 19.9% | 56.8%          | 1.55     |

Similarity — nearest-neighbour **grade agreement** (mean \|Δgrade\| to the nearest
non-identical climb; lower is better):

| representation          | neighbour \|Δgrade\| | random |
| ----------------------- | -------------------- | ------ |
| raw geometry vector     | 3.74                 | 3.74   |
| **Deep Sets embedding** | **2.60**             | 3.74   |

**Read:** geometry predicts Kilter grade well enough for a `content_prior` (GBM ≈
0.7 V-grade MAE), and the learned embedding is a real similarity space (30% better
than random on grade agreement) where raw geometry is no better than random. The
Deep Sets **grade head** still trails the GBM by ~0.13 MAE — the GBM's strongest
feature is the _sum_ of train-fit per-hold coefficients, which is nearly the whole
signal since grade is roughly additive. The value of Deep Sets is the shared
embedding (grade **and** similarity **and** style from one vector), which the GBM
can't give. (Duplicate-holdset retrieval is trivially perfect but uninformative on
the dev extract — only 3 duplicate groups; prod has ~16k fingerprint duplicates.)

## Phase-1b (next)

Close the grade gap and strengthen the embedding: an ordinal (CORAL) head, an
explicit contrastive objective (hold_fingerprint duplicates as positives),
hyperparameter tuning, and training on the full prod catalog + all boards (board
embedding). Then export `content_prior` + embeddings for the Phase-2 blend and the
Phase-3 similarity table.

That historical Phase-1b note predates the Stage-3 pre-registration above. The
new path deliberately does not add an ordinal head, contrastive loss, board
embedding, or hyperparameter sweep. If the same-feature GBM or either fixed seed
fails, the honest result is that the incumbent remains the grade model while the
morphology/split/shadow infrastructure stays available for similarity work.
