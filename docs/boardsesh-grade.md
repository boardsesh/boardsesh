# Boardsesh grade

The Boardsesh grade is a per-climb, per-angle difficulty estimate computed from
cross-board community data. This doc is written for a data scientist who wants to
understand the model, argue with it, and contribute. It documents the data we
have (and its traps), the exact formulas, the validation gates, the honest
limitations, and the alternatives we rejected and why.

Code map:

- Model math: `packages/db/src/queries/grade-model/` — `constants.ts` (every
  threshold), `coefficients.ts` (the estimators), `blend.ts` (the posterior),
  `gates.ts` (validation), `types.ts`.
- Pipeline: `packages/db/scripts/refresh-climb-grades.ts`.
- Output tables: `packages/db/src/schema/app/climb-grades.ts`.
- Tests: `packages/db/src/queries/grade-model/__tests__/grade-model.test.ts`.
- GraphQL: `boardseshGrade` (single climb+angle) and `boardseshGradesForAngles`
  (every computed angle for a climb, ascending) resolvers in
  `packages/backend/src/graphql/resolvers/climbs/queries.ts`. The shared
  `boardseshDifficultyExpr` / `boardseshConfidenceExpr` / `boardseshGradeTickJoinCondition`
  helpers in `packages/backend/src/graphql/resolvers/shared/sql-expressions.ts`
  embed the fallback grade on Climb and tick/session payloads (see below).

## 1. What it is and why

LED-board grades are noisy for three reasons that a single-board app can't fix:

- **Subjectivity.** A climb's grade is a crowd opinion, and the crowd is small
  and self-selected per climb.
- **Angle traffic is uneven.** The same climb at 40° may have 200 ascents and at
  25° have two. The sparse angle inherits nothing today.
- **Cross-board culture gaps.** Folk wisdom says Moon grades hardest and Kilter
  softest. Our data confirms it: among users who log graded sends on both Kilter
  and Tension, the paired median gap is about 1.2 ± 0.4 grade points, Kilter
  reading soft. That gap is invisible from inside any one board.

Boardsesh holds ascent data across all the boards, so standardizing grades is a
data problem rather than a matter of opinion. The reference point is theCrag's
GRAID, which applies Whole-History Rating to per-user ascent outcomes — we use a
different backbone (see §6) because our per-user data is far sparser than theirs.

The model is deliberately small: `GROUP BY` aggregates, frozen coefficient
rows, capped per-user evidence, and one closed-form empirical-Bayes blend, all
in TypeScript. No MCMC, no IRT, no neural net. It ships behind the
`boardsesh-grade` feature flag.

## 2. Data sources and their verified quirks

This section is the most important one for anyone poking holes. Every number
below was verified against production queries by an adversarial review panel
(a psychometrician, a rating-systems pragmatist, a selection-bias skeptic).

### `board_climb_stats.difficulty_average` — the crowd mean

Upstream computes `difficulty_average` as a plain arithmetic mean over their
per-user ascents table. It is a **live crowd signal on every board except
MoonBoard**: fractional, and it moves as ascents accumulate.

- **MoonBoard is the exception.** Moon's feed carries only integer labels —
  `difficulty_average == display_difficulty == benchmark` byte-for-byte. There
  is no crowd mean to model, so Moon gets no computed grade yet (§5).
- **Zero shrinkage upstream.** A one-ascent "grade" is one person's opinion
  surfaced raw. On Kilter, 34% of climb+angle rows have exactly one ascent and
  70% have four or fewer. The ≥20-ascent head is already stable (p90 lifetime
  drift 0.28 grade points). All the value and all the risk live in the sparse
  tail.

### The quick-ascent auto-fill (the echo problem)

Aurora's quick-ascent button copies the climb's displayed grade straight into
the user's log, and that same log feeds the upstream ascents table that
`difficulty_average` averages over. Boardsesh's quick-tick behaves similarly.
Result: about 85% of synced tick grades equal the displayed grade, and most of
those are UI auto-fills carrying zero information — they only pull the mean
toward the current label. Raw ascent counts overstate the independent-opinion
count by roughly 5–7×.

