# Second design pass (issue #2202)

Reviewed against a fresh set of device captures taken off a real Android device at HEAD
(`173cbd69a`): seven boards x four arms, 28 panels at capture resolution plus 21 native-pixel
detail tiles, and the Viénot dichromat figure. Sixteen reviewers went over them — fifteen lenses
(glance findability, art collision, density, scale invariance, hold identity, role glyphs,
CVD/luminance, the LED layer, the every-hold outline, fallbacks and small holds, an audit of the
first review's 26 items, an audit of the generated tracer data, renderer portability, the ship
path, and one lens asked only for ideas nobody had built) and a completeness critic. Every finding
was then re-measured by an adversarial verifier against the same images and the same code. 137
findings went in. Five came out refuted outright, and a little over half came out revised —
almost always because the mechanism was right and the number was not. What survives dedupes to the
eighteen changes below.

Two things to know before reading the list. The first review's tracer block landed and holds: re-run
against the committed `SPIKE_HOLD_OUTLINES`, its own gates give zero failures on all seven boards for
"contains its own placement", "contains no second placement" and "no polygon on the search-box edge".
The glow-geometry block (its items 2 to 6) and the fallback vocabulary (S4) landed nowhere at all.

## The call

**Outward glow leads and `traced-ring` should stop being an arm.** At the zoom a climber reads a
board at, roughly 300 px per panel, the glow is first or joint first on six of the seven boards and
second to the hybrid on Kilter Homewall, while the traced outline is last on all seven; it is last
for a reason visible at 4x, because its 8.1 board-px stroke is wider than the hold on every board
with small holds, so the arm whose premise is "the mark is the shape of the hold" paints a
featureless blob on 6 of 10 lit holds on MoonBoard 2016 and on both of Tension Original's foot
screws. `glow-tint` wins only on Kilter Homewall and buys that by destroying the hold's photograph:
on the Tension foot screw at board (270,1575) the glow panel shows the olive washer clearly and the
hybrid panel shows a flat pink blob. Keep the hybrid as the challenger and re-capture it before
scoring it, because three separate defects (a dangling clip, a missing size boost, a zero sentinel
in the lightness table) all push it the same way and nobody currently knows how much of its result
is real. Nothing changes about the glow's shape; what changes is the units it is specified in, its
alpha ramp, and the four things wrapped around it that are wrong today — the palette on four boards,
the spurs in the silhouette, an LED cover that misses the LED, and a FOOT glyph that is the same
graphic as a bolt highlight.

## Change list

| # | Change | Kind | Boards | File |
|---|---|---|---|---|
| **Blockers** ||||
| 1 | Role hues are grasshopper's on all seven boards | structural | kilter x2, moonboard x2 | `spike-config.ts` |
| 2 | Silhouette spurs paint the mark across the neighbouring hold | structural | kilter-homewall, tension-mirror | `scripts/spike-hold-outlines.ts` |
| 3 | The four arms differ by three variables, not one | structural | all seven | `SpikeBoardOverlay.tsx`, `spike-config.ts`, `SpikeBoard.tsx` |
| 4 | The hybrid has never rendered correctly from cold, and is smaller than the arm it is compared with | structural | all seven | `SpikeBoardOverlay.tsx`, `scripts/spike-hold-lightness.ts` |
| **Worth doing** ||||
| 5 | Drop `traced-ring` as an arm; keep the silhouette | structural | all seven | `spike-config.ts` |
| 6 | `glowSpreadWidth` is absolute board px on boards whose space differs 1.66x | tuning | moonboard x2 | `spike-config.ts`, `SpikeBoardOverlay.tsx` |
| 7 | The FOOT glyph is the same graphic as an LED | structural | grasshopper + 4 | `RoleGlyph.tsx`, `spike-config.ts` |
| 8 | The LED takeover misses the LED | tuning | grasshopper, kilter-original, moonboard x2 | `scripts/spike-led-dots.ts` |
| 9 | The glow falloff is a plateau with countable steps | tuning | all seven | `SpikeBoardOverlay.tsx`, `spike-config.ts` |
| 10 | Adjacent lit holds fuse into one envelope | tuning | kilter-homewall, tension-mirror | `SpikeBoardOverlay.tsx` |
| 11 | MoonBoard draws a second detached mark under every lit hold | structural | moonboard x2 | `SpikeBoardOverlay.tsx`, `spike-led-dots.ts` |
| 12 | The glyph is anchored on the bolt, not on the hold | tuning | all seven | `SpikeBoardOverlay.tsx` |
| 13 | Correct the record, commit the gates | process | moonboard x2 | `README.md`, `HANDOVER.md`, `__tests__/` |
| 14 | Get the branch green without `--no-verify` | process | grasshopper | `SpikeBoard.tsx`, `spike-art.ts` |
| **If there is time** ||||
| 15 | Capture the axes that have never been captured | process | all seven | `app/board-spike.tsx`, `scripts/spike/` |
| 16 | Score the arms at 400 px, the size the small surfaces use | process | all seven | `scripts/spike/capture-boards.sh` |
| 17 | Try a field-colour veil over the unlit wall | structural | 5 of 7 | `SpikeBoardOverlay.tsx` |
| 18 | Budget the renderer.rs port | process | all seven | `renderer.rs`, `renderer-version.ts` |

---

## Blockers

### 1. Four of the seven boards are painted in role colours the app does not use

`spike-config.ts:188` hardcodes one palette for every board:

```
shipped: { STARTING: '#00DD00', HAND: '#4455FF', FINISH: '#FF0000', FOOT: '#FF00FF' }
```

That is grasshopper's `displayColor` set. `packages/board-constants/src/hold-states.ts` gives Kilter
(products 1 and 7) `STARTING #00FF00, HAND #00FFFF, FINISH #FF00FF, FOOT #FFAA00` with **no**
`displayColor`, and the shipping renderer resolves `info.displayColor ?? info.color`
(`use-native-climb-render.ts:701`, `render-config.ts:65`). MoonBoard is `#44FF44 / #4444FF /
#FF3333` and has no FOOT role at all. So all eight Kilter panels and all eight MoonBoard panels are
drawn in hues those boards never light.

