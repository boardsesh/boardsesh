# Fourth design pass (issue #2202): the blue HAND

Reviewed the one open job in `PORT-HANDOVER.md` §0: HAND is the only role under 4.5:1 on the default
`#181225` play field, on five of the seven boards. Five lenses went in (the palette frontier, the mark's
structure with the hex held, the play field, fidelity to the official apps, and the surfaces the blue has
to work on), each paired with an adversarial skeptic that re-ran every number through the role-contrast
oracle (`packages/mobile/scripts/spike/role-contrast.mjs`, selftest 34/36 exact, the two misses being
the published tritan figures) and, where the claim was about pixels, against the committed captures
(`scratchpad/blue-hand/diagnosis.md`, recolour re-composites of the veil+glow panels). Fifteen
proposals went in; ten were refuted, five survived, and three of the five went to the device as
finalists ("What the capture said", at the end, is what the capture did to them). Every number
below is the oracle's or a pixel measurement; the recolour p95 figures are a model of the captured
marks with the hex swapped, not a render, and the real capture comes after this pass.

## The verdict

**Move the display hex, keep the wall, and split the boards.** Nothing that leaves the hex alone gets
HAND out of last place: anything drawn in `#4444FF` caps at the hex's own 3.05:1 (an alpha plateau
measures 3.33 / 3.08 / 2.99 on Grasshopper / Tension / MoonBoard 2016, a dark casing is identical to
shipped, spread x1.3 is 3.03 / 2.97 / 2.69), the darkest field the app could paint caps it at 3.52
(black) because a field multiplies every role by one factor, and a lighter same-hue edge tint is a
palette change wearing a different hat (at OkLab L 0.65 it takes the deutan HAND/FOOT pair to 7.2 per
hex and 4.4-4.7 against the FOOT glow; at L 0.64 Tension's Machado protan HAND/FOOT drops 6.81 to 5.16).
On the palette, no blue at 4.56:1 passes §0 (b) as literally written (0 of 3,593 in-gamut OkLCh hexes;
deuteranopia blocks 99.7% of them), so the panel reads (b) as: under Viénot and Machado protan and deutan
on the board's own palette, the protan HAND/FOOT pair (the one the glyph mode exists for) must not fall,
and no pair may fall below the lowest dichromat pair the app already ships unremarked, Tension's Machado
protan HAND/FOOT 6.81 (Kilter's 4.6 and Grasshopper's 3.2 are remarked; `equalL`'s 4.7 was called a
collision, and still is). Under that reading: MoonBoard (no FOOT) takes `#667CFF`, a pure lightness lift
at the shipped hue (5.11:1 against its 5.01 bar, no dichromat pair moves, dE00 16.6 from shipped); the
six FOOT boards take `#1C8AFF` (5.32:1, protan HAND/FOOT 7.29 to 11.51, deutan floor 12.55 to 8.75, hue
255 inside the band the official apps draw in, 2.0 dE00 from iOS system blue), with `#707BBB` as the
deutan-preserving alternative (12.31) that a capture has to prove is still blue at 37% chroma. Against
Marco's position: the wall LED stays `#0000FF` (`aurora.ts:270` never reads `displayColor`); the
"standard colour" on screen is already a band, not a hex (Aurora's own `screen_color` is `#0066FF` on
Tension, `#4455FF` on Grasshopper, `#0000FF` on Decoy; the TB2 app draws `#3B3BFF`, the MoonBoard app
`#2962FF` / `#005CFB`, all 7.5-19 dE00 from the LED and 2-12 from each other); Boardsesh already moved
this blue 9.5 / 13.7 dE00 on 2026-07-17 with 0 complaints in 19 issue comments. The finalists are 17-23
dE00 from today, past the ~10 dE00 memory tolerance, so climbers will see a lighter blue; the release
note says so and the wall does not change.

## The diagnosis

What the pixels say on the veil+glow panels (`diagnosis.md`; panel px, 460 px panels = a 2.35x downscale
of the 1080 px capture):

| Board             | HAND p95 vs field | rendered worst other role | losing to                     | evidence                                                                                                                                                                 |
| ----------------- | ----------------- | ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Grasshopper       | 2.97              | FINISH 3.41               | the FIELD (its own luminance) | 0.5% of the annulus brighter than the glow's p95; reach 12.5 px vs FOOT 15.0; 0 px of the falloff at 3:1, 4% of mark px at 3:1 (FOOT 4.0 px, 19%)                        |
| Tension Original  | 2.69              | FINISH 3.63               | the WALL and its own hold     | veiled art median Y 0.125 above the glow's p95 0.106 (1.11:1); 22.4% of the annulus brighter than p95; the punched-out lit hold is 4.7x the glow's peak                  |
| TB2 Mirror        | 3.81              | FINISH 3.92               | the WALL first                | 45% of the annulus brighter than the glow's median; p95 reaches 3.81 only because the glow lies over pale art (peaks `#6C6D9E`); reach is short for every role (7-11 px) |
| MoonBoard 2016    | 2.60              | FINISH 4.17               | the FIELD and its own hold    | 17% of the annulus is art; 1% of mark px at 3:1; the lit hold is 2.5x the glow's peak; reach 14.0 px, the longest on any board                                           |
| MoonBoard Masters | 2.64              | FINISH 5.29               | the FIELD and its own hold    | 12% of the annulus brighter than the glow median; 1.0 px at 3:1; hold 3.8x                                                                                               |

Four facts cut across the five boards. The ceiling is the hex: veil+glow p95 sits at 0.80-0.84 of the hex
Y on the four dark-wall boards because the alpha-1.0 band is one device px wide, and every other role
renders under its table number too (FINISH `#FF0000` 4.56 on paper is 3.41 / 3.63 rendered; FOOT 5.81 is
4.37-4.61). Reach is not the lever: HAND's extent (12.5-14 px) matches FOOT's (13-15). What differs by
role is how much of the reach carries contrast: HAND holds 3:1 for 0-1 px, FOOT for 4-5, STARTING for
4.5-8. And the winner made HAND's peak dimmer while quieting the wall (Grasshopper 3.46 to 2.97, Tension
3.12 to 2.69), so the residual is the mark's own luminance, which on a fixed hex is not recoverable. §0's
hint (fix the inner edge, not the palette) was tested and does not survive: the inner edge is either the
hex (capped) or a lighter tint (a palette change with the CVD cost of one). At 152 px the filled mark's
mean is 1.64-2.17:1 on the blue boards (Kilter cyan 5.17-5.88), fill-limited: `#4444FF` needs fill alpha
0.99 for 3:1, and FINISH red at the 0.3 fill is as weak (1.33) as the blue (1.30).

