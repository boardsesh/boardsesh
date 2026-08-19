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

CI has no Rust toolchain, so it cannot rebuild or verify this binary — it is
trusted on commit. Record what built it every time you regenerate, and keep the
runtime test below honest.

- Source of truth: `packages/board-renderer/wasm/pkg/` (git-tracked).
- Regenerate the pkg from Rust: `vp run build:wasm`
  (`cd packages/board-renderer/wasm && wasm-pack build --target web --out-dir pkg`).
- Current artifact built with **wasm-pack 0.15.0**, **wasm-bindgen 0.2.122**
  (pinned by `packages/board-renderer/Cargo.lock`), **rustc 1.95.0**, target
  `wasm32-unknown-unknown`, release profile + `wasm-opt`.
- `vp run build:wasm` reformats nothing, but `pkg/*.js` and `pkg/*.d.ts` are
  **not** in the Prettier ignore list, so run `vp fmt packages/board-renderer/wasm/pkg/`
  before syncing — otherwise the pre-commit hook reformats the pkg copy and the
  copies below drift out of byte parity.

`src/lib/__tests__/board-renderer-wasm-runtime.test.ts` loads this exact binary
and asserts that `stroke_width_multiplier`, `shape_size_multiplier` and per-hold
`shape` each change the rendered pixels. It is the only gate that catches a
stale artifact, so keep it passing rather than skipping it.

## Keep these in sync

After regenerating the pkg, re-copy into this folder and commit both:

```
bash scripts/sync-mobile-board-renderer-wasm.sh
```

The script copies `board_renderer_wasm.js` + `board_renderer_wasm_bg.wasm` from
the pkg and verifies the checksums match. `scripts/mobile-web-bundle-check.sh`
fails on any byte difference.

`packages/web/public/wasm/` holds a third copy for the Next.js board-render
worker. It has no sync script and no CI parity check — copy the same two files
there by hand when you regenerate, or www quietly keeps rendering with the old
core (that is exactly how it drifted before issue #4495).

## Marker support

This artifact is built from the **marker-aware** core: `stroke_width_multiplier`,
`shape_size_multiplier` and per-hold `shape` are all honoured, and an
unrecognised shape string degrades to a circle via `#[serde(other)]` instead of
failing the whole config parse.

Before issue #4495 the committed binary predated all three fields (built at
23f35aa95, overlay-only, 8-field `RenderConfig`). serde silently dropped the
unknown keys, so brush thickness did nothing, and `index.web.ts` refused shape
and size overrides outright rather than draw wrong geometry — which left every
overlay on Expo web blank once someone changed those settings. Both the stale
binary and the refusal are gone.