Three conclusions in the current write-up rest on that error:

- "HAND is the role that disappears" does not hold on Kilter. The real HAND is cyan at relative
  luminance 0.787 (14.5:1 against `#181225`) where the spike drew blue at 0.149 (3.46:1) — a 5.3x
  difference, on the two boards where the density argument is strongest.
- The "no luminance step against the art" measurement — HAND blue at 1.24:1 against Kilter
  Homewall's cream art — is a measurement of the wrong colour. Re-measure after the fix before
  proposing any luminance-step change; it may simply evaporate on those boards.
- Every CVD delta in this review is for a blue/magenta pair. Kilter's real pair is cyan/orange,
  which dichromacy separates well; Kilter's real green-vs-cyan START/HAND pair is worse.

And magenta means FOOT in all 28 panels while meaning FINISH on a real Kilter board.

**Change.** Replace `SPIKE_PALETTES.shipped` with a per-board lookup through `HOLD_STATE_MAP` +
`STATE_TO_PRIMARY_CODE` resolved as `displayColor ?? color`, the same expression `render-config.ts:65`
uses. Keep grasshopper's set as an explicit extra chip so cross-board comparisons are still possible.
Re-capture the sixteen Kilter and MoonBoard panels before scoring anything on those boards.

Related and worth writing down once: the role hex is not a design variable. `aurora.ts` builds each
LED entry as `colorSource = sanitizedOverride ?? state.color`, and the settings copy says so —
"Colour changes also light up your board (except for MoonBoards)". Any palette proposal is a change
to what the wall does, and per `CLAUDE.md` that needs a Fable review.

### 2. Every traced arm can paint a mark whose shape spans two holds

`detail__kilter-homewall-10x12__3.png`, lit STARTING 4628 at board (424,1234). At 3x across all four
panels the traced polygon is a numeral 6: a body on the lit hold plus a 37-board-px tail running
up-left along a pale sliver that carries no placement of its own. Panel 3 turns that tail into a
green bar lying across the unlit hold above it; panel 4 traces it in white and fills it. Two more
on the same board (4252 at (501,386), 4277 at (579,77)) and one on TB2 Mirror (574 at (445,763),
which reads as a capital P).

This is not the partition failing. Every emitted outline contains its own placement point and no
second one, and the largest excursion past a nearest-placement midline anywhere in the 32 lit
outlines is 0.6 board px. It is thin appendages surviving a correct partition: where a small hold's
bolt is closer to a strip of a neighbour's rim than the neighbour's own bolt is, that strip stays
4-connected to the small hold and the border follower traces it.

**Change.** In `packages/mobile/scripts/spike-hold-outlines.ts`, between the partition and
`traceBorder`, drop any part of the region reachable from the seed only through a neck narrower than
4 board px: distance-transform the local mask, flood from the seed through pixels at least 3 px from
the mask edge, keep the largest component, then dilate it back by 3 px constrained to the original
mask. Keep the raw mask if nothing survives the erosion — MoonBoard 2016 hold 148 is a 12x35 rail
and leaves only a ~6 px core.

