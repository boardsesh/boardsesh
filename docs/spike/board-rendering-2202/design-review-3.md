# Third design pass (issue #2202)

Reviewed against a fresh set of device captures taken off a real Android device at 1080x2400 at
HEAD (`7179ffa07`): seven boards x four arms, 28 whole-board panels plus 21 native-pixel detail
tiles, and the Viénot dichromat figure. Thirteen lenses plus a completeness critic went over them —
arm verdict, the never-reviewed veil arm, the per-board palettes, glance findability, the role
glyphs, the LED layer, density and fusion, small holds, hold identity, CVD and luminance,
cross-board consistency, renderer cost, and one lens asked only what nobody had captured. Every
finding was then re-measured by an adversarial verifier against the same images and the same code.
103 findings went in. One was refuted outright (the claim that `build-figures.mjs` uses a broken
Viénot matrix — it is canonical Viénot 1999, derived from scratch to within 8e-6), and roughly
three quarters came out revised, almost always because the mechanism was right and the number was
not. What survives dedupes to the seven changes below, nine deferred findings and nine things to
leave alone. Severity of the deduped set: one blocker, four major, eleven minor.

## The verdict

**Veil + glow wins, and it wins by turning the wall down rather than by adding ink.** Measured over
each panel's unlit hold art with the marks and the bare field masked out, arms 1, 2 and 3 leave the
wall where they found it — 95th-percentile luminance 209 / 209 / 209 on Kilter Homewall, 213 / 213 /
213 on Tension Original, 186 / 186 / 186 on TB2 Mirror, and means within 1.3 of each other — while
the veil takes those p95s to 126, 129 and 113 and does not change one pixel of the mark, so the whole
40% goes to mark-against-wall. It reads that
way at every size I looked at: at 1:1 in `detail__kilter-homewall-10x12__3.png` and at 300 px per
panel (the zoom a climber reads a board at) the veil panel is the only one of the four where sixteen
marks are the brightest objects on the board rather than sixteen things to hunt out of 499 cream
photographs. The runner-up is **Glow + tint**, not Outward glow: at 300 px its filled marks beat the
plain glow on every pale dense board, which is a change from the second pass's ranking. It loses
because it buys that by repainting the hold — about a third of the art's own luminance modelling
survives the α0.55 fill, the spread between lit holds collapses (interior luminance sd 14.4 to 2.3
on Tension Original), and on Grasshopper a filled blue hold is the same class of object as the ten
saturated cyan holds the wall already paints, which is the collision that killed plain whole-hold
tint two passes ago. Outward glow drops to third: it is what Veil + glow degrades to when the veil is
zero, and on its own it never moves the thing the mark has to compete with.

**Drop `glow-tint` as a captured arm and put `veil-tint` in its place.** Its result is known and it
is second; what is not known, and is the only open arm question left, is whether the fill still earns
anything once the wall is quiet. Keep `baseline` as the control and `outward-glow` as the veil's own
control — it is the measurement of what the veil buys.

## The one remaining pass

### 1. `veilOpacityFor` averages in a sentinel, so the winning arm is off on the two loudest walls

`SpikeBoardOverlay.tsx:114-121` means `SPIKE_HOLD_ART_LIGHTNESS` over every placement including the
0 sentinel. 94 of each MoonBoard's 198 entries are that sentinel, which drags the mean to 0.301 and
0.337, under `veilDimWallLightness` 0.375, and the arm returns 0. Panel 4 of
`whole__moonboard-2016.png` and `whole__moonboard-masters-2019.png` is therefore the outward-glow
panel republished: below the caption band the two differ by **0 channel samples of 5.4 million** on
both boards. The comment's justification is arithmetically empty — the veil is a fill of
`playFieldColor`, so over a bare cell it composites the field onto the field and changes nothing;
those zeros measure how empty the grid is, not how bright the wall is.

**Change.** Filter the zeros before the mean, and cap the result at `veilSoftOpacity` where fewer
than 60% of a board's placements carry a reading. Both MoonBoards go 0 to **0.30**; nothing else
moves (grasshopper 0.411 to 0.416, kilter-original 0.511 to 0.525, tension-classic 0.563 to 0.661,
tension-mirror 0.713 to 0.741, kilter-homewall unchanged at 0.626 — every board keeps the bucket it
has). 0.30 and not 0.45 because the A-K / 1-18 grid labels are painted into the MoonBoard art and go
with the wall: measured off the capture they run 6.12:1 against the field unveiled, **3.62:1 at 0.30
and 2.71:1 at 0.45**, and 2.71 is under the 3:1 floor. On the art that is there the two boards read
0.573 and 0.641, and once the other five are washed down they are left as the two loudest walls in
the set — wall p95 luminance 183 and 212 against 78 to 129 everywhere else. Simulated at 0.30 over
the real capture the ten blue and green marks separate cleanly from 140 pale grid holds.

