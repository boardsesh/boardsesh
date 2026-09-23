# Rust backend diagrams

Diagrams for the Rust backend migration epic (`epic:rust-backend`), embedded in
`docs/rust-backend-migration.md`. Each diagram has three files:

- `<name>.excalidraw`: the editable source of truth (Excalidraw scene JSON)
- `<name>.svg`: vector export, used in docs and issues
- `<name>.png`: 2x raster export on white, for places that do not render SVG

| File | Shows |
| --- | --- |
| `01-strangler-topology` | Clients → Cloudflare → Rust gateway on `ws.boardsesh.com` → native handlers or relay to Node at `boardsesh-backend.railway.internal:8080`; shared Redis + PostGIS; web SSR via `BACKEND_INTERNAL_URL` before and after RB-22; the homelab Traefik preview path |
| `02-operation-routing` | Request → root field → route table (`relay` / `relay-ws` / `shadow` / `native`), the `rb:routes` Redis override, shadow diff logging, the relay → shadow → native cutover and the three rollback rungs |
| `03-ws-connection-lifecycle` | Upgrade and Origin check → `connection_init` + auth → anonymous cap → per-connection context → per-message dispatch (native / HTTP relay / upstream graphql-ws) → keepalive → disconnect hooks and close codes |
| `04-redis-interop-boundary` | Redis key families with TTLs, the Lua script sites, the 9 pub/sub channels and envelope, the replay buffer and stream, and which Rust and Node components read or write each during phases 1–2 |
| `05-phase-dependency-graph` | RB-01 … RB-61 by phase with blocked-by edges, the two cutover points (RB-22, RB-61) and where the memory saving lands |
| `06-ralph-loop` | `TASKS.md` → agent iteration → `rb:gate` / `rb:gate:full` lanes → `GATE:` line → `PROGRESS.md` → draft PR, with the spin guards |

## Editing and regenerating

1. Open the `.excalidraw` file at <https://excalidraw.com> (menu → Open), edit it,
   and save it back over the same path.
2. One-time setup, downloads a headless Chromium into `~/.cache/ms-playwright`:
   `cd packages/web && vp exec playwright install chromium-headless-shell`
3. Re-export every diagram in this folder (needs network access to esm.sh,
   which serves the pinned `@excalidraw/excalidraw` exporter):
   `vp exec node scripts/render-excalidraw.mjs docs/diagrams/rust-backend`
4. To re-export one diagram, pass its name prefix as a second argument, for
   example `… docs/diagrams/rust-backend 05`.

Commit the `.excalidraw`, `.svg` and `.png` together so they never drift.
