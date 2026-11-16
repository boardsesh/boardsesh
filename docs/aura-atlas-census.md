# Aura atlas census

All **51 catalogue layout/size configurations pass** the host size census at their native resolution, with every catalogue hold retained. The 128 MiB aggregate native GPU admission budget is unchanged. This report measures requested static buffers; it does not establish actual driver allocation, peak process memory or physical-device performance.

The Kilter Homewall reference (layout 8, size 25, 499 holds, 1080 × 1504) falls from **120,143,120 bytes / 114.58 MiB** in v1 to **56,822,920 bytes / 54.19 MiB** in v2: **52.70% fewer atlas bytes**, below the 60 MiB target. Including the LUT requests 56,823,948 static GPU bytes. Padding still accommodates the 135% editing pulse.

## Catalogue results

The complete 51-row report is [aura-atlas-census.json](aura-atlas-census.json). All sets available for each layout/size participate in this census. Selected sets assemble their own participating holds, outline cap and LED covers.

| Family | Configurations | Largest requested static GPU MiB | Largest compressed geometry MiB |
| --- | ---: | ---: | ---: |
| Kilter | 16 | 54.19 | 14.21 |
| Tension | 15 | 53.60 | 15.71 |
| Decoy | 3 | 51.40 | 15.01 |
| Touchstone | 1 | 40.14 | 10.06 |
| Grasshopper | 5 | 59.25 | 15.84 |
| SoiLL | 2 | 30.67 | 8.31 |
| MoonBoard | 7 | 18.08 | 3.63 |
| Woods | 2 | 18.26 | 2.84 |

The largest requested static allocation is **62,130,596 bytes / 59.25 MiB**, on Grasshopper layout 1, size 5. The original expanded default manifest peaks at **3,299,653 bytes**, on Kilter layout 1, size 28, below the explicit **4 MiB CPU-manifest limit**. The later [role-alias census](aura-role-alias-census.md) records current compact metadata sizes, including larger optional glyph appearances, with unchanged pixel storage and limits. The tallest native output is **2093 pixels**, on Tension layout 9, size 5; the checked height limit is 2304. No configuration is reduced in resolution.

## What the byte counts include

`atlasBytes` is immutable pixel storage: exact packed distance/coverage fields, nontransparent cropped cover/fill/outline/glyph stamps, and annotations. `assembledGpuBytes = atlasBytes + 257 × 4` adds the float falloff LUT. This is requested static buffer storage. Allocation rounding, comparison textures and active-hold descriptor buffers are excluded from this census figure. Native admission separately accounts for application-owned resources retained by caches, mounted views and in-flight work. OS drawables, driver-internal staging and resources outside this renderer are not covered by its 128 MiB budget. Each dynamic active contribution requests a **224-byte descriptor**. `manifestBytes` counts CPU-side UTF-8 JSON separately.

The selected USB iPhone 13 Pro allocates **56,836,096 bytes** for the reference's **56,822,920-byte** pixel-buffer request. Its heap estimate alone does not include that VM-page rounding. Native Metal admission conservatively rounds reservations to both the heap alignment and OS page size, retaining the actual-allocation check and the unchanged 128 MiB ceiling. This buffer accounting is not a total process-memory measurement.

The independently compressed geometry artifacts total **447,141,340 bytes / 426.43 MiB** across the catalogue. Phones retain a bounded subset under the 256 MiB download ceiling; this total is not reserved phone storage. Each artifact was generated twice and matched exactly. The shipped CDN manifest remains empty until storage and public-CDN byte verification succeeds; these host artifacts are not evidence of publication.

## Preparation and correctness evidence

The original expanded-metadata atlas run used macOS 27.0.1 arm64, Rust 1.99.1, release profile, one observation per configuration. Host `prepare_owned` times range from **28.38 to 127.29 ms**, median **80.17 ms**. The separate artifact-generator run, which also deflates chunks, writes the container and computes its metadata/hash report, ranges from **147.34 to 1861.40 ms**, median **984.29 ms**. A local persistent-cache miss also pays this encoding cost before its artifact is retained. The atlas measurement excludes input parsing and disk writes. The artifact-generator measurement includes its file write and reporting. Neither includes GPU upload, rendering or visible presentation. They are single observations from separate host runs, not an alternating device comparison.

For every configuration, an independent host check retained every third hold and reconstructed each selected field from the full-set prebuild. Both the default treatment and Outline treatment matched local preparation exactly after crop and outline-cap recalculation: **51 configurations, 5,733 fields per treatment, zero differing fields**. This proves selected-set field equivalence for those sampled subsets. It does not prove native GPU pixel parity across all themes, mirrored views, auxiliary roles or animation frames.

The host Metal matrix also covers all 51 configurations with a raw Rust oracle. Filled treatments remain on PNG: after coordinate, pass-order and integer-blending fixes, a handful of dense filled pixels still differed by two channel bytes. No tolerance was silently widened. Default glow remains eligible; the final supported-mode matrix and its limits are recorded separately.

Historical physical baseline/candidate runs have since been collected on the user-selected USB iPhone 13 Pro and Pixel 8 Pro. Those application sources precede role-alias compaction and newer photo-readiness changes on the main branch. Compact-metadata native artifacts and the integrated application need fresh alternating phone measurements, hardware pixel comparisons and visual checks. See [device verification](aura-device-verification.md) for the separate initial and optimized observations. Atlas byte savings alone do not establish final process-memory savings or a visible speedup.

## Reproduce

1. Run `vp exec node --import tsx scripts/gpu-atlas-census.ts --out /tmp/boardsesh-aura-census`. Candidate mode validates 51 configurations, native dimensions, all holds, the 4 MiB manifest cap and 128 MiB requested static-buffer cap; it records every failure and exits unsuccessfully when any check fails.
2. Add `--configs-only` to export the 51 input configurations without preparing atlases. Add `--baseline` when collecting an older renderer's unsupported-configuration results; baseline reports retain errors and never claim a passing candidate census.
3. Run `vp exec cargo run --release --manifest-path packages/board-renderer/core/Cargo.toml --example prepare_gpu_geometry -- <config.json> <output.aura>` to generate geometry from an exported configuration. Compare two runs before publishing. Generated binaries remain build artifacts.
