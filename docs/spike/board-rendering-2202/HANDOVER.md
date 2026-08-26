# Handover: regenerating the #2202 board-rendering images

Everything needed to produce a fresh set of review images for
[issue #2202](https://github.com/boardsesh/boardsesh/issues/2202) on the
`spike/board-rendering-dark-2202` branch. Read `README.md` first for what the
treatments are and why; this file is only the mechanics.

**The spike is a dev screen, not a shipping change.** It is gated on
`__DEV__ || profile?.isTester` and reachable only by deep link, and it lands
green — commit it normally, never with `--no-verify`.

---

## 1. Get the app running on the emulator

The spike screen is only reachable by deep link, and it renders entirely from
bundled assets: no login, no network, no seeded database.

```bash
ADB=~/.cache/boardsesh/android-sdk/platform-tools/adb

# 1. Emulator. Sandbox OFF, and swangle — the default renderer segfaults in this VM.
#    Reuses a running emulator if there is one; NEVER run `-- shutdown` in that case,
#    it may belong to another worktree.
BOARDSESH_EMULATOR_GPU=swangle_indirect \
  node ./node_modules/tsx/dist/cli.mjs scripts/mobile-android-shots.ts run --no-screenshot-mode

# 2. Metro. Do NOT use the one android-shots starts: it runs with CI=1 and never
#    watches files, so edits will not reach the device. Pick a free port — other
#    worktrees squat 8081/8082/8097.
cd packages/mobile && bunx expo start --port 8099

# 3. Point the dev client at it.
$ADB reverse tcp:8099 tcp:8099
$ADB shell am force-stop com.boardsesh.app.dev
$ADB shell am start -a android.intent.action.VIEW \
  -d "com.boardsesh.app://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8099" \
  com.boardsesh.app.dev
```

Wait for `Android Bundled` in the Metro log before deep-linking. Fast Refresh
works from here, so code edits land without a relaunch — give it ~12s.

## 2. Open the spike

```bash
$ADB shell "am start -a android.intent.action.VIEW \
  -d 'com.boardsesh.app:///board-spike?board=grasshopper-master&treatment=outward-glow' \
  com.boardsesh.app.dev"
```

Three things that will each cost you twenty minutes if you miss them:

- **Three slashes.** With `com.boardsesh.app://board-spike` the route name parses
  as the URL _host_ and Expo Router never matches it.
- **Single-quote the URI for the device shell.** `adb shell` concatenates its
  arguments into one string that the _device's_ shell parses, so an unquoted `&`
  backgrounds the command there and every parameter after the first is silently
  dropped. The board changes, the treatment does not, and it looks like the
  param is broken.
- **The screen syncs state from params on change**, so re-linking works. It did
  not originally — `useState` initialisers only run once per JS launch.

Board and treatment keys are in `src/components/board-spike/spike-boards.ts` and
`spike-config.ts`.

## 3. Capture and build the figures

```bash
CAPTURES=/tmp/spike-captures
FIGURES=/tmp/spike-figures

packages/mobile/scripts/spike/capture-boards.sh "$CAPTURES"
node --import tsx packages/mobile/scripts/spike/build-figures.mjs "$CAPTURES" "$FIGURES"
cp "$FIGURES"/*.webp docs/spike/board-rendering-2202/boards/
```

`capture-boards.sh` walks 7 boards × 4 treatments — baseline, outward-glow,
glow-tint, veil-glow, the same four `build-figures.mjs` captions — and takes a
full-screen PNG of each (~2.5 min). Override with `BOARDS=... TREATMENTS`; the
treatment list is the script's remaining arguments. The link pins `leds=on`
rather than leaving that axis to the screen, which keeps whatever it was last
handed — otherwise one `LEDs: off` chip press before a run shoots the whole
matrix dark.

`build-figures.mjs` crops each capture to the board and writes the per-board
sheets, the all-boards sheet and the colour-vision simulation. It finds the board
by scanning for the play-field colour `#181225`, so it copes with any aspect
ratio — **but if you change the default play field, update `FIELD` in that
script or every crop fails loudly.**

## 4. Sanity-check before posting

Look at the contact sheet rather than trusting the run:

```bash
node -e "
const {createRequire}=require('module');
const sharp=createRequire('$PWD/package.json')('sharp');
const fs=require('fs'), path=require('path');
(async()=>{
  const dir='$CAPTURES';
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.png')).sort();
  const tiles=[];
  for(const f of files) tiles.push(await sharp(path.join(dir,f)).resize(150).png().toBuffer());
  const m=await sharp(tiles[0]).metadata(), cols=4, gap=5;
  await sharp({create:{width:(m.width+gap)*cols+gap,height:(m.height+gap)*Math.ceil(tiles.length/cols)+gap,channels:4,background:'#111'}})
    .composite(tiles.map((t,i)=>({input:t,left:gap+(i%cols)*(m.width+gap),top:gap+Math.floor(i/cols)*(m.height+gap)})))
    .png().toFile('/tmp/verify.png');
  console.log('wrote /tmp/verify.png');
})();"
```

A capture can silently be of the wrong state — the deep link is fire-and-forget
and the caption in each shot says which treatment is showing. Check the captions.

## 5. Regenerating the derived data

Only needed when the board set, the art, or the tracing parameters change. All
three write committed TypeScript tables and take a couple of minutes.

```bash
vp run spike:hold-outlines    # every hold's silhouette, traced from the art's alpha
vp run spike:hold-lightness   # art lightness in the ring's annulus AND inside the silhouette
vp run spike:led-dots         # which holds have an LED, and where the art already paints one
```

Run them in that order. `spike:hold-lightness` measures inside the polygons
`spike:hold-outlines` emits, so re-running the tracer without re-running it
leaves every silhouette lightness stale against a table that still lines up
key-for-key.

**Audit the tracer after changing it.** Three defects were shipped once already
and are invisible unless measured — outlines that ran into the search box and
traced its straight edge (215/499 on Kilter Homewall), lit holds whose silhouette
came from a _neighbouring_ hold (31/143 on MoonBoard Masters), and merged blobs
spanning two holds. All three are zero now.

Those checks used to live here as "worth re-running as throwaway scripts", and
that is how the counts in `README.md` stayed two rounds of fixes out of date.
They are committed now, in
`packages/mobile/src/components/board-spike/__tests__/spike-hold-outlines.test.ts`,
and run against the table in about two seconds:

```bash
vp run test:mobile
```

1. every emitted outline contains its own placement point;
2. no emitted region contains a second placement point;
3. zero polygons with more than 10% of perimeter on a search-box edge, and none
   with four or more axis-aligned runs carrying over 80% of it — that pair is the
   rejected crop rectangle's signature and no real hold's;
4. traced outlines per board against placements: 332/332 Grasshopper, 303/303
   Tension Original, 498/498 TB2 Mirror, 499/499 Kilter Homewall, 476/476 Kilter
   Original, 140/198 MoonBoard 2016, 112/198 Masters 2019. Pinned in both
   directions — a drop means the seed containment got too tight, and a jump on
   MoonBoard means the tracer started finding holds that are not there;
5. no outline loses more than 20 board px² to an open at 3 board px. Stated on
   that spur measure and not on perimeter: a 37-px tail running up a neighbour's
   rim barely moves the perimeter share, because the tail brings perimeter of its
   own. The gate measures the shipped polygons with a plain open — erode, dilate
   every core back inside the mask, count what never came back — deliberately not
   the tracer's own order, which grows the seed's core alone and is the stricter
   of the two. A gate that replays the generator passes whatever the generator
   emits. Zero outlines trip it on all seven boards, with no exceptions pinned;
   the worst survivor is Kilter Homewall 4219 at 16 px² of the 20 allowed, and the
   per-board worsts run 9 / 10 / 12 / 16 / 8 / 13 / 14.

Each gate carries a fixture that must trip it, including the one branch no board
reaches — the exemption for a hold too thin to core at all. A check that has never
failed is indistinguishable from one that cannot fail.

The run line the tracer prints, and now writes into the head of
`spike-hold-outlines.ts`, counts something different from gate 5: it is what the
trim took off the raw region, before Douglas-Peucker, and only the 20 px²
threshold is shared with the gate.

## 6. Posting to the issue

Images must be committed and referenced by **raw.githubusercontent.com pinned to
a commit SHA** — GitHub has no API for uploading images to a comment, and a
branch-relative URL rots. The repo is public so the raw URLs render.

```bash
git add -A && git commit -m "..." && git push
SHA=$(git rev-parse HEAD)
RAW="https://raw.githubusercontent.com/boardsesh/boardsesh/$SHA/docs/spike/board-rendering-2202/boards"
curl -s -o /dev/null -w "%{http_code}\n" "$RAW/board-grasshopper-master.webp"   # expect 200
gh issue comment 2202 --repo boardsesh/boardsesh --body-file <file>
```

## 7. Known state and traps

- **The board-art guard is green, and has to stay green.**
  `check:mobile-board-art-network` forbids rendering board art through
  react-native-svg `<Image href>`; the spike drew it that way so an
  `FeColorMatrix` could desaturate it, and that axis is gone. The art goes
  through `expo-image` on the same bundled `file://` paths the shipping stack
  resolves, and react-native-svg is the overlay only. A contrast variant, if one
  is ever wanted, is a second committed suffix in
  `scripts/generate-dark-board-art.ts` — not an SVG image layer. Do not commit
  with `--no-verify`.
- **`FeGaussianBlur` is broken** in react-native-svg 15.15.5 on Android: a stroke
  through it paints the filter region as a solid rectangle of the stroke colour.
  `FeColorMatrix` in the same version renders correctly on the same device. The
  glow falloff is concentric strokes because of this — do not "simplify" it back to a blur.
- **Two accessibility systems now coexist, deliberately.** The app already ships
  per-role marker _shapes_ (circle/triangle/square/diamond/octagon, user-
  configurable, in both the SVG and Rust renderers). Those work by changing the
  whole marker's shape — which a traced outline cannot do, because its shape is
  the hold. So the traced arms carry an inside-the-hold _glyph_ instead
  (`RoleGlyph.tsx`). If an arm goes back to a fixed circle, prefer the shipped
  shape system over the glyph.
- **The synthesised climb only lights placements that have a traced silhouette.**
  MoonBoard's placements are a synthetic 11x18 grid where most cells are empty,
  and lighting those produced bare rings for holds that do not exist — a climb no
  real user could select. Keep that restriction.
- **Metro dies quietly** in this VM after a while. If deep links stop changing
  anything, check the port is still listening before debugging the app.
