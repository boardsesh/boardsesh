# Climb2Vec — the hold-geometry content model

Climb2Vec is the Stage-3 evolution of the Boardsesh grade (`docs/boardsesh-grade.md`)
and the engine behind climb similarity and personal-style recommendations. Where
Stages 1–2 model **crowd opinion** (empirical-Bayes over community grades, plus a
rater/behavior de-herding layer), Climb2Vec models the **climb itself**.

## Why geometry

The Stage 1–2 model was built to mirror theCrag's GRAID — a rating system for
**outdoor rock**, where every hold is unique and unknowable, so all you have is
who-sent-what. LED boards are the opposite: every hold's position is fixed and
known, the holdset is identical across every board of a layout/size, and a climb
is a precise set of holds at a known angle. That structure is exactly what the
crowd-only model throws away, and it is strongest where the crowd is weakest:

- **Cold start** — 34% of Kilter climb-angles have a single ascent; a geometry
  prior grades them before the crowd arrives.
- **MoonBoard** — no crowd mean in our feed and no bridge users, so it gets zero
  computed grades today. Geometry is the only way to grade it.
- **Similarity & style** — "climbs like this" and "in your style" need a content
  representation, which co-occurrence data can't provide for the long tail.

The approach adapts MoonBoardRNN (arXiv:2102.01788, Apache-2.0): a learned
per-climb representation whose penultimate **embedding** feeds a grade head, a
similarity index, and per-user style centroids — extended to Boardsesh's
multi-board, foot-aware, angle-adjustable setting.

## How it coexists with the crowd model

The learned grade is **never the surfaced grade**. Its ordinal head emits the
reserved scalar `board_climb_grades.content_prior`, which enters the existing
grade pipeline as one more `DeherdedGradeSignal` (see `deherded.ts`
`combineDeherdedSignals`), most valuable in the no-crowd cold tail and always
bounded by the no-shock clamp so geometry can never overrule an established
crowd. It is trained on the Stage-2 **de-herded** crowd mean (frozen), never on
the EB posterior that consumes it — no feedback loop.

## Data spine (verified in prod)

- Per-hold geometry is complete on every board (`board_holes.x,y`), but there is
  **no physical hold size/type/radius anywhere** — behavioral difficulty +
  geometry + set membership are the substitutes; true jug/crimp/sloper is a
  documented ceiling.
- The join spine is load-bearing: `board_climb_holds.hold_id` is the frames
  **placement** id, not `board_holes.id`. Coordinates come via
  `board_climb_holds.hold_id → board_placements(board_type,id) → board_holes`.
- Kilter carries the labels (36.7k climb-angles at ≥20 ascents) and the only
  viable "also sent" co-occurrence head (~17% of climb-angles) — hence Kilter-first.

## Serving

Offline PyTorch trains + batch-scores (weekly, mirroring the coefficient refit)
and only ever `COPY`s two artifacts into Postgres: `content_prior` and embedding
`float[]`. Python never touches the request path or the nightly blend. Everything
downstream is pure TypeScript on the existing GitHub Actions crons. Embeddings are
`float[]` with a materialized top-K neighbor table — `pg_dump`-portable, no
pgvector needed at ~10⁵ climbs/board (it stays a drop-in later swap, same
`CREATE EXTENSION` class as the already-required PostGIS).

## Phased rollout (Kilter-first; each phase stacks on the last)

