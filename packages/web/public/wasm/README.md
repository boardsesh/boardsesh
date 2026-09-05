# Board renderer WASM (www)

`board_renderer_wasm.js` and `board_renderer_wasm_bg.wasm` are copied
**verbatim** from `packages/board-renderer/wasm/pkg/` by
`scripts/sync-mobile-board-renderer-wasm.sh`, which also writes the identical
copies under `packages/mobile/public/wasm/`. The Next.js board-render worker
(`packages/web/app/lib/board-render-worker/board-render.worker.ts`) loads the
glue from the site root at runtime. Never edit or copy them by hand:
`scripts/mobile-web-bundle-check.sh` fails on any byte difference, and the
provenance notes live in `packages/mobile/public/wasm/README.md`.

## Licence

These two files are build output of the Aura renderer
(`packages/board-renderer`), licensed **AGPL-3.0-or-later** as part of the
Boardsesh product core. See `LICENSING.md` at the repo root.
