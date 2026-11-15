# GPU climb overlay experiment (#7431)

This is an iOS development-build experiment, reached through Stories → GPU climb overlay → Kilter Homewall parity (`gpu-climb-overlay--parity`). It leaves the player, create editor, thumbnails, and share cards on their current renderer.

For repeatable capture, the story URL accepts `gpu=1`, `sample=0` through `4`, `resolution=512|768|1024`, `mode=compare|rust|metal`, and `verify=1`. Invalid inputs use the normal defaults; the unparameterized story keeps GPU drawing off. `verify=1` runs one pixel comparison after that request is ready and logs its metrics and PNG paths with the `[gpu-climb-parity]` prefix. The story harness's `theme=light|dark` parameter sets appearance.

## What the screen compares

Both sides receive identical Rust render configuration for Kilter Homewall layout 8, size 17, sets 26 and 27: real catalogue placements and traced silhouettes, the current shared Aura defaults, and the current light/dark veil. The test climbs are synthetic selections of real holds; they are never saved to the account. Five samples cover six spread holds, 30 spread holds, adjacent same-colour holds, adjacent different-colour holds, and an empty climb.

The positive `gpu-climb-overlay-experiment` flag is local to this story and starts off. Its switch enables the optional native view. A missing native module or rendering error shows the matching Rust image. This is a still prototype: there is no animation loop, breathing, or glide. The story disables drawing on route blur; the native view also handles application/window inactivity.

The initial output width is 768 pixels. The resolution button cycles through 512, 768, and 1024 pixels; both renderers receive the same resolution. A native memory-budget failure is reported and falls back to Rust. This experiment does not establish sharpness under pinch zoom or production rendering speed.

## Read the measurements correctly

Use **Mode: rust** or **Mode: metal** to run one renderer at a time. **Mode: compare** draws both and is for appearance; its timings include competing work. The screen retains the latest 100 sample records, with a **Share measurements** button for the JSON and **Reset readings** for a new sitting.

After the requested render completes, **Validate pixels** makes an offscreen Rust/Metal comparison at the same atlas resolution. The native view pauses while this runs. It reports maximum RGBA channel error, RMSE, and how many pixels differ by more than one byte, and saves both PNGs for inspection. The exported measurements include the snapshot paths and comparison result. These CPU/GPU compute timings exclude the normal PNG display path.

- **Rust API / PNG ready** includes the native API round trip, cache lookup, and any needed render/PNG encode/write. **Fresh Rust PNG** uses a new experiment-owned cache key. **Repeat cached key** reuses the key; the first such request may still miss.
- **Rust image onLoad** is the image-load callback measured from the same request start. It is not a compositor presentation timestamp.
- **Metal callback** is the native ready event round trip. **Atlas prepare**, **upload**, and **GPU** describe native stages; the atlas hit flag and resident byte count distinguish preparation from reuse. Relaunch the app for a cold in-process atlas.
- These story readings do not measure the production render scheduler, the player's gestures, or the create editor's tap-to-paint latency. Use the probes in `mobile-visible-performance.md` for those.

Record device, OS/build, output resolution, thermal state, power mode, whether the phone is charging, and sample counts alongside exported results. Compare alternating isolated Rust and Metal runs in the same sitting. iPhone 17 Pro evidence is preliminary; the issue's iPhone 13 Pro comparison remains a separate device run. Simulator images prove appearance only.

## Decision gate

Keep screenshots and exported measurements with the PR evidence. Compare silhouette edges, same-colour merging, different-colour seams, antialias coverage, and veil in both schemes. Report errors and unverified checks explicitly. Decide whether player or editor integration is worthwhile after this evidence; do not infer a production speedup from the existence of the shader.

An Android implementation would need a native drawing surface, equivalent resource preparation/cache and lifecycle handling, plus matching shader math (Vulkan/AGSL or a portable wgpu backend). A wgpu path would also need Rust/native surface ownership, shader/backend packaging, binary-size measurement, and parity checks. Neither ships in this slice.
