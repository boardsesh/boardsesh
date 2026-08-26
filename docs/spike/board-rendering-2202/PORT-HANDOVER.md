# Porting the #2202 winners into `renderer.rs`

For whoever takes this next. The spike is settled; this is what to build, what it costs, and the
three decisions that are not mine to make.

Read [`README.md`](./README.md) for what the treatments are, and the three design passes
([`design-review.md`](./design-review.md), [`design-review-2.md`](./design-review-2.md),
[`design-review-3.md`](./design-review-3.md)) for why the losers lost. This file does not repeat them.

**The spike itself is not the deliverable.** Every lit-hold pixel a climber sees comes out of the
Rust binary in `packages/board-renderer/core/src/renderer.rs` as a cached PNG. The
`react-native-svg` overlay all the arms are drawn in
(`packages/mobile/src/components/board-spike/SpikeBoardOverlay.tsx`) is a dev screen and is
imported by nothing else. Nothing here reaches a user until it is Rust.

---

## 1. What won

**Full board: veil + outward glow.** Wash the unlit wall down in the play-field colour with each
lit hold's silhouette punched out, then draw the glow off the outside edge of each lit silhouette.

The measurement that decided it: baseline, outward glow and glow+tint all leave the unlit wall at
_identical_ p95 luminance (209/209/209 on Kilter Homewall, 213×3 on Tension Original, 186×3 on TB2
Mirror). The veil takes them to 126/129/113 with the mark itself unchanged. Every other arm competes
with the wall; only the veil changes what the mark competes against.

**Thumbnails: veil + filled mark.** At 152 device px — the 76×96 dp list cell at 2× — a hollow ring
and a soft glow both lose their signal to downsampling and a filled shape does not. The app already
believes this: `ClimbListThumbnail` passes `filledStyle: true` and `renderer.rs:151/:201` switches
to an 8.0 base stroke plus a 0.3-alpha fill "so lit holds read as solid dots once scaled". The
winner keeps that filled marker and adds the veil.

So the treatment differs by surface. That is not a compromise — it is what the codebase already
does, and the split should be made explicit rather than inherited.

