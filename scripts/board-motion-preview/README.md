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

## What it does not show

Frame pacing and hitches, display scale, and the phone's GPU. Judge motion in
the lab on a phone; use these to see what a look draws at each moment.
