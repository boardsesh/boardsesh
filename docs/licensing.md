# Licensing: Apache-2.0 for Boardsesh, AGPL-3.0-or-later for the Aura renderer

Boardsesh is open source under two licences. Which one applies depends on the
directory a file lives in.

| Scope                                                  | Licence                                                    | Text                                   |
| ------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------- |
| Everything not listed in the boundary below            | Apache License 2.0                                         | `LICENSE` at the repository root       |
| The Aura board renderer and its bindings (table below) | GNU Affero General Public License v3.0 or later            | `LICENSE` inside each covered package  |

The machine-readable version of this page is `REUSE.toml` at the repository
root (per-path SPDX annotations, REUSE 3.3 format), plus the `license` field in
each covered `package.json` and `Cargo.toml`, plus an
`SPDX-License-Identifier: AGPL-3.0-or-later` header on each covered source file.
`scripts/__tests__/licence-boundary.test.ts` fails CI when any of those disagree
with this page.

This page is a description of what the repository declares. It is not legal
advice.

## The boundary

The renderer is already isolated behind package and crate boundaries; no code
moved when the licence changed. These directories, and everything under them,
are licensed AGPL-3.0-or-later:

| Directory                                  | What it is                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/board-renderer/`                 | The Rust workspace: `core` (geometry, hold masks, veil, glow, marks, distance transform), `ffi` (C ABI), `wasm` (wasm-bindgen export). Includes the committed `wasm/pkg/` build output. |
| `packages/mobile/modules/board-renderer/`  | The Expo native module that binds the C ABI on iOS (Swift, static `xcframework`) and Android (Kotlin + JNI, `jniLibs`), the Expo-web binding that drives the wasm build, and the prebuilt binaries committed under `ios/` and `android/`. |
| `packages/shared/board-render/`            | The TypeScript side of the renderer: the `RenderConfig` builder, the wasm loader, the sharp compositing and thumbnail encode pipeline, board details and validation. |
| `packages/shared/board-look/`              | The Aura look as data: glow tuning, veil opacities, mark styles, thumbnail style, and the builder that turns them into renderer fields. |
| `packages/shared/board-art-geometry/`      | Hold masks: the traced silhouettes per board config, the LED plate and white-key extractors, the veil and spill rules, and the ring fallback. |

Together those cover the six things the licence is meant to protect: board
geometry and hold masks, inactive-hold dimming (the veil), role-coloured
rendering, the glow and compositing passes, resolution-independent rendering,
and thumbnail rendering.

### Generated and prebuilt artifacts that are covered

These files are compiled from, or copied verbatim out of, the covered
directories. They carry the same licence even though they cannot carry a
header:

- `packages/board-renderer/wasm/pkg/board_renderer_wasm_bg.wasm`, `board_renderer_wasm.js`, and the `.d.ts` files (wasm-pack output).
- `packages/web/public/wasm/board_renderer_wasm.js` and `board_renderer_wasm_bg.wasm` (byte-for-byte copies of the above, written by `scripts/sync-mobile-board-renderer-wasm.sh`).
- `packages/mobile/public/wasm/board_renderer_wasm.js` and `board_renderer_wasm_bg.wasm` (same copies).
- `packages/mobile/modules/board-renderer/ios/BoardRendererNative.xcframework/**/libboard_renderer_ffi.a` (static iOS libraries built from the `ffi` crate).
- `packages/mobile/modules/board-renderer/android/src/main/jniLibs/*/libboard_renderer_ffi.so` (Android shared libraries built from the `ffi` crate).
- `packages/shared/board-art-geometry/src/generated/**` (the traced silhouette shards; see the open question about their inputs below).

Two source files inside the boundary carry no SPDX header on purpose:
`packages/shared/board-render/src/pipeline.ts` and
`packages/shared/board-render/src/background.ts`. Their
content hash is an input to `BOARD_RENDER_VERSION` (see
`scripts/generate-board-render-version.ts`), so a comment-only edit would mint
new `/render/board` URLs and flush a year of immutable CDN cache for no pixel
change. They are covered by the package `license` field and `REUSE.toml`.

### What is not covered

Everything that consumes the renderer stays Apache-2.0. In particular:

- `packages/web/app/components/board-renderer/` and `packages/web/app/lib/board-render-worker/` (the web components and the Web Worker that call the wasm build). The components directory has code from more than one contributor and is deliberately outside the boundary.
- `packages/backend/src/services/board-render.ts` and the `/render/board`, `/og/climb` and `/render/geometry` handlers.
- `packages/mobile/src/hooks/use-native-climb-render.ts` and the thumbnail components that call the native module.
- `packages/mobile/public/wasm/board-render.worker.js` (the Expo-web worker that loads the wasm build).
- `@boardsesh/board-config`, `@boardsesh/board-constants`, `@boardsesh/play-view`, `@boardsesh/shared-schema` and every other workspace package the renderer depends on.

Apache-2.0 code may be combined with AGPL-3.0 code. When Boardsesh ships a
binary or runs a server that contains both, the combined work is distributed
under the AGPL's terms; the Apache-2.0 files inside it keep their own licence.
Boardsesh meets the AGPL's source requirement by developing in public: the
complete corresponding source of every release is this repository.

## Earlier versions stay under their original licence

The renderer was added on 2026-05-24 (commit `23f35aa95`) and shipped in store
builds from `android-build-188` (2026-05-29) onwards. Until the commit that
added this page, every file now inside the boundary was offered under the
repository's Apache License 2.0, and `@boardsesh/board-renderer-module`
additionally declared `MIT` in its `package.json` (an unedited Expo module
template default). Nothing about the change is retroactive:

- Any revision of these files that you obtained before the change remains available to you under the licence it was offered under at the time (Apache-2.0, or MIT for the Expo module's metadata).
- Every store build, OTA bundle and git tag from before the change carries the renderer under Apache-2.0.
- The AGPL applies to the revisions from the relicensing commit onwards, and to every later change.

The renderer was never published to npm or crates.io, so no registry copy
exists under any licence.

## What the licence covers

The AGPL governs use of this implementation: the Rust and TypeScript source,
the native and wasm bindings, the tuning data, the traced geometry shards, and
the compiled artifacts built from them. If you copy, modify, link against, or
serve those, the AGPL's terms apply, including section 13 for network use.

It does not claim the visual ideas. Dimming unlit holds, colouring holds by
role, glowing a silhouette, rendering at any resolution, or drawing thumbnails
are ideas that anyone may implement independently. A renderer written from
scratch that happens to look similar is not a derivative work of this one.
Copyright protects the expression here, not the concept.

## Third-party components inside the renderer

The Rust workspace links permissively licensed crates. Their notices travel
with the prebuilt binaries and the wasm build:

| Crate                        | Licence                       |
| ---------------------------- | ----------------------------- |
| tiny-skia, tiny-skia-path    | BSD-3-Clause                  |
| arrayref                     | BSD-2-Clause                  |
| png, flate2, miniz_oxide, serde, serde_json, wasm-bindgen, js-sys and the rest of `Cargo.lock` | MIT and/or Apache-2.0, Zlib, 0BSD, Unlicense |
| unicode-ident                | (MIT OR Apache-2.0) AND Unicode-3.0 |

All of these are compatible with distribution under the AGPL. The full list is
`packages/board-renderer/Cargo.lock`; `cargo metadata` in that directory prints
each crate's licence field. The server-side pipeline uses `sharp`
(Apache-2.0), which loads libvips (LGPL-3.0-or-later) as a native addon; the
mobile binaries do not include it.

The in-app "Open source licenses" screen is generated from npm dependencies
only (`scripts/generate-oss-licenses.ts`). Reproducing the BSD notices of the
statically linked crates inside the app is a pre-existing gap that the licence
change does not create; it is tracked as a follow-up.

## Commercial licensing

The AGPL is the only licence the renderer is offered under in this repository.
Separate commercial licensing of the renderer may be available; no terms are
published here. Ask through the project's contact channels before relying on
any arrangement other than the AGPL.

## Contributions to the renderer

Contributions to the covered directories are accepted under the same licence
as the files they change (AGPL-3.0-or-later), which is the default GitHub
terms already provide. Whether the project should ask renderer contributors
for anything more than that is an open decision; see
`docs/renderer-contributor-policy-proposal.md`. That document is a proposal
for review and is not in force.

## Open questions for professional review

These were identified while preparing the change and are not resolved by it:

1. **App Store distribution.** The Free Software Foundation's position is that Apple's App Store terms are incompatible with the GPL family. Boardsesh distributing its own AGPL code through the App Store is a decision the copyright holder can make, but a fork that keeps the AGPL renderer cannot be sure of the same, and any outside contribution to the renderer accepted without an explicit grant would put Boardsesh's own store distribution in the same position. This is the main reason the contributor policy needs a decision before outside renderer contributions are merged.
2. **Traced geometry data.** `packages/shared/board-art-geometry/src/generated/**` is machine-traced from manufacturers' board artwork. The tracer, its rules and the selection are Boardsesh's; the input images are not. The AGPL notice covers Boardsesh's contribution and does not assert rights over the underlying artwork.
3. **AI-assisted authorship.** Much of the renderer was written with AI assistance (see the co-author trailers in git history). The extent to which such code is copyrightable, and therefore enforceable under any licence, varies by jurisdiction.
4. **`core/src/edt.rs`.** Cites the Felzenszwalb and Huttenlocher paper. The authors' reference C++ implementation is GPL-2.0-only, which would not be compatible; the file shows no sign of being a transcription, but the author should confirm it was written from the paper.