## Finalists

Ranked against §0 in priority order (a, b, c, d), then against Marco's position (smallest passing change
wins ties). Contrast on the five fields is the oracle's; "recolour p95" is the captured veil+glow HAND
mark with the hex swapped in sRGB (`scratchpad/blue-hand/dr4-recolour.py`, the skeptic's model, which
reproduces the shipped p95 by construction); "152 px" is the same recolour of the baseline-filled
thumbnail mark. Today's rendered p95 is 2.97 / 2.69 / 3.81 / 2.60 / 2.64 (Grasshopper / Tension Original
/ TB2 / MoonBoard 2016 / Masters).

### F1. MoonBoard: `#667CFF`, the shipped hue at OkLab L 0.64 (palette-frontier P1)

Spec: `HOLD_STATE_MAP.moonboard[43].displayColor` `#4444FF` to `#667CFF`
(`packages/board-constants/src/hold-states.ts:71`) and the mirror at
`packages/shared/board-config/src/moonboard-config.ts:150`; `color` `#0000FF` untouched. Serves 2016 and
Masters (one map entry). OkLCh 0.637 / 0.195 / 272.5 (shipped 0.526 / 0.265 / 272.6: hue held to 0.1
degrees, chroma 73%, HSL saturation 1.00).

|                   | `#181225`                             | grey `#3A3A3C` | ink `#0B0B0C` | plywood `#6B4F33` | white | dE00 to `#4444FF` / LED |
| ----------------- | ------------------------------------- | -------------- | ------------- | ----------------- | ----- | ----------------------- |
| shipped `#4444FF` | 3.05                                  | 1.90           | 3.29          | 1.26              | 5.97  | 0 / 9.5                 |
| `#667CFF`         | **5.11** (bar 5.01, FINISH `#FF3333`) | 3.18           | 5.52          | 2.11              | 3.56  | 16.6 / 26.1             |

