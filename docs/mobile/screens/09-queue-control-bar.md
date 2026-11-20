# Mobile queue controls

The current climb can appear in a native tab accessory, the floating queue bar,
a tablet pane, or the full-screen player. `resolveCurrentClimbSurface` chooses the
owning surface so two controls do not render over each other. Navigation and
platform placements are documented in [navigation](01-navigation.md) and
[mobile chrome](../../design/mobile-chrome.md).

## Queue state and controls

`packages/mobile/src/providers/queue-provider.tsx` composes queue state,
account-scoped persistence, session commands, and realtime delivery. Narrow state
and action contexts live under `src/providers/queue/`; consumers should subscribe
only to the state they render. Pure queue transitions are in `@boardsesh/queue`.

The model distinguishes History, Now, and Up next. Browsing and queue membership
follow [lists and queue](../../product/climb-lists-and-queue.md); the compatibility and event
rules for the Now slot are in [current climb outside the queue](../../product/current-climb-outside-queue.md).
Do not infer current behavior from the retired web QueueContext or its IndexedDB
stores.

## Queue sheet

`packages/mobile/src/components/play-drawer/QueueSheet.tsx` hosts the queue list.
The route player owns a separate host from the closed-player surface, and both
use the same queue state. Queue rows and suggestions remain virtualized. Keep
row identities stable, memoize callbacks, and request one additional page per
end-reach; see [performance](../react-native-performance.md).

Logging from History presents a child tick form above the Queue. Saving or closing
that child retains the Queue's detent and scroll position. Closing the Queue or
changing credentials cancels a pending child opening. The full contract and
current action arrangement are in [climb view options](../../product/climb-view-options.md).

## Session and wall state

The queue's current item, the board's confirmed wall state, and the Bluetooth
transport are separate facts. Connection and holder changes must not release a
replacement link or overwrite another wall; see [board connection holder](../../boards/board-connection-holder.md)
and [WebSocket architecture](../../backend/websocket-implementation.md).

Session setup, invites, leaving, and ending belong to the [Session screen](10-session.md).