Tick **provenance** splits the signal, and we exploit it:

| Tick source                     | Exact-echo rate | Dispersion | Treatment                                                           |
| ------------------------------- | --------------- | ---------- | ------------------------------------------------------------------- |
| Native Boardsesh (grade opt-in) | 0.77            | 0.97       | genuine opinion (opt-in ⇒ intentional; an echo is honest agreement) |
| Upstream-synced (quick-ascent)  | 0.85            | 0.81       | echo = probable auto-fill, carries no opinion                       |

Boardsesh made grade/quality optional on native ticks precisely for data
quality. Because a native grade is opt-in, even an exact echo is a real "the
label is right" vote. A synced exact-echo is treated as "no opinion expressed"
— counting it as agreement would underestimate σ_within by 2–3×.

### Anchors and benchmarks

- **Tension benchmarks are the one externally-valid anchor**: 2,867 curated
  problems with independent community validation (drift −0.04 ± 0.18). Tension
  is the offset origin (§3).
- **Kilter's `benchmark_difficulty` column is not curation** — 164k rows, it is
  not a hand-picked reference set and must not be treated as one.
- **Moon benchmarks are circular** in our feed (they equal the label).
- **No Moon standardization is publishable yet**: the feed has no crowd mean,
  and live paired-user coverage is still below the bridge threshold, so Moon
  remains report-only until the data grows.

### Structure and hygiene

- **Angle effect is real and monotone** (−1.9 grade points at 0° to +2.8 at 70°
  within a fixed climb) but **grade-dependent**: the span is 2.1 grades for
  V0–2 versus 3.3 for V6+. One curve won't do; we fit a grade × angle surface.
- **Mirrors have no aggregate dimension.** Mirrored ticks (25% on Tension) can't
  be joined to a per-mirror crowd mean; mirrors inherit the base grade (§5).
- **Duplicate holds.** 16k Kilter climbs share a `hold_fingerprint` (the same
  physical problem listed more than once). Tension's `hold_fingerprint` is 100%
  NULL. Fingerprint groups must agree at the same angle (gate in §4).
- **Concentration.** The top 50 users are 42.5% of all our sends, so coefficient
  estimation aggregates per user first (`σ_within`, the board offset, the LOO
  gate). This is an independence guard against pseudo-replication — a thousand
  ticks from one user are a thousand draws of one personal calibration, not a
  thousand opinions — **not** a claim that active users grade worse, and it
  applies to coefficients only: no user's opinion is down-weighted in any
  climb's grade (the crowd mean is upstream's unweighted average). The tempting
  counter-hypothesis, "power users grade more accurately, so weight them up",
  was tested on prod (2026-07) and rejected: mean |deviation| of expressed
  opinions from the established crowd mean rises monotonically with grading
  activity (0.96 grades for users with 3–9 expressed opinions → 1.33 for 500+),
  heavy graders run systematically harsh (bias −0.16 to −0.27) and disagree
  with _each other_ by ~1 full grade, and the per-user Kilter/Tension gap
  spread does not shrink with volume (sd ≈ 1.6–1.8 in every volume bucket), so
  volume-weighting the offset would only privilege a few individuals'
  calibration. Where concentration is extreme the guard does real work:
  Tension's top user is 33% of expressed opinions and tick-weighting would cut
  `σ_within` from 1.74 to 1.38 — one person's tight personal dispersion faking
  ~26% more confidence in every Tension crowd mean. On Kilter (top user 5.7%)
  the choice barely matters (1.55 vs 1.52). The read-only reproduction script is
  `packages/db/scripts/analyze-grader-concentration.ts`.
- Drafts and unlisted climbs are excluded from the pipeline.

## 3. The model

Closed-form empirical Bayes, one climb+angle at a time. All boards with a crowd
mean (everything except Moon) go through the same posterior.

### Echo fraction λ (deconvolution)

