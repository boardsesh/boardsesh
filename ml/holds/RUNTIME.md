# SW-01: on-device hold-detection runtime evaluation

Issue: #5434. Written 2026-09-14. Research only — no code, no dependency added.

Target: a 5–25 MB object detector, weights **downloaded from R2 at runtime**, run on a 1024 px
wall photo tiled 2x2, on a Pixel 6a-class Android and an iPhone 12.

Versions actually read from `packages/mobile/package.json` in this worktree (not from the brief):

- `expo` **57.0.18**
- `react-native` **0.86.3**
- `react` **19.2.3**
- `react-native-worklets` **0.10.1**, `react-native-reanimated` **4.5.3**
- `newArchEnabled: true` in `packages/mobile/app.config.ts` (line 309)

A repo-wide grep for `onnxruntime`, `tflite`, `executorch`, `vision-camera`, `mlkit`, `tensorflow`
across `package.json`, `*.ts`, `*.tsx`, `*.md`, `*.yml` returns **nothing**. There is no native ML
or vision dependency in the monorepo today and no precedent to follow. `ml/` currently holds only
`ml/climb2vec/` (Python, offline training — not a device runtime). The `plugins:` array in
`packages/mobile/app.config.ts` is all Expo first-party plus `react-native-edge-to-edge` and one
local plugin; adding a runtime means adding its config plugin there and taking a new native
fingerprint (so it cannot ship by OTA).

## Verdict

