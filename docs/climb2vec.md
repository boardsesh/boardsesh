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

The learned grade is **never the surfaced grade**. Production currently consumes
`content_prior` only in the no-crowd, no-cross-angle fallback. The Stage-3
candidate is evaluated in shadow as one more capped `DeherdedGradeSignal` before
any protected blend change is considered. It is trained on the frozen Stage-2
**de-herded** point estimate, never on the EB posterior that would consume it,
so there is no feedback loop.

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

## Stage-3 morphology trial (pre-registered, not production)

The incumbent is the aggregate-feature GBM, not the historical Deep Sets grade
head. The trial implemented in `ml/climb2vec/stage3_experiment.py` asks two
questions in order:

1. Does deterministic hold morphology improve that same GBM by at least `0.05`
   Aurora difficulty steps of Kilter validation MAE?
2. Only if it does, can a compact relational residual model improve another
   `0.05` over the same-feature GBM in both fixed seeds?

One Aurora difficulty step is one Font sub-grade, roughly half a V-grade. The
old `1.42` GBM and `1.55` Deep Sets numbers below used an 80/20 Kilter UUID split
and raw crowd `difficulty_average`. Runs 3–7 use a different, stricter
physical-problem 70/15/15 split and a frozen Stage-2 target, so their errors must
not be compared numerically to those historical values.

### Frozen target and leakage boundary

`extract-training-matrix.ts --target=stage2` reconstructs the persisted Stage-2
point estimate without refitting coefficients or changing the protected grade
pipeline. Kilter and Tension are exported together inside one read-only,
repeatable-read transaction; every row records the same PostgreSQL snapshot,
the coefficient version, and `climb2vec-frozen-stage2-v1`. The experiment
rejects mixed snapshots. Duplicate physical problems are pooled before the
target is computed and emitted once per physical problem+angle, so aliases do
not overweight training. Curated Tension benchmarks are admitted without a
crowd target or 20-ascent minimum, and their complete physical problems are
sealed from training and model selection. Conflicting benchmark grades among
duplicate aliases are never resolved by UUID ordering: the extractor rejects
the entire conflicted physical problem and writes
`<training-artifact>.rejections.json`. The July 2026 prod audit retained 2,846
sealed benchmark physical+angles, including all 88 below 20 pooled ascents, and
rejected 2 physical problems (29 rows) whose aliases disagreed at four angles.

The stored `board_hold_features.hand_difficulty` and `foot_difficulty` values
were fit on all labels and are therefore never model inputs. Both GBMs and the
relational model use per-role ridge hold effects refit inside each training
partition. The residual model's training rows receive two-fold out-of-fold GBM
predictions and fold-local hold effects. No user identity, flash/send/attempt
outcome, or rater-bias feature enters the content model; those existing Stage-2
signals affect only the frozen answer key and remain separately capped in the
grade model. Fitting uses the emitted frozen Stage-2 signal weight directly
(divided by its training-set mean only; no square root or winsorization).

The split key is angle-independent:

- Kilter: `(layout_id, hold_fingerprint)`.
- Tension: the lexicographically smaller of the whole original and mirrored
  route signatures, scoped to the product family.
- MoonBoard: the same whole-route rule, scoped to `layout_id`; editions reuse
  cell ids while carrying different physical holds.

STARTING, HAND, FINISH, and FOOT remain distinct. Canonicalizing each hold
independently would collide different asymmetric routes, so it is explicitly
forbidden.

### Hold morphology

`vp run db:extract-hold-morphology --` resolves each calibrated board position
to the nearest alpha component in the committed transparent board art. Features
are normalized by grid spacing rather than pixels:

`area, width, height, log aspect ratio, perimeter, solidity, eccentricity,
sin(2θ), cos(2θ), texture-edge density, mean luminance, luminance SD`.

Every row records its source asset SHA and center-distance confidence. The
sidecar records explicit failures, coverage, and a hash over the extraction
contract plus source assets. Current committed-art coverage is 5,763/6,286
(91.68%): Kilter 3,250/3,773 (86.14%), Tension 1,491/1,491, MoonBoard
1,022/1,022. Kilter's 523 gaps are not imputed; the model receives zeroed
morphology plus an explicit missingness feature.

The intensity and texture values can encode renderer differences. That is why
the first kill test is a same-learner GBM comparison on held-out physical
problems. If those features do not clear `0.05`, the neural runs never start.

### Model and compute budget

The enhanced GBM receives the incumbent aggregate geometry and train-fold hold
effects plus per-role morphology summaries and pairwise distance/horizontal/
vertical reach quantiles. The relational candidate receives the same
information per hold, no board or placement-ID embedding, and two layers of
four-head attention with learned `(dx, dy, distance)` bias. It predicts only a
Huber-loss residual over a detached, cross-fitted GBM. Its normalized
64-dimensional penultimate vector is the similarity embedding.