Then correct the same rationale in all three places it is published: the comment at
`SpikeBoardOverlay.tsx:104-113`, the block at `spike-config.ts:514-533`, and README's veil bullet.
Re-capture the four MoonBoard panels; nothing about those two rows is currently scoreable.

### 2. The veil's strength is calibrated for one play field and cannot see which one it is on

`veilOpacityFor` takes only a board key. The veil is a wash toward the field
(`SpikeBoardOverlay.tsx:469`), so its whole effect is the gap between the wall and the field, and the
function sees half of it. On the grey chip `#3A3A3C` Grasshopper's gap is 0.067 OkLab L and the
current 0.30 moves its wall by 4%; on the ply chip `#6B4F33` the gap is negative and the wash lifts
the wall it is there to quiet. This is not a spike-only chip problem: the shipping play view paints
`systemColors.secondaryBackground` (`app/play.tsx:124`), which is `#FFFFFF` in Android-fallback light
(`theme/colors.ts:59`) against `#181225` in dark (`:75`), and `PlatformColor('secondarySystemBackground')`
on iOS (`:24`). The field is a theme token the OS drives, not a constant, and light is the default for
anyone whose phone is light.

**Change.** Pass the field colour in (it is already in scope at the call site,
`SpikeBoardOverlay.tsx:280`) and bucket `wallL - fieldL` against **0.34 / 0.175** — the same two
thresholds minus `#181225`'s own OkLab lightness of 0.200. On the default field that reproduces
today's seven assignments exactly (gaps: TB2 0.541, Tension Original 0.461, Masters 0.441, Kilter
Homewall 0.426, MoonBoard 2016 0.373, Kilter Original 0.325, Grasshopper 0.216). Below 0.175 it
returns 0, which covers every case where the field is not meaningfully darker than the wall, so the
arm degrades to plain Outward glow instead of inverting.

### 3. The lit LED dot and the role glyph disagree about where the hold is

`SpikeBoardOverlay.tsx:542-543` draws the LED at `placement.cx + blobDx`; the glyph is drawn at the
silhouette's bbox centre (`hold.cx + bounds.centreX`). Over the committed outlines those are a median
2.1 to 4.6 board px apart (Kilter Homewall p90 8.5, max 14.5). On six of the seven boards
`brightInArt` is empty, so `blobDx` is `[0,0]` for every hold and the dot sits at the placement while
the mark sits somewhere else. A 5x crop of the lit FOOT in
`detail__kilter-homewall-10x12__3.png` shows the result plainly: the FOOT ring's hole, which
`RoleGlyph.tsx` designs as the place the role colour goes, frames the hold's own dark bolt hole with
a thin orange crescent at 12 o'clock. On the smallest holds that crescent is the only role colour in
the mark. On the bar roles the same offset squeezes a role-coloured pip out from behind the casing —
a fifth graphic nobody specified, on 9 of the 70 non-FOOT lit holds in the set.

**Change.** One expression in the LED block: `cx={placement.cx + (artBrightLeds.has(placement.id) ?
blobDx : (outlineBounds(boardKey, placement.id)?.centreX ?? 0))}`, same for `cy`. `outlineBounds` is
a free function at line 63. Keep `blobDx` for the unlit dark disc and for Grasshopper's 234
bright-LED placements — covering the art's own blob is what it was measured for, and moving those
would reopen the crescent the second pass closed (0 of 316 unlit placements now keep a pixel over
luma 200).

### 4. Make the tint's normalise pass one-way, then capture `veil-tint`

`SpikeBoardOverlay.tsx:633` flips the normalise underlay to `#000000` whenever the measured
silhouette lightness exceeds `tintNormaliseTarget` 0.588. That fires on 16 of 16 lit holds on TB2
Mirror and 12 of 16 on Tension Original — the two boards with the brightest walls — and takes the lit
hold's interior luminance from 146 to 120 and from 159 to 122, which is why the runner-up is the one
arm that scores *below* the control on TB2 Mirror.

