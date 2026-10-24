# Workout catalogue depth

How many climbs a generated workout can draw on, per board and grade, at each quality filter. Measured for #6232 (SEL0) before anyone changes the defaults. No default changed in code.

## Decision

1. **Keep one global default** of `minAscents 5` and `minRating 2`. On Kilter, Tension, Decoy and Grasshopper, every plan shape fills across the core grades at those values (Kilter layout 1: 1,691 climbs at its thinnest core grade; Tension: 123 or more; Decoy: 33). MoonBoard fills volume and grade focus everywhere, but not pyramid (67% to 88% of core grades) or ladder (33% to 63%), with or without a filter: the bottom of its grade table holds ids 13 and 16 (0 to 2 climbs at the defaults), and a pyramid or ladder aimed at the lowest core grades reaches down to them. That is a generator question (SEL2/SEL3 should clamp to grades that have climbs), not a quality-filter one.
2. **Do not copy Boardz's 50+ ascents / 3.5+ stars.** It leaves Decoy with 0 climbs at one core grade and fills a 20-climb volume plan at only 9% of Decoy grades, 78% on Kilter layout 1 and 70% on Kilter layout 8.
3. **The rating floor costs almost nothing; the ascent floor is what empties a catalogue.** Going from `5/0` to `5/2` removes under 5% of climbs on every board except Woods (Kilter layout 1: 26,242 to 25,425; Kilter layout 8: 5,174 to 5,127; Woods: 23 to 18); both rows are in the results below. Going from `0` to `5` ascents removes 76% on Kilter layout 1, 54% on Kilter layout 8 and 98% on Woods.
4. **Three small catalogues do not fill at the defaults:** Woods (18 climbs across the core grades, 0% of grades fill a 20-climb volume plan), SoILL (22%) and Touchstone (55%). They are young boards where most climbs have fewer than 5 ascents. A per-board default is possible, but a rule on the data is simpler: when a grade runs short, relax `minAscents` before borrowing from another grade. At `minAscents 1`, `minRating 0`, Woods reaches 88% on volume plans, SoILL 89% and Touchstone 100%. That belongs to SEL2/SEL3 as a fill step, shown in the preview, not as a different stored default.
5. **"Benchmarks only" is a MoonBoard feature in practice.** Every MoonBoard layout has 295 to 570 benchmark climbs at its popular angle. Kilter has 122 on layout 1 and 21 on layout 8, Tension 184 to 517, Decoy 166, Grasshopper 9, and SoILL, Touchstone and Woods none. SEL2 should expect a shortfall on most boards and say so in the preview, or hide the switch when the board has no benchmarks.
6. **Any change to these defaults is its own PR with a screenshot fixture re-record**: the recorded `SearchClimbs` request carries `minAscents:5,minRating:2`.

## What was measured

`packages/db/scripts/analyze-workout-candidates.ts`, read-only (one `READ ONLY` transaction). For every board and layout with at least 1,000 listed climbs, at the layout's popular angle (the angle with the most climbs that have a stats row), it counts climbs per grade that pass each combination of:

- `minAscents` in 0, 1, 5, 10, 50, 100 (`board_climb_stats.ascensionist_count >= n`)
- `minRating` in 0, 2, 3, 3.5 (`quality_average >= n`)
- benchmarks only: no or yes (`benchmark_difficulty > 0`)

It mirrors the server search in `create-climb-filters.ts`: the grade is `ROUND(display_difficulty)`, and only listed, published, visible climbs count. A climb with no ascent count or no rating passes only the 0 threshold, as in the server. The workout sends `gradeAccuracy: 'moderate'`. The server reads it with `parseFloat` (`mapSearchInputToParams`) and gets `NaN`, and `createClimbFilters` adds the accuracy condition only for a truthy value, so the search runs with no accuracy filter. The offline search skips it the same way. These tables match that. `'moderate'` is the filter picker's label for the wire value `'0.1'`; if the workout ever sends `'0.1'`, every climb whose crowd average sits more than 0.1 from its rounded grade drops out and these counts no longer hold.