Do **not** use a plain morphological open. Design-review S1 already ruled that out ("erode/dilate
breaks thin necks (tension-mirror)"), and TB2 Mirror is one of the two boards that need this fix.

Cost, measured over all 2,360 committed outlines: 66/499 on Kilter Homewall, 6/498 on TB2 Mirror,
1/332 on Grasshopper, 0 on the other four lose more than 20 board px². Four of Kilter Homewall's
sixteen lit holds and one of TB2 Mirror's are affected. Add it as gate 5 in `HANDOVER.md` §5, stated
on the spur measure (open by 3 px, fail anything that loses more than 20 px²), not on perimeter.

### 3. The four arms differ by three variables, not one

Four separate confounds, all in the same file, all pointing the same way.

**(a) Baseline draws no role glyph.** The `!drawsShapeGlow && !drawsTint && !drawsTracedRing &&
!drawsHybrid` branch emits a bare `<Circle>` and never calls `RoleGlyph`. Look at the lit FOOT at
grasshopper board (444,1128) across all four panels: panel 1 has a magenta LED dot and nothing else,
panels 2, 3 and 4 all carry a white glyph — and in a luminance-only render of that board the glyph is
the strongest element on the mark. `README.md` says "Role glyphs, identical in every arm"; design
review S6 says "apply the identical glyph set to every arm so the experiment measures treatments,
not glyph sets". Neither is true, and `boards/colour-vision.webp` inherits it: its two panels change
the treatment, the glyph and the casing at once.

**(b) The every-hold casing is on in arms 3 and 4 only.** `outward-glow` and `glow-tint` carry
`halos: 'all', haloPolicy: 'auto'`; `baseline` and `traced-ring` are `halos: 'none'`.
`boardWantsNeutralHalos` fires on grasshopper (0.116), tension-classic (0.062), moonboard-2016
(0.346) and masters (0.240). Measured wall-only mean luminance on grasshopper: 36.2 in panels 1 and
2, 39.3 in panels 3 and 4, with the bright-pixel share going 0.50% to 2.32%. It is visible without
measurement in an 8x crop of grasshopper board (100,980): every unlit hold carries a light contour
in panels 3 and 4 and none in 1 and 2. Separately, `haloTargets('all', ...)` returns every placement
including the lit ones, so the casing is also drawn under every lit mark — design review S5
explicitly forbade that.

**(c) The LED takeover is in all four arms.** The LED `<G>` sits outside every selector conditional,
so the panel captioned "Baseline (ships today)" carries 234 dark discs on grasshopper's unlit holds
and a saturated role-coloured dot at the centre of every lit hold. `renderer.rs` draws neither.

**(d) The baseline stroke is 35% too heavy on six boards.** `strokeWidth: 6 * 1.35` hardcodes
grasshopper's board multiplier, and its own comment says so. `getBoardStrokeWidthMultiplier` returns
1.0 for kilter, tension and moonboard, so the control ring is 8.1 board px where the app draws 6.0
on six of seven boards.

**Change.** Gate the LED `<G>` and the casing group on the selector. Set `halos: 'none'` on
`outward-glow` and `glow-tint` and keep the casing as its own chip. Add `<RoleGlyph>` to the ring
branch — its `clipId` is already optional and the fallback branch at line 297 already does exactly
this. Make `strokeWidth` per-board via `getBoardStrokeWidthMultiplier(board.boardName)`. And fix the
chip, which is currently one-way: `resolveHalos` returns `treatment.halos` and exits before reading
`halosOverride` whenever `haloPolicy` is `'never'`, so "Halos: on" can subtract the casing from arms
3 and 4 and can never add it to 1 and 2.

### 4. The hybrid has never rendered correctly from a cold start, and it is smaller than the arm it is compared with

**(a) A dangling clip reference.** `SpikeBoardOverlay.tsx:172` emits the `spike-outside-<id>`
ClipPath only under `outwardOnly` (which is `selector === 'shape-glow-out'`), but line 345 in the
`drawsHybrid` branch renders `<G clipPath="url(#spike-outside-${hold.id})">`. On Android,
react-native-svg 15.15.5 keeps `mDefinedClipPaths` in a HashMap that is only ever `put()` and
`get()`, never cleared (`SvgView.java`), and `capture-boards.sh:20` renders `outward-glow`
immediately before `glow-tint` on the same SvgView. The captures are clean because the previous arm
left the definition behind. Deep-link straight to `?treatment=glow-tint` and the twelve glow bands
draw centred and unclipped: a cumulative-alpha-1.0 role-colour annulus 8 board px wide inside every
silhouette, which is most of a grasshopper hold.

**(b) The glow bands drop `smallHoldBoost`.** Line 353 strokes them at `band.width * 2`; the plain
glow at line 445 strokes at `band.width * scale * smallHoldBoost`. So wherever the size floor fires
the hybrid's glow is up to 1.7x narrower than the arm it is being compared with — 2 of 16 lit holds
on kilter-original, 4 on tension-mirror, 6 of 10 on moonboard-2016. Visible side by side on Tension
Original hold 269 at board (270,1575): panel 3's halo is plainly wider than panel 4's, same hold,
same capture. (`smallHoldBoost` is already computed above the `if (drawsHybrid)` branch; nothing
needs moving.)

**(c) The lightness table carries a zero sentinel and measures the wrong region.**
`scripts/spike-hold-lightness.ts` samples the 0.85r–1.15r annulus — the band the *ring* is drawn in,
mostly outside the hold — and ends `weight === 0 ? 0` when no art falls in it. The `drawsHybrid`
branch reads that table as "the art under this hold" and derives `normaliseOpacity` from it. Zeros
in the committed table: 45 of 303 on tension-classic, 94 of 198 on each MoonBoard, 19 on
tension-mirror, 13 on kilter-original, 4 on grasshopper. `?? tintNormaliseTarget` does not catch it
because 0 is not nullish, so the normalise pass paints white at α0.588. Tension Original 269 and 270
are the result: in panel 4 they are pale pink blobs with the olive washer gone, against panel 3
where the washer is fully legible.

**Change.** Emit the clips under `(outwardOnly || drawsHybrid)` and board-scope the ids
(`spike-outside-<boardKey>-<id>`; placement ids repeat across boards and the map is never cleared).
Apply `smallHoldBoost` at line 353. Add a second lightness table measured inside the traced
silhouette and have the hybrid read that one, leaving the annulus table for the ring casing at line
272 — that is what it was measured for. Then re-capture arm 4; nothing about the hybrid's ranking is
currently knowable.

---

## Worth doing

### 5. Drop `traced-ring` as an arm; keep the silhouette

At ~300 px per panel it is last on all seven boards. The mechanism is visible at 4x: `strokeWidth`
is 8.1 board px times `smallHoldBoost` (up to 1.7), centred on the path, so on a hold narrower than
about 26 board px the stroke closes the shape completely.

| Board | Lit holds ≥79% covered by their own stroke | Worst case |
|---|---|---|
| moonboard-2016 | 6 of 10 | hold 26, 17x16 hold, 12.5 px stroke, 100% |
| moonboard-masters-2019 | 4 of 10 | hold 27, 96% |
| tension-mirror-12x12 | 2 of 16 | hold 612, 19x14, 12.2 px stroke, 99% |
| kilter-original-12x12 | 2 of 16 | hold 1477, 18x17, 12.2 px stroke, 100% |
| tension-classic | 2 of 16 | holds 269/270, 25x25, 13.1 px stroke |

Tension Original 269 at board (270,1575) is the clearest single frame: panel 1 shows an olive washer
inside a ring, panel 2 shows a solid magenta disc. MoonBoard 2016 hold 26 at board (241,835) is the
same story with a gold chip. The arm also reintroduces the failure that got plain whole-hold tint
cut: on grasshopper a filled blue hold-shaped blob sits on a wall carrying ten filled cyan
hold-shaped blobs of the same size, which is exactly what `README.md` gives as the reason plain tint
lost.

What dropping it costs, and this belongs on the record: `traced-ring` is the only arm that keeps 16
separate coloured regions for 16 lit holds on Kilter Homewall and TB2 Mirror — baseline, glow and
hybrid all fuse the same HAND/FOOT pairs — and at 1:1 it is the clearest arm about *which* hold is
lit. It loses on findability, which is what #2202 is about, not on identity.

**Change.** Remove `traced-ring` from the captured arm set in `spike-config.ts`. Keep
`SPIKE_HOLD_OUTLINES`: the silhouette is the glow's path, the hybrid's fill boundary and
inside-clipped edge, and the glyph's clip. If a silhouette-alone control is wanted later it needs the
stroke inside-clipped to `spike-inside-<id>` at 2x the visible width (design review item 5 specified
exactly this and it was implemented only on the hybrid's tint band) and a per-board width — but that
is a different arm and a different capture.

### 6. `glowSpreadWidth` is one absolute constant on boards whose coordinate space differs 1.66x

MoonBoard's art box is 650 board px wide; the other five boards here are 1080, and both are
width-fit to the same screen (`SpikeBoard.tsx` sizes the board `width: '100%'` with an aspect ratio).
So `glowSpreadWidth: 21` renders 35 device px on MoonBoard against 21 elsewhere. Compounded with
`smallHoldBoost`, which fires on 6 of 10 lit MoonBoard 2016 holds, the outward reach runs 34.9–53.9
device px on MoonBoard against 21.0–25.1 on grasshopper.

The consequence is not just size. Past roughly 1.5x the hold's own width the glow stops tracing the
silhouette and reads as a plain disc: in `whole__moonboard-2016.png` panel 3, hold 26 is a ~24
board-px chip inside a round green disc with countable concentric arcs, while hold 40 in the same
panel (boost 1.00) still traces its hold. One climb, two different marks, 250 px apart.

**Change.** Express the glow in units the boards share. `glowSpreadWidth` and `glowCoreWidth` become
fractions of the placement radius — `21 / 49.09 = 0.43 r` and `8 / 49.09 = 0.163 r` reproduce
grasshopper byte-for-byte — computed in `SpikeBoardOverlay.tsx` next to `glyphLineWidth`. MoonBoard
then gets 12.5 board px (20.8 device px) instead of 21 (34.9). Cap the result at about 1.2x the
hold's own short extent so the glow keeps its shape on the smallest holds.

Same treatment for the other absolute constants in that block: `strokeWidth`, `tintBandWidth`,
`tintOuterEdgeWidth`, `casingDarkWidth`, `casingLightWidth`, `haloStrokeWidth`. The block's header
comment claims they are "all as fractions of the placement radius" and most of them are not — fix the
comment too, because it is a trap for whoever does the port. Note that `renderer.rs:150` computes
`stroke_width = 6.0 * scale_x * multiplier`, the same absolute board-pixel convention, so this is not
a spike-only defect.

### 7. The FOOT glyph is the same graphic as an LED

The single most decisive frame in the set is grasshopper's lit FOOT at board (444,1128) across all
four panels. Panel 1 draws the magenta LED dot and no glyph. Panels 2, 3 and 4 replace it with a
white dot in a dark socket — and each of the four unlit holds in the same crop carries a white
crescent in a dark socket of the same size. The mark that says "this is a foot" is the mark the wall
already draws on every hold.

The geometry: `RoleGlyph.tsx` draws FOOT as `<Circle r={pass.width / 2}>`, so its white core is a
disc whose diameter is the line width (5.40 board px on grasshopper, 22.9 px²), while HAND, START
and FINISH are lines of that same width spanning `2 x reach` (reach = 1.6 x placement radius),
clipped to the silhouette — about 270 px² for a HAND bar on a 50 px hold. Measured white-core ink per
mark in the outward-glow panel: kilter-original FOOT 4 px against HAND 68; tension-mirror 5 against
69; tension-classic 16 against 265; grasshopper 31 against 224; kilter-homewall 63 against 250. On
kilter-original the FOOT glyph is a 2x2 block at capture resolution.

This is not a polish item. Under correctly computed Viénot protanopia (matrix applied in linear RGB,
which `build-figures.mjs` already does) HAND and FOOT are dE00 3.2 apart — Machado agrees at 3.8 —
so the glyph is the *only* channel separating those two roles for a protanope, and the one carrying
it is a 2–5 px pip. In the protan glow panel of `colour-vision.webp` the two STARTs and one HAND read
by their bars; four blue glows carry nothing but a pip and are identified by the absence of a bar.

**Change.** Two halves, in this order. First fix the LED (change 8) so the wall stops drawing
FOOT-shaped marks. Then in `RoleGlyph.tsx` give FOOT a shape sized off `reach` rather than off
`pass.width` — a ring or a filled square at the same line width — targeting ink within about 2x of a
bar rather than 1/10. Not a short cross: a plus is the START bar and the HAND bar drawn together,
which is the exact reading `README.md` rejected when it chose an X for FINISH.

While in that file: the glyph casing is `0.11 x 1.9 = 0.209 r` wide against an LED disc of `0.200 r`,
concentric and drawn after, so on the five boards with `ledOffsetY: 0` the lit LED is 80% covered by
whatever glyph sits on it, for every role. Either drop the lit LED on those boards or accept it is
decorative. Do not draw it after the glyph: that punches a role-coloured hole through the middle of
the HAND bar.

### 8. The LED takeover misses the LED

On grasshopper, `ledDotRadiusFraction: 0.1` gives a 4.91 board-px radius drawn at the placement
centre. The art's bright blob has a radius of 4.21 board px (p90 4.33), so it fits inside the dot —
but its centroid sits a median 2.15 board px away from the placement (p90 3.69, max 6.20). Result:
190 of 316 unlit placements keep a pixel above luma 200 within 8 board px of centre, 165 above 230,
2,320 pixels board-wide, identical in all four arms. Visible in the 8x crop of board (100,980) as a
dark disc with a bright crescent on it.

In fairness the layer mostly works — it removes 79% of the board's near-white pixels (12,403 in the
art, 2,572 in the capture) and lowers local contrast around a flagged hold from 240.8 to 223.2. It is
about 20% short, and that 20% is what collides with the FOOT glyph.

**Change.** Emit the blob's centroid per placement from `scripts/spike-led-dots.ts` (flood-fill from
the brightest pixel within 4 board px, threshold linear luma 0.5) and draw at that point. Leave the
radius at `0.10 r`: a per-hold radius is not needed, and the 0.165 that would cover p90 puts a 16
board-px near-black disc on 222 holds, which is a louder artefact than the crescent.

