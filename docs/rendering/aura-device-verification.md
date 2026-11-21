# Aura device verification

The initial candidate was rejected for a real performance regression. The optimized replacement, `4b41371cf75848efe6c382302056ebaa67279f20`, subsequently passed the registered Pixel app-frame and iPhone GPU-command comparisons against the common photo correction baseline, `f4d12c848e7eca71cf1b612228d732458422fc36`. Both phones also completed three alternating primary pairs. These are historical, source-scoped results: the newer role-metadata fix and main-branch integration still require fresh native builds and phone verification before rollout acceptance. Full samples and provenance are in [the structured report](aura-device-verification.json).

## Optimized replacement: phone rendering observations

| Physical measurement | Matched baseline | Optimized replacement |
| --- | ---: | ---: |
| Pixel app deadline misses, ten swipes | 97/778 frames (12.47%) | 34/919 frames (3.70%) |
| Pixel app-frame P95 | 25.35 ms | 15.79 ms |
| iPhone GPU-command duration, 20 matched gestures | Reference | All 20 mean and P95 differences improved |

The Pixel run passed the unchanged rule that both app-frame P95 and deadline-miss percentage must be no worse than its fresh matched baseline. Exact process/surface identity, native-window coverage and independent rendered-frame counts matched. The dedicated FrameTimeline buffer lost no data; scheduling data overwrote older chunks, and global parser info counters were 13/8 with unknown process/cause. One trace per build is limited observational evidence, not average FPS, physical scanout or population performance.

The iPhone paired median GPU-command mean and P95 differences were −16.28 and −17.96 ms. All 1,318 baseline and 1,627 candidate commands completed with GPU timings. Presentation callbacks included 87/82 zero timestamps, so all derived presentation statistics remain null. This result establishes lower measured GPU-command cost only; whole-screen cadence remains unavailable after three failed Instruments attachments. The initial presentation protocol's incomplete baseline is retained separately and is not pooled.

The separately captured Pixel player endpoints show the main-board and kickboard photographs with aligned holds. The user's subsequent “Photo and holds look correct” confirmation applies to that replacement artifact's photograph and hold alignment, not all catalogue configurations or a later build. The rejected initial-source report remains unchanged.

## Primary observations

| Physical phone | Baseline median peak process RSS | Candidate median peak process RSS |
| --- | ---: | ---: |
| USB iPhone 13 Pro, iOS 26.6.1 | 796.05 MiB | 526.78 MiB |
| Pixel 8 Pro, Android 16/API 36 | 916.09 MiB | 819.76 MiB |

Each build completed 30 measured swipes and 24 local edit changes per phone: 54 in-memory atlas hits, zero atlas misses/uploads or rendering/replay failures, and 54 guarded full-art events. These counts exclude setup and qualification. Warm updates still write their changing descriptors and uniforms; they do not rebuild or upload atlas geometry.

These are instrumented process high-water measurements, not GPU-memory totals or an isolated packing benchmark. App data and caches survive installs; each primary member starts a fresh process. Pixel repeats one excluded full conditioning tour before its measured tour. The iPhone uses no separate harness warmup cycle: its unchanged flow settles the player/editor for ten seconds and has one excluded setup swipe. Compare within each phone, not across phones.

Startup callback medians have not improved, and no visible-startup speedup is claimed. Request-ready GPU samples, callback latency and guarded full-art RAF are not all animation frames or physical scanout. The initial and replacement candidates are never pooled. Three sequential pairs without an A/A noise distribution do not establish population performance.

The baseline uses viewport-sized fields; the replacement uses full native fields. The equal-resolution atlas result remains the separate [51-configuration census](aura-atlas-census.md): 114.58 MiB to 54.19 MiB for the reference, with no resolution reduction or larger budget.

## Regression found and corrected

The [initial candidate was rejected](aura-device-verification-initial.md): its qualified Pixel FrameTimeline run increased app deadline misses from 10.93% to 31.98% and app-frame P95 from 24.41 to 79.74 ms. Its iPhone request-ready GPU samples also increased. Missing Android photos and the iPhone allocation rejection are preserved separately from accepted measurements.

The replacement computes an immutable active stamp-layer mask once per scene, including later paint passes and annotations. Existing uniform space carries the selected mask; the shader skips entire empty layers. Pixel math, painting order, field resolution, format, the 224-byte descriptor and 144-byte uniform layout are unchanged. No extra geometry preparation is introduced.

On the M5 Max host, 631 old/new samples matched byte-for-byte, including 327 intermediate unions, 80 annotation samples, 23 positive later-pass-only samples and 161 mirrored samples. Independently rendered Rust references passed 74 still and 24 pulse comparisons within one channel byte. Intermediate union comparisons preserve frozen Metal behavior; they are not an independent Rust union oracle. One extra outline/glyph variant was rejected before drawing by the unchanged 128 MiB preparation limit.

Host GPU timings improved in the measured reference cases; they are not phone frame evidence. After committing the mask change, temporarily ignoring later subpasses made the Swift and JVM guards fail. Exact committed helpers were restored and the Swift guards and all 15 JVM tests passed.

## Evidence limits and remaining gates

The simulator native build and canonical headless startup passed. Its screenshot shows the development launcher and is not application-appearance or live-GPU evidence. All twelve iPhone player/editor endpoints were visually inspected. The Pixel primary flow captures editor endpoints only: twelve conditioning/measured screenshots across six members, with no primary player stills. All twelve Pixel editor images were inspected and show the actual main-board/kickboard photographs with aligned holds. Separate frame-run player endpoints were inspected as described above; they cannot establish every primary member's player appearance. The original primary baseline's matching dSYM is unavailable; no symbolized baseline stack attribution is claimed. The subsequent iPhone GPU-command pair retained matching symbols.

Native iPhone frame collection uses a separate temporary recorder and separately rebuilt, identically instrumented artifacts. Three Instruments attachment attempts failed before recording, including an escalated diagnostic; those attempts contain no measured frame evidence. Direct drawable presentation and completed-command GPU metrics must retain their own labels and completeness/clock/identity guards. They cannot be presented as Instruments hitches, whole-UI deadlines or physical scanout.

Both phones completed the replacement-source generated-miss, process-restart reuse, valid local prebuilt and corrupt-hash controls. Local prebuilt selection is a qualified inference from the controlled cache state; no direct source counter or CDN hit was observed. Each case had two requests/selections but one successful ready event, so its preparation timing may omit superseded work and does not establish a speedup. The iPhone generated file was independently hashed; Android Release access established expected filename and length only.

Physical iPhone parity observed all 51 defaults and four variants within one channel byte before the next glyph variant exceeded the 4 MiB CPU manifest cap. The wider cohort did not reach its final guards; the Pixel catalogue matrix did not start. Compact role references now bring all 84 host census inputs below that unchanged cap with exact pixels and descriptors, but this is not final phone parity. Fresh baseline/candidate primary pairs, Pixel frames, catalogue correctness, reduced-motion and integrated visual checks remain pending.

The [current GPU rollout](gpu-climb-overlay-experiment.md) excludes the parked CDN publication experiment. Local supplied files are not CDN-hit evidence. Reconsidering publication requires verified immutable objects and separate catalogue rollout qualification; the measurements above do not establish either.