**Core grades** are the 10th to 90th percentile of the unfiltered grade distribution, so a handful of climbs at the extremes does not set the result. **Plan fill** is the share of core grades where the plan can be built from distinct climbs:

- volume: 20 climbs at the target grade
- grade focus: 15 climbs at the target grade
- pyramid: 1 climb at the target and 2 at each of the two grades below it (5 steps x 1)
- ladder: 2 climbs at each of the 5 grades ending at the target

The demand per grade is not hand-modelled: the script calls `generateWorkoutPlan` from `@boardsesh/playlist-generator` with the default options and counts the slots per grade, so the shapes follow the app. It walks the board's real grade table (`getGradesForBoard`, the table the app's generator gets), including table grades that have no climbs, and clamps at the bottom of the table as the generator does. A grade in the table with no climbs is demand that cannot be met, which is why MoonBoard fails pyramid and ladder plans aimed near the bottom of its table, even unfiltered.

Run it (dev DB up, or any Postgres with the snapshot data):

```
node --import tsx packages/db/scripts/analyze-workout-candidates.ts            # markdown
node --import tsx packages/db/scripts/analyze-workout-candidates.ts --format json
```

`--min-climbs` (default 1000) sets the smallest layout to include. The grid maths lives in `analyze-workout-candidates-core.ts`, with tests beside it. Re-measured 2026-10-24 after the review fixes to the pyramid shape and the grade table; the earlier numbers (MoonBoard 4/5 pyramid at 43% and 75%) came from a five-grade pyramid the app never builds.

## Caveats

- Data: the dev database built from the nightly board snapshots (newest `board_climb_stats` row 2026-09-24). Counts move as the snapshots refresh; the shape should not.
- Size and sets are not applied. A real board is a size and a set of holds, so a real climber sees fewer climbs than a layout-wide count. The smallest layouts are the first to run short.
- Cross-angle stats and the Boardsesh grade source are not modelled. The workout sends neither today.
- A signed-in climber with the default `unfamiliar` bias also loses every climb they have attempted or sent at the angle. That personal cut is not in these tables. Strong climbers on a small board will see less than shown, which is the case SEL2's "prefer unsent, sent as top-up" is for.
- MoonBoard angle is 40 degrees for every layout here, the only angle MoonBoard offers in most layouts.

## Results

Dev database, 2026-10-24. Climbs counted at each layout's popular angle.

#### No quality filter (minAscents 0, minRating 0)

| board | layout | angle | core grades | climbs | median per grade | fewest per grade | volume 20 at one grade | grade focus 15 | pyramid 5 steps x 1 | ladder 5 steps x 2 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| decoy | 2 | 40 | 15-25 | 3906 | 318 | 157 | 100% | 100% | 100% | 100% |
| grasshopper | 1 | 30 | 13-22 | 6200 | 574 | 255 | 100% | 100% | 100% | 100% |
| kilter | 1 | 40 | 16-24 | 110874 | 8980 | 5681 | 100% | 100% | 100% | 100% |
| kilter | 8 | 40 | 15-24 | 11276 | 1005 | 402 | 100% | 100% | 100% | 100% |
| moonboard | 2 | 40 | 19-25 | 93234 | 12338 | 4633 | 100% | 100% | 86% | 57% |
| moonboard | 3 | 40 | 19-26 | 35368 | 4150 | 1819 | 100% | 100% | 75% | 50% |
| moonboard | 4 | 40 | 17-23 | 56700 | 6364 | 3819 | 100% | 100% | 71% | 43% |
| moonboard | 5 | 40 | 17-24 | 48082 | 5133 | 2369 | 100% | 100% | 88% | 63% |
| moonboard | 6 | 40 | 17-22 | 7999 | 1125 | 590 | 100% | 100% | 67% | 33% |
| moonboard | 7 | 40 | 17-23 | 5227 | 751 | 273 | 100% | 100% | 71% | 43% |
| soill | 1 | 30 | 13-21 | 540 | 52 | 17 | 89% | 100% | 100% | 100% |
| tension | 9 | 40 | 14-24 | 20935 | 1493 | 664 | 100% | 100% | 100% | 100% |
| tension | 10 | 40 | 16-25 | 23584 | 1844.5 | 1034 | 100% | 100% | 100% | 100% |
| tension | 11 | 40 | 16-25 | 14404 | 1146.5 | 716 | 100% | 100% | 100% | 100% |
| touchstone | 1 | 35 | 13-23 | 1087 | 89 | 32 | 100% | 100% | 100% | 100% |
| woods | 1 | 40 | 15-26 | 1167 | 127 | 62 | 100% | 100% | 100% | 100% |

