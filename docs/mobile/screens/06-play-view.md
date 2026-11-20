# Mobile climb player

`packages/mobile/app/play.tsx` hosts the full-screen player. `PlayDrawer`, `PlayCore`,
and the components under `packages/mobile/src/components/play-drawer/` provide its
board, gestures, actions, and detail sections. Opening a player is separate from
changing the wall or adding a climb to Up next.

## Presentation and lifecycle

The route is a root `transparentModal`. It hosts its own QueueSheet, tick form,
and Bluetooth picker so these present above the player. The drawer-host provider
owns the target and board override, consumes each target once, and resets it when
the route closes. A child sheet must settle before a player-to-pane handoff.

The first commit mounts the current board and gestures; list walks and below-fold
requests wait behind that first paint. Native iPad landscape places the board
beside the Up next / Logbook / Beta panel. Other arrangements are resolved by the
layout helpers, not by copying the retired web drawer's percentage heights.

## Board and actions

Rendering, image caching, GPU admission, and fallback belong to the native board
components; see [board geometry](../../rendering/board-art-geometry.md),
[GPU rendering](../../rendering/gpu-climb-overlay-experiment.md), and
[performance](../react-native-performance.md). Gestures and feedback follow
[mobile motion](../../design/mobile-motion.md) and [accessibility](../../design/mobile-accessibility.md).

[Climb view options](../../product/climb-view-options.md) owns action order, board-control
placement, the fixed Log action, detail sections, and queue-child tick behavior.
[Lists and queue](../../product/climb-lists-and-queue.md) owns browsing, explicit queue adds,
and continuation. Do not restore the old rule that browsing necessarily enqueues
or lights a climb. Wall control and connection lifetime are specified in
[board connection holder](../../boards/board-connection-holder.md).

## Details and logging

Beta, your logbook, crew/community logs, moderation, grades, analytics, and similar
climbs use the sections mounted by PlayCore. Hidden or deferred sections must not
start background work merely because the player opened. Log through the shared
save/update/delete tick hooks; see [logbook](19-logbook.md) and
[ascents and attempts](../../data/ascents-and-attempts.md).

The website renders public climb detail separately; see [climb detail](07-climb-detail.md).
