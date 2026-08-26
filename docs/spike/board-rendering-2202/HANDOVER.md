# Handover: regenerating the #2202 board-rendering images

Everything needed to produce a fresh set of review images for
[issue #2202](https://github.com/boardsesh/boardsesh/issues/2202) on the
`spike/board-rendering-dark-2202` branch. Read `README.md` first for what the
treatments are and why; this file is only the mechanics.

**The spike is a dev screen, not a shipping change.** It is committed with
`--no-verify` and CI is red on `check:mobile-board-art-network` — see the last
section.

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

`capture-boards.sh` walks 7 boards × 4 treatments (~2.5 min) and takes a
full-screen PNG of each. Override with `BOARDS=... TREATMENTS` — the treatment
list is the script's remaining arguments.

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
vp run spike:hold-lightness   # art lightness under each ring, per hold
vp run spike:led-dots         # which holds have an LED, and where the art already paints one
vp run spike:oklab-board-art  # contrast-stretched art (Grasshopper only, writes webp assets)
```

**Audit the tracer after changing it.** Three defects were shipped once already
and are invisible unless measured — outlines that ran into the search box and
traced its straight edge (215/499 on Kilter Homewall), lit holds whose silhouette
came from a _neighbouring_ hold (31/143 on MoonBoard Masters), and merged blobs
spanning two holds. All three are zero now. The checks worth re-running, as
throwaway scripts against `SPIKE_HOLD_OUTLINES`:

1. every emitted outline contains its own placement point;
2. no emitted region contains a second placement point;
3. zero polygons with >10% of perimeter on a search-box edge;
4. outline count per board versus placement count — a sudden drop means the seed
   containment got too tight.

## 6. Posting to the issue

Images must be committed and referenced by **raw.githubusercontent.com pinned to
a commit SHA** — GitHub has no API for uploading images to a comment, and a
branch-relative URL rots. The repo is public so the raw URLs render.

```bash
git add -A && git commit --no-verify -m "..." && git push
SHA=$(git rev-parse HEAD)
RAW="https://raw.githubusercontent.com/boardsesh/boardsesh/$SHA/docs/spike/board-rendering-2202/boards"
curl -s -o /dev/null -w "%{http_code}\n" "$RAW/board-grasshopper-master.webp"   # expect 200
gh issue comment 2202 --repo boardsesh/boardsesh --body-file <file>
```

## 7. Known state and traps

- **CI is red and that is expected.** `check:mobile-board-art-network` forbids
  rendering board art through react-native-svg `<Image href>`, and the desaturate
  toggle needs the art inside the SVG so an `FeColorMatrix` can act on it.
  Nothing fetches over the network — the hrefs are the same bundled `file://`
  paths — but it is the shape the rule exists to stop, so this cannot merge as
  written. Commits use `--no-verify` by the maintainer's call.
- **`FeGaussianBlur` is broken** in react-native-svg 15.15.5 on Android: a stroke
  through it paints the filter region as a solid rectangle of the stroke colour.
  `FeColorMatrix` in the same version is fine. The glow falloff is twelve
  concentric strokes because of this — do not "simplify" it back to a blur.
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