λ(board) is the share of logged grades that are quick-ascent auto-copies. We
recover it from the two tick provenances. Let `a` be the native exact-echo rate
(honest agreement) and `e` the synced exact-echo rate (agreement mixed with
auto-fills). Then

```
e = λ + (1 − λ)·a        →        λ = (e − a) / (1 − a)
```

Boards with too few native ticks borrow the pooled agreement rate; boards with
too few synced ticks fall back to `DEFAULT_ECHO_FRACTION = 0.85`. λ is clamped
to [0.2, 0.95] so a pathological estimate can neither zero out nor fully trust
the crowd. Estimator: `estimateEchoFractions` in `coefficients.ts`.

### Effective sample size and standard error

```
n_eff = ascensionist_count · (1 − λ)        (floored at 1 when any ascent exists)
se²   = σ_within² / n_eff
```

`σ_within(band)` is the SD of **genuinely expressed** grades around the crowd
mean, per board × grade band, measured from native graded ticks plus synced
non-echo ticks (synced echoes are dropped as "no opinion"). Aggregated per user
first so one power user can't set the variance — an independence guard, not an
accuracy judgement (see Concentration, §2). Estimator: `estimateSigmaWithin`.

The de-attenuation reading: a small observed drift on a high-traffic climb, once
you divide out the (1 − λ) of ascents that were auto-copies, implies a much
larger true disagreement. The widened `se` keeps the extra uncertainty honest.

### Cross-angle prior μ0

The prior mean for one climb+angle comes from **that same climb's other
angles**, each mapped to an angle-neutral reference via the angle surface,
combined weighted by `n_eff`, then mapped forward to the target angle
(`crossAnglePrior` in `blend.ts`). If no sibling angle carries crowd evidence,
there is no prior.

The display grade is **never** treated as independent evidence. On most boards
the display _is_ the crowd mean (on Kilter, a damped blend of it), and logged
grades anchor to it. Blending toward display would re-count the same signal and
fake a tighter CI. This is why the middle regime below leaves the mean alone.

### The three-regime posterior

`computePosteriorGrade` picks a regime by what independent evidence exists:

1. **Crowd mean + cross-angle prior** → proper EB blend, where the prior's
   variance includes the siblings' own sampling error — when a climb is new its
   other angles are thin too, and must not masquerade as head-quality evidence:
   ```
   V0      = τ² + σ²/n_eff(siblings)          — the prior's real variance
   shrunk  = (V0·mean + se²·μ0) / (V0 + se²)
   post_sd = sqrt(V0·se² / (V0 + se²))
   ```
   (Ignoring the sibling sampling term was the first prod validation's failure:
   thin siblings dragged grades with unearned confidence, and the backtest
   showed zero improvement over raw. With V0 correct it beats raw.)
   For established rows (n ≥ 50) the posterior is additionally clamped within
   ±1 grade of the crowd mean — a prior never overrules a crowd that has
   already spoken.
2. **Crowd mean only** → the mean stands as-is with an honest `se = σ/√n_eff`.
   No shrinking toward display (same signal).
3. **No crowd mean** → the cross-angle prior if one exists (SD √V0), else the
   display grade passed through **with no CI**, always tiered `setter_only`.

### Projected grades for unclimbed angles (v2.1)

Regime 3 above already covers a climb+angle with thin evidence via the
cross-angle prior. v2.1 persists that same projection for angles with **zero**
ascents too — a climb that has never been climbed at 45° still gets a
`board_climb_grades` row there, as long as the climb has real crowd evidence at
2+ other angles. Previously the pipeline only ever computed a row for a
(climb, angle) pair with an existing `board_climb_stats` row; unclimbed angles
returned nothing, even though the model could project them the same way it
already projects a thin one.

`computeBoard` widens each eligible climb's angle set to the board's full fixed
angle list, adding a zero-evidence synthetic observation for every angle
without real stats, and lets it fall through the existing regime-3 path
unchanged. The synthetic observation's `displayDifficulty` (needed to pick the
right grade band for σ_within/τ²/angle-offset) is resolved with a cheap
two-pass probe: run the cross-angle projection once to get a nominal grade,
feed that back as the band-selection input, then compute the real posterior —
without it, a zero-evidence row silently defaults to the `v3-5` band regardless
of the climb's actual difficulty.