#### Rating floor off (minAscents 5, minRating 0)

| board | layout | angle | core grades | climbs | median per grade | fewest per grade | volume 20 at one grade | grade focus 15 | pyramid 5 steps x 1 | ladder 5 steps x 2 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| decoy | 2 | 40 | 15-25 | 1201 | 101 | 33 | 100% | 100% | 100% | 100% |
| grasshopper | 1 | 30 | 13-22 | 1470 | 119 | 72 | 100% | 100% | 100% | 100% |
| kilter | 1 | 40 | 16-24 | 26242 | 2158 | 1747 | 100% | 100% | 100% | 100% |
| kilter | 8 | 40 | 15-24 | 5174 | 419.5 | 215 | 100% | 100% | 100% | 100% |
| moonboard | 2 | 40 | 19-25 | 36452 | 3425 | 939 | 100% | 100% | 86% | 57% |
| moonboard | 3 | 40 | 19-26 | 10565 | 698.5 | 278 | 100% | 100% | 75% | 50% |
| moonboard | 4 | 40 | 17-23 | 28617 | 2319 | 1048 | 100% | 100% | 71% | 43% |
| moonboard | 5 | 40 | 17-24 | 18871 | 1597.5 | 432 | 100% | 100% | 88% | 63% |
| moonboard | 6 | 40 | 17-22 | 5276 | 644 | 259 | 100% | 100% | 67% | 33% |
| moonboard | 7 | 40 | 17-23 | 2912 | 323 | 110 | 100% | 100% | 71% | 43% |
| soill | 1 | 30 | 13-21 | 158 | 14 | 5 | 22% | 44% | 100% | 100% |
| tension | 9 | 40 | 14-24 | 7451 | 506 | 292 | 100% | 100% | 100% | 100% |
| tension | 10 | 40 | 16-25 | 6573 | 475 | 289 | 100% | 100% | 100% | 100% |
| tension | 11 | 40 | 16-25 | 4518 | 355 | 123 | 100% | 100% | 100% | 100% |
| touchstone | 1 | 35 | 13-23 | 343 | 22 | 15 | 55% | 100% | 100% | 100% |
| woods | 1 | 40 | 15-26 | 23 | 3 | 0 | 0% | 0% | 50% | 0% |

#### Current defaults (minAscents 5, minRating 2)

