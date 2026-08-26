# Board-lighting treatments — decision document (issue #2202)

Reviewed against real captures on six boards: grasshopper-master, kilter-original-12x12, kilter-homewall-10x12 (pale/dense), tension-classic, tension-mirror-12x12 (pale/dense), moonboard-2016 and moonboard-masters-2019 (synthetic grid). Baseline read first on every board.

---

## 1. Verdict per treatment

### Outward glow — **ready with the §3 changes; make it the headline arm**

**Good at:** it is the only treatment that beats baseline on every board I compared. On `grasshopper-master__outward-glow.png` the eighteen lit holds are unmistakable against a wall of ~400 grey holds, and critically the wall's own cyan holds do _not_ read as lit, because a halo is a thing hold art cannot produce. `kilter-original-12x12__outward-glow.png` and `detail__tension-classic__outward-glow.png` are both clearly faster to read than their baselines. On `detail__moonboard-2016__outward-glow.png` the small yellow chips at D10/F8/D6 — the holds you squint for — carry real presence, which the baseline ring does not give them.

**Bad at:** it inherits every tracer defect and amplifies them, because the glow is the biggest painted object of the three. On `detail__kilter-homewall-10x12__outward-glow.png` one lit HAND at ~(330,215) glows as a single envelope over three holds. On `moonboard-2016__outward-glow.png` two of the eight lights (F18 red, F17 blue) have physically moved to a neighbouring cell, and E3 stays a hollow baseline ring in a field of glows — two visual languages on one climb. On `moonboard-masters-2019__outward-glow.png` three of eight lights are hollow rings and two more (G12, G4) sit on the wrong hold. Glows also fuse: kilter-original's red FINISH and blue HAND at the top merge into one blob, as do the tension-mirror pairs.

### Traced halos — **not viable as an arm against #2202; demote to a base-layer modifier**

**Good at:** hold-from-hold separation on dark, low-contrast art. `kilter-original-12x12__shaped-halos.png` is the best case — the grey holds genuinely detach from the field.

**Bad at:** by construction the lit mark is byte-identical to baseline, so this arm cannot improve lit visibility; it can only lose. And it does lose. On `grasshopper-master__shaped-halos.png` a bright rim on ~400 holds turns the field into a luminous mesh and the rings pop _less_ than in baseline. On `detail__tension-classic__shaped-halos.png` it is indistinguishable from baseline — full cost, zero benefit. On `detail__kilter-homewall-10x12__shaped-halos.png` it lays a black web over the wall _and_ draws hard-cornered rounded rectangles instead of silhouettes (~(120,130), (215,220), (690,140), (810,270)) — a visible rendering bug. Polarity flips on visually identical neighbours everywhere: grasshopper (95,185) vs (815,180), moonboard-2016 (130,72) vs (225,75).

**Call:** don't spend an arm on it. Make the neutral outline an independent on/off modifier (see §3 S5) so the experiment measures lit-visibility treatments, not a hold-legibility layer confounded into all three.

### Whole-hold tint — **drop plain tint; keep only as the glow hybrid (§4 V1)**

**Good at:** pale neutral art. `detail__kilter-homewall-10x12__hold-tint.png` and `detail__tension-classic__hold-tint.png` read well — saturated fill on cream art is unambiguous, and the mark is the shape you grab.

**Bad at:** everything else, and it is _worse than baseline_ on three of six boards.

- Size collapse. `moonboard-2016__hold-tint.png`: F16 is a thin blue sliver on a hold's top edge, D6 a chip; against baseline's uniform ~78px rings this is a large net loss of signal. `tension-mirror-12x12__hold-tint.png` and `kilter-original-12x12__hold-tint.png` repeat it — the magenta feet are ~8px dabs where baseline gave 50px rings.
- Colour collision. `detail__grasshopper-master__hold-tint.png`: the lit HAND at (345,240) and the unlit cyan art hold at (345,345) read as the same class. The wall has eight of those cyan holds. Glow has no such ambiguity in the same crop.
- It is the least tolerant of tracer error, because it has no ring to fall back on: `detail__moonboard-masters-2019__hold-tint.png` puts the top-right light on a wedge of the _wrong_ hold, and `detail__kilter-homewall-10x12__hold-tint.png` shows a magenta _rounded rectangle_ at (565,432) — a crop box shipped as a hold.

