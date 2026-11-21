# Shared sessions and wall control

The mobile queue provider owns the active session and composes its commands and
realtime subscription from `packages/mobile/src/providers/queue/`. GraphQL schema
and event contracts are shared by backend and clients. Read
[WebSocket architecture](../../backend/websocket-implementation.md) before changing room
membership, sequencing, reconnection, or delivery.

A shared queue is not proof of a Bluetooth connection or a lit wall. The board's
presence/holder state, the currently displayed climb, and confirmation of a
physical write have separate lifetimes. `board-presence-provider.tsx` and
`bluetooth-provider.tsx` coordinate those facts. The current driving, preview,
confirmation, and disconnect rules are in [board connection holder](../../boards/board-connection-holder.md)
and [local board QA](../../qa/local-board-qa.md); the old web always-live driverless
interaction is not the mobile specification.

Participant, invite, and live session controls are rendered by the
[Session screen](10-session.md). The player and queue controls reuse that session
state. A board or account switch must not let stale realtime events, delayed
identity resolution, or an old transport callback mutate a replacement binding.
Follow [the current-climb compatibility design](../../product/current-climb-outside-queue.md)
when changing queue events consumed by released clients or Live Activity.