| board | layout | angle | core grades | climbs | median per grade | fewest per grade | volume 20 at one grade | grade focus 15 | pyramid 5 steps x 1 | ladder 5 steps x 2 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| decoy | 2 | 40 | 15-25 | 1199 | 101 | 33 | 100% | 100% | 100% | 100% |
| grasshopper | 1 | 30 | 13-22 | 1468 | 119 | 72 | 100% | 100% | 100% | 100% |
| kilter | 1 | 40 | 16-24 | 25425 | 2065 | 1691 | 100% | 100% | 100% | 100% |
| kilter | 8 | 40 | 15-24 | 5127 | 417 | 215 | 100% | 100% | 100% | 100% |
| moonboard | 2 | 40 | 19-25 | 36445 | 3425 | 937 | 100% | 100% | 86% | 57% |
| moonboard | 3 | 40 | 19-26 | 10562 | 698.5 | 278 | 100% | 100% | 75% | 50% |
| moonboard | 4 | 40 | 17-23 | 28616 | 2319 | 1047 | 100% | 100% | 71% | 43% |
| moonboard | 5 | 40 | 17-24 | 18865 | 1597.5 | 432 | 100% | 100% | 88% | 63% |
| moonboard | 6 | 40 | 17-22 | 5275 | 644 | 259 | 100% | 100% | 67% | 33% |
| moonboard | 7 | 40 | 17-23 | 2912 | 323 | 110 | 100% | 100% | 71% | 43% |
| soill | 1 | 30 | 13-21 | 158 | 14 | 5 | 22% | 44% | 100% | 100% |
| tension | 9 | 40 | 14-24 | 7429 | 506 | 292 | 100% | 100% | 100% | 100% |
| tension | 10 | 40 | 16-25 | 6568 | 474.5 | 289 | 100% | 100% | 100% | 100% |
| tension | 11 | 40 | 16-25 | 4506 | 354.5 | 123 | 100% | 100% | 100% | 100% |
| touchstone | 1 | 35 | 13-23 | 341 | 22 | 15 | 55% | 100% | 100% | 100% |
| woods | 1 | 40 | 15-26 | 18 | 2 | 0 | 0% | 0% | 25% | 0% |

#### Benchmarks only (no other filter)

| board | layout | angle | core grades | climbs | median per grade | fewest per grade | volume 20 at one grade | grade focus 15 | pyramid 5 steps x 1 | ladder 5 steps x 2 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| decoy | 2 | 40 | 15-25 | 166 | 11 | 4 | 18% | 36% | 91% | 73% |
| grasshopper | 1 | 30 | 13-22 | 9 | 0 | 0 | 0% | 0% | 0% | 0% |
| kilter | 1 | 40 | 16-24 | 122 | 10 | 7 | 0% | 33% | 100% | 78% |
| kilter | 8 | 40 | 15-24 | 21 | 1 | 0 | 0% | 0% | 20% | 0% |
| moonboard | 2 | 40 | 19-25 | 570 | 65 | 36 | 100% | 100% | 71% | 43% |
| moonboard | 3 | 40 | 19-26 | 468 | 49.5 | 35 | 100% | 100% | 75% | 50% |
| moonboard | 4 | 40 | 17-23 | 358 | 36 | 27 | 100% | 100% | 71% | 43% |
| moonboard | 5 | 40 | 17-24 | 417 | 39 | 30 | 100% | 100% | 75% | 50% |
| moonboard | 6 | 40 | 17-22 | 457 | 58 | 41 | 100% | 100% | 67% | 33% |
| moonboard | 7 | 40 | 17-23 | 295 | 28 | 19 | 86% | 100% | 71% | 43% |
| soill | 1 | 30 | 13-21 | 0 | 0 | 0 | 0% | 0% | 0% | 0% |
| tension | 9 | 40 | 14-24 | 517 | 41 | 12 | 82% | 82% | 100% | 82% |
| tension | 10 | 40 | 16-25 | 286 | 16.5 | 6 | 30% | 60% | 100% | 100% |
| tension | 11 | 40 | 16-25 | 184 | 13 | 6 | 20% | 40% | 100% | 90% |
| touchstone | 1 | 35 | 13-23 | 0 | 0 | 0 | 0% | 0% | 0% | 0% |
| woods | 1 | 40 | 15-26 | 0 | 0 | 0 | 0% | 0% | 0% | 0% |

#### Boardz-style (minAscents 50, minRating 3.5)