Two more defects in the same generator:

- MoonBoard measures at the wrong point. `spike-led-dots.ts` samples `sampleDisc(hold.cx, hold.cy, 3)`
  at the placement centre while the overlay draws at `cy + ledOffsetY` = 25 board px below. 23 of 23
  flagged placements on moonboard-2016 and 12 of 13 on masters have zero opaque art where the dot is
  actually drawn, so it covers nothing and adds 21 and 12 black specks to bare play field — visible
  in `detail__moonboard-2016__2.png` panel 1 around (314,354). Sample at `(cx, cy + ledOffsetY)`;
  expect `brightInArt` to go to zero on both, at which point the dot correctly stops being drawn.
- `BRIGHT_RATIO` has no absolute floor. Kilter Original's 10 flags are mid-grey bolt holes at linear
  luma 0.26–0.43 whose centre/surround ratios (2.52–3.41) sit on a continuum with the unflagged ones
  (2.38–2.44), against grasshopper's real LEDs at 0.60–0.99. Require the centre above about 0.6
  linear luma as well as 2.5x the annulus. That drops Kilter Original's 10 and MoonBoard's 23/13 to
  zero and leaves grasshopper's 234 intact.

### 9. The glow falloff is a plateau with countable steps

Compositing the twelve bands (`0.95 * (0.06 + 0.94 * p²)`, widths 21 down to 8) gives cumulative
alpha 1.000 out to 8 board px, 0.972 at 10, 0.826 at 12, 0.558 at 14, 0.194 at 18 and 0.057 at 21 —
full alpha to `d/B = 0.38` where design review item 6 asked for 0.42 at `d/B = 0.40`. A device ray
confirms it: `detail__tension-mirror-12x12__2.png`, up column x=1401 from lit FOOT 612, reads
(255,0,255) at dy = 12, 15, 18 and 21, then 248, 224, 184, 119, 77, 49, and field at 42.