These rows are tiered `cross_angle_estimate` (see the table below), are real
SQL columns like any other grade — sortable, filterable, synced to mobile
offline storage — and are gated by their own zero-evidence backtest (§4)
before publish. Projection additionally requires fitted angle-surface coverage
for the target cell and at least two contributing sibling cells; a missing cell
is never treated as a learned zero offset. Every board this model already covers is eligible
(`CROWD_MEAN_BOARDS`: Kilter, Tension, Grasshopper, Decoy, So iLL, Touchstone);
the backtest runs independently per board so a high-volume catalog cannot hide
a weak or missing surface on a smaller one. MoonBoard has no crowd feed into
this model at all and stays untouched.

Publication has a rollout guard: the scheduled job must explicitly pass
`--publish-cross-angle-estimates`. Ship the readers first, then enable that flag
only after the compatible mobile build is the minimum supported version; older
clients do not understand the new confidence tier safely.

### Per-climb isotonic angle constraint (v1.1)

Each angle's crowd herds independently, so raw per-angle grades can invert —
The Enchiridion (Kilter Homewall) was crowd-graded a full point _harder_ at 30°
(n=55) than at 35° (n=33), display grades included. The blend can't fix that:
with real evidence at both angles, own-angle data rightly dominates the
cross-angle prior. But the same holds at a steeper wall cannot be easier, so
after blending, each climb's grades are projected onto "non-decreasing with
angle" via weighted isotonic regression (pool-adjacent-violators, weights =
posterior precision 1/post_sd²) — violating neighbours merge to their
precision-weighted mean, monotone climbs are untouched. Established rows keep
the no-shock promise (never moved more than 1 grade from their own crowd mean;
a binding cap can leave a residual inversion, which the run counts and logs).
Display-only pass-through rows carry no evidence and don't participate.
Implementation: `isotonic.ts`.

### Kilter display-delta hygiene (v1.2)

Kilter has a small data-quality tail where the upstream displayed grade appears
mixed-scale or corrupted: the crowd mean is normal, but the label sits near the
scale floor or several grades away from the standardized result. The model does
not repair those source rows and does not clamp the computed grade back toward
the suspect label. Instead, after blending and isotonic projection, any Kilter
row that would be `confirmed` is downgraded to `provisional` when:

```
round(universal_grade) - round(display_difficulty) < -3
round(universal_grade) - round(display_difficulty) >  1
```

The local/universal grade and confidence band stay unchanged; only the tier is
lowered so the UI stops presenting an outlier as settled. The nightly run logs
and persists how many rows were downgraded. Implementation:
`applyDisplayDeltaHygiene` in `hygiene.ts`.

### Capped rater and behavior evidence (v2.0)

Stage 2 adds two per-user signals before the EB blend, but keeps them bounded
so they cannot overpower the upstream crowd aggregate they often feed.

**Rater model.** For every user × gym/board location, we estimate a shrunk bias
against the current crowd mean. Native Boardsesh grade ticks count as explicit
opinions, including exact display matches. Synced exact-display echoes count as
zero opinion because they are likely quick-log auto-fills; synced non-echo
grades count at `0.25`. Biases need at least 3 effective opinions, shrink toward
zero with a 12-opinion prior, and clamp to ±1 grade. The climb-level rater
signal is capped to ±0.5 grade from the raw crowd mean and at 5 effective
opinions.

**Behavior model.** Native flash/send/attempt outcomes are converted into a
weak grade signal after fitting shrunk user ability from successful ticks.
Behavior only publishes for boards whose **used** native rows are broad enough
after the high-traffic and ability filters (≥100 users, ≥500 outcomes, top user
≤3% of outcomes). Outcome buckets need support and cannot be dominated by one
user before they are used. The climb-level behavior signal is capped to ±0.35
grade from the raw crowd mean and at 2 effective opinions.