| #      | Phase                                           | Ships                                                                                                                                                                                                                                         |
| ------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0**  | **Hold-feature substrate** ✅ (#3584)           | `board_hold_features` + nightly `refresh-hold-features.ts`; shadow-fills `user_hold_classifications`.                                                                                                                                         |
| **1a** | **Training matrix + offline eval** ✅ (this PR) | `extract-training-matrix.ts` + `ml/climb2vec/` (Deep Sets encoder, GBM/ridge baselines, leakage-free eval). Feasibility numbers below.                                                                                                        |
| 1b     | Content-model export ✅ (this PR)               | `board_climb_embeddings` + score extract + `train_export.py` + `load-content-model.ts` + weekly `refresh-content-model.yml`. Tuning (ordinal/contrastive) iterates here.                                                                      |
| **2**  | **`content_prior` into the blend** ✅ (this PR) | Cold-tail grades use the geometry estimate: `content_prior` enters `computePosteriorGrade` Regime 3 (no crowd, no cross-angle prior) as `provisional`, persisted to `board_climb_grades.content_prior`. Gate-safe (never touches crowd rows). |
| **3a** | **Similarity data layer** ✅ (this PR)          | `board_climb_similar` + numpy top-K (`similarity_export.py`) + `load-similarity.ts`, folded into the content-model workflow. Blending into the `similarClimbs` resolver/UI (Jaccard fallback) is a focused follow-up.                         |
| 4      | "Also sent" item-item CF                        | Co-send neighbors from `boardsesh_ticks` + a climb-detail rail.                                                                                                                                                                               |
| 5      | Style / anti-style recs                         | Per-user style centroids → "recommended in your style" / "train your anti-style".                                                                                                                                                             |
| 6      | Generalize to Tension + MoonBoard               | First-ever MoonBoard grades (`content_only`); multi-board similarity.                                                                                                                                                                         |

## Phase 1a — offline feasibility (Kilter, 29,748 held-out-by-climb observations)

Grade accuracy on held-out climbs, leakage-free (hold effects fit on train only;
label = crowd `difficulty_average`, in Aurora units ≈ 2 per V-grade → MAE 1.4 ≈
~0.7 V-grade). Full method + how to reproduce: `ml/climb2vec/README.md`.

| model                    | exact | within ±1 | MAE      |
| ------------------------ | ----- | --------- | -------- |
| ridge (linear content)   | 17.4% | 48.2%     | 1.93     |
| GBM (aggregate features) | 23.8% | 59.8%     | **1.42** |
| Deep Sets (Climb2Vec)    | 19.9% | 56.8%     | 1.55     |

Similarity — nearest-neighbour grade agreement (mean |Δgrade|, lower better): the
Deep Sets embedding scores **2.60** vs **3.74** random, while a raw geometry vector
is no better than random (3.74). So geometry predicts grade well enough for a
`content_prior`, and the learned embedding is a real similarity space (the value
the GBM can't provide). The Deep Sets grade head still trails the GBM by ~0.13 MAE
— Phase 1b (ordinal head, contrastive objective, tuning, full catalog) closes it.

## Phase 0 — the hold-feature substrate (#3584)

`board_hold_features` (`packages/db/src/schema/app/hold-features.ts`) holds one
row per placement, regenerated nightly by
`packages/db/scripts/refresh-hold-features.ts`:

- **Geometry** (`packages/db/src/queries/hold-features/geometry.ts`) — normalized
  position, edge & nearest-neighbour distance, and a geometry-derived pull
  direction, all angle-independent and normalized to each board's hole bbox.
- **Behavioral difficulty**
  (`packages/db/src/queries/hold-features/behavioral.ts`) — a **de-confounded**
  per-hold contribution, ridge-regressed over the hold-incidence matrix of graded
  climbs (`ascensionist_count ≥ 20`), split by role (hand vs foot). A raw per-hold
  mean would let a hold inherit the difficulty of the hard holds it co-occurs
  with; the ridge attributes it correctly (unit-tested).
- **Coarse type** (`set-type.ts`) — footholds from set membership; everything else
  NULL (no shape data).

The job shadow-writes `user_hold_classifications` (hand/foot rating quintiles +
pull direction) under a reserved `system-hold-classifier` user, reviving the
dormant per-hold layer with generated data instead of user input.

MoonBoard uses layout-independent grid-cell IDs (`p1` through `p198`) in frames,
while `board_hold_features` is keyed by physical placement. Its reference data
therefore assigns each covered layout/cell pair a stable synthetic placement ID
(`layout_id * 1000 + cell_id`) and keeps `hole_id` as the shared cell ID. Hold
feature and training queries resolve MoonBoard cells through `(layout_id,
hole_id)`; Aurora-family boards continue to resolve `hold_id` directly to a
placement ID. A MoonBoard climb with any cell absent from the authoritative map
is excluded as a whole instead of being reduced to a partial frame. MoonBoard
shadow classifications remain disabled until its product-size relations exist.

Run it: `node --import tsx packages/db/scripts/refresh-hold-features.ts --dry-run`
(`--board=<name>`, `--no-shadow`). Tests:
`node --import tsx --test packages/db/src/queries/hold-features/__tests__/hold-features.test.ts`.
