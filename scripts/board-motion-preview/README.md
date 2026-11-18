# Board motion lab previews

Renders the board motion lab's variants on this Mac's GPU, so a look can be
judged without a phone. Everything drawn is the real thing: the Metal shader
(`ClimbOverlayShader.swift`), the per-hold look (`ClimbOverlaySwapLook.swift`),
the production Rust packet encoder, and each variant's own driver stepped frame
by frame. Each frame's uniforms are Rust's base sample for its pair with the
weights patched in; the run first checks that patching against Rust-encoded
samples byte for byte. Output belongs outside the repository.

What it renders:

- **Contact sheets**, ten moments of one swipe (drag 20, 40, 60 pt, the commit,
  +40 to +230 ms, rest) on the Kilter Homewall 8/25 photo at 1080 × 1504, with
  three real recorded climbs: A and every swap look, Subtle and Bold.
- **Compare sets**: A, I and J on the lab's "90% shared holds" and "shared holds
  change role" climbs, and on a MoonBoard 2024 pair (commit-frame clutter).
- **Motion**: 60 fps H.264 videos of one script (a slow drag held at 80 pt and
  let go, a quick flick, then a flick re-flicked 90 ms after it commits): A and
  every look at 1× and 0.25×, Bold at 0.25×, and each look beside A. 0.25× is
  true slow motion, with the finger and every clock slowed; the lab's 0.25× keeps
  the pager's own fling at full speed. Labels sit above the board, never on it.
- **The ghost-halo cut check**: E at drag 60 pt through the shader before the
  look's ownership fix and through today's, full frames and 3× crops.
- **Stats** (`summary.json`): pixels each variant changes against A per frame,
  and the glow (mean chroma) at the darkest moment after each commit against A's.
- **Endpoints**: every pair I's sheets draw, through the look at W = (1, 0) and
  (0, 1), against the still frame of the climb at rest, pixel for pixel. A
  difference would light or drop a pixel on the first drag frame or the swap's
  last frame. Any difference fails the run after `summary.json` is written, with
  an eight-times-brighter difference image per pair in `<out>/endpoints/`. Run it
  alone with the built executable: `<out>/build/board-motion-preview endpoints
  <work> <fresh dir>`.
- **Parity**: with `--golden`, the shader with no look bound against the shader
  at `--baseline` on the Aura transition golden's 42 samples, byte for byte.

## Run

1. Build the host Rust examples (step 1 of `scripts/aura-transition-golden/README.md`).
2. Step every variant and write the packets:

   ```sh
   vp exec node --import tsx scripts/board-motion-preview/prepare.ts \
     --out ~/.cache/claude-tmp/board-motion-lab/preview-work \
     --packet-cli <target>/release/examples/prepare_gpu_packet
   ```

3. Render. `--golden` takes a work directory from the golden's `prepare.mjs`.
   `--baseline` is the shader parity compares against (default: where this
   branch leaves `origin/main`); `--before-fix` is the shader the cut check
   compares against (any ref with the look but without its ownership fix).

   ```sh
   vp exec node scripts/board-motion-preview/render.mjs \
     --work ~/.cache/claude-tmp/board-motion-lab/preview-work \
     --out ~/.cache/claude-tmp/board-motion-lab/previews \
     --golden <aura-transition-golden work dir> --before-fix <ref>
   ```

   Sheets land in `<out>/sheets/`, videos in `<out>/rendered/motion/`, the cut
   check in `<out>/rendered/cut-check/`, numbers in `<out>/summary.json`. Needs
   Xcode's `swiftc`, ImageMagick (`magick`) and `ffmpeg` with libx264. The whole
   run draws about 15,000 frames, a few minutes on an M-series Mac.

## Android (GLES)

`gles.mjs` draws the same prepared frames with the Android shader and the Kotlin
swap look, then compares every frame with Metal. Every Android input comes from
the real Kotlin objects: a temporary unit test outside the repository, added to
the generated Android project through a Gradle init script, writes
`OverlayShader`'s strings, the baseline ref's `OverlayShader`, and each frame's
words from `OverlaySwapLook.Frame.encode`. `gles-look.cpp` renders offscreen on an
Android emulator's GLES 3.1 (ANGLE on SwiftShader, so on this Mac's CPU). Android
draws with two programs, as `OverlayRenderer` does: a frame with look words uses
the look program (`OverlayShader.lookFragment`), any other the base program
(`OverlayShader.fragment`, main's source byte for byte). It reports, per frame,
the largest channel error, pixels off by more than one byte, pixels changed at
all, how many pixels the look itself changes on Metal (so a match means
something), and whether Swift's and Kotlin's look words are the same. The three
worst frames are saved as Metal, GLES and 32× difference images. With `--golden`,
it also renders the Aura transition golden's 42 samples through the shader at
`--baseline`, today's base program and today's look program with no look: every
byte must match.

`--endpoints` is the GLES twin of the Metal `endpoints` check: every pair I's
sheets draw, as a look frame at W = (1, 0) and (0, 1) through the look program,
against the still frame of that climb through the base program, pixel for pixel.
It needs no Metal; numbers land in `<out>/endpoints.json`, and any difference
exits non-zero.

1. Generate the Android project (`packages/mobile/android`, gitignored) with
   `vp exec expo prebuild --platform android --no-install` in `packages/mobile`,
   with `JAVA_HOME` and `ANDROID_HOME` from `vp run mobile:android-doctor`.
2. Boot an arm64 emulator with `-gpu swiftshader_indirect` and note its serial.
3. Run (about 2 s a frame; the default is variant I's 1× track and its five sheets):

   ```sh
   vp exec node scripts/board-motion-preview/gles.mjs \
     --work ~/.cache/claude-tmp/board-motion-lab/preview-work \
     --out ~/.cache/claude-tmp/board-motion-lab/gles \
     --android-project packages/mobile/android --ndk <sdk>/ndk/<version> \
     --adb <sdk>/platform-tools/adb --serial emulator-5554 \
     --golden <aura-transition-golden work dir>
   ```

   `--ids` takes other tracks and sheets (comma-separated); `--words-only` skips
   the emulator and compares only the look words, for any number of frames. Each
   frame is 6.5 MB on the emulator, so keep a run under its free `/data` space.
   Numbers land in `<out>/compare/compare.json` and `<out>/gles-parity.json`.

This is emulator evidence: it shows the GLES source and the Kotlin math draw
what Metal draws. It says nothing about a phone's driver or frame times.

## What it does not show

Frame pacing and hitches, display scale, and the phone's GPU. Judge motion in
the lab on a phone; use these to see what a look draws at each moment.