**De-echoed crowd mean.** The crowd mean point estimate is gently moved away
from display by dividing the observed display delta by `(1 − λ)`, but only when
there is enough independent evidence and only up to ±0.75 grade from the
observed mean. If the de-echo step is not eligible, the raw crowd mean stands.

Rater and behavior coefficients are fit on training rows. Prediction evidence
is then built separately, with Tension benchmark holdout rows allowed in
prediction but excluded from fitting. For normal published rows, per-user rater
bias and behavior ability are applied leave-target-out so the target climb does
not help calibrate the user signal used to grade that same target.

All three signals are blended into the observation's `difficultyAverage` before
the existing cross-angle prior, isotonic projection, no-shock gate, and
hysteresis. The visible ascent count and confidence-tier thresholds still use
the upstream raw ascent count, so Stage 2 cannot make a thin climb look like a
head climb.

### Duplicate climbs share one identity

Climbs with the same `(layout_id, hold_fingerprint)` are the same physical
problem listed under different UUIDs. The pipeline treats a duplicate group as
ONE climb: per angle an n-weighted pooled mean/count (and averaged display),
pooled Stage 2 evidence, and every member uses the group's full angle set as
its cross-angle evidence — so members get identical posteriors by construction.
Before pooling, 44% of Kilter duplicate groups disagreed by more than a grade.

### Grade × angle surface

Per board, offsets are fit on 5° angle bins × grade bands, using only climbs
with ≥2 angles at ≥10 ascents each — so the surface measures re-grading of a
fixed climb, not which climbs happen to exist at each angle. Cells need ≥30
climbs to be trusted; lookups fall back band → `all` → 0, never extrapolating to
an unobserved angle. Estimator: `estimateAngleSurface`.

### τ² (between-climb prior variance)

τ² is the **leave-one-angle-out residual variance** of the cross-angle prior:
on ≥20-ascent multi-angle head climbs, predict each angle's mean from its
siblings via the frozen surface, and take the variance of the residuals per
board × band. That makes τ² the honest uncertainty of the prior itself, not a
guessed hyperparameter. Clamped to [0.05, 4.0]. Estimator: `estimateTauSquared`.

### Cross-board offset (Tension anchor)

```
universal_grade = local_grade + board_offset,   board_offset(Tension) = 0
```

The Kilter offset is the median over shared Kilter/Tension users of their
(Tension median − Kilter median) sent grade — a robust paired estimator, min 10
graded sends per side. Expected ≈ −1.2 ± 0.4 (Kilter reads soft). It ships only
if leave-one-user-out instability stays under ±0.5 (`OFFSET_LOO_MAX_DELTA`),
guarding against a single power user setting the whole board's offset. Small
boards (Decoy, Grasshopper, So iLL, Touchstone) have nothing to anchor against,
so they publish a within-board `local_grade` only and `universal_grade` is NULL.
Estimator: `estimateBoardOffsets`.

### Confidence tiers

| Tier                   | Condition                                                                           | UI                                              |
| ---------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| `confirmed`            | n ≥ 20 and `post_sd` ≤ 0.35, unless Kilter display-delta hygiene downgrades the row | grade, "confirmed by N sends"                   |
| `provisional`          | 3 ≤ n < 20, or a confirmed Kilter row tripped the v1.2 display-delta hygiene rule   | grade with a visible ± band                     |
| `setter_only`          | n < 3                                                                               | no Boardsesh number, setter's call              |
| `cross_angle_estimate` | 0 ascents at this angle, projected from 2+ sibling angles                           | `≈` grade, muted, "projected from other angles" |

### Publish hysteresis

The surfaced grade only changes when a recompute moves it ≥ 0.5 grade points or
the tier flips (`shouldPublish`). The head is already stable, so this kills
night-to-night jitter without hiding real movement. Every row stamps
`model_version` and `coeff_version` for reproducibility.

## 4. Validation gates

Coefficients are refit weekly and frozen between refits. Every nightly run
evaluates the gates first and **writes zero grade rows if any blocking gate
fails**. Results persist to `board_grade_coefficients` (kind `gate_results`).