| board | layout | angle | core grades | climbs | median per grade | fewest per grade | volume 20 at one grade | grade focus 15 | pyramid 5 steps x 1 | ladder 5 steps x 2 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| decoy | 2 | 40 | 15-25 | 146 | 14 | 0 | 9% | 45% | 91% | 82% |
| grasshopper | 1 | 30 | 13-22 | 198 | 15 | 4 | 40% | 50% | 100% | 100% |
| kilter | 1 | 40 | 16-24 | 531 | 43 | 16 | 78% | 100% | 100% | 100% |
| kilter | 8 | 40 | 15-24 | 315 | 29 | 7 | 70% | 80% | 90% | 70% |
| moonboard | 2 | 40 | 19-25 | 3952 | 403 | 142 | 100% | 100% | 86% | 57% |
| moonboard | 3 | 40 | 19-26 | 1449 | 126 | 57 | 100% | 100% | 75% | 50% |
| moonboard | 4 | 40 | 17-23 | 3494 | 309 | 146 | 100% | 100% | 71% | 43% |
| moonboard | 5 | 40 | 17-24 | 2548 | 245.5 | 96 | 100% | 100% | 75% | 50% |
| moonboard | 6 | 40 | 17-22 | 1279 | 118.5 | 61 | 100% | 100% | 67% | 33% |
| moonboard | 7 | 40 | 17-23 | 545 | 50 | 20 | 100% | 100% | 71% | 43% |
| soill | 1 | 30 | 13-21 | 5 | 0 | 0 | 0% | 0% | 0% | 0% |
| tension | 9 | 40 | 14-24 | 1206 | 84 | 43 | 100% | 100% | 100% | 100% |
| tension | 10 | 40 | 16-25 | 1358 | 99 | 48 | 100% | 100% | 100% | 100% |
| tension | 11 | 40 | 16-25 | 953 | 64.5 | 23 | 100% | 100% | 100% | 100% |
| touchstone | 1 | 35 | 13-23 | 77 | 4 | 0 | 0% | 0% | 64% | 36% |
| woods | 1 | 40 | 15-26 | 0 | 0 | 0 | 0% | 0% | 0% | 0% |

#### minAscents 10, minRating 3

| board | layout | angle | core grades | climbs | median per grade | fewest per grade | volume 20 at one grade | grade focus 15 | pyramid 5 steps x 1 | ladder 5 steps x 2 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| decoy | 2 | 40 | 15-25 | 623 | 48 | 17 | 82% | 100% | 100% | 100% |
| grasshopper | 1 | 30 | 13-22 | 764 | 60.5 | 31 | 100% | 100% | 100% | 100% |
| kilter | 1 | 40 | 16-24 | 12770 | 1133 | 756 | 100% | 100% | 100% | 100% |
| kilter | 8 | 40 | 15-24 | 3195 | 262.5 | 122 | 100% | 100% | 100% | 100% |
| moonboard | 2 | 40 | 19-25 | 21662 | 1702 | 515 | 100% | 100% | 86% | 57% |
| moonboard | 3 | 40 | 19-26 | 5853 | 347.5 | 164 | 100% | 100% | 75% | 50% |
| moonboard | 4 | 40 | 17-23 | 18845 | 1291 | 517 | 100% | 100% | 71% | 43% |
| moonboard | 5 | 40 | 17-24 | 11205 | 782 | 242 | 100% | 100% | 75% | 50% |
| moonboard | 6 | 40 | 17-22 | 3855 | 366.5 | 150 | 100% | 100% | 67% | 33% |
| moonboard | 7 | 40 | 17-23 | 1847 | 160 | 57 | 100% | 100% | 71% | 43% |
| soill | 1 | 30 | 13-21 | 68 | 7 | 2 | 0% | 0% | 100% | 78% |
| tension | 9 | 40 | 14-24 | 4043 | 257 | 133 | 100% | 100% | 100% | 100% |
| tension | 10 | 40 | 16-25 | 3990 | 298 | 173 | 100% | 100% | 100% | 100% |
| tension | 11 | 40 | 16-25 | 2746 | 211 | 62 | 100% | 100% | 100% | 100% |
| touchstone | 1 | 35 | 13-23 | 202 | 13 | 5 | 45% | 45% | 100% | 82% |
| woods | 1 | 40 | 15-26 | 3 | 0 | 0 | 0% | 0% | 0% | 0% |

