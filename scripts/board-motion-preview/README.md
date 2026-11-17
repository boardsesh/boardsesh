# Board motion lab previews

Renders each board motion lab variant (A, the shipped swap, and the swap-look
variants D to H) on this Mac's GPU, so a timeline can be judged without a phone.
It uses the real Metal shader (`ClimbOverlayShader.swift`), the real per-hold look
(`ClimbOverlaySwapLook.swift`), the production Rust packet encoder for the
packet and every frame's uniforms, and each variant's own driver stepped at
120 Hz. Output belongs outside the repository.

The board is the Aura transition golden's Kilter Homewall 8/25 at 1080 × 1504,
with three real recorded climbs (12 to 14 holds). The swipe drags left to the
commit distance over 400 ms and lets go; the fling lands 150 ms later. Ten frames
are kept: drag 20, 40 and 60 pt, the commit, then +40, +80, +120, +170 and
+230 ms, and rest. Each is the GPU overlay drawn over the board photo.

## Run

1. Build the host Rust examples (see `scripts/aura-transition-golden/README.md`
   step 1; only `prepare_gpu_packet` is needed here, plus the golden's own for
   step 3).
2. Step every variant and write the packet and uniforms:

   ```sh
   vp exec node --import tsx scripts/board-motion-preview/prepare.ts \
     --out ~/.cache/claude-tmp/board-motion-lab/preview-work \
     --packet-cli <target>/release/examples/prepare_gpu_packet
   ```

3. Render the frames and one contact sheet per variant. `--golden` takes a work
   directory from the Aura transition golden's `prepare.mjs` and also checks that
   the shader with no look bound is byte-identical to the shader at `--baseline`
   (default `HEAD`) on all 42 of its samples.

   ```sh
   vp exec node scripts/board-motion-preview/render.mjs \
     --work ~/.cache/claude-tmp/board-motion-lab/preview-work \
     --out ~/.cache/claude-tmp/board-motion-lab/previews \
     --golden <aura-transition-golden work dir>
   ```

   Sheets land at `<out>/<letter>-<variant>.png`, frames in `<out>/frames/`
   (`<name>.png` on the photo, `<name>-overlay.png` the overlay alone), the
   parity result in `<out>/parity/parity.json`. Needs Xcode's `swiftc` and
   ImageMagick (`magick`).

## What it does not show

Timing between the ten frames, frame pacing, re-flicks and reversals, display
scale, and the real phone's GPU. Judge motion in the lab on a phone; use these to
check that a look draws what it should at each moment.