**Recommend `react-native-executorch` 0.10.2.** It is the only one of the three that names our exact
stack in a published compatibility table — "react-native-executorch 0.10.x: React Native 0.83, 0.84,
0.85, 0.86" and "Expo SDK 57 / RN 0.86: Supported" — it requires the New Architecture (which we
already run), it takes a plain `file://` path or local path as a model source with no bundling step,
and it ships a generic object-detection path (`fromCustomModel()`, since v0.8.0). **The single
biggest risk is Android app size**: the maintainers' own open issue #1464 (2026-09-11) states that
the backend opt-out does not prune the `core-android-*` artifacts, so an Android build ships every
backend — 2.67 MB of dead XNNPACK when you asked for Vulkan, next to an 11.7 MB Vulkan `.so` — and
open issue #1467 says `libexecutorch.so` re-exports its own libc++, duplicating 91% of
`libc++_shared`'s ABI. That is tens of megabytes of APK for a ~10 MB model, and it is unfixed today.
If SW-02 measures that as unacceptable, `react-native-fast-tflite` 3.0.1 is the fallback: smaller
surface, a clean `loadTensorflowModel({ url: 'file://…' })` API and an Expo config plugin, but with
no published RN 0.86 / SDK 57 claim at all and a model that must be exportable to TFLite.
`onnxruntime-react-native` is the one to avoid: its last published release is 1.24.3 from
2026-03-05, and the fix for its Expo autolinking bug (PR #29005) has sat open and unmerged since
2026-06-11.

## Comparison

| Criterion | react-native-fast-tflite | react-native-executorch | onnxruntime-react-native |
| --- | --- | --- | --- |
| Latest version / date | 3.0.1 — 2026-04-21 | 0.10.2 — 2026-09-11 (nightlies daily, latest 2026-09-14) | 1.24.3 — 2026-03-05 (six months stale; `main` is at an unreleased 1.31.0) |
| Load from arbitrary file path | Yes — `loadTensorflowModel({ url: 'file:///var/mobile/.../my-model.tflite' }, [])` | Yes — a model source is "a plain URL or local path … a `file://` path"; "Local paths are always passed through untouched" | Yes — `await InferenceSession.create(modelPath)`, but bundled-asset paths fail on iOS (#26738, open) and on iOS the `file://` prefix must be stripped |
| RN 0.86 declared | Not declared. peerDeps are `react-native: "*"`. Inferred OK via `react-native-nitro-modules` 0.37.1, whose 0.36.2 note adds "support for RN 0.87+" — **unconfirmed** | **Yes, explicitly**: 0.10.x → RN 0.83, 0.84, 0.85, 0.86 | Not declared. peerDeps `react-native: "*"`; devDeps still pin RN 0.73.11 — **unconfirmed** |
| Expo SDK 57 declared | Not declared — **unconfirmed** | **Yes**, compatibility table: SDK 57 / RN 0.86 → Supported | Not declared; open Expo-specific autolinking bug (#29005) — **unconfirmed** |
| New architecture | Yes — v3.0.0 (2026-04-14) migrated to Nitro Modules, "support for new architecture and bridgeless mode" | **Required** — "requires the New Architecture and is not compatible with the old architecture" | No TurboModule, no codegen. Legacy `ReactPackage` + JSI `install()` at import time. Works via the interop layer; this is the mechanism behind the null-module crash in #29004 |
| Expo config plugin | Yes — `app.plugin.js` shipped; `['react-native-fast-tflite', { enableCoreMLDelegate: true, enableAndroidGpuLibraries: true }]` | No dedicated plugin needed; uses `expo-build-properties` to assert `newArchEnabled` | Yes — `"plugins": ["onnxruntime-react-native"]`, but the plugin patches `MainApplication` and has broken repeatedly (#28657 Expo 55+, #28672 hoisted monorepos) |
| Works with `expo prebuild`, no ejecting | Yes — docs say run prebuild after adding the plugin | Yes — a clean prebuild is the documented path; a development build is required (Expo Go unsupported) | Nominally yes, but see the autolinking blocker below |
| Delegates | CoreML (iOS, opt-in via plugin or Podfile), `android-gpu` (OpenCL), `nnapi`; Android XNNPACK **not yet released** (PRs #206/#207 open, 2026-09-10). Selected as the 2nd argument: `loadTensorflowModel(src, ['core-ml'])`. Docs warn NNAPI is deprecated on Android 15 | XNNPACK (CPU), Core ML and MLX (Apple), Vulkan (Android GPU). **Chosen at export time**, baked into the `.pte`; `getRegisteredBackends()` checks availability at runtime | NNAPI + XNNPACK (Android), CoreML + XNNPACK (iOS), via `SessionOptions.executionProviders` |
| Model format | `.tflite` only. Must add `tflite` to Metro `assetExts` | `.pte` only (torch.export → ExecuTorch lowering), exported offline with the PyTorch toolchain | `.onnx` and `.ort` both supported since 1.13. No ArrayBuffer loading; no unsigned tensor types except uint8 on Android |
| Package / binary size | Not documented — **unconfirmed** | Documented only as a defect: Android ships 2.67 MB of unused XNNPACK next to an 11.7 MB Vulkan `.so`; iOS downloads 36.03 MB of unused device-slice `.a` at build time (#1464), plus libc++ duplication (#1467) | npm unpacked 107 KB, but it pulls the `com.microsoft.onnxruntime:onnxruntime-android` AAR at build time. On-device size **unconfirmed** |
| Licence | MIT | MIT | MIT |
| Headline blocker | No published RN 0.86 / SDK 57 statement; Android XNNPACK delegate unreleased | Android app-size bloat (#1464, #1467, both open); open `fmt` build error on Xcode 26.4 (#1081) | Expo autolinking fix unmerged since 2026-06-11 (#29005); six-month-old release |

## react-native-fast-tflite

**Version.** 3.0.1, published 2026-04-21 (npm registry metadata). MIT. Zero runtime dependencies;
peer-depends on `react`, `react-native`, and `react-native-nitro-modules` (all `"*"`).

**Release history** (github.com/mrousavy/react-native-fast-tflite/releases):

- 3.0.1 — 2026-04-21 — "return created GPU delegate from getAndroidGPUDelegate"
- 3.0.0 — 2026-04-14 — migration to Nitro Modules, new architecture and bridgeless support
- 2.0.0 — 2026-01-13 — **Android 16 KB page alignment support**, LiteRT 1.4.0
- 1.6.0 — 2025-03-10 — new architecture support, Android GPU library config plugin

**Loading from disk.** The README is explicit, and this is the cleanest API of the three:

```ts
// Asset from React Native Bundle
loadTensorflowModel(require('assets/my-model.tflite'), [])
// File on the local filesystem
loadTensorflowModel({ url: 'file:///var/mobile/.../my-model.tflite' }, [])
// Remote URL
loadTensorflowModel({ url: 'https://tfhub.dev/google/lite-model/object_detection_v1.tflite' }, [])
```

The README also advertises "Supports swapping out TensorFlow Models at runtime", which is the shape
the R2 download needs. Inference is `await model.run([inputBuffer])` with `ArrayBuffer` in and out,
or `model.runSync(...)` inside a worklet.

**Expo.** Ships `app.plugin.js`. CoreML:

```json
{ "plugins": [["react-native-fast-tflite", { "enableCoreMLDelegate": true }]] }
```

Android GPU/NNAPI needs `enableAndroidGpuLibraries: true` (or an array such as
`["libOpenCL-pixel.so", "libGLES_mali.so"]`), which writes `<uses-native-library>` entries into
`AndroidManifest.xml`. The README: "For Expo, remember to run prebuild if the library is not yet
included in your `AndroidManifest.xml`." No ejecting beyond prebuild.

**Delegates.** Second argument to `loadTensorflowModel`: `['core-ml']`, `['android-gpu']`,
`['nnapi']`. Caveats from the docs and issue tracker:

- "NNAPI is deprecated on Android 15. GPU delegate is preferred."
- "Android does not officially support OpenCL, but most GPU vendors do."
- The documented `'metal'` delegate throws unconditionally — open PR #199 (2026-08-13).
- An Android XNNPACK delegate is **not released**: PRs #206 and #207 opened 2026-09-10, both open.

**Known blockers.** No open issue mentions RN 0.86, Expo SDK 57, or 16 KB pages (16 KB was handled
in 2.0.0). Two live ones worth noting:

- #186 (open, 2026-04-22) — "Random SIGABRT in PVROCL watchdog thread on PowerVR devices — GPU
  delegate lifecycle issue" on v3.0.1. Pixel 6a is Mali, not PowerVR, so probably not our device.
- #169 (open, 2026-03-03) — iOS `EXC_BAD_ACCESS` in bridgeless mode, runtime captured by reference
  in an async lambda in `TensorflowPlugin.cpp`. Filed against **v2.0.0**; v3.0.0 rewrote the native
  layer on Nitro and claims bridgeless support, so this may be stale. **Unconfirmed.**

RN 0.86 support is the real gap: nothing published says so. The transitive constraint is
`react-native-nitro-modules` (latest 0.37.1, 2026-08-27, MIT), whose v0.36.2 notes "Add support for
RN 0.87+ by overloading new `installJSIBindingsWithRuntime`" and whose 0.37.0 notes reference
"RN <85" code paths — circumstantial evidence that Nitro tracks current RN, but not a statement
about fast-tflite itself on 0.86.

Links: [npm](https://www.npmjs.com/package/react-native-fast-tflite) ·
[README](https://github.com/mrousavy/react-native-fast-tflite) ·
[releases](https://github.com/mrousavy/react-native-fast-tflite/releases) ·
[#206](https://github.com/mrousavy/react-native-fast-tflite/pull/206) ·
[#199](https://github.com/mrousavy/react-native-fast-tflite/pull/199) ·
[#186](https://github.com/mrousavy/react-native-fast-tflite/issues/186) ·
[#169](https://github.com/mrousavy/react-native-fast-tflite/issues/169) ·
[nitro releases](https://github.com/mrousavy/nitro/releases)

## react-native-executorch

**Version.** 0.10.2, published 2026-09-11. Nightly `0.11.0-nightly-*` builds publish daily (most
recent 2026-09-14). MIT. Maintained by Software Mansion.

**Dependencies it drags in.** Peer: `react`, `react-native`, `react-native-worklets`
(`>=0.10.0 <0.13.0` — we are on 0.10.1, inside the range), `react-native-blob-util` (`^0.24.0`),
`@kesha-antonov/react-native-background-downloader` (`>=4.4.0`). Runtime deps: `zod`, `jsonrepair`,
`jsonschema`, `@huggingface/jinja`, `react-native-device-info`. That is three new native modules,
not one.

**Compatibility (the reason this wins).** The published compatibility table states:

| react-native-executorch | Supported React Native |
| --- | --- |
| 0.8.x | 0.82–0.85; untested for 0.86 |
| 0.9.x | 0.82–0.85; untested for 0.86 |
| 0.10.x | 0.83, 0.84, 0.85, **0.86** |

and for Expo: SDK 54 (RN 0.81) not supported; SDK 55 and 56 "needs explicit versions"; **SDK 57
(RN 0.86) supported**. The README restates the floor: "React Native 0.83+ or Expo SDK 55+ with
Development Builds (Expo Go is not supported due to custom C++ native libraries)", "New
Architecture enabled", "iOS 17.0+ / Android 13+ (`minSdkVersion` >= 26)". An iPhone 12 runs iOS
17/18 and a Pixel 6a runs Android 13+, so both target devices clear the floor.

**Loading from disk.** From the "Downloading & Caching Models" docs: a model source is "a plain URL
or local path — a file bundled with the app, a `file://` path, or a URL on your own host", and
"Local paths are always passed through untouched; only `http(s)` URLs are ever downloaded."
Downloads go to "a persistent cache keyed by URL". Both shapes work for us: hand it the R2 URL and
let the library download and cache it, or download it ourselves and hand it a `file://` path. The
`useExecutorchModule` form is `modelSource: 'file:///path/to/model.pte'`.

**Object detection.** `useObjectDetection` ships with SSDLite320-MobileNetV3-Large (plus quantized
variants). Since v0.8.0 the computer-vision modules are generic — a custom model plugs in via
`fromCustomModel()` provided it matches the expected input/output contract. Every CV hook also
exposes a `runOnFrame` worklet for VisionCamera v5, which we do not need for still photos.

**Delegates.** XNNPACK (CPU), Core ML and MLX (Apple), Vulkan (Android GPU). Selection happens at
**export time** — the backend is lowered into the `.pte`. At runtime `getRegisteredBackends()`
reports what is linked, and "if your model was lowered to an unavailable backend, execution fails".
That is a real difference from the other two: we would ship two `.pte` files (one Core ML, one
XNNPACK or Vulkan) rather than one file with a runtime delegate flag.

**Export.** "the standard PyTorch → ExecuTorch path: torch.export, then lowering to a backend." The
library does not do the export; you use the upstream ExecuTorch toolchain.

**Known blockers (all open as of 2026-09-14 unless noted).**

- #1464 (2026-09-11) — "Backend opt-out doesn't shrink the app — `core-*` artifacts ship every
  backend on both platforms." Numbers quoted in the issue, measured against `v0.10.0-libs`,
  arm64-v8a: `libxnnpack_executorch_backend.so` is 2 673 072 B and ships even when you declare
  `backends: ["vulkan"]`; `libvulkan_executorch_backend.so` is 11 736 456 B; on iOS the podspec
  gates at link time, so it is wasted bandwidth instead — "36.03 MB of device-slice `.a` is
  downloaded and never used." **This is the top risk for us.**
- #1467 (2026-09-11) — "`libexecutorch.so` re-exports its own libc++, duplicating 91% of
  `libc++_shared`'s ABI."
- #1462 (2026-09-10) — 0.9 → 0.10 performance regression: "24 of 42 model pairs are slower."
- #1081 (open, 2026-04-20) — "fmt error on Xcode 26.4." An iOS build-toolchain blocker; SW-02 must
  confirm against whatever Xcode our EAS image uses. **Unconfirmed whether it affects 0.10.2.**
- 16 KB pages: handled — #1004, "chore(android): update binaries so package is compatible with
  16KB", closed 2026-03-24.

Links: [npm](https://www.npmjs.com/package/react-native-executorch) ·
[README](https://github.com/software-mansion/react-native-executorch) ·
[compatibility](https://docs.swmansion.com/react-native-executorch/docs/other/compatibility) ·
[downloading models](https://docs.swmansion.com/react-native-executorch/docs/fundamentals/downloading-models) ·
[exporting custom models](https://docs.swmansion.com/react-native-executorch/docs/core-and-advanced/exporting-custom-models) ·
[Expo setup](https://mintlify.wiki/software-mansion/react-native-executorch/guides/expo-setup) ·
[#1464](https://github.com/software-mansion/react-native-executorch/issues/1464) ·
[#1467](https://github.com/software-mansion/react-native-executorch/issues/1467) ·
[#1462](https://github.com/software-mansion/react-native-executorch/issues/1462) ·
[#1081](https://github.com/software-mansion/react-native-executorch/issues/1081) ·
[#1004](https://github.com/software-mansion/react-native-executorch/issues/1004)

## onnxruntime-react-native

**Version.** 1.24.3, published **2026-03-05** — the newest published release, six months old at the
time of writing. The `main` branch's `js/react_native/package.json` already says `1.31.0`, so the
repo has moved on without releasing this package. dist-tags are only `latest: 1.24.3` and a `dev`
tag frozen at `1.21.0-dev.20250306`. MIT. Depends on `onnxruntime-common@1.24.3`; peers `react` and
`react-native` at `"*"`; devDeps still pin `react-native@^0.73.11`.

**Loading from disk.** `const session: InferenceSession = await InferenceSession.create(modelPath);`
That takes a path, which suits a downloaded file. Two documented sharp edges: the README says the
library does **not** support "model loading using ArrayBuffer", and reporters consistently have to
strip the `file://` prefix on iOS before calling `create()`.

**Formats.** "ONNX Runtime React Native version 1.13 supports both ONNX and ORT format models, and
includes all operators and types." So `.ort` is **not required** — plain `.onnx` works, and `.ort`
is an optimization rather than a gate. Other limits from the README: no unsigned tensor types except
uint8 on Android.

**Delegates.** Via `SessionOptions.executionProviders`: NNAPI and XNNPACK on Android, CoreML and
XNNPACK on iOS, plus CPU. ONNX Runtime's own mobile guidance is to start on CPU for a quantized
model, XNNPACK for a float model, and only reach for NNAPI/CoreML if those miss the target.

**Architecture.** `OnnxruntimePackage` is a plain `com.facebook.react.ReactPackage` — no TurboModule
spec, no codegen (read from `js/react_native/android/.../OnnxruntimePackage.java` on `main`). The
JSI binding is installed at JS import time by calling `NativeModules.Onnxruntime.install()`. That
works under bridgeless through the interop layer, but it is what turns the autolinking bug below
into a hard crash rather than a warning.

**Known blockers.**

- **#29004 / #29005 (the big one).** Filed 2026-06-11: "`unimodule.json` makes Expo exclude
  onnxruntime-react-native from autolinking — `NativeModules.Onnxruntime` is null ('Cannot read
  property `install` of null')". The package ships a `unimodule.json`, so `expo-modules-autolinking`
  classifies it as an Expo module and drops it from React Native community autolinking, while
  nothing registers it on the Expo side; the Gradle build still succeeds, so there is no build-time
  signal. The reporter verified the one-line fix (delete the file) on Expo SDK 56 / RN 0.85 /
  1.24.3 on Android. The issue was **closed by the stale bot on 2026-08-12** with no fix, and
  PR #29005 is **still open and unmerged** as of 2026-09-14. Using this package under Expo today
  means carrying a pnpm patch.
- #26738 (open, 2025-12-06) — bundled ONNX assets fail to load in an Expo standalone iOS build; the
  model has to be copied out of the app bundle first. Less relevant to us, since we would download
  to the documents directory anyway.
- #27062 (closed by the stale bot 2026-03-21, **not fixed**) — `InferenceSession.create()` fails on
  Expo 54 standalone iOS even after copying the model to the documents directory and stripping
  `file://`, with both `.onnx` and `.ort`, while identical code works on Android. That is exactly
  our intended flow, and it is an unresolved report.
- #28657 (closed, 2026-05-25) — "ORT RN Expo config plugin incompatible with Expo 55+"; #28672
  (closed, 2026-05-26) — the plugin does not support hoisted monorepos. We are a pnpm monorepo on
  SDK 57, so both bear directly on us.
- 16 KB pages: #26228, "[Mobile] Support 16 KB page sizes", was closed 2025-12-11, so 1.24.3
  (2026-03-05) postdates the fix. Not independently verified for the React Native AAR —
  **unconfirmed**.
- The Android `build.gradle` resolves
  `com.microsoft.onnxruntime:onnxruntime-android:latest.integration@aar`, a floating version — worth
  checking for build reproducibility if this is ever adopted.

The `main`-branch README claims "React Native's autolinking registers the native Android and iOS
modules automatically. No manual changes … are required", which reads as though the #29004 fix
landed on `main`. **That text is not in the published 1.24.3.**

Links: [npm](https://www.npmjs.com/package/onnxruntime-react-native) ·
[README on main](https://github.com/microsoft/onnxruntime/blob/main/js/react_native/README.md) ·
[#29004](https://github.com/microsoft/onnxruntime/issues/29004) ·
[#29005](https://github.com/microsoft/onnxruntime/pull/29005) ·
[#27062](https://github.com/microsoft/onnxruntime/issues/27062) ·
[#26738](https://github.com/microsoft/onnxruntime/issues/26738) ·
[#28657](https://github.com/microsoft/onnxruntime/issues/28657) ·
[#26228](https://github.com/microsoft/onnxruntime/issues/26228) ·
[ORT mobile EP guidance](https://onnxruntime.ai/docs/tutorials/mobile/)

## Not attempted

**Not attempted in SW-01.** No `expo prebuild` or dev-client build was run against
any of the three runtimes, and no dependency was added to `packages/mobile` — that
is SW-02's job (#5435), and the epic deliberately keeps native changes to one PR.

Two practical reasons it was skipped rather than time-boxed here:

- The spike box has no GPU and had a CPU training run occupying it for most of the
  session; a Gradle + dev-client build alongside it is exactly the concurrency
  this machine has fallen over under before.
- A prebuild smoke test only answers "does it compile". The questions that decide
  the runtime — does inference finish inside the 8 s budget on a Pixel 6a, does
  peak memory stay under 500 MB, does a model load from a downloaded file path —
  need a real device, which this box does not have either.

So everything above is from published documentation, release notes and issue
trackers, dated 2026-09-14. Treat it as a shortlist with reasons, not as a
verified build.

## What SW-02 must verify on device

Each item is a number to write down, not a yes/no impression.

1. **APK and IPA size delta.** Build `main` and `main` plus the runtime, and record the arm64 APK
   size and the iOS thinned app size in MB. Executorch's #1464 predicts roughly +14 MB of Android
   `.so` before our model; anything over +20 MB should send us back to fast-tflite.
2. **Cold load time from a downloaded file.** Time `loadTensorflowModel({url:'file://…'})` /
   `modelSource: 'file://…'` / `InferenceSession.create(path)` against a file already on disk, for a
   10 MB model, on Pixel 6a and iPhone 12. Report ms, median of 10, app freshly launched.
3. **Per-tile inference time.** Four 512x512 tiles from one 1024 px photo. Record ms per tile and
   total wall-clock for the four-tile pass, CPU/XNNPACK versus the GPU or Core ML delegate, on both
   devices. State the target before measuring.
4. **Peak RSS during the four-tile pass.** MB, from Android Studio Profiler and Xcode Instruments. A
   1024 px photo plus a detector must not push a Pixel 6a into a background kill.
5. **Delegate actually engaged.** Prove the accelerator ran rather than silently falling back:
   for executorch, `getRegisteredBackends()` plus a Core ML- or Vulkan-lowered `.pte` that fails
   when the backend is absent; for fast-tflite, a CPU versus `['core-ml']` / `['android-gpu']`
   timing gap outside noise. Note fast-tflite has no released Android XNNPACK delegate (PR #206).
6. **Fingerprint and OTA impact.** Run `vp exec expo-updates runtimeversion:resolve --platform
   ios|android` before and after adding the dependency and record both hashes — adding any of these
   is a native change, so the store fleet cannot reach it by OTA.
7. **16 KB page compliance on Android 15+.** Run the alignment check over every new `.so` in the APK
   and record pass or fail per library. fast-tflite claims this since 2.0.0 and executorch since
   #1004; verify, do not assume.
8. **Model swap after an R2 download.** Download a second model revision over the first at runtime,
   load it, and confirm the old native handle is released (no RSS growth across three swaps) — that
   is the whole point of the runtime-download design.