The 126%-of-baseline coloured-area number quoted for kilter-homewall is an artefact of the merge bug, not a win. Plain tint's best board is also the board where it most often paints three holds.

---

## 2. Ranked change list per treatment

All three are blocked on the shared tracer stack **S1–S4** (§3). Those come first regardless of arm.

### Outward glow

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Kind       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | **S1–S4** (§3). Nothing below is worth tuning on a merged or misplaced silhouette.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | structural |
| 2   | **Cap extent on the edge-to-edge gutter, not the hold and not centre distance.** `extent = clamp(min(0.45·r_eq + 8, 0.40 · gap_NN), 4, 14)` render px at whole-board zoom, where `gap_NN` is silhouette-to-silhouette distance to the nearest placement (precompute per board at trace time). Today's extent is a near-constant 13–22px that knows nothing about spacing, which is why kilter-homewall (median gutter ~4px) and tension-mirror fuse while moonboard is fine. Specify in board units so it survives pinch-zoom.                                                                                                                                         | structural |
| 3   | **Clip each lit glow to its own nearest-placement cell.** Two glows then cannot overlap and each keeps its hue. Do **not** use Lighten/Plus to resolve overlaps: `Lighten(#FF0000,#4455FF) = #FF55FF`, which is the FOOT magenta — a wrong-role colour, not a soft one.                                                                                                                                                                                                                                                                                                                                                                                                | structural |
| 4   | **Normalise band width across boards.** MoonBoard renders ~22px at whole-board zoom against 13–14px on Kilter/Tension; that alone is why `detail__moonboard-2016__outward-glow.png` reads as decorative blobs (a 20px hold inside a 110px halo) while tension-classic reads as a hairline. One value in board units.                                                                                                                                                                                                                                                                                                                                                   | tuning     |
| 5   | **Offset the outer edge from the silhouette's convex hull, keep the inner edge on the raw path.** Kills the valentine-heart cleft on the moonboard arrow at (310,255) without a join hack; on convex Kilter/Tension holds the hull is within 1–2px and nothing changes.                                                                                                                                                                                                                                                                                                                                                                                                | structural |
| 6   | **Trim the alpha plateau.** Stops as fraction of band width d/B: `0.00 → 1.00, 0.15 → 0.90, 0.40 → 0.42, 0.70 → 0.13, 1.00 → 0.00`. Current profile holds full alpha to d/B ≈ 0.32, which is what makes it read as printed paint. Do not delete the plateau — the first ~4px is what separates hold from field.                                                                                                                                                                                                                                                                                                                                                        | tuning     |
| 7   | **Kill the hairline between glow and hold.** On pale/mid art (tension-classic, kilter-homewall, kilter-original) suppress the neutral outline on lit holds entirely and make the gradient's inner stop the pure role colour at α1.0 flush against the silhouette. On dark art (grasshopper, MoonBoard) keep a 1px rim but draw it in the role colour mixed 30% to white (#4455FF→#7C88FF, #FF00FF→#FF4CFF, #00DD00→#4CE84C, #FF0000→#FF4C4C) and use that as the inner gradient stop. Clip that rim _inside_ the silhouette and draw it after the glow — today it is centre-aligned, the outside clip eats half of it, and the surviving line reads as a die-cut edge. | structural |
| 8   | **Only if 2+3 leave visible overpaint:** draw the on-art portion of the glow in a second pass with Screen at ~0.6 of the field alpha, ramping to 0 as destination luma goes 150→220. Ranked last deliberately — once the extent is capped at 0.40·gutter the glow barely touches a neighbour, and Screen on near-white art desaturates to a white smear.                                                                                                                                                                                                                                                                                                               | structural |

