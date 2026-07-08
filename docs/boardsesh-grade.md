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

The v1 model is deliberately small: `GROUP BY` aggregates, two coefficient
tables, and one closed-form empirical-Bayes blend, all in TypeScript. No MCMC,
no IRT, no neural net. It ships behind the `boardsesh-grade` feature flag.

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
  is no crowd mean to model, so Moon gets no computed grade in v1 (§5).
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
- **No Moon standardization is possible in v1**: zero users have ≥3 graded sends
  on both Moon and another board, so there is no bridge to anchor Moon against.

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
  the choice barely matters (1.55 vs 1.52).
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

### Duplicate climbs share one identity

Climbs with the same `hold_fingerprint` are the same physical problem listed
under different UUIDs. The pipeline treats a duplicate group as ONE climb: per
angle an n-weighted pooled mean/count (and averaged display), and every member
uses the group's full angle set as its cross-angle evidence — so members get
identical posteriors by construction. Before pooling, 44% of Kilter duplicate
groups disagreed by more than a grade.

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

| Tier          | Condition                   | UI                                 |
| ------------- | --------------------------- | ---------------------------------- |
| `confirmed`   | n ≥ 20 and `post_sd` ≤ 0.35 | grade, "confirmed by N sends"      |
| `provisional` | 3 ≤ n < 20                  | grade with a visible ± band        |
| `setter_only` | n < 3                       | no Boardsesh number, setter's call |

### Publish hysteresis

The surfaced grade only changes when a recompute moves it ≥ 0.5 grade points or
the tier flips (`shouldPublish`). The head is already stable, so this kills
night-to-night jitter without hiding real movement. Every row stamps
`model_version` and `coeff_version` for reproducibility.

## 4. Validation gates

Coefficients are refit weekly and frozen between refits. Every nightly run
evaluates the gates first and **writes zero grade rows if any blocking gate
fails**. Results persist to `board_grade_coefficients` (kind `gate_results`).

| Gate                      | Threshold                                                                                                                         | Blocks?             | What a failure means                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `tail_backtest`           | multi-angle shrunk MAE must not exceed raw MAE (+0.01 tolerance), n ≥ 100; improvement % reported against an aspirational 20% bar | yes                 | the blend makes sparse grades worse than doing nothing                                                                        |
| `head_holdout`            | single-angle shrunk MAE must not exceed raw MAE (+0.01), n ≥ 100                                                                  | yes                 | the model regressed the rows where it is supposed to be a no-op                                                               |
| `no_shock`                | no ≥50-ascent climb's local grade moves >1.0 from its raw mean                                                                    | yes                 | the prior is overpowering established grades (also enforced by a clamp inside the blend itself; the gate catches regressions) |
| `fingerprint_consistency` | ≤1% of duplicate-fingerprint groups disagree by >1 grade at the same angle                                                        | yes                 | evidence for one physical problem is being split badly                                                                        |
| `residual_paired_gap`     | shared-user mean gap vs fitted offset ≤ 0.3 after the Kilter offset                                                               | withholds universal | the "constant offset" story is wrong; local grades still publish, universal grades don't                                      |
| honesty report            | reports `corr(grade, display)` and mean \|Δ\| per board                                                                           | no (report only)    | a board whose numbers never leave the label is dressing the label as a data product; UI copy must say so                      |

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
de-herded evaluation (predicting held-out Tension benchmarks) is the Stage-2
way to raise it honestly.

## 5. Known limitations

These are real and we'd rather state them than paper over them.

- **Moon is not standardized.** No crowd mean (label-only feed), no bridge users
  to any other board, circular benchmarks. Moon shows its native grade plus "not
  standardized yet." The unlock is Moon logbook growth — more logged Moon sends
  create both a crowd mean and shared users.
- **Small boards aren't universalized.** Decoy, Grasshopper, So iLL, and
  Touchstone have no anchor, so they get a within-board grade with no
  cross-board claim.
- **Mirrors inherit the base grade.** The aggregates carry no mirror dimension,
  so a mirrored climb reads at its base orientation's grade. Documented, not
  fixed.
- **Anchoring / herding attenuates deviations.** Because loggers anchor to the
  displayed grade, the crowd mean drifts less than true disagreement would
  warrant. v1 applies the (1 − λ) de-attenuation to the _standard error_ but
  does **not** de-attenuate the point estimate itself — inflating the deviation
  is easy to get wrong and could manufacture movement on thin evidence, so we
  chose the conservative option and left it for Stage 2's rater model.
- **Single-angle sparse climbs gain little.** With one angle and few ascents the
  posterior is essentially the raw mean. The model's tail value is cross-angle
  pooling; a lone sparse angle has nothing to pool with.

## 6. Rejected alternatives

| Alternative               | Why not (for v1)                                                                                                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full Bayesian / MCMC      | Upstream gives us aggregate means, not per-ascent variances. Without the underlying distributions there's nothing for a sampler to condition on that the closed-form EB blend doesn't already capture — the cost buys no extra signal.                                                  |
| WHR / IRT as the backbone | Per-user outcomes cover only ~14% of the Kilter catalog. theCrag's GRAID works because it has dense per-user ascent data; ours is too sparse to carry a rating system as the primary estimator. Ticks are a coefficient factory (variance, cross-board offset), not a grading backbone. |
| CNN content model         | Deferred, not rejected. A gradient-boosted model on hold features is the cheaper, more credible Stage-3 version (`content_prior` column is already reserved, NULL in v1).                                                                                                               |

## 7. Contributing

### The roadmap

- **Stage 2 — ordinal rater model.** Model per-rater bias on an ordinal scale
  with echo ticks down-weighted, so the point estimate can be de-attenuated
  safely. Add a behavioral flash/attempt Rasch signal from tick outcomes, which
  is anchoring-immune (whether someone flashed a climb doesn't depend on the
  displayed number).
- **Stage 3 — hold-feature content prior.** A gradient-boosted model over hold
  features to give the cold tail a prior before any ascents exist. The
  `content_prior` column on `board_climb_grades` is reserved for this.

### Running it

Unit tests (Node's native runner via tsx):

```
node --import tsx --test packages/db/src/queries/grade-model/__tests__/grade-model.test.ts
```

The pipeline locally, against the dev DB (or a read-only prod `DB_URL`):

```
node --import tsx packages/db/scripts/refresh-climb-grades.ts --validate-only
node --import tsx packages/db/scripts/refresh-climb-grades.ts --dry-run
node --import tsx packages/db/scripts/refresh-climb-grades.ts --refit-coefficients
```

- `--validate-only` refits coefficients in memory, runs every gate against live
  data, prints per-board tier counts and the honesty report, and writes nothing.
  It works even before the grade tables exist (e.g. prod pre-migration).
- `--dry-run` evaluates and records gates but writes no grade rows.
- `--refit-coefficients` forces a weekly refit instead of reusing the frozen set.
- A bare run reuses frozen coefficients if they're under a week old, else refits.

### Where things are stored

- `board_climb_grades` — one row per climb+angle: `local_grade`,
  `universal_grade` (NULL when unanchorable), `grade_low`/`grade_high`,
  `confidence`, `ascensionist_count` snapshot, `content_prior` (NULL in v1),
  `model_version`, `coeff_version`.
- `board_grade_coefficients` — versioned coefficient rows keyed by
  `(coeff_version, kind, key)`. Kinds: `echo_fraction`, `sigma_within`,
  `tau_squared`, `angle_offset`, `board_offset`, and `gate_results` (per-run
  pass/fail + metrics). Plain table, `pg_dump`-portable.
