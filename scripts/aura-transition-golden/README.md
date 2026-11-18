# One Aura transition golden

This is one full-resolution Kilter Homewall 8/25 fixture, not a catalogue image
matrix. It compares the frozen full-scan compositor against the current tiled
compositor using actual GPU readback. Generated packets, executables and images
belong in a fresh output directory outside the repository.

`fixture.json` selects real catalogue placements and calibrated role aliases.
`prepare.mjs` reuses `buildCatalogueGpuConfig`; it does not copy hold geometry into
this directory. The fixture has two outgoing holds, three incoming holds, three
shared canonical roles and one changed canonical role. Its sources are
previous=B, current=A, next=B, at native 1080 × 1504 pixels.

`controls.json` contains exactly 42 ordered samples:

- Twenty forward/reverse samples: progress 0, .25, .5, .75, 1 and back, both display mirrors.
- Six editor stills: reaches 1, 1.175 and 1.35, both display mirrors.
- Four previous/current interiors: progress .25 and .75, both display mirrors.
- Eight wall-swap samples. Current/next at lower/upper weights (1, 0), (.4, 0),
  (.25, .3), (0, .6) and (0, 1); (.25, .3) again with the display mirrored; and
  previous/current at (.2, .4) and (0, .6). The swap's weights live in uniform
  `viewport.zw` and its mode in `motion.z`.
- Four shared-hold samples (native API 7), current/next at lower/upper/shared
  weights (.4, 0, .4), (.25, .3, .4), (0, .6, .6) and (1, 0, 0). The shared weight
  lives in uniform `tuning2.w`; the other swap samples leave it at 1.

Since the board motion lab's swap look, the shader also reads fragment buffer 5
(the look's header). `MetalGolden.swift` binds it as zero, which is the API 7 path
the 42 samples check; `scripts/board-motion-preview` renders the look itself.

The transition packet retains the mixed edit baseline. The editor subcase uses a
second real Rust Plan with every current hold marked changed. It must reuse the
same chunks and tile resources. This makes the production Rust renderer's global
reach setting a valid independent pulse oracle; it does not pretend that global
reach represents a mixed changed-hold mask. The independent byte encoder and Rust
unit guards cover the mixed mask. Interior transition reach stays at 1.

Four production Rust images cover the still endpoints and editor reaches.
Sixteen sampled controls each check both old and new GPU output against a Rust
image, including the swap's settled (1, 0) and (0, 1) samples. Interior animation
images compare the old weighted union against the new weighted union; they are
not called Rust animation parity. Display mirror changes reveal direction for the
wipe and nothing for the swap. Physical placement mirroring is separate
native/unit coverage.

The frozen full-scan references carry two reviewed amendments: the same swap
branch in `reveal_weight`, between `// Wall-swap amendment` and
`// End wall-swap amendment.`, and the shared-hold weight just above the
shared-hold line, between `// Shared-dip amendment` and
`// End shared-dip amendment.`. Each is recorded in `reference/provenance.json`
with its pre-amendment hashes. `guards.test.mjs` deletes the blocks newest first
and checks each pre-amendment file comes back exactly, so nothing else in the
oracle can change quietly. The wipe path is untouched, so wipe samples still render the frozen
pixels. Because the block copies the production branch, the old/new comparison
only checks the tiled compositor against a full scan for the swap samples.

The swap's arithmetic is checked on its own, against the two Rust stills and the
fixture's hold classes (`swapClassChecks` in `analyse.mjs`). Inside the bounds of
holds only one side lights, away from every other hold's reach, a side at weight 0
must match the other side's still within one byte, and a side at weight w must
move the pixels from the other still toward its own by w, within 0.08. Shared
holds, where the two stills agree exactly, must match within one byte when whole.
At a shared weight w below 1 they are measured the same way inside their own
bounds, away from other holds' reach: from the bare veil (all a hold at weight 0
leaves) toward the stills by w, and at 0 within one byte of the veil. A shader
that swapped the lower and upper weights, left shared holds whole or gave them a
side's weight fails these checks.

## Prepare and run

1. Build the host-only Rust examples. This does not rebuild native archives.

   ```sh
   vp exec rustup run 1.98.0 cargo build --release \
     --manifest-path packages/board-renderer/core/Cargo.toml \
     --example prepare_gpu_atlas --example prepare_gpu_packet \
     --example render_overlay --example generate_gpu_packet_contract \
     --target-dir /tmp/aura-transition-rust
   ```

2. Generate the fixture, checked packet bytes and independent Rust oracles.

   ```sh
   vp exec node --import tsx scripts/aura-transition-golden/prepare.mjs \
     --out /tmp/aura-transition-run \
     --packet-cli /tmp/aura-transition-rust/release/examples/prepare_gpu_packet \
     --atlas-cli /tmp/aura-transition-rust/release/examples/prepare_gpu_atlas \
     --render-cli /tmp/aura-transition-rust/release/examples/render_overlay
   ```