And twelve bands is not smooth at these widths. `whole__moonboard-2016.png` at y=1490, walking out
from x=2637, gives green plateaus 2–3 px wide at 185, 181, 159, 153, 130, 124, 101, 97, 76, 74, 57,
42, 30 — steps of up to 13% of the peak across 3 px — and the arcs are countable in a 3.4x crop of
hold 26. `spike-config.ts` claims "four bands showed visible rings; twelve on a squared falloff reads
as a smooth fade"; at MoonBoard's rendered width it does not.

**Change.** Solve the per-band alphas from a target *cumulative* curve instead of setting each band's
own alpha. Stops as a fraction of extent: `0.00 -> 1.00, 0.15 -> 0.90, 0.40 -> 0.42, 0.70 -> 0.13,
1.00 -> 0.00`, with `a_k = 1 - (1 - A(w_k)) / (1 - A(w_{k-1}))`. Pin the plateau bands at 1.0
explicitly — the recursion divides by zero wherever the target is 1.0 — and start the solve at the
first stop below 1. The 8 board-px plateau is `glowCoreWidth`, so trimming it means moving that
constant, not just the ramp. Raise `glowBandCount` where the rendered step would exceed about 1.5
device px rather than lowering it; six bands doubles a step that is already visible.

Do not replace this with a blur. `FeGaussianBlur` paints the filter region as a solid rectangle of
the stroke colour in react-native-svg 15.15.5 on Android.

### 10. Adjacent lit holds fuse into one envelope

On Kilter Homewall, HAND 4294 (617,887) and FOOT 4317 (656,926) are 14.5 board px apart
silhouette-to-silhouette against a combined 42 px reach, and their envelopes merge. Same for TB2
Mirror 439/447 (19.5 px) and 343/574 (26.4 px).

Adjudicated against two lenses that overstated it. In a 3x crop of the Kilter Homewall pair, panel 1
shows the two baseline rings intersecting as a figure-eight — baseline fuses the same pair — and in
panels 3 and 4 the blue and magenta stay separate hues with a hard 1–2 px boundary, not a purple
blend. Connected-component counts agree: Kilter Homewall gives 15 / 16 / 15 / 15 regions for 16 lit
holds across baseline / traced / glow / hybrid, TB2 Mirror 14 / 16 / 14 / 14. Only the traced arm
keeps them apart, and Kilter Original is not an instance at all — its nearest lit pair is 84.9 board
px apart and its glow panel resolves into 16 separate blobs. So this is real, it is no worse than
what ships, and both roles remain readable.

**Change.** Cap the extent at 0.45 x the distance to the nearest **lit** silhouette, floored at 8
board px. The lit set is known at render time, so this needs no bake-time data and no new primitive.
On 4294/4317 that gives 6.5 px each, which is under the floor, so on that one pair the honest fix is
a 2 board-px field-coloured gap on the facing side rather than shrinking both.

Do **not** clip each glow to its nearest-placement Voronoi cell. Kilter Homewall's median gutter is
3.6 board px, so the midline sits about 1.8 px off the silhouette and a cell clip leaves a 2 px rim —
which is approximately the traced arm, the panel that visibly loses at glance zoom on that exact
board. And the thing the cell clip was proposed to fix does not need fixing: measured over the unlit
holds' own art pixels, the glow buries *less* neighbouring art than the baseline circle does (2.67%
against 2.84% on Kilter Homewall, 1.64% against 2.26% on TB2 Mirror).

### 11. MoonBoard draws a second detached mark under every lit hold