The fixed encoder supports at most 40 holds. Any physical problem with a
zero-hold or >40-hold row is excluded as a whole before splitting and its count
is written to the result artifact. Holds are never truncated; the database
export also orders them deterministically. The prod ≥20-ascent audit found 122
Kilter rows across 33 physical problems and 4 Tension rows across 2 physical
problems above that limit (maxima 306 and 58 holds respectively).

Five top-level runs fit in the one-week/single-digit budget:

| Run | Fit                                                             | Continue only when                                                            |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 3   | Incumbent-feature GBM                                           | reference                                                                     |
| 4   | Same GBM + morphology/pairwise features                         | Kilter validation MAE improves by ≥0.05                                       |
| 5   | Relational residual, seed 13                                    | improves over Run 4 by ≥0.05                                                  |
| 6   | Relational residual, seed 29                                    | improves over Run 4 by ≥0.05                                                  |
| 7   | Selected seed refit on train+validation, then sealed evaluation | Kilter test improves by ≥0.05 and sealed Tension benchmark regresses by ≤0.01 |

All thresholds are absolute Aurora difficulty steps. Run 7 refits the selected
seed on train+validation; two-fold cross-fitting remains internal so its
residual target is out-of-fold. Only after that refit does it open the test
split once. Its Kilter answer key is restricted to physical problems with at
least 50 pooled ascents. Runs 5 and 6 share their two train-fold GBMs.
`content_sd` is held-out RMSE grouped by the model's predicted grade band, which
is the band available at score time; MoonBoard
uses the more conservative available Kilter/Tension value for that band.
Similarity diagnostics exclude every row with the query's `physicalKey`, not
just the same UUID.

### Shadow before integration

A passing Run 7 artifact is evaluated by
`db:evaluate-content-prior-shadow`. The read-only replay adds content as one
precision-weighted `DeherdedGradeSignal`, clamps it to ±0.5 from the modeled
crowd observation, and caps it at 2 effective opinions. It blocks when:

- fewer than 95% of eligible Kilter/Tension backtest rows have a usable
  prediction, measured both overall and per board. Missing predictions are a
  no-op in shadow, so this limits baseline dilution to 5% while allowing a small
  number of extraction or keying misses;
- either tail or head has fewer than 100 matched rows, or its MAE regresses
  against the existing backtest by more than `0.01`;
- any grade-band or angle segment with at least 50 rows regresses by
  more than `0.05`;
- the no-shock or fingerprint invariant fails.

The last two invariants fail closed when there are no established rows or
checkable physical-alias groups. Absence of evidence does not satisfy a ship
gate.

Traffic is not reported as a cold-tail stratum here: the history backtest truth
population is selected from climbs that currently have at least 50 ascents, so
its current-traffic buckets cannot validate zero-ascent behavior.

The passing score artifact is combined across boards but remains load-safe:
every catalog climb-angle is identified by `boardType`, `modelVersion`, UUID,
and angle. Encoder-supported rows carry model outputs; zero- or over-40-hold
physical problems carry explicit null tombstones. `load-content-model.ts`
validates exact selected-board catalog coverage before an atomic replacement,
and `similarity_export.py` plus `load-similarity.ts` keep neighbours inside
`(boardType, layoutId, angle)`. The legacy `climb2vec-v1` single-board artifact
continues through its explicit upsert-only compatibility mode: it has no
tombstone record shape, so `extract-training-matrix.ts` keeps dropping zero-hold
rows there and only retains them for a Stage-3 extract (`--morphology`,
`--target=stage2`, or the explicit `--keep-unsupported`). Handing a zero-hold row
to the incumbent line would score an all-zero climb and upsert that fabricated
`content_prior` onto a cold-tail cell the grade job reads.

The unchanged `vp run db:refresh-climb-grades -- --validate-only` and
`--dry-run` commands remain required afterward as integration sanity checks.
They are not evidence that content improved the model: under the protected
production behavior, content is still consumed only by the existing no-crowd,
no-cross-angle fallback. `--validate-only` always refits coefficients in memory,
and `--dry-run` may refit when the frozen set is stale, so neither command is
run against prod during this read-only/no-refit implementation. Moving the
passing shadow signal into the Stage-2 blend and authorizing those safety runs
is a separate reviewed change.

### What transfers from published work

MoonBoardRNN (arXiv:2102.01788) supports a learned representation and relational
move structure, but its fixed-angle MoonBoard data, inferred move sequences, and
well-repeated population do not match adjustable boards or the cold tail.

Board-to-Board (arXiv:2311.12419) scraped the 2016/2017/2019 MoonBoard route
coordinates, retained routes with at least five ascents, and used benchmarks as
test sets. Its main feature was an 18×11 occupancy grid. Its vision experiment
also collected individual hold images, locations, and orientations from the
MoonBoard site, rendered one route image per climb, and tried ResNet50/MaxViT
with monochrome, RGB, and RGBA inputs. The best vision result (1.84 MAE in that
paper's Font-grade unit) trailed its occupancy models. What transfers here is
the evidence that hold appearance may help board-to-board generalization; what
does not transfer is an end-to-end route CNN. We extract auditable per-hold
morphology, give it to the incumbent GBM first, and stop if it adds no held-out
signal.

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