3. Compile the macOS Metal preflight, review its receipt, then execute explicitly.

   ```sh
   vp exec node scripts/aura-transition-golden/metal.mjs --work /tmp/aura-transition-run
   vp exec node scripts/aura-transition-golden/metal.mjs --work /tmp/aura-transition-run --execute yes
   ```

4. Build the Android offscreen helper with actual compiled Kotlin shader strings.

   ```sh
   vp exec node scripts/aura-transition-golden/gles-build.mjs \
     --work /tmp/aura-transition-run --ndk /path/to/android-ndk \
     --contract-cli /tmp/aura-transition-rust/release/examples/generate_gpu_packet_contract \
     --android-project /path/to/generated/mobile/android
   ```

   This adds a temporary test source through an external Gradle init script;
   production native files stay untouched. An existing reviewed runtime export
   can instead be supplied with `--runtime-shaders /path/to/export`. Its receipt
   must bind the actual current `OverlayShader.kt`, generated layout, and emitted
   vertex/fragment strings. Manual Kotlin-string interpolation is not accepted.

5. Register the exact physical device before execution.

   ```sh
   vp exec node scripts/aura-transition-golden/gles-run.mjs \
     --work /tmp/aura-transition-run --adb /path/to/adb \
     --serial EXACT_USB_SERIAL --model 'Exact device model'
   ```

   Registration performs no device action. Review the source, build, input hashes
   and device scope. Preserve the proposal, then freeze `APPROVED_FROZEN` with
   `rootPhaseGrant: true` and record the approved registration hash. Only then run
   the same driver with `--work /tmp/aura-transition-run --execute yes`. A failed
   attempt is never resumed: retain its files and use a fresh reviewed directory.

The connected GLES helper creates only a fresh
`/data/local/tmp/boardsesh-aura-lazy-golden-<12 hex digits>` directory. It does not
install an app, change settings, clear data or use the network. It checks exact
USB model/serial, temperature at most 35°C, thermal status zero, every transferred
input and ELF hash before/after, actual hardware GLES 3.1, the generated Rust
contract, native PID and all output lengths. A 150-second native alarm bounds a
lost connection. Host cleanup can signal only an exactly matched owned command
line; unreadable/offline process state is not treated as successful exit. Owned
files and all invalid evidence are retained.

## Physical iPhone Metal

The same `MetalGolden.run(inputURL:outputURL:)` implementation runs in a minimal,
separately audited UIKit diagnostic container. Bundle the generated `inputs/`,
`ReferenceShader.swift`, current `ClimbOverlayShader.swift` and its generated
layout. The caller runs on a serial background queue and supplies only a fresh,
reject-existing `Documents/aura-rich-golden-<run>` output path. It reads no account,
preferences or other app data, and has no networking or telemetry.

Signing, exact executable/resources, source and device identity must be reviewed
before installation. Preserve the existing profile app/data and restore the
proper primary artifact after extracting only this owned output folder. The
physical collector copies the prepared host oracles and uses `analyse.mjs` to
rehash every raw image and check all 42 old/new pairs and 16 oracle-linked controls.
Host Metal is useful preflight; it never substitutes for physical iPhone evidence.
`EmitMetalShaders.swift` can independently evaluate and hash the exact compiled
Swift shader strings for comparison with each run's reported runtime hashes.

## Acceptance and evidence

Maximum channel error remains 1, with zero pixels over 1, at unchanged native
resolution and the existing 128 MiB application-owned GPU ceiling. Retain all 84
raw GPU images and their hashes, native source/runtime hashes, PID, contract,
input/build receipts, temperatures and failures. The host independently recomputes
the native diffs. Progress, both intermediate/peak editor reaches, mirror and
previous/current selection must change pixels. Replaying the reverse controls
must reproduce the corresponding forward images. The swap's settled samples must
reproduce the wipe's still endpoints, its mirrored sample must equal the unmirrored
one, and each change of weight must change pixels.

This fixture proves offscreen image correctness. It does not measure gesture
cadence, cancellation/lifecycle, warm geometry reuse, scanout, whole-UI frame
times, aggregate mounted-view residency or driver-private allocation. Those stay
separate native unit, live app and paired physical performance checks.

CI can run source/input guards and compile available host examples/helpers:

```sh
vp exec node --import tsx --test scripts/aura-transition-golden/guards.test.mjs
vp check scripts/aura-transition-golden
```

No passing host check is labelled physical device coverage. Frozen reference
shader provenance is in `reference/provenance.json`; updating that reference
requires an explicit review rather than silently replacing the oracle.