#### Climbs per core grade at the current defaults (grade id: climbs)

- decoy layout 2: 15: 111, 16: 103, 17: 91, 18: 106, 19: 74, 20: 101, 21: 89, 22: 116, 23: 140, 24: 63, 25: 33
- grasshopper layout 1: 13: 97, 14: 134, 15: 149, 16: 149, 17: 141, 18: 146, 19: 104, 20: 104, 21: 72, 22: 97
- kilter layout 1: 16: 2065, 17: 1733, 18: 2240, 19: 1691, 20: 2338, 21: 1772, 22: 3118, 23: 2334, 24: 1880
- kilter layout 8: 15: 333, 16: 544, 17: 425, 18: 542, 19: 409, 20: 526, 21: 351, 22: 460, 23: 271, 24: 215
- moonboard layout 2: 19: 18145, 20: 5537, 21: 3776, 22: 3425, 23: 1829, 24: 1372, 25: 937
- moonboard layout 3: 19: 4841, 20: 1718, 21: 785, 22: 964, 23: 612, 24: 600, 25: 278, 26: 366
- moonboard layout 4: 17: 11444, 18: 4470, 19: 3723, 20: 2319, 21: 1967, 22: 2011, 23: 1047
- moonboard layout 5: 17: 7273, 18: 2553, 19: 2387, 20: 1758, 21: 1267, 22: 1437, 23: 780, 24: 432
- moonboard layout 6: 17: 1909, 18: 1302, 19: 829, 20: 459, 21: 318, 22: 259
- moonboard layout 7: 17: 801, 18: 744, 19: 436, 20: 323, 21: 182, 22: 173, 23: 110
- soill layout 1: 13: 8, 14: 18, 15: 14, 16: 30, 17: 18, 18: 27, 19: 9, 20: 11, 21: 5
- tension layout 9: 14: 307, 15: 567, 16: 815, 17: 393, 18: 761, 19: 366, 20: 675, 21: 292, 22: 644, 23: 506, 24: 387
- tension layout 10: 16: 438, 17: 361, 18: 511, 19: 427, 20: 589, 21: 418, 22: 695, 23: 612, 24: 512, 25: 289
- tension layout 11: 16: 376, 17: 306, 18: 366, 19: 343, 20: 403, 21: 296, 22: 466, 23: 411, 24: 276, 25: 123
- touchstone layout 1: 13: 36, 14: 22, 15: 38, 16: 38, 17: 33, 18: 34, 19: 15, 20: 18, 21: 15, 22: 15, 23: 17
- woods layout 1: 15: 2, 16: 3, 18: 5, 20: 1, 22: 3, 23: 2, 24: 0, 26: 0

#### Benchmark share of the unfiltered catalogue

| board | layout | angle | climbs | benchmarks |
| --- | --- | --- | --- | --- |
| decoy | 2 | 40 | 3906 | 166 |
| grasshopper | 1 | 30 | 6200 | 9 |
| kilter | 1 | 40 | 110874 | 122 |
| kilter | 8 | 40 | 11276 | 21 |
| moonboard | 2 | 40 | 93234 | 570 |
| moonboard | 3 | 40 | 35368 | 468 |
| moonboard | 4 | 40 | 56700 | 358 |
| moonboard | 5 | 40 | 48082 | 417 |
| moonboard | 6 | 40 | 7999 | 457 |
| moonboard | 7 | 40 | 5227 | 295 |
| soill | 1 | 30 | 540 | 0 |
| tension | 9 | 40 | 20935 | 517 |
| tension | 10 | 40 | 23584 | 286 |
| tension | 11 | 40 | 14404 | 184 |
| touchstone | 1 | 35 | 1087 | 0 |
| woods | 1 | 40 | 1167 | 0 |
