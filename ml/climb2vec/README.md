# Climb2Vec — offline training & evaluation

Offline PyTorch/sklearn pipeline for the hold-geometry grade model (see
`../../docs/climb2vec.md`). **Offline only** — nothing here ships to prod; serving
is pure TypeScript. The pipeline reads the training matrix exported by
`packages/db/scripts/extract-training-matrix.ts` and produces grade-accuracy and
similarity numbers, plus (eventually) the `content_prior` + embedding artifacts
that a nightly job `COPY`s into Postgres.

## Layout

- `dataset.py` — load the JSONL extract, split by climb (no angle leakage), build
  label-free geometry features + hold-identity, duplicate-holdset keys.
- `model.py` — the Deep Sets encoder: per-hold node MLP → masked mean/max/**sum**
  pool → angle → penultimate **embedding** → linear grade head.
- `evaluate.py` — the leakage-free eval: ridge + GBM + Deep Sets grade accuracy on
  held-out climbs, and similarity (duplicate retrieval + nearest-neighbour grade
  agreement). Writes `artifacts/results.json`.

## Leakage discipline

The per-hold `hd`/`fd` fields in the extract were fit on **all** grades, so using
them as model inputs would leak the label. Instead every hold effect is learned on
the **train split only** — a train-fit ridge coefficient (fed as a node feature)
and a learned per-placement embedding — then applied to held-out climbs. Only
label-free geometry + hold identity reach the models.

## Run

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
pip install torch --index-url https://download.pytorch.org/whl/cpu   # for Deep Sets

# 1. Export the training matrix (needs board_hold_features populated):
node --import tsx ../../packages/db/scripts/extract-training-matrix.ts \
  --board=kilter --out=ml/climb2vec/data/kilter-train.jsonl   # run from repo root

# 2. Evaluate:
python evaluate.py --data data/kilter-train.jsonl --epochs 30
```

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

## v2 tuning (2026-07, prod 36,652 obs, held-out by climb)

Two levers were tried against the diagnosis "grade is roughly additive in per-hold
difficulty, and the GBM wins via the summed per-hold coefficient":

- **Wide & deep (kept, shipped as `wide_deep=True`).** Add the sum of the train-fit
  per-hold ridge coefficient (already a node feature), scaled by ONE learned weight,
  to the Deep Sets head. Deep Sets MAE **1.49 → 1.43**, within-±1 **58.5% → 60.6%**
  (now ≈ the GBM's 1.38 / 61.3%), and the embedding grade-agreement improved to
  **2.67** (vs 3.72 raw geometry, 3.82 random). Note: a *naive* full per-placement
  additive (~3k free params) OVERFIT to 1.81 — the single-weight version is the fix.
- **De-herded training label (tried, reverted).** Training on
  `board_climb_grades.local_grade` instead of the raw crowd mean did NOT help
  (1.49 → 1.52). That column is the *full* Stage-2 blend (cross-angle prior +
  isotonic + no-shock clamp) — crowd-specific adjustments geometry can't learn — so
  it's a noisier target, not a cleaner one. We train on the crowd mean.

## Phase-1b (next)

Close the remaining gap and strengthen the embedding: an ordinal (CORAL) head, an
explicit contrastive objective (hold_fingerprint duplicates as positives),
hyperparameter tuning (LR schedule, early stopping, capacity), and training on all
boards (board embedding). A *proper* de-herded label — the raw `deherdCrowdMean`
output, NOT `local_grade` — is still worth one test. Then re-export `content_prior`
+ embeddings for the Phase-2 blend and the Phase-3 similarity table.