### Whole-hold tint (only as part of §4 V1)

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Kind       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | **S1–S4**, and more urgently than for glow: tint has no ring, so a trace error is unrecoverable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | structural |
| 2   | **Size floor = the baseline ring on top of the fill, not a fat collar.** If `max(bboxW,bboxH) < 0.45·D` (D = the board's baseline cue diameter — measured 48px kilter-original, 51px tension-mirror, 61px kilter-homewall, 70px tension-classic at 760px board width), also stroke the baseline circle: diameter D, 3px, role colour, centred on the placement. This fires on exactly the holds that fail (kilter-original 20×14 and 17×16, tension-classic bolt-row 21×22, tension-mirror 18×14) and on nothing on kilter-homewall. **Reject the outward-collar alternative:** growing a 14px silhouette to D means a ~17px opaque rim, which buries neighbouring art on a 500-hold wall and merges lit neighbours at tension-mirror's ~35px pitch. The hollow ring is the reason baseline survives density. | structural |
| 3   | **Normalise the base so the role hex is board-invariant.** Before the tint, fill the same clip toward L=150 using the per-hold art lightness the pipeline already measures: white at `α=(150−L)/(255−L)` when darker, black at `α=(L−150)/L` when lighter. Then role colour at the existing α0.55. Every lit hold then composites to the same value on every board (HAND rgb(105,114,208), FOOT rgb(208,68,208), STARTING rgb(68,189,68), FINISH rgb(208,68,68)), and the hold's own shading and bolt hole survive (α0.50 retained on grasshopper's dark holds, 0.17 on tension's pale wood) — which an opaque underlay destroys.                                                                                                                                                                             | structural |
| 4   | **Give the lit hold a role-coloured 2px silhouette stroke with a 1px white outer edge.** Crisp saturated silhouette-exact edges are something photographic hold art cannot make; this, not palette lifting, is what separates a lit HAND from grasshopper's cyan plastic and MoonBoard's yellows. **Reject a separate "fill-mode" palette** — a second set of role hexes breaks identity against the LED colours, the legend and the other arms.                                                                                                                                                                                                                                                                                                                                                              | structural |
| 5   | **Clip the band inside the silhouette.** Set the traced path as clip, stroke it at 2× the visible width (target ~3 capture px, replacing today's 5–8px straddle), miter join limit 4. Today's marker is 1.5–2px proud of the art on every edge and blunts tapers into lozenges — see the rail at (310,245) in `detail__moonboard-masters-2019__hold-tint.png` and the pointed corner at (505,300) in `detail__kilter-original-12x12__hold-tint.png`. Taper and corners are how you identify a hold on the wall.                                                                                                                                                                                                                                                                                               | structural |
| 6   | **Threshold tension-classic's alpha at 0.5** — its art carries a 1–2px drop shadow the tracer is picking up, so the band sits entirely outside the visible hold. Leave Kilter and MoonBoard alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | tuning     |

### Traced halos (as the base-layer modifier)

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                                  | Kind       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | **S3** — the rounded-rectangle outlines are a shipping blocker on their own. A 1.5px rectangle is still a rectangle; no width or colour tuning matters until the crop-box branch emits null.                                                                                                                                                                                                            | structural |
| 2   | **Delete the per-hold light/dark branch. Draw one unconditional two-tone casing** on the same traced path: pass 1 width 3.0px `#10101A` α0.55, pass 2 width 1.25px `#FFFFFF` α0.60, dark first. That yields ~0.9px dark flanking a 1.25px light core on both edges: core 7.1:1 against the #181225 field, flank 3.7:1 against cream kilter-homewall art. One language, no classifier, no checkerboard.  | structural |
| 3   | **Keep only the largest contour per placement.** Discard interior holes and any contour under 15% of the placement's area — this is what is re-stroking 1px scratch marks as 3–4px bars and drawing closed loops around bolt holes on kilter-homewall, and cutting the tension-mirror rail into segments.                                                                                               | structural |
| 4   | **Outside-align the stroke** (inverse-clip to the silhouette) so hold art is never repainted, and **scale the width**: `clamp(0.08 × hold min-dimension, 0.75, 2.0)` render px. Today it is constant, so a 5–6px rim eats a quarter of a 16–20px MoonBoard chip while being invisible on a 60px jug.                                                                                                    | structural |
| 5   | **Ramp alpha continuously off per-hold art lightness** rather than gating on/off: `alpha = clamp((48 − (L*_hold − 6.9)) / 30, 0, 1)`. Grasshopper lands ~0.87, kilter-original's dark quartile ~0.4, the cream majority of tension-classic/tension-mirror/kilter-homewall lands at 0 — which is the correct outcome there. A continuous ramp misreads gracefully; a binary misreads as salt-and-pepper. | tuning     |
| 6   | **If it is ever run as a lit-visibility arm, the lit mark must change too:** give lit holds a 2px 100% role-colour silhouette stroke replacing the fixed circle wherever the silhouette exceeds it. Otherwise the arm is baseline-plus-noise and can only lose.                                                                                                                                         | structural |

---

## 3. Cross-cutting changes

### S1 — Per-placement alpha partition (structural, bake time) — _blocker for glow and tint_

One nearest-placement label map per layout+set: jump-flood over the composited alpha (`ALPHA_FLOOR` stays 96) seeded at **every** placement in the layout, not just lit ones. A placement's mask is `alpha ≥ floor` ∧ `label == this placement` ∧ connected to its own seed. Touching holds then split along the midline between their bolts, which reads as "the hold ends here". Cap growth at `min(0.75 × distance to nearest other placement, 1.3 × nominal hold radius)`.

**Delete:** the rounded cell-rect intersect (it draws squircle chords through large holds), the 2.2×-bbox reject, the 0.5-pitch centroid test, the bbox-fill > 0.85 test. **Keep** one backstop: post-partition area > 2.2× the _per-board_ median traced area → fall back (medians differ 6×: ~2027px² kilter-homewall vs ~332px² masters-2019).

_Adjudication:_ reviewers split between Voronoi partition, erode/dilate, and a cell-disc clip. Erode/dilate breaks thin necks (tension-mirror) but not the wide contact on kilter-homewall, so it is a supplement at best. The cell-disc clip cuts arcs through legitimately large isolated holds. Partition is the only one that is exact where holds touch and inert where they don't.

### S2 — Seed containment (structural) — _blocker, MoonBoards_

Seed only inside a disc of `max(4px, 0.15 × cell pitch)` around the placement — enough to cover a punched-out bolt hole, not enough to reach a neighbour. Never "nearest filled pixel anywhere in the box". No seed → emit nothing. On moonboard-2016 the cell pitch is 58.7px while the baseline circle radius is 38.8px, so any search sized on the marker circle reaches two-thirds of the way into both horizontal neighbours — that is the root cause of the F18/F17 leaks, and it is why the fix is a smaller search, not a stricter post-filter.

**Do not** re-introduce a "traced area ≥ 40% of the nominal circle" gate: it rejects 7/7 lit holds on moonboard-2016, 7/7 on grasshopper, 7/7 on tension-classic. moonboard-2016 F8 keeps its silhouette at 311px = 6.6% of the nominal circle; pin that as a negative test.

### S3 — Kill the crop-rectangle fallback at source (structural) — _blocker, all three_

The constant-size axis-aligned rounded square centred on the bolt hole is the trace's "no alpha above threshold" branch. Make it emit **null**; the renderer's existing null-path → fallback route handles it. Keep a post-condition on every emitted polygon: reject if >10% of perimeter lies on the search-box edge, or if 4+ straight runs within 2° of the image axes account for >80% of perimeter. No real hold silhouette does that; a crop box always does.

### S4 — Fallback vocabulary must match the arm (structural)

The MoonBoard synthetic-grid fallback is known, but shipping a hollow baseline ring inside a glow/fill climb is not — it reads as an annotation next to a light. Shrink the fallback radius to ~0.6× today's (≈ the board's median hold half-width) so its footprint matches a lit hold, then:

- **glow:** one radial gradient disc centred on the placement, r = 1.6R, stops `0→0.625` transparent, `0.625` role α0.90, `1.0` role α0. Interior stays play-field, exactly like every other lit hold.
- **tint:** filled disc, role colour composited over a light base (#E6E6E1) so its brightness matches a tint on pale art, plus the ring.
- **halos:** nothing.

**One language per climb:** count the lit holds that fell back; if any did, draw the ring on every lit hold of that climb (ring _plus_ fill/glow where the silhouette is good). On the synthetic MoonBoard layouts this collapses to ring-everywhere, which is the honest outcome there and removes the three-languages problem visible in `moonboard-masters-2019__hold-tint.png`.

### S5 — The neutral outline on unlit holds is not part of the answer to #2202

It is currently a hidden confound in all three arms and it measurably hurts two boards: `grasshopper-master__shaped-halos.png` lifts mean board luminance 37.3 → 48.1 and the rings get harder to find; kilter-homewall drops 80.2 → 67.1 under a black web. Baseline proves holds are perfectly visible on every board without it.

**Make it an independent flag.** Ship the glow and hybrid arms with the outline layer **off** by default; traced-halos _is_ the outline layer, run as an on/off modifier if you want that read. When it is on, it uses the §2 traced-halos spec (unconditional casing, outside-aligned, alpha ramp), and it must never be drawn on a lit hold in a treatment that paints outward.

### S6 — Role palette: CVD is a baseline defect, fix it in parallel, don't gate on it

Role is carried by hue alone in all four renderings. Under protanopia HAND #4455FF → #5353FF and FOOT #FF00FF → #5E5EFF, ΔE 7.7 — hands and feet are one colour. This is already true of what ships, so it is not a regression in any candidate and must not block the experiment.

Keep all four hues, freeze outer geometry (there is negative headroom on kilter-homewall, where a HAND and a FOOT ring already overlap in `detail__kilter-homewall-10x12__baseline.png`), and add an **inner glyph** at full opacity inside the existing footprint, sized as a fraction of marker outer diameter D:

- HAND — no glyph · FOOT — filled dot 0.30 D · START — filled bar 0.62 D × 0.20 D, round caps · FINISH — that bar plus its vertical twin

Channel is silhouette: none / dot / bar / cross. All plain fills. Glyph in role colour for ring-based marks; in a neutral (white on dark art, black on pale, reusing the existing per-hold lightness read) for glow and tint, where the fill underneath is already the role colour. **Apply the identical glyph set to every arm** so the experiment measures treatments, not glyph sets. For glow this is a deliberate bounded exception to "the hold surface stays clean" — HAND, the most numerous role, stays clean.

### S7 — Everything painted must be specified in board units

Glow extent is currently a near-constant device-pixel value (~18–22px tension-mirror vs ~15px grasshopper despite grasshopper rendering 1.5× larger), and the neutral outline width is constant per board. Both must scale linearly with render scale or they misbehave under pinch-zoom, which is exactly when a climber is trying to read a hold.

---

## 4. What to try that nobody built

### V1 — Glow + normalised tint (the arm that should replace plain hold-tint)

Per lit hold, in order: (1) base-normalise the silhouette toward L=150 (§2 tint #3); (2) fill with role colour at α0.55; (3) 3px inside-clipped band in the role colour; (4) outward glow band per §2 glow #2/#5/#6, clipped to the hold's Voronoi cell; (5) baseline ring on top when `max(bbox) < 0.45·D`; (6) §S6 glyph. This is where the findings converge from four independent directions: the glow supplies the "not-art" cue that fill alone cannot (grasshopper cyan), the fill supplies shape and target size on pale boards where glow is cramped, and the ring backstops the small-hold case. Expect it to be the best arm on kilter-homewall and tension-classic and to trade with plain glow on MoonBoard.

### V2 — Shaped ring (cheapest structural step away from baseline)

Keep baseline's hollow-ring vocabulary but make the ring the hold's shape: stroke the traced silhouette in the role colour at `0.055 × grid pitch` (~3.2px at whole-board zoom), sitting outside a 1px neutral hairline, paired with a minimum 5–6px glow band. Rationale: on `detail__tension-mirror-12x12__hold-tint.png` the chip at (180,487) reads only because its whole 20×11 area is filled — a 2–3px hue change on a line is not enough separation on a #181225 field at board zoom, so the band is not optional. Hollow means it never buries neighbouring art, which is the property that lets baseline survive 500-hold walls.

### V3 — Ring + glow, silhouette never load-bearing (the risk-hedged arm)

Baseline circle unchanged at the placement, plus a silhouette-clipped outward glow. If the trace fails — wrong hold, merged blob, crop box — the circle is still exactly where the climb says the hold is, so the failure degrades to "baseline plus a stray halo" rather than "lights the wrong hold". Worth running precisely because §S1–S3 are new code landing on seven layouts; this arm bounds the blast radius of a tracer regression in production.

---

## 5. What to measure on device

**Pre-rollout capture gates (deterministic, run in CI on this PNG set — not opinions):**

1. Every emitted outline contains its own placement point. Currently fails 31/143 on masters-2019 and 19/159 on moonboard-2016.
2. No emitted region contains a second placement point. Currently ~5/16 lit placements on kilter-homewall.
3. No painted pixel of a lit mark is nearer another placement than its own.
4. Zero polygons with >10% of perimeter on a search-box edge. Currently 47% on kilter-homewall, 24% on tension-mirror.
5. Outline components fall in one luminance cluster per board (today: 183/184 split on kilter-original, 47/87 on moonboard-2016), with zero mixed-polarity components.
6. Coloured regions per capture == lit-hold count, on kilter-homewall and tension-mirror in both glow and tint.
7. CVD gate: run the captures through Viénot protan/deutan/trit and assert HAND-vs-FOOT ΔE ≥ 15 after the §S6 glyphs.

**In-app telemetry, stratified by `board × layout` — never pooled.** The treatment effect flips sign by board (glow wins moonboard-2016, tint wins kilter-homewall, halos loses on grasshopper), so a pooled result is meaningless and will read as "no effect".

- **Zoom behaviour** — pinch events per climb view and max zoom level reached. Climbers zoom when they cannot read the board at a glance; this is the closest proxy the app has to the actual complaint in #2202.
- **Time from climb open → first queue/BLE action**, p50 and p90.
- **Same-climb re-open rate within a session** (going back to check which hold was lit).
- **Fallback telemetry, per render, bucketed by board:** counts by reason — no-seed, multi-placement rejected, box-edge rejected, area rejected, mask clamped by the distance limit. kilter-homewall and tension-mirror should dominate the clamp counter; a spike on a sparse board means the placement centres are wrong, not the trace. Gate rollout on the fallback fraction, per board.
- **Render cost:** board-render frame time p95 and cold-render time. Glow adds four to six paths per lit hold plus a clip; MoonBoard layouts carry ~180 outlines and Kilter ~500. Watch Android mid-tier especially.
- **Guard metric:** tick and attempt logging rate must not move. If a treatment makes people light the wrong hold, that shows up as abandoned climbs, not as a design complaint.
- **One in-app prompt** to the experiment cohort only: "could you tell which holds were lit at a glance?" Free text is more useful than a scale here, because the failures are specific (three holds glowing, a light on the wrong hold) and users will name them.

**Do not** gate rollout on a hold-legibility metric such as hold-vs-field contrast. It ranks grasshopper — the board where the outline layer measurably _hurts_ lit visibility — as the board most in need of outlines.
