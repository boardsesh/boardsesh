# @boardsesh/board-renderer-module

The Expo native module that binds the Aura board renderer
(`packages/board-renderer`) into the app:

- `ios/`: Swift module over the C ABI, linked statically from the committed `BoardRendererNative.xcframework`.
- `android/`: Kotlin module plus a JNI shim (`src/main/cpp/jni_bridge.cpp`), loading the committed `jniLibs/*/libboard_renderer_ffi.so`.
- `src/index.ts`: the JS surface (`renderHoldsOverlay`, `renderHoldsOverlayWithMarkers`), returning a `file://` PNG from an on-device cache.
- `src/index.web.ts`: the Expo-web fallback, driving the same core compiled to WebAssembly from `packages/mobile/public/wasm/`.

Rebuild the binaries with `scripts/build-native-renderer.sh`.

## Licence

**AGPL-3.0-or-later** (`LICENSE` in this directory), like the rest of the
app; this directory, including the prebuilt binaries, is part of the Aura
renderer described in [`LICENSING.md`](../../../../LICENSING.md). Versions of
this module from before the transition were offered under Apache-2.0 (the
repository licence) and declared `MIT` in `package.json`, an Expo module
template default; those versions stay available under those terms.