**Change.** Skip the pass entirely when `artLightness >= tintNormaliseTarget`, so the fill only ever
lifts dark art (one conditional around lines 632-637). Accept that a HAND on Tension's pale wood and
on Grasshopper's near-black holds is then not exactly the same blue; that consistency is worth less
than the contrast it costs on the two densest wooden boards. Then in `spike-config.ts` add
`{ key: 'veil-tint', chip: 'Veil+tint', selector: 'glow-tint', veil: true }` and put it in
`capture-boards.sh`'s default `TREATMENTS` in place of `glow-tint`. `veil` is already a modifier
beside a selector rather than a selector itself, so this is one entry, not a new code path. Capture
it *after* the normalise fix or the panel measures the black wash rather than the combination.

### 5. Shoot the field axis, and pin the halo chip in the capture link

28 of 28 panels are on `#181225`. #2202 says "like #1449 but worse" and #1449's entire body is "Should
add grey background or something similar", so the reporter's own suggested fix has never been in an
image; and per change 2 the shipping field is light for anyone whose phone is. The arithmetic says
the light field inverts the Kilter and MoonBoard palettes: against `#FFFFFF`, Kilter's HAND `#00FFFF`
goes 14.54:1 to **1.25:1**, STARTING `#00FF00` 13.28:1 to 1.37:1 and FOOT `#FFAA00` 9.55:1 to 1.91:1,
while Grasshopper's blue HAND `#4455FF` goes the other way, 3.46:1 to 5.26:1.

**Change.** Add `{ key: 'light', label: 'Light', color: '#FFFFFF' }` to `SPIKE_BACKGROUNDS`
(`spike-config.ts:260-265`) and run
`FIELDS='field grey light' capture-boards.sh <dir> baseline outward-glow veil-glow` on
`grasshopper-master` and `kilter-homewall-10x12`, passing each field's hex to `build-figures.mjs` as
argv[4]. Both loops already exist; this is one line of code and one capture run. While in that
script, pin `&halos=auto` in the deep link next to `leds=on`: `resolveHalos` now reads the override
first (correctly), so one stale "Halos: on" chip press adds 966 two-tone casing strokes to every
panel of a run and nothing in the link stops it.

### 6. Correct the record where a porter reads it as the spec

Six documented facts no longer match the code, all in files that are read as the specification.

- **`README.md:190-197`, the LED table.** The committed generator has `brightInArt` of **234 / 0 / 0
  / 0 / 0 / 0 / 0**. Kilter Original's published 10 and the MoonBoards' 23 / 13 are the pre-fix run,
  zeroed by the absolute-luma floor. Add that the unlit dark disc is Grasshopper-only, and that the
  lit pip is drawn only where `ledOffsetY === 0`, i.e. on five of seven boards.
- **`README.md:217`.** FOOT is a ring at 0.24 × the placement radius, not "dot, diameter == the line
  width". It has been a ring since `ef0153125`.
- **`build-figures.mjs:285` and `:302`.** The sub-caption still reads "FOOT a dot" and the header
  still reads "role by hue alone vs role by glyph". Both panels of the committed
  `boards/colour-vision.webp` draw rings, and the left panel carries the same glyph set as the right
  one — the baseline got the glyph in change 3a, which voids the comparison the title promises.
  Retitle it as baseline against outward glow with the glyph on both, and re-emit with the next
  capture.
- **`design-review-2.md` §1's CVD sentence.** Kilter's collapsing pair is STARTING `#00FF00` against
  FOOT `#FFAA00` at Viénot deuteranopia ΔE00 **4.6** (protan 14.6), computed with the repo's own
  matrix. The two pairs the paragraph names are the safest in the set: HAND/FOOT 39.6 protan / 48.9
  deutan, STARTING/HAND 38.7 / 48.5. On both Kilter boards the two starts and the four feet of every
  climb are one yellow for a deuteranope, and the START bar and the FOOT ring are the only thing
  separating them.
- **`design-review-2.md` "What we still do not know" §9 and the closing note of Blocker 1.**
  `displayColor` is screen-only: `aurora.ts:270` builds every LED entry as
  `sanitizedOverride ?? state.color` and `hold-color-overrides.ts:439` already carries the
  display/wire split. So the palette is not frozen by the BLE path. It is frozen by deuteranopia
  instead — lifting Tension's HAND toward FOOT magenta's lightness takes their deutan ΔE00 24.3 to
  8.6 to 1.3 — and that is the reason to record.
