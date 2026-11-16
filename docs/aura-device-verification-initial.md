# Initial device verification: candidate rejected

The initial candidate reduces memory but fails performance acceptance. Pixel FrameTimeline shows more app deadline misses and longer tail frame durations; iPhone ready-command GPU samples also rise. Preserve this initial-source evidence and re-register verification for the optimized candidate.

The [structured initial measurements](aura-device-verification-initial.json) retain the full sample and hash provenance. See [current verification status](aura-device-verification.md) for the replacement candidate.

## Primary observations

### Google Pixel 8 Pro · Android16/API36

| Member | Peak RSS MiB | Open callback / live-art ms | Swipe CPU s | Edit CPU s | Warm callback swipe / edit ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| A1 | 912.42 | 639.11 / 695.67 | 34.609 | 12.410 | 78.77 / 50.23 |
| B1 | 835.14 | 740.13 / 786.12 | 33.801 | 11.770 | 89.91 / 85.38 |
| A2 | 952.33 | 646.99 / 705.86 | 35.447 | 12.063 | 74.32 / 52.62 |
| B2 | 854.66 | 752.49 / 813.68 | 34.145 | 12.168 | 89.35 / 87.38 |
| A3 | 924.63 | 669.26 / 719.14 | 36.915 | 12.104 | 75.09 / 48.61 |
| B3 | 820.61 | 727.18 / 776.61 | 34.070 | 11.123 | 85.02 / 82.87 |

| Measure | Baseline median [range] | Candidate median [range] | Paired B−A median [range] |
| --- | ---: | ---: | ---: |
| Peak RSS MiB | 924.63 [912.42, 952.33] | 835.14 [820.61, 854.66] | -97.67 [-104.02, -77.28] |
| Open GPU callback ms | 646.99 [639.11, 669.26] | 740.13 [727.18, 752.49] | 101.02 [57.92, 105.50] |
| Open live-art ms | 705.86 [695.67, 719.14] | 786.12 [776.61, 813.68] | 90.45 [57.47, 107.82] |
| Swipe CPU s | 35.45 [34.61, 36.91] | 34.07 [33.80, 34.15] | -1.30 [-2.84, -0.81] |
| Edit CPU s | 12.10 [12.06, 12.41] | 11.77 [11.12, 12.17] | -0.64 [-0.98, 0.10] |
| Warm swipe callback mean ms | 75.09 [74.32, 78.77] | 89.35 [85.02, 89.91] | 11.14 [9.93, 15.03] |
| Warm edit callback mean ms | 50.23 [48.61, 52.62] | 85.38 [82.87, 87.38] | 34.76 [34.26, 35.16] |
| Warm swipe live-art mean ms | 103.44 [101.12, 105.95] | 118.11 [115.25, 119.37] | 13.42 [11.81, 16.99] |
| Warm edit live-art mean ms | 82.60 [78.90, 82.87] | 113.14 [112.43, 114.83] | 32.23 [29.57, 34.24] |

One excluded complete swipe/editor tour per process, followed by one measured tour.

### iPhone13Pro · iOS26.6.1

| Member | Peak RSS MiB | Open callback / live-art ms | Swipe CPU s | Edit CPU s | Warm callback swipe / edit ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| A1 | 788.56 | 1066.10 / 1087.23 | 14.652 | 9.296 | 71.13 / 31.91 |
| B1 | 510.62 | 1099.46 / 1112.67 | 14.072 | 9.168 | 79.28 / 45.32 |
| A2 | 809.09 | 1029.60 / 1043.97 | 14.733 | 9.267 | 65.32 / 30.07 |
| B2 | 530.28 | 1057.06 / 1078.74 | 14.090 | 9.229 | 84.74 / 44.13 |
| A3 | 771.44 | 993.36 / 1009.73 | 14.767 | 9.208 | 66.29 / 28.66 |
| B3 | 531.42 | 1083.58 / 1098.05 | 14.056 | 9.184 | 84.80 / 44.13 |

| Measure | Baseline median [range] | Candidate median [range] | Paired B−A median [range] |
| --- | ---: | ---: | ---: |
| Peak RSS MiB | 788.56 [771.44, 809.09] | 530.28 [510.62, 531.42] | -277.94 [-278.81, -240.02] |
| Open GPU callback ms | 1029.60 [993.36, 1066.10] | 1083.58 [1057.06, 1099.46] | 33.36 [27.46, 90.21] |
| Open live-art ms | 1043.97 [1009.73, 1087.23] | 1098.05 [1078.74, 1112.67] | 34.77 [25.44, 88.32] |
| Swipe CPU s | 14.73 [14.65, 14.77] | 14.07 [14.06, 14.09] | -0.64 [-0.71, -0.58] |
| Edit CPU s | 9.27 [9.21, 9.30] | 9.18 [9.17, 9.23] | -0.04 [-0.13, -0.02] |
| Warm swipe callback mean ms | 66.29 [65.32, 71.13] | 84.74 [79.28, 84.80] | 18.51 [8.15, 19.42] |
| Warm edit callback mean ms | 30.07 [28.66, 31.91] | 44.13 [44.13, 45.32] | 14.06 [13.42, 15.48] |
| Warm swipe live-art mean ms | 91.90 [89.89, 94.51] | 106.52 [100.83, 108.90] | 16.62 [6.32, 17.00] |
| Warm edit live-art mean ms | 47.84 [47.64, 51.79] | 64.21 [61.31, 65.00] | 13.47 [12.42, 17.36] |
| Swipe ready-command GPU mean ms | 6.26 [5.47, 7.02] | 30.30 [27.17, 31.03] | 23.28 [20.91, 25.56] |
| Edit ready-command GPU mean ms | 11.01 [10.96, 11.48] | 25.98 [24.59, 26.39] | 14.50 [13.63, 15.39] |