`SPIKE_LED_DOTS['moonboard-*'].ledOffsetY` is 25 board px and the dot radius is 2.9, so a
role-coloured dot lands 25 px below a hold whose silhouette reaches at most 25 px in any direction.
Component counts at ≥60 px: moonboard-2016 gives 18 coloured objects for 10 lit holds in the traced
panel, masters 21 for 10. The glow arms absorb it and the baseline ring encloses it, but the dot is
still separately visible in the hold-26 crop in all of panels 2, 3 and 4. On a board where an empty
grid cell is the normal case, a saturated role-coloured dot sitting in a gap reads as a light on a
hold that is not there.

**Change.** Draw the LED inside the same clip and glow group as its hold, with a 2 board-px stem from
the silhouette edge to the dot (a stroked segment, which `renderer.rs` already does via
`stroke_path`), or drop the lit LED on MoonBoard entirely — the mark already carries role. Also note
in `README.md` that the downward direction is an assumption: `led-placements-data.ts` has
`moonboard: {}`, so nothing in the data confirms the sign.

### 12. The glyph is anchored on the bolt, not on the hold

`RoleGlyph` is called with `cx={hold.cx} cy={hold.cy}` in all four branches — the placement, never
the silhouette. Offsets between each lit hold's bbox centre and its placement: masters 194
(+6.5, −9.0) on a 29x40 hold, Kilter Homewall 4538 (0, +9.0) on 44x36, 4331 (−8.0, +2.0), TB2 Mirror
439 (−9.0, −1.5) on 32x39, grasshopper 397 (−8.5, −3.0). Across the boards the placement sits a
median 5–11% off the bbox centre, p90 10–21%, and 19 of 476 Kilter Original and 11 of 499 Kilter
Homewall placements fall outside the middle half of their own silhouette.

Because the bars are clipped to the silhouette, an off-centre anchor changes the glyph's rendered
*shape*, not just its position. On the MoonBoard 2016 12x35 rail the HAND bar is shoved hard against
the left edge with the whole right half of the photograph surviving; the same vocabulary on the next
hold draws a centred bar. A fixed vocabulary cannot afford that. The masters FINISH at (391,85) is
the visible case: the X sits in the lower-left lobe of a donut hold with one arm crossing off the art.

**Change.** Compute the silhouette's bbox centre once per lit hold — `outlineExtent` already walks
the same points — and pass that to `RoleGlyph`. Keep the placement centre only for the ring fallback,
where it is the only anchor available.

### 13. Correct the record, and commit the gates

Four documented facts no longer match the code, and all four sit in the sections a porter would read
as the spec.

- `README.md` says the tracer produces 159/198 on MoonBoard 2016 and 143/198 on Masters. The
  committed table has **140 and 112**. The deltas, 19 and 31, are exactly the neighbour-leak counts
  the README's own defect table reports as fixed, so the published number is from the pre-fix run.
  That number is what `HANDOVER.md` §5 check 4 is measured against, so the check currently fires on
  nothing.
- `README.md` says the glyph is "sized on the hold's shortest axis". `outlineExtent`'s `'shortest'`
  branch is never called from anywhere, and `spike-config.ts` says the width is "deliberately NOT
  scaled by the hold it sits on". The two documents contradict each other; the config is right.
- `README.md` says "below 0.45 x placement diameter the baseline ring is now drawn as well". The code
  replaced that with the size boost, and its own comment says drawing both "reads as two marks
  disagreeing about where the hold is". The same paragraph's "5/10 on MoonBoard 2016" is 6/10 today.
- `outlineHaloStrokeWidth`, `outlineHaloOpacity` and `outlineHaloDarkOpacity` carry a fourteen-line
  rationale in `spike-config.ts` and are referenced nowhere in the repo; the every-hold outline draws
  from `casingDarkWidth` / `casingLightWidth`.

**Change.** Correct all four, delete the three dead constants and move their rationale onto the
casing widths, and have `spike-hold-outlines.ts` write its per-board traced and rejected counts into
a comment at the top of the generated file so the numbers cannot drift again. Then commit design
review §5 gates 1–4 as a vitest next to `spike-shapes.test.ts` — they run against the committed table
in a couple of seconds. Add change 2's spur check as gate 5 and the connected-component count as gate
6, run on **all four arms**: expect gate 6 to fail on baseline, glow and hybrid on TB2 Mirror and
Kilter Homewall, which is the honest state rather than a regression.

### 14. Get the branch green without `--no-verify`

`check:mobile-board-art-network` has exactly two violations, both `svg-image-background` in
`SpikeBoard.tsx` — line 3 (the `Image as SvgImage` import) and line 157 (the `<SvgImage>` art layer).
Those layers exist only so the Desat `FeColorMatrix` can act on the art and so the OkLab-stretched
siblings can be swapped in. Neither the `art` axis nor the `desaturate` axis is part of any of the
four arms, and neither appears in any of the 28 captures.

`README.md` frames this as a standoff and says real support means "either a build step over every
board's art, or doing the stretch on-device". The build step already ships:
`scripts/generate-dark-board-art.ts` writes committed `.dark.webp` siblings, has a `--check` CI mode
and a golden test, and `background-image-cache.ts` prefers the sibling when one is bundled and falls
through unchanged when it is not. A contrast variant is a second suffix in that pipeline, not a new
asset directory plus an SVG image layer.

**Change.** Delete the `art` and `desaturate` axes, `spike-art.ts`, `packages/mobile/assets/spike/`
(10 files, 920 KB) and `packages/mobile/.tmp3/` (68 lines of tracked scratch). Render the board art
through expo-image and keep react-native-svg for the overlay only. Gate `app/board-spike.tsx` on
`__DEV__ || profile?.isTester`, the way `app/(tabs)/profile/more.tsx` gates its dev panel. That is a
standalone PR that lands green with no `--no-verify`.

---

## If there is time

### 15. Capture the axes that have never been captured

`app/board-spike.tsx` reads only `{ board, treatment }` from the deep link; field, palette, art,
desat and the halo override are `useState` with no param sync, and `capture-boards.sh` only varies
board and treatment. `build-figures.mjs` then hard-codes `FIELD = [0x18, 0x12, 0x25]` and throws if
the board rect is not that colour, so even a hand-driven capture on another field cannot be cropped.
Every one of the 28 panels is the same axis combination.

