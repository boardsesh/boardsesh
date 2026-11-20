# Climb detail surfaces

The app opens a climb in the [mobile player](06-play-view.md). Its detail sections
live under `packages/mobile/src/components/play-drawer/`, including beta videos,
logbook, community/moderation, grade information, and similar climbs. The selected
climb's board and angle must remain associated with its content when the active
wall differs.

The Next.js website keeps server-rendered public climb pages. The tuple routes
under `packages/web/app/[board_name]/` and canonical slug routes under
`packages/web/app/b/` render public content and offer an app handoff. They do not
mount the retired interactive climbing provider tree, web tick form, or web BLE
controls.

Use [web architecture](../../web/web-reposition.md) for route compatibility,
[web board images](../../rendering/wasm-worker-rendering.md) for server-rendered artwork, and
[climb OG images](../../web/og-climb.md) for share previews. Public content and metadata
must be useful before hydration; private or unavailable content must not become
indexable through an alternate detail URL.
