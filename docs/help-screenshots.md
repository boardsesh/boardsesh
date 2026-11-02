# Help page screenshots

## Help refresh: 2 November 2026 (#7208)

The refreshed media uses application source `3b1d9be90cf99517947b5622618df7533864708c`
from `main`, captured on 2026-11-02 (Athens). The dedicated simulator was
`Boardsesh Help 7208`: iPhone 16 Pro Max, iOS 27.0, dark appearance,
1320 × 2868. It ran a cached Debug dev-client with current Metro JavaScript,
against the local Docker database and its seeded test user. No production
account was changed.

The existing screenshot-mode fake Bluetooth adapter supplied the board link.
These are captures of the real app controls and state changes, **not physical
Bluetooth delivery tests**. The cached widget's native source provenance was
not verified, so none of these captures establishes the current Live Activity
appearance.

| Requested media | Disposition and capture contents |
| --- | --- |
| `09-board-sheet` → `board-sheet.webp` | Refreshed while driving: status line, Stop driving after, Re-light, Turn off all lights and Disconnect. |
| `10-board-view` → `board-view.webp` | Refreshed open-ended drive; the separate timed-drive clip demonstrates a Put on board tap and its clock. |
| `11-climb-actions` → `climb-actions.webp` | Refreshed lifted row above the dimmed list with the native menu; no Preview or Add to queue row. |
| `preview-browsing` | Re-recorded from a tracked row and one board swipe; closes on the verified last-look MiniPlayer. A simultaneous wall-header capsule comparison is not shown; the preview still's back chip provides the wall reference. |
| `wall-swipe-to-drive` | Re-recorded: flat amber swipe, open-ended frost, board swipe and tap to stop. |
| `long-press-climb-actions` | Re-recorded with both the row hold and ⋯ opening the lifted menu. |
| `remove-from-playlist` | Re-recorded with the current menu and playlist sheet coordinates. Local playlist membership was removed and restored within the take. |
| `start-playlist-queue` | Re-recorded with the compatible local Aurora Circuit 5 list: header Play opens the three-way prompt through the same first-climb activation callback; Cancel opens a preview. The playlist-loading switch was verified on and Up next was nonempty. |
| `swipe-row-queue-playlist` | Re-recorded in this session with current row actions and toast. |
| `docs/images/list-model/player-browsing.png` | Replacement uses the tracked-row preview with the wordless chip, Preview · not on the wall caption and plain Put on board. |
| `docs/images/wall-button-states.png` | Replacement montage covers plain controls, preview, open-ended frost and the timed drive. |
| `docs/images/7113/swipe-to-drive-*.png` | Current dark-state references replaced from this session's button swipe and timed drive. Older light/workout references are retired from current guidance and retained as historical files. |
| `put-on-board-timed-drive` | New take: tap Put on board, clock and shrinking frost, board swipe to refill, then tap to stop. |
| `mini-player-last-look` | Covered by the end of `preview-browsing`; no duplicate standalone clip. The simultaneous wall-header comparison is deliberately omitted. |
| `15-board-lighting` → `board-lighting.webp` | New Settings › Board lighting still via `?section=lighting`. Tension is active, so the conditional MoonBoard row is absent. Always drive the wall replaces the older Light automatically controls (#7218). |
| `12-preview` → `preview.webp` | New shipped still from a tracked-row preview and swipe, visually checked for the preview caption and plain button. The old same-first-climb deep-link capture is not used. |
| One-time preview-first card | Deliberately omitted: the steady-state captures mark the notice seen; no new runtime override was added to force it unseen. |
| Select Board picker | Deliberately omitted: no new runtime override was added to force the fake-adapter picker. |
| Live Activity and mini-player drive ring | Deliberately omitted: the cached widget's native source provenance is unverified, and a solo fake-Bluetooth drive is not an activity session. The separate mini-player drive ring was not captured; the last-look MiniPlayer is visible in `preview-browsing`. |

All seven refreshed clips are converted with posters. Each final clip is
12.0 seconds, and the largest encoding is 717 KB: every file is below the
1.5 MB budget. The source movies were normalized to constant frame rate, then
idle portions were cut; every retained segment plays at 1×. The timed-drive
cut skips idle countdown time without speeding up its clock. The playlist-start
clip holds its actual final preview frame for 1.5 seconds, with no UI compositing
or speedup. Normalized edited inputs are retained in the default `raw` directory
for reconversion; original recordings remain local in `uncut` and `cfr`. The
[source cut log](help-clips.md#source-cut-log) records the original-CFR offsets.
Final visual QA passed, including the timed stop and Cancel opening the fully painted preview.

Raw captures from this session remain local. The immutable download links below
and `help-screenshots.json` still describe the older **published raw batch**;
they are not links to this refresh. Run `help:publish-shots` with configured
`DEV_*` credentials to publish a replacement raw batch.

## Historical capture: 31 October 2026

The previous driving player, Board controls and preview example used source
`3c4fd3702d`, captured on an iPhone 16 Pro Max simulator, dark appearance,
1320 × 2868. They predated #7170 (frost only while driving) and #7188
(preview-first lighting, wordless back chip, timed drives and last-look
MiniPlayer), and have been superseded by the refresh above. The older published
raw links are retained for provenance.

## Published raw captures

Generated by `vp run help:publish-shots`. The raw PNGs live in the public `dev`
object-storage bucket and are ignored by Git; only this index and the shipped
webp assets are committed.

`vp run help:publish-shots` uploads every PNG in the capture directory, verifies
each public download checksum, and rewrites `help-screenshots.json` and this file.
The index is written once, after every upload succeeds, so a failed run leaves the
previous links intact. A run prunes entries whose source PNG is gone; stored
objects are retained, and content-hashed keys keep shared links stable.

`vp run help:convert-shots` turns the same directory into
`packages/web/public/images/help/<name>.webp`. It requires the complete set and
names every absent capture rather than shipping a short one.

Gestures a still cannot teach — a long press, a swipe, a drag across the board —
ship as short silent screen recordings instead, through a separate pipeline:
`vp run help:convert-clips`, documented in [help-clips.md](help-clips.md). Those
are simulator `recordVideo` captures rather than Maestro shots, and they never
pass through this index.

Add the variables from `.env.dev-artifacts.example` to the repository root’s
ignored `.env.local`, then fill in the dev bucket credentials. These commands use
only `DEV_*` storage variables, never production media credentials.

| Capture | Ships as | Size | Shot |
| --- | --- | ---: | --- |
| `01-discover.png` | `discover.webp` | 490 KB | [Open shot](https://pub-ce4091dbd55b4b71b1c59a2461a28360.r2.dev/help-shots/01-discover/fdc7568e64c38a8617353a0c57407af8617d542dbbfae6f8fdf2dbac300bd473.png) |
| `02-playlist-detail.png` | `playlist-detail.webp` | 1331 KB | [Open shot](https://pub-ce4091dbd55b4b71b1c59a2461a28360.r2.dev/help-shots/02-playlist-detail/aa31f4b1951f8368a796066e7da3110726d4f74eeeb941c0df83820404ae9b77.png) |
| `03-home-live.png` | `live-sessions.webp` | 600 KB | [Open shot](https://pub-ce4091dbd55b4b71b1c59a2461a28360.r2.dev/help-shots/03-home-live/93205cfd82dbb6e069922d824dbc17ed89dd7eb4bbbf284baf98c39bca300b9a.png) |
| `04-session-detail.png` | `session-detail.webp` | 380 KB | [Open shot](https://pub-ce4091dbd55b4b71b1c59a2461a28360.r2.dev/help-shots/04-session-detail/327e872a3104fa8805ed73fba1857200ee0c562db73122b464ab814194fcbd80.png) |
| `05-holds-filter.png` | — | 1908 KB | [Open shot](https://pub-ce4091dbd55b4b71b1c59a2461a28360.r2.dev/help-shots/05-holds-filter/56c4e56e13741962b291a94ebfc5223d349f483f5fe0a2bfda0bf5b51d41ef70.png) |
| `06-zone-filter.png` | — | 2356 KB | [Open shot](https://pub-ce4091dbd55b4b71b1c59a2461a28360.r2.dev/help-shots/06-zone-filter/70066ce65f5eed85cb6cd33f3a7168519588885d10caffe2bf47826f830dae48.png) |
| `07-setters.png` | `setters.webp` | 270 KB | [Open shot](https://pub-ce4091dbd55b4b71b1c59a2461a28360.r2.dev/help-shots/07-setters/f7a5ac7f538aa4494d4a874d1112deef97441bab7f276b952be3c5c12679966a.png) |
| `08-logbook.png` | `logbook.webp` | 536 KB | [Open shot](https://pub-ce4091dbd55b4b71b1c59a2461a28360.r2.dev/help-shots/08-logbook/30da2a471b9102f2fa0854d87882eb09bed5fa88208ecb8f9458f28080c5f915.png) |
| `09-board-sheet.png` | `board-sheet.webp` | 668 KB | [Open shot](https://pub-ce4091dbd55b4b71b1c59a2461a28360.r2.dev/help-shots/09-board-sheet/a628b9d4bdbf566a852898dd336801f207bef47ca1d78eba068e9c4244f542a3.png) |
| `10-board-view.png` | `board-view.webp` | 2047 KB | [Open shot](https://pub-ce4091dbd55b4b71b1c59a2461a28360.r2.dev/help-shots/10-board-view/d6a19116471423a64f6c16ce6bb010db888f46f73f0caa774b54f7467d67df57.png) |
| `11-climb-actions.png` | `climb-actions.webp` | 1082 KB | [Open shot](https://pub-ce4091dbd55b4b71b1c59a2461a28360.r2.dev/help-shots/11-climb-actions/88e2910edf39058058fde2125a2e5ef42e4961ae4d686ef77cb7b54835965450.png) |
| `12-preview.png` | — | 2047 KB | [Open shot](https://pub-ce4091dbd55b4b71b1c59a2461a28360.r2.dev/help-shots/12-preview/9cf5d01d0c22f477ca6f893b09591187099bba413f8779f20b076ac52e76abc3.png) |
