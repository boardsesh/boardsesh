# Marketing campaign screenshot provenance

These 12 images are genuine native Boardsesh screenshots captured on 19 September 2026 from the merged store campaign scenario. They supply the marketing homepage and About page with separate iOS and Android previews. They contain replayed test-account activity; the shared queue is the real native queue UI backed by the recorded crew scenario.

## Sources

- App JavaScript source: commit `d70cbded942b6233783cf5d2ab6cdf4c4f44992c`, including the campaign merged in PR #5575. The native development clients loaded that checkout through Metro with screenshot mode enabled, locale `en-US`, dark appearance, and the default platform rendering variant.
- Campaign reference: [Android store gallery](https://pub-ce4091dbd55b4b71b1c59a2461a28360.r2.dev/store-screenshots/android/17e879fe779c2bcc1ad3472481a041b23415dd47ad37c2531e8fdedd84dbd1ca/index.html). These marketing files are fresh native captures of the same pinned replay scenario, not crops extracted from the framed gallery.
- Replay fixture: [`app-stores/screenshot-fixtures.json`](../../app-stores/screenshot-fixtures.json), SHA-256 `0f4f7bf934deca6654e148cae8f8ac608fc26eef964a5401e8f8ae6fa0df40d4`. The verified archive contains 274 files, is 1,571,502 bytes, and freezes activity at `2026-09-19T01:04:05.000Z`.
- iOS native client: cached `Boardsesh.app`, version `2.6.0`, build `1`; `Boardsesh.debug.dylib` SHA-256 `18b0932b0dfcd3caff4d8d4ad4bc8c034058321c74d4d0b3e361460459e3c9a9`. Captured on an iPhone 16 Pro simulator running iOS 26.5 at 1206 × 2622 pixels.
- Android native client: GitHub release [`rn-android-dev-880`](https://github.com/boardsesh/boardsesh/releases/tag/rn-android-dev-880), artifact `boardsesh-dev-android.apk`, SHA-256 `ed97598cc05f9a02036a2c01168119e2e37719e1e6ee54097c4e9187d9de803f`. Captured on the API 36 arm64 emulator at 1080 × 1920 pixels, density 420.

## Capture record

The source PNGs were captured locally through Maestro. The identifiers below are local Maestro run directories, not GitHub Actions run IDs. Working PNGs, flows, and logs are retained in the ignored `.boardsesh/marketing-campaign/` directory of the capture checkout; that directory is not a published asset store.

| Platform | Shots | Local run identifier |
| --- | --- | --- |
| iOS | Kilter, Tension, MoonBoard | `ios-primary-run/2026-09-19_141253/ios-primary` |
| iOS | Wall status | `ios-session-run/2026-09-19_141442/ios-session` |
| iOS | Shared queue | `ios-queue-run/2026-09-19_141659/ios-queue` |
| iOS | Profile, adjusted scroll position | `ios-profile-run/2026-09-19_141824/ios-profile` |
| Android | Kilter, Tension, MoonBoard, profile | `android-primary-run/2026-09-19_141306/android-primary` |
| Android | Wall status, shared queue | `android-session-run/2026-09-19_141430/android-session` |

Each original is under its run's `takeScreenshot/<platform>/<shot>.png`. The canonical working copies are `.boardsesh/marketing-campaign/native/<platform>/<shot>.png`.

The capture used the existing screenshot environment and replay backend from `scripts/mobile-screenshots.ts` and `scripts/lib/screenshot-backend.ts`. Native app code was not changed. Simulator access used the repository lease guard. App data and keychains were preserved; the Android client was upgraded with `adb install -r`.

To reproduce the surfaces, fetch the pinned fixture with `vp run mobile:screenshot-fixtures-fetch`, start the normal screenshot replay environment with `--keep-keychain`, and use a cached native development client as described in [iOS screenshot documentation](../ios-simulator-screenshots.md). Select locale `en-US`, dark appearance, and the default rendering variant. The following navigation uses existing screenshot deep links and real native controls:

1. Open `com.boardsesh.app://climbs?screenshotOpenFirst=1&screenshotBoardIndex=0`, then indices `1` and `2`, for the three board views.
2. Open the first board's list, select **Guessing Games**, close its play drawer, and capture the persistent **Lightest Pair of Shorts** wall status. The local selection and the crew's on-wall climb are intentionally different.
3. Open `com.boardsesh.app://join/00000000-0000-4000-8000-000000000101`, join **Friday board crew**, confirm two climbers, open the current climb, then expand the queue to show six climbs and the contributor avatars.
4. Open `com.boardsesh.app://profile`, scroll to `profile-board-share-chart`, and keep the nine-row board legend clear of the native navigation. On iOS the final capture moved the content downward after centering the chart.

The iOS on-wall status uses its native title chip and Marco avatar. Android uses the native **ON THE WALL · MARCO** banner. The queue shows the recorded test crew's actual native session state, including contributions by Marco and Test User. The profile chart shows 254 problems across nine board families. These are illustrative replay captures, not current live usage counts.

## Image processing and verification

Only proportional downsampling and WebP encoding were applied. The complete native screen is preserved; there are no composited controls, relabeled platforms, AI-generated pixels, or baked-in marketing frames. The website supplies any decorative framing and detail crop with CSS.

Processing used Sharp: `resize({ height: 1600, withoutEnlargement: true }).webp({ quality: 87, effort: 6 })`. iOS exports are 736 × 1600 pixels; Android exports are 900 × 1600 pixels. The English captures are reused across marketing locales, always from the selected native platform.

Every final image was decoded and visually inspected. The board holds are loaded, both queues show six climbs with contributor avatars, wall status survives browsing another climb, and each profile shows the complete board legend. The final iOS profile was recaptured by scrolling to avoid the floating navigation covering its first row.

All paths below are relative to `packages/web/public/images/app/`. Raw SHA-256 refers to the original PNG; output SHA-256 refers to the committed WebP.

| Asset | Source size | Output size | Bytes |
| --- | --- | --- | ---: |
| `ios/kilter.webp` | 1206 × 2622 | 736 × 1600 | 94,494 |
| `ios/tension.webp` | 1206 × 2622 | 736 × 1600 | 64,674 |
| `ios/moonboard.webp` | 1206 × 2622 | 736 × 1600 | 44,990 |
| `ios/queue.webp` | 1206 × 2622 | 736 × 1600 | 70,874 |
| `ios/wall-status.webp` | 1206 × 2622 | 736 × 1600 | 92,276 |
| `ios/profile.webp` | 1206 × 2622 | 736 × 1600 | 61,914 |
| `android/kilter.webp` | 1080 × 1920 | 900 × 1600 | 87,330 |
| `android/tension.webp` | 1080 × 1920 | 900 × 1600 | 76,478 |
| `android/moonboard.webp` | 1080 × 1920 | 900 × 1600 | 45,062 |
| `android/queue.webp` | 1080 × 1920 | 900 × 1600 | 87,940 |
| `android/wall-status.webp` | 1080 × 1920 | 900 × 1600 | 82,706 |
| `android/profile.webp` | 1080 × 1920 | 900 × 1600 | 56,548 |

Total: **865,286 bytes** across 12 files.

| Asset | Raw PNG SHA-256 | WebP SHA-256 |
| --- | --- | --- |
| `ios/kilter` | `597850a3b67ab821b8c43c4e568b70af46aec52d818478029b2554e416f72581` | `9589b70d12cf2546373a72f471b7c472fb42b65711d2e8401f6c7f0b97a94c80` |
| `ios/tension` | `7e4116ac664724acd2d0feaec37aabc282e0e20a97a1fce0f0f2519743c9a437` | `a315533e60a2125a59423dce763c2d038046859d408b840a3fbe93560c03dd8a` |
| `ios/moonboard` | `fd765d4f29ca1ac258b16bc37fd2e4f672072f9fcde4ada07dd085310b58bbc1` | `206dbb52767dbc289fbf5d200474e0271016362977ffedfa76af47c53d1bdac2` |
| `ios/queue` | `9698243244fdb1dfc7d6f39d4e683d7007178c4f9182433a51e0cc73c79d4c1a` | `b4fb612eea9686ce922677dd90fff9b8e117df36e2e94492ba03e0ab7731ccb3` |
| `ios/wall-status` | `fdb8eec4e899020dce2fa63c43df51c5ee83436f832c94f66e0f77d3ca33136d` | `a2e42f21aba84312a38b8968e2a6ff319c6292db4d2a8777a941bff5aacc6e48` |
| `ios/profile` | `1c6e50ff729b2540d151f484ff2bdd8e7c122727c5b82aba850619aa9a8d1616` | `f03c82e1f887a644e542972748839ed074c0738eafe2bb69a1e7277a330dc3d8` |
| `android/kilter` | `977184520b781b62b21e377efcda531281981cf12c21d5fed87fcd741f0cc09c` | `12b7c081aa4b75d4d85a535ab199b07d015610f2cf7a1a1c1ff0d411f1684a07` |
| `android/tension` | `82be291d86792001878e825876c6b3ed8f343652f0b21ee52c454da60c059c26` | `c149fe9ecaf93ec2964a236f21cbaa109ce1102464eb0487eac24bc1d6a3c2a4` |
| `android/moonboard` | `528a8f47dc74705b7f5bedb3a2a61fc88e4c3c222d2dd8dd2f8918c61cd42ceb` | `9dce8570aa661034a7e66872113f9a909236deef751f3c6b5195073ba8aea1c4` |
| `android/queue` | `e728ffb637e62fc3d1a74846b10677cb5414f8a818540afe5267a6484900e633` | `a541296cd5b4015ab4d82e0c526d2fbdb4a5ee10f6ba83a07e11d52cd69c3b9a` |
| `android/wall-status` | `440ddaab20d7566e670ea619290a12ef270389769d73e0c5ff4985f01ed16b9b` | `54cc604dbb33030c3c0d7f0e1aa9d960ba98f443d56874d5a56973e09a26113d` |
| `android/profile` | `07ef28a8d1109fb2d99a2ce4c055ee54fe0b40fd61550adfd87449bddb3743c2` | `687f4b3f924fe4d708e4396bfd713b8cdc5c4bcc5d1bdeffce3ad346a4d62d11` |