- **`spike-config.ts:363-376` and `:284`.** `glowHoldExtentCap` is 1.2 on the one-sided *reach*, so
  the mark it permits is `shortest × (1 + 2 × 1.2)` = **3.4x** the hold's short extent, not the
  "roughly 1.5x" the prose implies — visible as the round magenta discs on Tension Original's bottom
  foot row in panels 2, 3 and 4. And `glowNeighbourFloorWidth` is documented as "a property of the
  screen" and stored in board pixels, so it is 13.3 device px on MoonBoard and 8.0 elsewhere. Fix
  both comments; do not move either number (see Leave alone).

### 7. Only if the MoonBoard re-capture is happening anyway: make the tracer's neck trim relative

`scripts/spike-hold-outlines.ts:76` — `NECK_TRIM_RADIUS = 3` is absolute board pixels on boards whose
coordinate space differs 1.66x, the same unit mistake the second pass fixed for `glowSpreadWidth`.
Re-running the trim at radius 2 on MoonBoard 2016, hold 103 (HAND, board 241,485) keeps 100% of its
art instead of 81.9% — the gold hook sweeping off its triangular body is currently cut off by a
straight chord — and hold 83 keeps 94.5% instead of 81.4%. Two of that board's ten lit holds have a
real, grabbable feature missing from their mark, and it is baked data that ships into `renderer.rs`.

**Change.** `const NECK_TRIM_RADIUS = Math.max(2, Math.round(3 * boardWidth / 1080))`, with the two
module-level erosion/dilation offset tables built from it rather than from a constant. The five
1080-wide boards come out byte-identical. Then re-run `spike:hold-outlines` → `spike:hold-lightness`
→ `spike:led-dots` in that order and re-run the committed gates. Skip this if the pass is tight: it
is two holds on one board, and it touches committed data plus three generators.

## Deferred

Real, verified, and not worth the last slot.

1. **The glyph is wider than the hold it names.** The FOOT ring's outer casing is 0.689 r, wider than
   the silhouette on 12 of the 30 lit FOOT holds, covering 70-78% of eight of them; the HAND bar
   covers 74% of MoonBoard 2016's 11x13 hold 83 and the STARTING bar 50% of Kilter Original 1477. The
   fix is one line — clamp the line width, `lineWidth = min(0.11 r, 0.15 × shortest)`, which takes
   Grasshopper 51 from 70.5% to 51.2% and TB2 Mirror 612 from 69.9% to 49.0% — and it is *not* to
   clamp the ring's radius, which closes the hole into a filled disc on 8 of those 12. Deferred
   because it moves hold identity and not findability, which is what #2202 is about.
2. **The veil's fallback punch.** `SpikeBoardOverlay.tsx:284` falls back to
   `plainRingPath(hold.cx, hold.cy, hold.radius)` — the full placement circle. Two adjacent fallback
   circles overlap (placements sit 1.41 r apart on the Aurora boards, 1.71 r on MoonBoard) and under
   `fillRule="evenodd"` the overlap has crossing number 3 and fills back in: a field-coloured lens
   painted through the middle of two lit marks. Unreachable in every capture — `SpikeBoard.tsx`
   restricts the synthesised climb to placements that traced, and `HANDOVER.md` §7 requires that — so
   it is a port-time defect. Punch with a mask, or clamp the fallback radius to half the distance to
   the nearest lit placement.
3. **The port has nowhere to put the field colour, and may not need one.** `RenderConfig`
   (`board-renderer/core/src/types.rs:37-55`) has no background field and `buildCacheKey`
   (`use-native-climb-render.ts:607-635`) hashes no field token, so a veil baked into the overlay PNG
   is cached against a field nothing keys on and is served to the play view, the 400 px thumbnail,
   the Live Activity, the OG card and web alike. But the veil carries no colour at all: compositing
   the field at alpha *a* over (art over field) is algebraically identical to compositing the art at
   alpha *(1-a)* over the same field — I verified the identity, and the captures are exactly that
   blend. So "the board art at (1-a) opacity with the lit silhouettes at full opacity" is the same
   pixels with no hex to plumb. Decide which shape the port takes before budgeting it.