| Gate                             | Threshold                                                                                                                                               | Blocks?             | What a failure means                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tail_backtest`                  | multi-angle shrunk MAE must not exceed raw MAE (+0.01 tolerance), n ≥ 100; improvement % reported against an aspirational 20% bar                       | yes                 | the blend makes sparse grades worse than doing nothing                                                                                                 |
| `head_holdout`                   | single-angle shrunk MAE must not exceed raw MAE (+0.01), n ≥ 100                                                                                        | yes                 | the model regressed the rows where it is supposed to be a no-op                                                                                        |
| `behavior_eligibility`           | reports how many board behavior models pass the Stage 2 coverage guard                                                                                  | no (report only)    | behavior data is too concentrated or sparse on some boards, so their outcome signal is ignored                                                         |
| `moon_bridge_readiness`          | reports Moon paired-user coverage and candidate offset stability                                                                                        | no (report only)    | Moon still lacks a publishable bridge; this deliberately does not block Kilter/Tension grades                                                          |
| `zero_evidence_projection`       | per board: hides a well-sampled angle (≥20 ascents), projects it as if unclimbed, and must beat the naive effective-n-weighted sibling mean by ≥0.01 MAE, n ≥ 100 | withholds that board's projections | walking a grade through this board's fitted angle surface is no better than assuming a climb grades the same at every angle                            |
| `deherded_tension_benchmark`     | held-out Tension benchmark Stage 2 MAE must not exceed Stage 1 MAE by >0.01, n ≥ 100; display MAE is reported only                                      | yes                 | rater/behavior/de-echo evidence made the benchmark set worse than the existing model                                                                   |
| `deherded_tension_calibration`   | held-out Tension benchmark 95% interval coverage must land in [85%, 98%], n ≥ 100                                                                       | yes                 | Stage 2 uncertainty is materially under- or over-confident                                                                                             |
| `deherded_segment_no_regression` | no grade-band, angle, or traffic segment with ≥50 rows may regress by >0.05 MAE vs Stage 1                                                              | yes                 | the aggregate benchmark score hid a segment-level regression                                                                                           |
| `no_shock`                       | no ≥50-ascent climb's local grade moves >1.0 from its raw mean                                                                                          | yes                 | the prior is overpowering established grades (also enforced by a clamp inside the blend itself; the gate catches regressions)                          |
| `fingerprint_consistency`        | ≤1% of duplicate-fingerprint groups disagree by >1 grade at the same angle                                                                              | yes                 | evidence for one physical problem is being split badly                                                                                                 |
| `residual_paired_gap`            | shared-user mean gap vs fitted offset ≤ 0.3 after the Kilter offset                                                                                     | withholds universal | the "constant offset" story is wrong; local grades still publish, universal grades don't                                                               |
| `display_delta_hygiene`          | reports Kilter rows downgraded from `confirmed` to `provisional` for rounded universal-display delta outside [-3, +1]                                   | no (repaired)       | source labels likely contain mixed-scale/corrupt display values; the grade publishes, but not as confirmed                                             |
| honesty report                   | reports `corr(grade, display)` and mean \|Δ\| per board                                                                                                 | no (report only)    | a board whose numbers never leave the label is dressing the label as a data product; UI copy must say so                                               |

The backtest replays `board_climb_stats_history` (5.4M snapshots): for series
that later reached ≥50 ascents (their final mean ≈ truth), it takes the
earliest 1–3-ascent snapshot plus each sibling angle's state at that instant,
and asks whether the blended grade beats the raw sparse average against the
final truth. Scoring: `evaluateBacktest` in `gates.ts`.

Why the pass bar is no-regression rather than "beat raw by 20%": the backtest's
"truth" is the eventual community mean, and quick-log echoes herd that mean
toward whatever the early label was — so the raw early average partly _creates_
the target it is scored against. Under that metric a corrective model cannot
win big; what it must never do is lose. On the 2026-07-07 prod run the blend
beat raw by 2.5% on the multi-angle subset (MAE 0.592 vs 0.607) and exactly
matched it on single-angle rows. The 20% figure remains in the gate output as
an aspirational bar so refits that help or hurt stay visible run over run; a
de-herded evaluation (predicting held-out Tension benchmarks) is the Stage 2
way to raise it honestly.

The Stage 2 benchmark split withholds 20% of Tension benchmarks from rater and
behavior fitting using a stable climb+angle hash. The withheld rows are still
allowed to produce prediction evidence; only coefficient fitting is withheld.
The withheld rows are scored against a true Stage 1 compute path with all Stage
2 transforms disabled, and against the Stage 2 model. Display grade remains a
report-only yardstick because benchmarks are curated labels, and requiring the
model to beat the display label itself would reject any useful non-label signal.

## 5. Known limitations

These are real and we'd rather state them than paper over them.

- **Moon is not standardized.** No crowd mean (label-only feed), circular
  benchmarks, and paired-user coverage below the bridge threshold. Moon shows
  its native grade plus "not standardized yet." The unlock is Moon logbook
  growth — more logged Moon sends create shared users for the bridge report.
- **Small boards aren't universalized.** Decoy, Grasshopper, So iLL, and
  Touchstone have no anchor, so they get a within-board grade with no
  cross-board claim.
- **Mirrors inherit the base grade.** The aggregates carry no mirror dimension,
  so a mirrored climb reads at its base orientation's grade. Documented, not
  fixed.
- **Anchoring / herding is only partially corrected.** Stage 2 de-echoes the
  crowd point estimate and adds rater/behavior evidence, but every step is
  capped. That is intentional: the data is still sparse and self-selected, so a
  bounded correction is preferable to manufacturing movement from thin ticks.
- **Single-angle sparse climbs gain little.** With one angle and few ascents the
  posterior is essentially the raw mean. The model's tail value is cross-angle
  pooling; a lone sparse angle has nothing to pool with.

## 6. Rejected alternatives

| Alternative               | Why not                                                                                                                                                                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full Bayesian / MCMC      | Upstream gives us aggregate means, not per-ascent variances. Without the underlying distributions there's nothing for a sampler to condition on that the closed-form EB blend doesn't already capture — the cost buys no extra signal.                                                  |
| WHR / IRT as the backbone | Per-user outcomes cover only ~14% of the Kilter catalog. theCrag's GRAID works because it has dense per-user ascent data; ours is too sparse to carry a rating system as the primary estimator. Ticks are a coefficient factory (variance, cross-board offset), not a grading backbone. |
| CNN content model         | Deferred, not rejected. A gradient-boosted model on hold features is the cheaper, more credible Stage 3 version (`content_prior` column is already reserved, NULL in v2).                                                                                                               |

## 7. Contributing

### The roadmap

- **Stage 2 — rater and behavior evidence.** Implemented in v2.0 with capped
  per-user rater bias, weak native behavior outcomes, de-echoed crowd means,
  held-out Tension benchmark gates, and report-only Moon bridge readiness.
- **Stage 3 — hold-geometry content model ("Climb2Vec").** A learned per-climb
  representation over hold geometry gives the cold tail a prior before any
  ascents exist (into the reserved `content_prior` column), and the same
  embedding powers climb similarity and style recommendations. It enters the
  blend as one more `DeherdedGradeSignal` (§3), under the no-shock clamp, and is
  the only path to grading MoonBoard (no crowd mean, no bridge users). Full
  design + phased rollout: `docs/climb2vec.md`. **Groundwork shipped:** the
  generated per-hold feature substrate (`board_hold_features` — geometry +
  de-confounded behavioral difficulty per placement, refreshed nightly by
  `scripts/refresh-hold-features.ts`), which also refills the dormant
  `user_hold_classifications` layer with algorithmic data. **Experimental
  implementation:** deterministic morphology from committed board art, a frozen
  Stage-2 training target, physical-problem leakage guards, the incumbent GBM
  comparison, and a two-seed relational residual model now live behind the
  pre-registered Runs 3–7 in `ml/climb2vec/stage3_experiment.py`. A passing
  artifact must clear the separate read-only content shadow before any proposal
  to change the protected blend. The existing `--validate-only`/`--dry-run`
  battery remains an integration safety check; it cannot measure marginal
  content value while production consumes content only in the cold-tail
  fallback.

### Running it

Unit tests:

```
vp run test:db
```

Read-only validation against the dev DB or a read-only prod `DB_URL`:

```
vp run db:refresh-climb-grades -- --validate-only
vp run db:refresh-climb-grades -- --validate-only --allow-empty-backtest
```

Publish-path validation is also read-only, but requires the grade tables because
it exercises hysteresis against existing rows:

```
vp run db:refresh-climb-grades -- --dry-run
```

Writable publish paths require a writable `DB_URL`:

```
vp run db:refresh-climb-grades --
vp run db:refresh-climb-grades -- --refit-coefficients
vp run db:refresh-climb-grades -- --publish-cross-angle-estimates
```

- `--validate-only` refits coefficients in memory, runs every gate against live
  data, prints per-board tier counts, writes nothing, and exits nonzero if a
  blocking gate fails. It works even before the grade tables exist (e.g. prod
  pre-migration).
- `--dry-run` evaluates gates through the normal publish path but writes no
  coefficients, gate results, or grade rows.
- `--refit-coefficients` forces a weekly refit instead of reusing the frozen set.
- `--publish-cross-angle-estimates` enables the new tier only for boards whose
  per-board gate passes. Keep it off until compatible mobile clients are required.
- A bare run reuses frozen coefficients if they're under a week old, else refits.
- `--allow-empty-backtest` is only for dev-style databases without stats history;
  production validation should not use it.

### Where things are stored

- `board_climb_grades` — one row per climb+angle: `local_grade`,
  `universal_grade` (NULL when unanchorable), `grade_low`/`grade_high`,
  `confidence`, `ascensionist_count` snapshot, `content_prior` (NULL in v2),
  `model_version`, `coeff_version`.
- `board_grade_coefficients` — versioned coefficient rows keyed by
  `(coeff_version, kind, key)`. Kinds: `echo_fraction`, `sigma_within`,
  `tau_squared`, `angle_offset`, `board_offset`, `rater_model`,
  `behavior_model`, `bridge_readiness`, and `gate_results` (per-run pass/fail +
  metrics). Plain table, `pg_dump`-portable.
- Climb and tick/session GraphQL payloads (`climb`, `searchClimbs`, `ticks`,
  `sessionGroupedFeed`, `sessionDetail`, and friends) each embed
  `boardseshDifficulty` (`COALESCE(universal_grade, local_grade)`) and
  `boardseshConfidence` alongside the legacy grade fields, for row-level
  display without a per-climb refetch. Both are nullable — null whenever no
  `board_climb_grades` row exists (MoonBoard, or too few ascents) — and
  clients fall back to the legacy consensus/Aurora grade in that case (and
  when `boardseshConfidence` is `setter_only`).
- **On-device (mobile offline).** When a board is downloaded for offline
  browsing on native, `board_climb_grades` is synced
  to on-device SQLite alongside `board_climbs`/`board_climb_stats`. The pull is
  the per-board `syncClimbGrades` resolver + the `board_climb_grades`
  `table-config`/DDL (v4 migration) entries — see `docs/sync-table-manifest.md`
  for the resolver ↔ DDL ↔ table-config contract. Only the surfaced columns are
  synced (`local_grade`, `universal_grade`, `grade_low`/`grade_high`,
  `confidence`, `ascensionist_count`, `computed_at`) — **not** `model_version`,
  `coeff_version`, or `content_prior`. Offline climb search + detail LEFT JOIN
  the table and expose the same `boardseshDifficulty`/`boardseshConfidence`
  fields the server does, and the play-drawer grade section + by-angle chart
  read the `boardseshGrade`/`boardseshGradesForAngles` ops local-first from it,
  so the grade works with no network.
