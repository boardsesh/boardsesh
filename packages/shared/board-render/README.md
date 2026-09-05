# @boardsesh/board-render

The TypeScript half of the Aura board renderer: `buildRenderConfig` (the only
producer of the JSON the Rust core consumes), the wasm loader, the `sharp`
compositing and thumbnail encode pipeline, board details, validation and the
OG-card helpers. Consumed by the backend and the Next.js site.

The barrel deliberately leaves out `./pipeline` and `./wasm` so that consumers
which only need board details or validation do not pull `sharp` or the wasm
glue into their graph.

## Licence

**AGPL-3.0-or-later** (`LICENSE` in this directory), unlike the rest of the
monorepo. See [`docs/licensing.md`](../../../docs/licensing.md) for the
boundary. `src/pipeline.ts` and `src/background.ts` carry no SPDX header on
purpose: their content hash feeds `BOARD_RENDER_VERSION`, and a comment-only
edit would flush the CDN cache. They are covered by this package's `license`
field and by `REUSE.toml`.