CVD, MoonBoard palette (`#44FF44 / HAND / #FF3333`), worst pair per transform today to new: Viénot protan
STARTING/FINISH 42.0 unchanged (HAND's own pairs 57.8+), Viénot deutan 18.5 unchanged (69.2), Machado
protan 39.4 unchanged (52.9), Machado deutan 18.2 unchanged (60.7); simple tritan STARTING/HAND 7.8 to
8.8 (up); Machado tritan STARTING/HAND 40.4 to 29.1 with the next pair at 70.4. Recolour p95 4.10 (2016)
/ 4.20 (Masters): 0.07 under 2016's rendered FINISH 4.17, and Masters' 5.29 is unreachable by any HAND hex
(FINISH there renders at 1.07x its hex over pale art; the hex would need 0.972x). 152 px: 1.64 to 2.17
(2016), 1.74 to 2.34 (Masters). Plywood 1.26 to 2.11, not worse. Light theme 5.97 to 3.56 (FINISH is 3.64
there, STARTING 1.34). By eye on the recoloured crop (`scratchpad/blue-hand/verify-recolour-moonboard-2016.webp`,
panel 2) it is a lighter blue and nothing else. Skeptic corrections carried: the lens's k-proxy render
estimate (4.27 / 4.35) ran 0.15-0.17 high; the light-theme drop was a cost the lens did not flag. If the
capture wants the 2016 FINISH bar cleared, the same line one step up is `#6980FF` (5.32:1, hue 272.3, 1.2
dE00 from `#667CFF`, Machado tritan 28.2, recolour 4.25 / 4.35); do not go past L 0.70 (`#7E95FF` is
nearest-named periwinkle, 2.75 on white). Passes (a), (b) literally, (c), (d). Smallest change of the
three: hue identical, one map entry.

### F2. The six FOOT boards: `#1C8AFF` (surfaces-and-shipping P1)

Spec: `displayColor` `#1C8AFF` on tension codes 2 and 6 (`hold-states.ts:58,62`), touchstone 2 (`:87`),
grasshopper 2 (`:93`, from `#4455FF`), soill 2 (`:99`), woods 2 (`:109`), decoy 2 (`:81`, from raw
`#0000FF`); `color` untouched everywhere; Kilter untouched. OkLCh 0.639 / 0.197 / 254.9 (chroma 74% of
shipped; hue 18 degrees toward cyan, inside the 250-278 "blue" naming envelope and at the cyan edge of the
official apps' 257-271 band).

|                                                 | `#181225`                             | grey               | ink                | plywood            | white              | dE00 to shipped / LED                      |
| ----------------------------------------------- | ------------------------------------- | ------------------ | ------------------ | ------------------ | ------------------ | ------------------------------------------ |
| shipped `#4444FF` / `#4455FF` / decoy `#0000FF` | 3.05 / 3.46 / 2.12                    | 1.90 / 2.16 / 1.32 | 3.29 / 3.74 / 2.29 | 1.26 / 1.43 / 1.14 | 5.97 / 5.26 / 8.59 | 0 / 9.5, 0 / 13.7, 0 / 0                   |
| `#1C8AFF`                                       | **5.32** (bar 4.56, FINISH `#FF0000`) | 3.31               | 5.74               | 2.20               | 3.43               | 23.4 / 18.9 / 32.4 to shipped; 32.4 to LED |

CVD, Tension palette (touchstone, soill, woods identical; Grasshopper differs only in today's protan
floor), unrounded, worst pair today to new: Viénot protan HAND/FOOT 7.29 to **11.51** (Grasshopper 3.2 to
11.51); Machado protan HAND/FOOT 6.81 to **6.85** (Grasshopper 3.8 to 6.85); Viénot deutan
STARTING/FINISH 12.55 to HAND/FOOT **8.75**; Machado deutan 12.19 to HAND/FOOT **9.00**; Machado tritan
FINISH/FOOT 27.0 to STARTING/HAND 19.6; simple tritan STARTING/HAND 15.0 to 17.7. Decoy: protan 16.7 to
11.5 (Viénot) and 13.5 to 6.85 (Machado), the one board where protan gets worse, because its shipped hex
is the raw LED. Under the panel's reading of (b) it passes with 0.04 dE00 of margin on Machado protan;
under the literal flag it fails on deutan, like every blue at 4.56.

Recolour p95 **4.33 / 4.33 / 5.80** (Grasshopper / Tension / TB2), above rendered FINISH (3.41 / 3.63 /
3.92) and within 0.04-0.10 of rendered FOOT (4.37 / 4.43); share of mark px at 3:1 goes 4% to 24-33%.
152 px: 1.78 to 2.22, 1.86 to 2.46, 2.17 to 3.00 (still fill-limited; the fill composite over Tension's
pale holds is a luminance match, 1.06:1, at any blue). Plywood 1.26-1.43 to 2.20 (FINISH is 1.90 there,
FOOT 2.43: HAND stops being the invisible role on wood). Light theme 5.97 / 5.26 to 3.43 (FOOT 3.14 is
lower). Other shipping composites: Android Material default `#140E1E` 5.51, iOS `#1C1C1E` backstop 4.97.
Grasshopper's nine unlit cyan holds (median `#1087BB`, 4.50:1): dE00 from HAND 21.0 to 10.5 unveiled,
19.1 veiled (protan 10.7, deutan 9.9). Fidelity: 2.0 dE00 from iOS system blue `#0A84FF`, 12.6 from
Aurora's Tension `screen_color` `#0066FF`, 14.3 from the MoonBoard app's `#2962FF` (shipped `#4444FF` is
10.6 / 8.7 from those; what moves is lightness, L 0.53 to 0.64, not the hue class). Skeptic corrections
carried: the dev-DB row count is 7.53 M not 1.45 M (HAND is 43.7-48.6% of lit holds on the Aurora boards,
65.7% on MoonBoard, so this hex is most of every climb's marks); the picker's LED/display split on
Grasshopper grows 13.7 to 32.4, not 9.5; MoonBoard dev-firmware preview code 47 `#C084FC` would be a
protan collision (2.9 / 3.2) if `#1C8AFF` were applied to MoonBoard, which F1 does not do. Passes (a),
(b) under the panel's reading, (c) by the numbers, (d). Ranked above F3 on (a): 5.32 vs 4.55 flat and
4.33 vs 3.85 rendered.

### F3. The six FOOT boards, deutan-preserving alternative: `#707BBB` (palette-frontier P2)

Spec: same map entries as F2, value `#707BBB`. OkLCh 0.601 / 0.098 / 275.6 (hue +3 to +5 degrees, chroma
37% of shipped, HSL saturation 0.36; CIELCh calls it 13 degrees off). Nearest named colour Glaucous (5.8).

|           | `#181225`                                                        | grey | ink  | plywood | white | dE00 to `#4455FF` / `#4444FF` / LED |
| --------- | ---------------------------------------------------------------- | ---- | ---- | ------- | ----- | ----------------------------------- |
| `#707BBB` | **4.55** (bar 4.56: 0.01 under, oracle `meetsOthersWorst` false) | 2.83 | 4.91 | 1.88    | 4.01  | 14.9 / 18.3 / 26.6                  |

CVD, unrounded: Viénot protan HAND/FOOT 7.29 to **13.46** (Grasshopper 3.2 to 13.46); Machado protan
6.81 to **8.74**; Viénot deutan worst 12.55 (STARTING/FINISH) to HAND/FOOT **12.31**; Machado deutan
12.19 to 12.15; Machado tritan 27.0 to 26.8; simple tritan STARTING/HAND 15.0 to 8.1 (the two tritan
matrices disagree in sign here; the oracle ranks the simple matrix least trustworthy). It is the only
Aurora candidate at 4.5 whose deutan worst pair stays within 0.24 of today's, which is why it is here.
Recolour p95 3.85 / 3.89 / 5.52, above rendered FINISH (3.41 / 3.63 / 3.92), under rendered FOOT. 152 px
2.10 / 2.38 / 2.90. Plywood 1.43 / 1.26 to 1.88. Light theme 4.01. Two conditions the skeptic added: it
must ship only where the veil is drawn (unveiled, its dE00 to Grasshopper's cyan holds is 1.8-2.4 under
every dichromat transform against 9.7-17.7 today; today's `renderer.rs` and the OG card draw no veil, so
"work it independently of the port" is unsafe for this hex), and (c) is undecided by the numbers: on the
recoloured crops (`verify-recolour-grasshopper-master.webp`, `verify-recolour-tension-original.webp`,
panel 2) it reads as a grey-lavender ring and Grasshopper's veiled cyan holds are more chromatic than the
mark (OkLab C 0.102 vs 0.089 at the glow edge). Passes (a) at tolerance, (b) with margin, (d); (c) goes
to the capture. Ranked third because (a) comes first in §0 and it is 0.48 rendered under F2.

What shipping any of the three touches (surfaces P3, verified): `hold-states.ts` and
`moonboard-config.ts:150` (drift-tested at `moonboard-hold-state-drift.test.ts:30`);
`RENDERER_VERSION` 6 to 7 at `packages/mobile/src/hooks/renderer-version.ts:30` (mandatory:
`buildCacheKey` at `use-native-climb-render.ts:635` hashes no colour; Expo web flushes via
`overlay-cache-warmup.web.ts:51`); `use-native-climb-render.test.ts:271` (expects `#4455FF`); the three
consumers need no edit (`use-native-climb-render.ts:701`, `worker-manager.ts:328`,
`render-config.ts:65` all resolve `displayColor ?? color`). No BLE file moves, no Fable review. It is an
OTA change, not a native release; two server surfaces lag behind one-year immutable caches until their
URLs carry a version (OG cards, `util.ts:96-110` and `headers.ts:26`; the web `/api/internal/board-render`
route the iOS Live Activity fetches, `route.ts:126-128`, two copies of `SharedConstants.swift`,
`ThumbnailFetcher.swift:42` `cacheVersion` 5). Users with a HAND colour override never see it (the
override wins on screen and wall). A tripwire in `packages/board-constants` (every
`STATE_TO_PRIMARY_CODE` role at 4.5:1 on `#181225`; decoy fails it today at 2.12) cannot import the oracle
from `packages/mobile/scripts`; the matrices and CIEDE2000 have to be lifted to a shared package.

## What the capture said

Captured after the pass, on the device at 1080 px: `capture-boards.sh` with
`PALETTES='hand-1C8AFF hand-707BBB hand-667CFF hand-6980FF'` on the five blue boards, `baseline` and
`veil-glow` at full width and `thumb-baseline` / `veil-glow` at 152 px. The sheets are
`boards/blue-hand-candidates.webp`, `boards/blue-hand-candidates-detail.webp` (the middle of each
board at capture resolution) and `boards/blue-hand-candidates-152px.webp`; the numbers come from the
diagnosis finder run on the raw captures (`scratchpad/blue-hand/measure-captures.py`), all seven HAND
marks found on every board and palette. HAND p95 relative luminance as WCAG contrast against
`#181225`; the gate is the rendered FINISH on the same capture (4.2 vs field on Masters):

| Board                    | shipped   | `#1C8AFF` | `#707BBB` | `#667CFF` | `#6980FF` | rendered FINISH | rendered FOOT |
| ------------------------ | --------- | --------- | --------- | --------- | --------- | --------------- | ------------- |
| Grasshopper              | 3.17      | 4.83      | 4.17      | 4.58      | **4.92**  | 4.18            | 5.11          |
| Tension Original         | 2.84      | 4.85      | 4.12      | 4.64      | **4.89**  | 4.18            | 5.03          |
| TB2 Mirror               | 2.83      | 4.79      | 4.18      | 4.65      | **4.83**  | 4.12            | 5.10          |
| MoonBoard 2016           | 2.76      | 4.80      | 4.13      | 4.57      | **4.85**  | 4.58            |               |
| MoonBoard Masters        | 2.79      | 4.80      | 4.14      | 4.61      | **4.90**  | 4.61            |               |
| 152 px, p95, five boards | 2.51-2.78 | 4.09-4.31 | 3.58-3.72 | 3.98-4.11 | 4.17-4.35 |                 |               |

Share of HAND mark pixels at or above 3:1: shipped 0.3-10%, every candidate 20-39%.

The sheet-basis model ran low, all in one direction: the device renders every mark brighter than the
460 px sheets (shipped HAND 3.17 / 2.84 / 2.83 / 2.76 / 2.79 against the sheet's 2.97 / 2.69 / 3.81 /
2.60 / 2.64, TB2's sheet figure having been pale art under the ring rather than the glow; rendered
FINISH is 4.12-4.61, not 3.41-4.17), so the recolour p95 figures in "Finalists" ran 0.3-0.5 low on the
Aurora boards and every finalist clears the gate by more than the model said. `#707BBB` fails the
gate on four of five boards (4.12-4.18 against FINISH 4.12-4.58) and on the detail sheet it is the
grey-lavender ring the skeptic described, less chromatic than Grasshopper's cyan holds beside it; it
is out. `#667CFF` passes on the Aurora boards and Masters and misses MoonBoard 2016's rendered FINISH
by 0.01 (4.57 vs 4.58); `#6980FF`, one step up the same line, clears it by 0.27 and is the brightest
rendered HAND on every board.

**The pure lightness lift passes the capture gate on the Aurora boards too**, which the pass had
excluded only on its reading of (b). On the device `#6980FF` renders 4.83-4.92 on Grasshopper /
Tension / TB2 against `#1C8AFF`'s 4.79-4.85. What separates the two is the oracle, not the render
(Tension palette, worst pair today to new): `#6980FF` takes Viénot protan HAND/FOOT 7.3 to 9.9,
Machado protan 6.8 to **5.8**, Viénot deutan 12.6 (STARTING/FINISH) to HAND/FOOT 7.8, Machado deutan
12.2 to 8.1; `#1C8AFF` takes them to 11.5, 6.9, 8.8 and 9.0. On Grasshopper both lift the protan pair
the glyph mode exists for (3.2 / 3.8 to 9.9 / 5.8 with `#6980FF`, to 11.5 / 6.9 with `#1C8AFF`). So
the hue-held hex costs 1.0 dE00 on Tension's Machado protan pair (under the 6.81 floor the pass set,
well above Grasshopper's shipped 3.8) and about 1.0 on the two deutan pairs, and buys a hue identical
to today's (272.3 against 272.6; `#1C8AFF` moves 18 degrees toward cyan), a smaller move from today
(dE00 13.5 / 17.9 against 18.9 / 23.4 on Grasshopper / Tension), one hex on all five boards, and a
mark that does not share a colour family with Grasshopper's unlit cyan holds: on the detail sheet the
`#1C8AFF` marks and the cyan holds read as relatives, the `#6980FF` marks do not.

By eye on the detail sheet: `#1C8AFF` is a bright azure and the easiest mark to find on every board;
`#667CFF` and `#6980FF` are the shipped blue made lighter, unmistakably the same colour; `#707BBB` is
grey-lavender.

Two finalists survive the capture, and the choice between them is a policy call, not a measurement:

- **`#6980FF` on all five blue boards.** The smallest change that passes: the shipped hue, one hex,
  the best rendered contrast on every board, MoonBoard 2016's gate cleared. Costs the Tension-class
  Machado protan HAND/FOOT pair 6.8 to 5.8 and the deutan HAND/FOOT pairs about 7.8 / 8.1.
- **`#1C8AFF` on the six FOOT boards, `#6980FF` on MoonBoard.** The pass's recommendation: Machado
  protan held at 6.9, deutan 8.8 / 9.0, at the cost of a visible hue shift toward cyan (18 degrees,
  2.0 dE00 from iOS system blue), a second hex, and a mark in the same family as Grasshopper's cyan
  holds.

Either way `#707BBB` is out, `state.color` does not move, and the shipping path is the one under
"Finalists".

## Rejected

Every idea that lost, with the number that killed it. Items an earlier pass rejected and a lens re-tried
are marked (re-tried).

1. Edge rim, 3 device px at OkLab L 0.65 (mark A, `#6783FF` / `#6B81FF`): per-hex deutan HAND/FOOT 7.2 /
   7.4 from a board worst of 12.6, and 4.4-4.7 against a FOOT glow pixel at alpha 0.88; the handover called
   `equalL`'s 12.6 to 4.7 a collision. Sheet p95 4.03 / 4.24 / 3.81 reproduced.
2. Two-tone falloff to 0.4 of the extent at L 0.65 (mark B): same edge, same deutan pair; fails (a) on
   MoonBoard at L 0.65 on both bases (sheet 4.09 vs FINISH 4.37, device 4.39 vs 4.47), so its L 0.70
   exception (periwinkle) is mandatory; its own Grasshopper Machado deutan 4.3 contradicts its "at or above
   Kilter's 4.5" claim.
3. Rim plus two-tone (mark C): strongest on (a) (5.4 device-res on every board) and fails (b) exactly as A.
4. The skeptic's corrected edge at L 0.64 (`#637FFF` / `#687DFF`): Tension Machado protan HAND/FOOT 6.81 to
   5.16, under the shipped floor; the L 0.63-0.64 window the skeptic found satisfies its own "no pair under
   5.0" but not the panel's rule.
5. Edge at L 0.60 (`#546DFF`): Machado protan HAND/FOOT 1.5 / 1.4; WCAG 4.35 fails 4.56 anyway.
6. Edge at L 0.70 on a FOOT board (`#7B96FF`, the `equalL` HAND, re-tried): deutan HAND/FOOT 1.4 / 1.6.
7. HAND-only alpha plateau to 0.15 of the extent (mark, surfaces P2): 3.33 / 3.08 / 2.99; the hex is the
   ceiling (3.05 / 3.46); on the device at 1x the gain is 0.9x to 1.0x of hex Y, not 0.82x to 1.0x.
8. Per-role spread x1.3: p95 3.03 / 2.97 / 2.69; extent 12.7 to 17.1 panel px against a 21 px pitch.
9. Dark casing outside the glow (4 px a0.7, 6 px a1.0 `#0B0B0C`): p95 unchanged; casing 1.09:1 vs the
   field; reads as a black second ring over art.
10. Brighter LED pip (tint or white): 1.0-1.1% of the mark's area, p95 unchanged; white is the near-white
    trap (18:1); the MoonBoards draw no centred pip.
11. Rim of 2 device px: rejected by the lens at 3.44 / 3.48 / 3.20 on the sheet, which the skeptic showed is
    a blur-model artefact (device-res 5.4:1); moot because every rim fails (b).
12. Thumbnail fill alpha 0.30 to 0.45 alone: `#4444FF` needs 0.99 for 3:1; every role moves (Kilter cyan
    2.30 to 3.73); native-only; unmeasured on white and on the 400 px accessory / 384 px Live Activity.
13. Pin the play field to `#181225` (field F1): moves nothing on the default field (3.05 / 3.46 by
    design); as specified it pins nothing (Material's `role="low"` ignores `fallbackColor`, and the tint
    composites the solid path to `#130E1D`); its "veil gap negative on 6 of 7 boards on plywood" is 1 of 7. The light-scheme numbers survive as a separate finding (Kilter HAND 1.25 / 1.16 on white).
14. Darker field `#0F0B16` (F2): HAND 3.05 to 3.26; the Android default composite is already `#140E1E`
    (3.16), so the real gain is +3%; the lens's ceiling is black at 3.52 / 3.99, rendered 3.05 / 3.30.
15. Third veil bucket 0.60 on Tension-class walls (F3): glow vs field stays 2.69; Tension's 287 unlit holds
    drop 3.08 to 2.22 vs field; the 0.46 gate has 0.0009 OkL of margin against Tension's 0.4609.
16. Cooler / neutral / warm / per-board fields: WCAG 3.02-3.05 on every one; hue is worth at most 6.5 dE00.
17. Grey `#3A3A3C` and plywood as fields: Tension HAND 1.90 / 1.26, FINISH 2.84 / 1.88, FOOT 3.62 / 2.40.
    There is no user-facing play-field setting; grey, ink and plywood exist only as `SPIKE_BACKGROUNDS`.
18. Keep the light scheme's white field as-is: Kilter HAND 1.25, STARTING 1.37, MoonBoard STARTING 1.34
    on white; a light field inverts which role fails.
19. One hex on all five boards, `#8178B6` (frontier P3): 4.60 fails MoonBoard's 5.01 bar; OkLCh hue +17-19
    degrees at 35% chroma, nearest named Ube (2.8), lavender-grey on both recolour crops; fails (c).
20. `#4589FF` on the seven blue boards (fidelity P2): refuted as filed on literal (b) (Viénot deutan 12.55
    to 7.73, Machado deutan 12.19 to 8.11) and on its own restated gate on decoy (global worst 12.19 to
    7.02). Its skeptic and F2's skeptic applied different readings of (b) to hexes 3.2 dE00 apart; both sets
    of numbers are right. Under the panel's reading it would pass (Machado protan 7.02); it stays out because
    `#1C8AFF` is 1.0 / 0.9 dE00 better on the two deutan pairs at a cost of 0.17 on Machado protan, and
    because it was refuted as filed.
21. Pure lightness lift on a FOOT board, hue held (`#5872FF` 4.57, `#5B6FFF` 4.48, `#5C70FF` 4.53,
    `#647AFF` 5.01, `#667CFF` on Tension): Machado protan HAND/FOOT 2.8 / 2.2 / 2.4 / 4.5 / 4.92 against
    6.81 (Tension) and 3.8 (Grasshopper). At L 0.57-0.58 it bottoms at 0.4 (`#4D65FF`). Deuteranopia pins the
    top of the line (L 0.70 `#7C97FE` deutan 1.1 / 1.3), protanopia the bottom; the 4.5 band sits between.
22. Minimum-dE contrast-only hexes (`#6C6CFD`, `#786AFE`, `#726CFF`): Machado protan 1.8 / 1.9 / 2.2.
23. Small lift at the shipped hue (`#5555FF`, `#5C5CFF`, `#6666FF`): Viénot protan 0.7 / 2.4 and 3.85 /
    4.26 flat.
24. Bigger lift at the shipped hue (`#7070FF`, `#6C82FB`, `#6887FF`, `#7A8EFF`): Viénot deutan 10.8 / 7.1 /
    6.2 / 3.3 and Machado protan 3.0 / 6.1; worse than the hue-255 candidate on every transform.
25. Violet-ward (`#8060FF`, `#7A5CFF`, `#7565DB`, `#7D68C0`): `#8060FF` h 290 "bluish purple", Viénot protan
    1.9; `#7565DB` passes dichromat-strict but at 4.03 fails (a).
26. Cyan-ward at the shipped lightness (`#3379F4`, `#0081DE`, `#007DF1`): Machado protan 2.7 / 4.2 / 3.0.
27. Hue 240 `#0086C5`: 2.4 dE00 from Grasshopper's cyan hold art `#1087BB` (protan 2.2, deutan 2.0);
    simple tritan STARTING/HAND 15.5 to 7.7.
28. Teal `#1B89B3` (h 230): passes all four dichromat checks at 4.58 and is Cerulean (5.3), 41 degrees off.
29. The slate at 5.0 (`#7484CD`): deutan HAND/FOOT 8.6 / 8.5; bluer than `#707BBB` but dE00 20.0 / 29.1.
30. Pastel passes (`#B8B1F7`, `#A9BAFE`, `#BEB0FB`, 9.3-9.7:1): dE00 29.5-33.4 from shipped, white 1.9-2.0.
31. Past 6:1 (`#4BA1FE`, `#319CFC`): Viénot deutan HAND/FOOT 1.5 / 3.6; HAND becomes FOOT for a deuteranope.
32. Aurora's own Tension `screen_color` `#0066FF` or the MoonBoard app's `#2962FF` for fidelity: 3.77 / 3.72
    flat; Viénot protan HAND/FOOT 0.7 / 0.2 on every FOOT board.
33. A hex bright enough that the render reaches 4.5 (5.3:1 flat, Y 0.255): on the FOOT boards only
    reachable at chroma 40% (`#7484CD`, deutan 8.5) or as pastel.
34. Moving FOOT's `displayColor` too (`#FF00AA`) so a saturated pure-L HAND passes: Machado tritan
    FINISH/FOOT 27.0 to 18.4, and FOOT drifts from its own LED; a two-hex move nobody asked for.
35. The literal oracle `collision` flag as the gate: 0 passes on every board at every target; on MoonBoard
    it trips only on Machado tritan; on Kilter it could never trip because HAND is in no worst pair.
36. The per-role colour override as a display-only vehicle or an opt-out (re-tried): `aurora.ts:270` sends
    `sanitizedOverride ?? state.color` to the wall.
37. Editing `color` (the LED) instead of `displayColor`: changes the wall, Fable review, and Marco's constraint.
38. Different hexes per board to track each board's own official app: the official apps disagree by
    2.1-12.3 dE00 among themselves; the existing 4.3 dE00 Grasshopper/Tension split has no user signal.
39. Kilter's cyan `#00FFFF` everywhere: 41.1 dE00 from F2; Grasshopper's unlit art hue class (h 237); 1.25 on white.
40. Watch the HAND colour-override set-rate as the aversion signal (fidelity P3): overrides persist under
    `holdColorOverrides` in the on-device preference store and no analytics event references them.
41. A capture gate of "HAND p95 at or above FINISH p95 on every board": unreachable on Masters (FINISH
    5.29 renders at 1.07x its hex over pale art; a HAND hex would need 0.972x). Gate Masters on 4.2 vs field.

## Leave alone

1. **The LED hex, `state.color`.** `#0000FF` on every Aurora board, `#00FFFF` on Kilter; the wall is what
   climbers calibrate on and every official app keeps it. No proposal touches it and no BLE review is needed.
2. **The default field `#181225` and the veil buckets.** Every dark shipping composite is at or below it
   in Y (Android Material default `#140E1E`, opt-in Liquid Glass `#130E1D`, iOS solid `#15131A`); a field
   cannot change HAND's rank on any board (HAND/FINISH stays 0.669 / 0.758 on every field). Keep the
   `Y <= 0.0086` note (where `#4444FF` holds 3:1) for any future field option; it rejects `#1C1C1E`, grey and
   plywood.
3. **`glowFalloffStops`, spread, `glowHoldExtentCap`, the casing rules** (design-review-3 leave-alone 1-3).
   The mark lens measured every one of them for HAND and none moved the p95 past the hex.
4. **Kilter's palette.** HAND cyan is the best role on the board (14.54); a uniform +0.10 L rim on every
   role takes Kilter's deutan STARTING/FOOT 4.6 to 2.1.
5. **FOOT and FINISH `displayColor`s.** A FINISH lift to `#FF3333` costs Machado tritan FINISH/FOOT 27.0 to
   20.3 (`#FF4D4D` 14.9); the "lift the dark role" move is not free for red either.
6. **The glyph mode as the CVD answer.** F2 improves the pair it was built for (protan HAND/FOOT 3.2 to
   11.5 on Grasshopper) and lowers the deutan floor to 8.75; the glyph stays opt-in and off by default.
7. **The oracle.** `role-contrast.mjs` reproduced 34 of 36 published checks exactly; the two misses are the
   published tritan figures (24.7 / 3.3) that no matrix reproduces. Its selftest constants pin the shipped
   3.05 / 3.46 and need new expectations, not a new pipeline, when a hex lands.

## What we still do not know

1. **What the capture did not answer.** The capture (see "What the capture said") settled (a) and the
   `#707BBB` question; what it cannot settle is the policy call between `#6980FF` everywhere and
   `#1C8AFF` on the FOOT boards, and whether either reads as the same hold colour as a `#0000FF` light
   2-4 m away, which only a climber at a wall can say.
2. **The 4x pinch.** The capture settled the 1x sheet-to-device ratio (the device renders 0.3-0.5
   brighter than the 460 px sheets); the 4x pinch has still not been captured with any arm.
3. **Deuteranopia.** The 6.81 floor is a policy, not a measurement; F2 lands at 8.75 / 9.00 where today's
   worst is 12.55 / 12.19, and no deuteranope has been asked. `colour-vision.webp` carries deutan panels of
   the two controls (Viénot, Grasshopper) but no veil+glow arm and no candidate hex; re-render it for F2.
4. **Tritan.** The published 24.7 / 3.3 reproduce under no matrix; the Fidaner simple matrix and Machado
   2009 disagree in sign for F3 (15.0 to 8.1 vs 27.0 to 26.8). Nothing here gates on tritan; say which
   model does before anyone quotes a tritan number in the port docs.
5. **The light theme.** All three finalists take HAND on white from the board's best role (5.26-5.97) to
   3.4-4.0; `HOLD_STATE_MAP` has no theme axis, and the light scheme's real failures are Kilter HAND 1.25 /
   1.16 and STARTING 1.34-1.37. Whether light mode wants its own display hex is a separate job.
6. **iOS.** Never captured, three passes running; the play field there is the `secondarySystemBackground`
   backstop (`#1C1C1E`, F2 4.97) under a glass tint nobody has measured.
7. **So-iLL.** Aurora's `board_placement_roles` says middle magenta, finish white LED / `#7F7F7F` screen,
   foot cyan; Boardsesh draws the Tension palette. One of them is wrong, and "the standard colour" for a
   So-iLL HAND may not be blue at all.
8. **Real climbs.** HAND is 43.7-48.6% of lit holds on the Aurora boards and 65.7% on MoonBoard (dev DB,
   7.53 M frame-0 rows); every capture is 7 of 16. MoonBoard is where the blue is most of the climb, and
   it is the board that gets the smallest change.
9. **The MoonBoard dev-firmware preview codes 45-48.** `#667CFF` is 5.7 / 5.5 dE00 (Viénot / Machado
   protan) from code 47 `#C084FC`, also named HAND; catalogue climbs never use those codes.
10. **The immutable caches.** Whether to version the OG and `board-render` URLs now (an unknown `v=` query
    key is ignored by both routes, so it is safe) or let the one-year edge caches age out with the old blue.
11. **Change aversion, measured.** The only in-app signal would be the override store, which is not
    captured anywhere; a 0-complaint history on a 9.5 / 13.7 dE00 move is the whole evidence base.
