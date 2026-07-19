# Board renderer WASM (web target)

`board_renderer_wasm.js` and `board_renderer_wasm_bg.wasm` are copied **verbatim**
from `packages/board-renderer/wasm/pkg/` (the wasm-pack build of the shared Rust
board-render core). Expo serves this `public/` folder below the configured
`/app` base path, so the
web board renderer (`modules/board-renderer/src/index.web.ts`) loads the glue at
runtime by URL from `/app/wasm/board_renderer_wasm.js` and instantiates
`/app/wasm/board_renderer_wasm_bg.wasm`. Metro cannot bundle these — they are static
assets, not modules in the graph.

They are copies (not symlinks or a build-time step) because Expo's static-file
middleware and `expo export` only see real files under `public/`.

## Provenance

- Source of truth: `packages/board-renderer/wasm/pkg/` (git-tracked).
- Regenerate the pkg from Rust: `vp run build:wasm`
  (`cd packages/board-renderer/wasm && wasm-pack build --target web --out-dir pkg`).

## Keep these in sync

After regenerating the pkg, re-copy into this folder and commit both:

```
bash scripts/sync-mobile-board-renderer-wasm.sh
```

The script copies `board_renderer_wasm.js` + `board_renderer_wasm_bg.wasm` from
the pkg and verifies the checksums match.

## Phase 0 note

This committed artifact is the **overlay-only** core (8-field `RenderConfig`, no
`stroke_width_multiplier` / `shape_size_multiplier` / per-hold `shape`). Marker
overrides therefore fall back to default rendering on web — see the guard in
`index.web.ts`. Rebuilding the pkg from the current Rust core (which supports
markers) and re-syncing will lift that limitation.
