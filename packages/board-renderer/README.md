# Boardsesh Aura board renderer

The Rust implementation behind every Boardsesh board image: the veil over
unlit holds, each lit hold's traced silhouette glowing in its role colour, the
classic marker mode, and the same drawing at any output size from a 200 px
thumbnail to a full-screen board.

## Licence

**This workspace is licensed under the GNU Affero General Public License v3.0
or later** (`LICENSE` in this directory, SPDX `AGPL-3.0-or-later`), like the
rest of the Boardsesh product core. The exact boundary, the generated
artifacts it covers, what earlier versions were released under, and how the
licence relates to the visual ideas are all in
[`LICENSING.md`](../../LICENSING.md). Separate commercial licensing could be
available from the copyright holder; no terms are published in this
repository.

## Layout

| Crate  | Package name           | What it is                                                                                                   |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `core` | `board-renderer-core`  | The renderer. `renderer.rs` (entry point + classic mode), `aura/` (veil, glow, marks, geometry), `edt.rs` (labelled distance transform), `types.rs` (the `RenderConfig` JSON contract), `frames_parser.rs`. Draws with `tiny-skia`. |
| `ffi`  | `board-renderer-ffi`   | The C ABI: `board_renderer_render` and `board_renderer_free`. Built as a static library for iOS and a shared library for Android by `scripts/build-native-renderer.sh`. |
| `wasm` | `board-renderer-wasm`  | The `wasm-bindgen` export `render_overlay`. `wasm/pkg/` is the committed `wasm-pack` output (`vp run build:wasm`), consumed by the backend, the Next.js Web Worker and the Expo-web binding. |

## API

The renderer has one input and one output, on every platform:

- Input: a `RenderConfig` JSON document (`core/src/types.rs`). Board size, output width, the `frames` string, the hold list with optional traced outlines, the hold-state colour map, and the Aura tuning fields. Every Aura field has a default and unknown enum values fall back, so an older config always renders.
- Output: a premultiplied RGBA buffer plus its width and height. The C ABI returns them through out-parameters; the wasm export prefixes the buffer with two little-endian `u32`s.

The narrow surface is deliberate: a consumer on any platform builds the JSON
(`@boardsesh/board-render` does that in TypeScript), calls one function, and
encodes or composites the pixels itself.

## Consumers

- iOS and Android: `packages/mobile/modules/board-renderer/` (Expo module, Swift + Kotlin/JNI) over the prebuilt libraries committed there.
- Backend `/render/board`, `/og/climb`: `packages/backend/src/services/board-render.ts` through `@boardsesh/board-render` and the wasm build.
- Web: `packages/web/app/lib/board-render-worker/` (Web Worker + OffscreenCanvas) over `packages/web/public/wasm/`.
- Expo web: `packages/mobile/modules/board-renderer/src/index.web.ts` over `packages/mobile/public/wasm/`.

## Developing

```
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`core/tests/native_artifact_contract.rs` reads the committed iOS and Android
binaries and fails when they drift from the Rust source, so a `RenderConfig`
change means rebuilding them (`scripts/build-native-renderer.sh`; the iOS half
needs macOS, or dispatch `.github/workflows/build-renderer-ios-artifact.yml`).
After `vp run build:wasm`, run `scripts/sync-mobile-board-renderer-wasm.sh` so
the two `public/wasm/` copies match the pkg byte for byte.

`cargo run --release --example render_overlay -- config.json out.png` renders
one config to a PNG for eyeballing (used by `scripts/glow-lab.ts`).