4. **Six surfaces mount this overlay, not two.** `BoardImageNative` is used by `SwipeBoardCarousel`
   (play), `InteractiveCreateBoard`, `InteractiveFilterBoard`, `WallHeroStage` (the gym kiosk) and
   `BoardForm`, and `ClimbListThumbnail` mounts `LayeredClimbImage` directly. The two hold-picking
   boards exist so the user can choose among the *unlit* holds, which is the content the veil dims,
   and `WallHeroStage`'s own docstring says nothing is ever rendered over it. Whatever ships, the
   veil is a play-view flag, never a layer inside `LayeredClimbImage`.
5. **Nothing has been scored above 1x or below 1080 px.** `MAX_SCALE` is 4
   (`shared/play-view/src/swipe-carousel.ts:21`) and the overlay is clamped to the board's native
   width (`use-native-climb-render.ts:712`), so a 4x pinch scales a 1080 px raster to 4320 device px
   — and the glow's 15-band falloff and silhouette-exact inner edge are exactly what that upscale
   destroys, while the control's saturated ring is indifferent. At the other end, the 400 px
   thumbnail and the 384 px Live Activity have still never been rendered with any arm. Second pass
   change 16, still open.
6. **Grasshopper's real distractors are chromatic and the veil cannot touch them.** Its wall carries
   nine saturated cyan holds at 4.58:1 against the field, against a HAND at 3.46:1, and an alpha wash
   scales chroma by the same (1-a) as luminance — 0.30 leaves them at 2.82:1, still the loudest unlit
   objects in the frame. It is visible in panel 4 of `whole__grasshopper-master.png`, which is hard to
   tell from panel 2. Two other boards have the same shape of problem: Tension Original's 41
   terracotta holds (6.45:1, hue 21, against FINISH `#FF0000` at 4.56:1) and MoonBoard 2016's 36 gold
   holds, which under deuteranopia land ΔE00 **1.6** from FINISH `#FF3333` (protan 20.1) — one colour
   for a deuteranope, separated only by the X glyph. No cheap lever: a saturation matrix would have to act on the art, and the art
   cannot go back through react-native-svg `<Image href>`.
7. **FINISH is the dimmest role on all seven boards** (Kilter `#FF00FF` 5.81:1, Tension/Grasshopper
   `#FF0000` 4.56:1, MoonBoard `#FF3333` 5.01:1) and appears once per climb, while HAND is 7 of 16
   marks and is the brightest role on both Kilters. The measurement says FINISH should get more
   geometry. The images disagree — the X is the heaviest glyph in the vocabulary and the FINISH mark
   is legible on every board, while the blue HAND on the five non-Kilter boards is what is actually
   hard to find. Record the disagreement; do not add a per-role size multiplier on this evidence.
8. **The untraced-hold branch draws a different vocabulary.** With no silhouette,
   `SpikeBoardOverlay.tsx:589-603` draws a bare ring at the placement radius with the glyph at
   `reach = hold.radius` and no clip, and no glow band at all — bars 2.0-3.2x longer than a traced
   one, ring 38% smaller, and the treatment for that hold is the control. Unreachable in every
   capture, first seen on the first board outside these seven that the tracer cannot read. Second
   pass "what we still do not know" §5, still open.
9. **The every-hold casing and the veil have never been in the same picture.** `spike-config.ts`
   pitches the veil as the cheap replacement for 632-966 casing strokes, and all four captured arms
   run `halos: 'none'`. One extra capture on Grasshopper and Tension Original settles whether the
   0.30 bucket is still right with a casing under it.

## Leave alone

1. **The glow's shape, band mechanism and falloff stops.** `glowFalloffStops` is the second pass's
   own specification and the banding it was written for is gone — a device ray out of TB2 Mirror's
   lit FOOT has no plateau and no step above 2 levels per pixel. Moving the middle stops outward
   would push the half-alpha point from 0.33 of the extent to 0.60, which is a reversal, not a tune,
   and it needs a re-capture on MoonBoard 2016 hold 26 where the arcs were countable. The 15-band
   floor is a react-native-svg Android workaround, not spec — say so for the porter, do not
   re-tune it here.
2. **`glowNeighbourFraction` 0.45 and `glowNeighbourFloorWidth` 8.** They work: all three glow arms
   give 16 separate coloured regions for 16 lit holds on all seven boards, where the baseline still
   fuses Kilter Homewall 4294+4317 and TB2 Mirror 439+447 into figure-eights. 0.45 is under 0.5 on
   purpose — two caps at 0.45 of the same gap can never meet, which is what makes that count 16 —
   so do not raise it to 0.7. The cost is four marks of 100 rendering at the 8 px floor; record it.