No separate harness warmup cycle. The fixed WDA flow settles player/editor before warm segments; one setup swipe to the editor climb is outside the measured swipe segment.

Each phone completed three alternating A/B pairs: 30 measured swipes and 24 measured editor changes per build. Across all 12 members, every measured change hit the atlas: 216 hits, zero misses/uploads/failures or replay misses, and 216 guarded full-art events. These are measured counts; excluded setup and diagnostic actions are separate.

Pixel payloads are A 91,002,920bytes/player and 81,054,780bytes/editor versus B 56,822,920bytes/both. iPhone payloads are A 112,790,176bytes/player and 87,627,168bytes/editor versus B 56,822,920bytes/both. Payloads are not aggregate GPU allocations. Both primary sources share the reviewed bundled-photo correction.

## Frame evidence

| Pixel ten-swipe trace | Baseline A | Initial candidate B |
| --- | ---: | ---: |
| Qualified app frames | 787 | 419 |
| App deadline misses | 86 (10.93%) | 134 (31.98%) |
| App-frame P50 | 7.80 ms | 8.78 ms |
| App-frame P95 | 24.41 ms | 79.74 ms |

Each admitted native PID maps to one MainActivity surface. All unique surface frames fall within the native BOOTTIME gesture window and match independent gfxinfo rendered counts. BOOTTIME snapshot offsets are zero. The dedicated FrameTimeline buffer has zero overwrites, discards or data loss. The scheduling ring overwrote older chunks (A 16,351,232 bytes; B 32,768 bytes), limiting scheduling attribution without invalidating FrameTimeline. The common protocol binds identical flow/config hashes, exactly ten swipes per build, no extra conditioning swipe tour, and a fixed two-second final settle. Quantiles use linear interpolation at (n − 1)q over individual app-frame slices. These are not average FPS, physical scanout or isolated shader timings.

iPhone native frame evidence is unavailable: two scheduled host recorder attempts and one escalated attachment diagnostic failed before recording. This is a recorder/tool failure, not an observed app failure. Its GPU figures above are Metal command-buffer samples from requests that reported ready; they are not all motion frames, presented FPS, P95 or Instruments hitches.

The printed 4,950 ms GPU histogram entry is an overflow bucket, not an exact 4.95 second GPU latency. [AOSP ProfileData.cpp](https://android.googlesource.com/platform/frameworks/base/+/b01edb92b711/libs/hwui/ProfileData.cpp) clamps samples of 25 ms or more into that bucket.

## Provenance and limits

| Device/build | Source | Artifact SHA-256 | Embedded bundle SHA-256 |
| --- | --- | --- | --- |
| android/A | `f4d12c848e7eca71cf1b612228d732458422fc36` | `e20cdbfd28a1fb34b039b85691b6edda6c7d600f750515d864327a9f1d1bcc1d` | `9523bbfd330758a6d41f9523e3705b04f6370950bf641d48488725d64b9384eb` |
| android/B | `d0f4816a0c7afb16f33652bdd8e8173bf6b03b7a` | `2517f896d7f5a67cad76f95bc68d404453d3968ac8087b0bbbdbfe4d6df90d11` | `835acb0f8018f5bb4a4c20acac38914cb951500e1786d5a088b37b97a26cb935` |
| ios/A | `f4d12c848e7eca71cf1b612228d732458422fc36` | `0059f6246ffe7684632b14c04bf9364a1450a573e1c6ed5f3b36e1b1d17401aa` | `c00024a1fb74a5cd5eab40c84c11ba612e6a84b8300605e2046ab9b6d6114aac` |
| ios/B | `29375f1c5c7fcbbf3621342266e7705cea587a08` | `6cf7d8ca72a83a38494e9b0d2032ee0ab359d9b3f2b1eeaec2b52b083f63df74` | `904929bca207a5426174fac7e6f8a68f4902c08ac2a088d003b0667902545ce1` |

All primary builds use instrumentation `433827c3c4798674537db053c17966aae283d1f310a33a5fcb722dcab253e276` and synthetic replay fixture `5dcf9ab9e545fab56b9049ccc6052e2cc25ff20ea55d17297ebf580fd64ee686`. The companion JSON includes build, flow, registration, trace/config/protocol and analysis-tool hashes. Android D0 is the measured source; its runtime is identical to the Android tree in the initial iOS-corrected 293 source. Raw phone identifiers, accounts, board UUIDs, traces and diagnostics remain private local evidence.

The platforms use different drivers and setup: compare within each phone, not across phones. Peak RSS is an absolute process high-water value, not growth or total driver footprint. Callback and guarded live-art values are proxies, not physical scanout or first PNG-bridge visibility; warm means are not P95. CPU includes the driven UI/accessibility/settling workload. Baseline fields are viewport-sized, while the candidate uses native 1080×1504 fields, so the comparison measures product behavior rather than packing alone. Three pairs without an A/A noise distribution do not establish population performance.

Host evidence covers still/pulse and semantic reveal/role/mirror checks. Rust pixel parity for animation that unions old/new scenes is **not established here**. No physical 211-case catalogue oracle, final local-prebuilt claim, or reduced-motion secondary acceptance is included for this rejected source. Resolution and the 128 MiB admission budget are unchanged; the one-byte pixel tolerance was not widened. A future shader/source change needs separate, newly preregistered paired verification.
