# Mobile sessions

The Session tab is `packages/mobile/app/(tabs)/record/index.tsx`; its implementation
is `packages/mobile/src/components/session-screen/SessionScreen.tsx`. The route
keeps its historical `record` name. A pre-session form and a live session view
share the screen, selected by the queue provider's active session ID.

Before starting, the climber can browse the selected board, change boards, and
configure the session/workout. Browse opens that board's climbs; Change board
returns to setup. Starting disables duplicate submission and keeps setup visible
until the tab handoff. If the climber switches tabs while creation is pending,
creation finishes without forcing them back. Workout starts retain their own
handoff; ordinary successful starts open Climbs.

The live view provides session controls and invitations. Shared queue commands
and realtime subscription ownership live under `packages/mobile/src/providers/queue/`.
Leaving and ending are distinct operations; retain the existing confirmation and
ownership checks. The recorded summary uses `app/(tabs)/record/summary.tsx`.

Historical session detail routes are shared by Home and Profile stacks, while
`app/join/[sessionId].tsx` handles incoming app invitations. The website preserves
public session/share links and its join compatibility route; do not recreate the
old web Start Session drawer.

See [WebSocket architecture](../../backend/websocket-implementation.md),
[workout stages](../../product/workout-stages.md), [rest timer](../../product/rest-timer.md), and
[navigation](01-navigation.md) for the respective contracts.