The field axis is not optional. #2202 says "like #1449 but worse", and #1449's entire body is "Should
add grey background or something similar" — the reporter's own suggested fix is a chip in this spike
and is in none of the images. It matters arithmetically: HAND's contrast against the field falls from
3.46:1 on `#181225` to 2.16:1 on the grey chip and 1.43:1 on plywood, and an outward glow is a
light-on-dark effect.

**Change.** Extend the param type to `{ board, treatment, field, palette, art, desat, halos }` and
sync them the way board and treatment already are; make `FIELD` a CLI argument of
`build-figures.mjs`. Then capture at minimum `{field, grey} x {baseline, outward-glow}` on
grasshopper and moonboard-2016, and add one fixture climb per MoonBoard that deliberately lights an
untraced cell so the ring fallback appears in exactly one capture and can be judged. Keep the
eligibility filter for the normal captures — `HANDOVER.md` §7 requires it and the captures are honest
with it.

### 16. Score the arms at 400 px

Every judgement here is at 1080 px, which is the largest size the app ever uses. The same overlay
ships at `renderWidth 400` in `ClimbListThumbnail` (displayed at 76x96 dp) and 384 in the Live
Activity. Downsampling `whole__grasshopper-master.png` and counting role-coloured pixels
(max channel ≥ 90, chroma ≥ 70) per panel, baseline / traced / glow / hybrid:

| Panel width | Baseline | Traced | Glow | Hybrid | Glow vs baseline |
|---|---|---|---|---|---|
| 1080 px (capture) | 51,479 | 31,893 | 59,690 | 72,760 | +16% |
| 228 px (76 dp at 3x) | 2,531 | 1,550 | 2,762 | 3,323 | +9% |
| 152 px (76 dp at 2x) | 1,247 | 737 | 1,250 | 1,479 | +0.2% |

The glow's margin over baseline is a function of render size and is gone by 152 px. The hybrid keeps
a +19% lead at every size, which is the one place its fill earns something the glow cannot. The app
has already answered the hollow-versus-filled question for those surfaces the same way:
`thumbnail: filledStyle` switches `renderer.rs` to an 8.0 base stroke plus a 0.3-alpha fill "so lit
holds read as solid dots once scaled".

**Change.** Add a second capture row per board at `renderWidth 400` displayed at 76x96 dp and score
the arms there too. Whichever arm wins needs its own small-surface branch next to the existing
`if config.thumbnail`.

### 17. Try a field-colour veil over the unlit wall

Nobody built the obvious counterpart to every arm here. All four are additive: they spend ink on the
roughly 3% of the board that is lit and leave the rest alone, and on four boards arms 3 and 4 make
the wall *brighter*. Simulated at α0.45 over `whole__kilter-homewall-10x12.png` panel 3 (leaving
pixels with chroma > 55 alone), the wall's mean Rec.709 luminance falls 79.1 to 52.8 and the sixteen
marks visibly gain; TB2 Mirror falls 66.5 to 45.9.

It is one element: `<Path fillRule="evenodd" fill={playFieldColor} fillOpacity={veilOpacity}
d={boardRect + ' ' + litSilhouettePaths.join(' ')} />` as the first child of the overlay SVG. Even-odd
makes each lit silhouette a hole, so no `<Mask>`, no `<Filter>` and no `<Image href>` — the guard
stays clear — and in `renderer.rs` it is one even-odd filled path, cheaper than the every-hold casing
it would replace (664 stroked paths on grasshopper). `SpikeBoard.tsx` does not pass `backgroundColor`
down today; it would have to.

