# Quantum Aura simulator evidence

Captured on 28 November 2026 using an iPhone 16 Pro Max simulator, iOS 26.5.
The after captures exercise **native API1 / Rust PNG Aura fallback**. They do not
verify physical-device Metal/GLES presentation or BLE.

Before: `fb51eb22fd`, the legacy Quantum SVG-circle renderer. After runtime
checkpoint: `ce0bf69b8a`, with Aura, silhouettes, `softDisc=false` and default
`glowReach=1`. The real player/carousel, climb-list and interactive-editor views
use deterministic sample climbs on the bundled Quantum geometry. Both feature
flags are supplied as enabled. These are view fixtures, not backend recordings.

| Model | Player, list and editor: before / after |
| --- | --- |
| XL | [Contact sheet](xl.webp) |
| L | [Contact sheet](l.webp) |
| M | [Contact sheet](m.webp) |
| S Fitness | [Contact sheet](s.webp) |

[Heatmap comparison](s-heatmap.webp) shows baseline dots becoming filled physical
hold silhouettes. [Scaled editor tap](xl-editor-tap.webp) shows a real tap at
`(78,340)` device points hitting the expected XL hold `1002092` on the
`1536×1552` canvas; that previously unlit hold gains its cyan silhouette glow.

[Ten XL swipes](xl-ten-swipes.mp4) records all ten next-problem and painted-overlay
assertions passing, ending at circuit 11. The wall and silhouette marks remain
visible through the recorded transitions; no circle fallback was observed.
The 19.383-second raw recording contains 767 decoded frames. A board-only color
probe, excluding the logo and chrome, found no frame without role-colored pixels
(minimum 621 at 408×366). The MP4 is a 660×1434, 30 fps review copy.

The default reach remained clearly visible on XL and the larger S Fitness holds,
so Quantum keeps scale 1.0. The disposable simulator's original circle preference
was saved, changed only through the public hold-shape settings API, and restored;
the complete restored settings match the saved settings exactly. The temporary
preference-changing setup story was removed. No application data was wiped.

`vp run check:mobile-simulator` passed with the matching rebuilt Debug client and
30 seconds of device logs; `vp run mobile:screenshot` also passed. The screenshot
Metro session was stopped after QA. Raw image hashes and media hashes are in
[manifest.json](manifest.json).