**The role glyphs are opt-in and out of scope for a first port.** They replace the shipped per-role
marker shapes (#3204) as an accessibility mode, default off. Ship the default render first.

---

## 2. What `renderer.rs` cannot draw today

`render_overlay` (`renderer.rs:119`) draws circles and marker shapes from geometry. It has no
radial gradient and no non-circular outline. Both are needed.

| Piece          | Needed                                                           | Cheapest expression        |
| -------------- | ---------------------------------------------------------------- | -------------------------- |
| The veil       | one even-odd filled path: board rect, minus every lit silhouette | one path, no per-hold cost |
| The glow       | a falloff band outside each lit silhouette                       | see below                  |
| The silhouette | each lit hold's real outline                                     | a committed table, see §4  |

**Do not port the twelve-to-twenty concentric strokes.** They exist only because
`FeGaussianBlur` is broken in `react-native-svg` 15.15.5 on Android — a stroke through it paints
the filter region as a solid rectangle of the stroke colour. Rust has no such constraint. Draw the
falloff directly.

**Do not replace the silhouette-clipped glow with a placement-centred radial gradient.** The hard
inner step where the glow stops on the hold's own edge _is_ the arm. Median silhouette
`rmax/rmin` about the placement centre runs 1.74–2.00, and p90 3.18–3.24 on the MoonBoards, so no
circular or bbox-elliptical gradient reproduces it.

**The glow's clips are the expensive part, and they collapse.** In the spike the glow needs one
outside-clip per lit hold — 16 per board, 32 clip paths on Grasshopper. Every one of those clips is
a subset of the same geometry the veil already needs, so a port that draws the veil first gets the
glow's masking for free from one shared mask. Painted objects per whole board, measured:
Grasshopper baseline 300 [16 clips], outward glow 511 [32], veil+glow 512 [32], glow+tint 575 [32];
Kilter Homewall / TB2 Mirror / Kilter Original baseline 66 [16], outward 274 [32].

---

## 3. Decision one: the veil probably does not belong in `renderer.rs` at all

This is the biggest open question and it is a judgement call.

The veil is a wash in the **play-field colour** over the unlit wall. But `renderer.rs` produces a
transparent overlay PNG that is composited over the board photo by `LayeredClimbImage`, and that
component **already ships a `dim` scrim** at `rgba(0,0,0,0.18)` in the layer above. The veil is the
same kind of object as that scrim.

Two consequences:

- **Cache correctness.** The overlay PNG's cache key hashes the climb, not the background. Bake a
  field-coloured veil into it and every cached overlay is wrong the moment the user changes the play
  field. The spike has exactly this bug today and it is only invisible because the captures never
  varied the field.
- **Cost.** As a scrim it is one composite over the whole image, and it replaces the every-hold
  casing layer the spike used to draw (632 stroked paths on Grasshopper, 966 on Kilter Homewall).

The counter-argument is that the veil must have holes exactly where the lit silhouettes are, and
the scrim layer does not know the silhouettes. Resolving that either means passing the lit
silhouette geometry up to `LayeredClimbImage`, or emitting the veil as a second PNG from the same
Rust call that already knows it.

**My recommendation, not a decision:** emit the veil as its own layer from Rust — same geometry
pass, separate output — and composite it in `LayeredClimbImage` beside the existing scrim, with the
field colour applied at composite time rather than baked. That keeps the cache key honest and keeps
the silhouettes where they already are.

---

## 4. Decision two: the silhouette table

The traced outlines are what make every winning treatment possible, and they are currently a
committed TypeScript table: **236 KB for 7 of roughly 53 board configs**, so about 1.8 MB
extrapolated, in one eagerly-imported flat record.

Two things have to change before that ships:

- **Shard and lazy-load it per board**, the way `@boardsesh/board-constants` already shards hole
  placements. Nobody should pay 1.8 MB to render one board.
- **Key the lookup on `mirrored_hold_id`.** `HoldData` (`types.rs:57`) carries
  `mirrored_hold_id: Option<u32>` and `renderer.rs` swaps to it for coordinates on a mirrored climb.
  A silhouette table keyed only on `id` traces the wrong shapes on every mirrored climb, and mirrored
  climbs are common.

The generator is `packages/mobile/scripts/spike-hold-outlines.ts`. It is not fast and it is not
subtle, but it is correct now and it carries six committed gates (§6). Running it over the whole
catalogue is a batch job, not a rewrite.

---

## 5. Decision three: release mechanics

**This is a native release, not an OTA.** Three artifacts move together:

- the iOS and Android binaries,
- `packages/board-renderer/wasm/pkg/board_renderer_wasm_bg.wasm` (473 KB, loaded by the backend OG
  card service),
- `RENDERER_VERSION` in `packages/mobile/src/hooks/renderer-version.ts`, currently **6**.

**The version bump is not optional.** The overlay cache key hashes the climb, not the drawing
(`use-native-climb-render.ts:443-448` reuses any PNG whose prefix matches `v{RENDERER_VERSION}_`),
so without a bump every existing user keeps their stale overlay forever and the change appears to
do nothing.

**Old binaries fail silently, so name the new call.** `RenderConfig` (`types.rs:38`) is
`#[derive(Deserialize)]` with `#[serde(default)]` on several fields and **no**
`deny_unknown_fields`. An old binary handed a config with new veil/glow fields ignores them and
draws today's baseline without erroring. Add a new bridged method name that the shim falls through
on — the way `renderHoldsOverlayWithMarkers` already does — rather than extending the existing one.

---

## 6. The gates that must keep passing

`packages/mobile/src/components/board-spike/__tests__/spike-hold-outlines.test.ts`, about 5 s:

1. every emitted outline contains its own placement point;
2. no emitted region contains a second placement point;
3. no polygon with >10% of perimeter on a search-box edge, and none with 4+ axis-aligned runs
   carrying >80% of it (the rejected crop rectangle's signature);
4. traced outlines per board against placements — 332/303/498/499/476/140/112;
5. no outline loses more than 20 board px² to an open at the board's trim radius;
6. **cut share** — no silhouette boundary running through a _neighbour's_ art. This is the one that
   catches the defect where a mark wraps a wedge of the hold next to it. Post-fix the neighbour mean
   is 0/0/0/0.2/0/0.2/0.2% per board.

Gates 5 and 6 both carry fixtures that were verified to go red when their guard is removed. Keep
that property; the round before shipped a gate whose fixture could not reach the branch it pinned.

---

## 7. What is still unknown

1. **Whether any of this helps a climber.** There is no user data. The telemetry that would answer
   it — pinch events per climb view, time from climb open to first queue or BLE action, same-climb
   re-open rate, all stratified by board and never pooled — does not exist.
2. **iOS.** Only the Android emulator was ever exercised.
3. **The play field.** The veil's strength is bucketed on the wall-to-field gap, which is right in
   principle, but only the dark field has been reviewed at length. On the plywood chip the veil
   correctly returns 0 — nobody has looked at what a climber wants there instead.
4. **Real climbs.** Every capture is one synthesised 16-hold climb per board. Real catalogue climbs
   vary in lit-hold count and role mix, and role mix is what decides how much the glyph work matters.
5. **The user's marker settings.** The app ships six per-role marker shapes, a shape-size slider, a
   brush-thickness slider and per-role colour overrides. Nobody has decided what a silhouette-based
   treatment does to a climber who set "diamond at size 2.0" — the silhouette _is_ the shape, so
   that setting has no meaning in the winning arm.
6. **Render cost on a mid-tier Android device.** Counted, never profiled.

---

## 8. Running the spike yourself

[`HANDOVER.md`](./HANDOVER.md) has the emulator and Metro sequence, the three deep-link traps, the
capture and figure scripts, and the axes. The screen is gated on `__DEV__ || profile?.isTester` and
reachable only by deep link.