Bucket `veilOpacity` on the mean over **all** placements, not the non-zero ones (94 of each
MoonBoard's 198 entries are the zero sentinel): 0.45 for TB2 Mirror 0.713, Kilter Homewall 0.626 and
Tension Original 0.563; 0.30 for Kilter Original 0.511 and grasshopper 0.411; 0 for both MoonBoards
(0.301 / 0.337), where half the cells are already bare field and there is no wall to quiet.

### 18. Budget the `renderer.rs` port

Whichever arm wins reaches a user only through Rust. `BoardImageNative` hands `useNativeClimbRender`'s
output to `LayeredClimbImage` as an expo-image `<Image source={{uri}}>`, and
`board-renderer/BoardHoldOverlay.tsx` — the react-native-svg marker path the spike's baseline
imitates — is imported by nothing outside its own barrel. So the port is a native release, not an
OTA, and three artifacts move together: the iOS and Android binaries, the committed
`packages/board-renderer/wasm/pkg/board_renderer_wasm_bg.wasm` (473 KB, loaded by the backend OG
service), and `RENDERER_VERSION` (currently 6; the cache key hashes the climb, not the drawing, so
without a bump every user keeps the stale PNG). Old binaries ignore unknown `RenderConfig` fields —
`#[serde(default)]`, no `deny_unknown_fields` — and silently draw the baseline, so the new work needs
a new bridged method name that the shim falls through on, the way `renderHoldsOverlayWithMarkers`
already does. None of that is in `README.md`'s "what would have to change" list, which stops at the
port itself.

Two shape constraints worth deciding now rather than in review: the silhouette table is 238 KB for 7
of about 53 board configs (roughly 1.8 MB extrapolated) in one eagerly-imported flat record, where
`board-constants` already shards hole placements per board and loads them lazily; and the lookup has
to key on `mirrored_hold_id`, because `renderer.rs` swaps to it for coordinates and a mirrored climb
would otherwise trace the wrong shapes.

---

## Leave alone

1. **The role palette.** `equalL` looks like the fix and is not. Computed correctly — both Viénot
   1999 and Machado 2009 applied in linear RGB, which `build-figures.mjs` already does — it fixes
   protan HAND/FOOT (dE00 3.2 to 16.5) and creates three worse collisions: deutan HAND/FOOT 1.3
   (shipped 20.6), deutan STARTING/FINISH 4.7 (shipped 12.6), tritan STARTING/HAND 3.3 (shipped
   24.7). Keep the shipped hues and carry CVD on the glyph, which is what design review S6 said.
   (Any earlier claim that the two models disagree came from applying a linear-light matrix to
   gamma-encoded sRGB; they agree.)
2. **The nearest-placement partition.** Re-run against the committed table it is clean: 0 of 2,360
   outlines fail "contains its own placement", 0 contain a second, 0 have more than 10% of perimeter
   on the search-box edge. Change 2 is trimming thin appendages off a correct partition, and should
   be described that way.
3. **The 2.2x-median area backstop.** Do not re-add it. It deleted 14 real grasshopper holds to catch
   nothing, and every defect found this round is thin, not large.
4. **`ALPHA_FLOOR` and the erosion direction.** The emitted polygon already sits *inside* the art — a
   median 9% of each hold's alpha≥96 mask falls outside it on grasshopper and Tension Original, 13%
   on the MoonBoards, 20% on TB2 Mirror, 35% on Kilter Homewall — so eroding the mask or raising the
   floor pushes the systematic error the wrong way.
5. **`smallHoldBoost` in the glow.** It is the only thing keeping a mark on TB2 Mirror's 19x14 chip
   above the 64 board-px ring baseline draws there, and `README.md` records that unboosted tracing
   lost to baseline once already. Fix the asymmetry between the two glow arms (change 4b); do not
   delete it. Do not feed it the *shortest* axis either: `boost = sizeFloor / extent`, so the short
   axis would widen the stroke on exactly the thin rails it is meant to protect.
6. **The twelve-stroke glow mechanism.** `FeGaussianBlur` paints the filter region as a solid
   rectangle of the stroke colour in react-native-svg 15.15.5 on Android. And do not replace the
   silhouette-clipped glow with a placement-centred radial gradient: the hard inner step where the
   glow stops on the hold's own edge is the arm, and no circular or bbox-elliptical gradient
   reproduces it (median silhouette rmax/rmin about the placement centre is 1.74–2.00, p90 3.18–3.24
   on the MoonBoards).
7. **Lighten or Plus for glow overlaps.** `Lighten(#FF0000, #4455FF) = #FF55FF`, which is the FOOT
   magenta — a wrong-role colour, not a soft one.
8. **A Voronoi cell clip on Kilter Homewall.** See change 10: at a 3.6 board-px median gutter it
   leaves a 2 px rim, which is approximately the arm being dropped.
9. **The eligibility filter on the synthesised climb.** `HANDOVER.md` §7 requires it and the captures
   are honest with it. Add a deliberate fallback fixture instead (change 15).
10. **The 0.85r–1.15r annulus lightness table.** It is the right measurement for the ring casing at
    `SpikeBoardOverlay.tsx:272`. Add a second table for the hybrid; do not repoint both at one
    number.

---

## What we still do not know

1. **Whether any of this helps a climber.** There is no user data of any kind. Design review §5's
   telemetry — pinch events per climb view, time from climb open to first queue or BLE action,
   same-climb re-open rate within a session, all stratified by board and layout and never pooled — is
   the only thing that answers #2202, and none of it exists.
2. **iOS.** Only the Android emulator has been exercised. The leaking clip map behind change 4a is
   specifically an Android implementation detail of react-native-svg; what that dangling reference
   does on iOS is unknown, and it may be the difference between "the hybrid looks fine" and "the
   hybrid paints the hold solid".
3. **The grey and plywood play fields.** Never captured, and the arithmetic says they are the hard
   case. This is the reporter's own suggested fix and it is in none of the 28 images.
4. **The small surfaces.** The 400 px list thumbnail and the 384 px Live Activity have never been
   rendered with any of these arms, and the downsample says the glow's lead over baseline is gone by
   152 px.
5. **The ring fallback.** Unreachable in every capture. On Masters 2019, 86 of 198 placements have no
   silhouette — those cells are genuinely empty on the synthetic grid, but the first board outside
   these seven whose art the tracer cannot read is the first time anyone will see that branch. Its
   geometry is untested too: the fallback ring is 2.0–2.6x the diameter of a traced mark on the same
   board, and its `RoleGlyph` is called with `reach={hold.radius}` and no `clipId`, against
   `hold.radius * 1.6` with a clip everywhere else.
6. **Real climbs.** Every capture is one synthesised 16-hold climb per board, built from the same
   relative coordinates. The fallback rate, the lit-hold density and the role mix on real catalogue
   climbs are all unmeasured — and the role mix is what decides how much the FOOT glyph matters (it
   is 6 of 16 here).
7. **User marker settings.** The app ships six per-role marker shapes, a 0.5–2.0 shape-size slider, a
   0.5–2.0 brush-thickness slider and a free-hex per-role colour override, none of which the spike
   reads. Nobody has decided what a traced arm does to a user who set "diamond at size 2.0": the
   silhouette *is* the shape, so that setting has no meaning in three of the four arms.
8. **Render cost.** Whole-board painted-element counts are roughly 255 for baseline, 289 for traced,
   1,129 for the glow and 1,193 for the hybrid on grasshopper. Design review estimated "four to six
   paths per lit hold plus a clip", a 3x undercount. Nothing has been measured on a mid-tier Android
   device or in `renderer.rs`.
9. **Whether the role hex can move at all.** It is what the app streams to the wall's LEDs. The
   hybrid's α0.55 fill already desynchronises the screen from the wall by 15–25% in value, and any
   palette change is a change to what the hardware does.
10. **Whether the every-hold casing helps.** It has never been captured on the three boards where it
    is off, and never captured off on the four where it is on. The only thing measured about it is
    that it lifts grasshopper's unlit wall by 8%.