3. **`smallHoldBoost` and `glowHoldExtentCap` 1.2.** Lowering the cap to 0.8 inverts the size floor:
   once the cap binds, rendered reach is `shortest × cap` regardless of the boost, so MoonBoard's
   smallest holds would end up with the *least* light. Raising it makes the discs wider. Fix the
   comment (change 6), not the number.
4. **The FOOT ring's radius, and the ring itself.** Clamping the radius to fit the hold drives the
   casing's inner edge negative on 8 of 12 holds — the ring becomes a filled disc, which is the
   LED-lookalike blob the ring replaced. If the ring is ever narrowed it is the line width.
5. **The role hexes.** Grasshopper's HAND/FOOT pair is ΔE00 3.2 under protanopia, which is why the
   glyph exists; `equalL` and any lightness lift on blue HAND each collapse a different dichromat
   pair. `displayColor` being screen-only makes a change *possible*; deuteranopia is what makes it
   wrong.
6. **The nearest-placement partition, the eligibility filter, and the annulus lightness table.** The
   partition is clean against the committed data. The eligibility filter is what keeps the captures
   honest; add a deliberate fallback fixture instead. The annulus table is the right measurement for
   the ring casing and for the veil's bucket — the defect in change 1 is the sentinel, not the table.
7. **The baseline arm.** It is the control, it carries the LED layer and the glyph like the other
   three, and the fact that panels 1, 2 and 3 now leave the wall identical to the 95th percentile is
   the proof that the second pass's change 3 landed. Do not "improve" it, and do not read it as what
   ships.
8. **`FeGaussianBlur`.** Still broken in react-native-svg 15.15.5 on Android, and `tiny_skia` 0.11
   has no blur primitive either — an alternative falloff in the port is a hand-written pass over a
   scratch pixmap, not a primitive swap.
9. **The white glyph core and the two-tone casing.** The core is the brightest element of every mark
   in every arm on every board (peak relative luminance 0.897-0.909), which is why any contrast
   number quoted for an arm has to exclude near-white or it is a measurement of the accessibility
   layer. Raising `glyphOpacity` from 0.95 to 1.0 is the only cheap idea in there and it is worth 12
   of 255 on a layer that already saturates.

## What we still do not know

1. **Whether any of this helps a climber.** Still no user data of any kind. The telemetry the first
   review specified — pinch events per climb view, time from climb open to first queue or BLE action,
   same-climb re-open rate within a session, stratified by board and layout and never pooled — is
   the only thing that answers #2202 and none of it exists.
2. **iOS.** Only the Android emulator has been exercised, three passes running.
3. **Any play field but `#181225`.** Change 5 shoots grey and light on two boards; ply, and every
   board but those two, stay unknown. The shipping field is a theme token, so light mode is the
   default for anyone whose phone is light, and the veil is the first arm whose pixels depend on it.
4. **The small surfaces and the zoomed one.** 400 px thumbnail, 384 px Live Activity, and the 4x
   pinch on the play view. Three sizes the app actually draws, none of them captured.
5. **The ring fallback, and boards outside these seven.** The mark, the glyph and the veil's punch
   all take a different shape on an untraced hold, and no capture reaches that branch. The silhouette
   table is 238 KB for 7 of roughly 53 board configs.
6. **Real climbs.** Every capture is one synthesised 16-hold climb per board from the same relative
   coordinates. The fallback rate, the lit-hold density and the role mix on catalogue climbs are all
   unmeasured.
7. **User marker settings.** Six per-role shapes, two sliders and a free-hex per-role override, none
   of which the spike reads, and the silhouette *is* the shape in three of the four arms.
8. **Render cost.** Whole-board painted objects run 288 (baseline) to 500 (veil) on Grasshopper and
   66 to 275 on Kilter Homewall, of which the veil is exactly one path more than the glow. Nothing
   has been measured on a mid-tier Android device or in `renderer.rs`.
9. **Whether the tint's fill still earns anything once the wall is quiet.** That is what change 4's
   `veil-tint` capture is for, and it is the last open arm question.
10. **Whether the every-hold casing helps at all.** Never captured on with the veil, never captured
    off on the boards where `boardWantsNeutralHalos` fires. The only thing measured about it is that
    it lifts Grasshopper's unlit wall by 8%.
