# Board connection holder — "who's connected / writing to the wall"

Reference for the board-presence **connection holder**: the live indicator of who is currently connected to a climbing wall and writing climbs to it. Shipped GA (no feature flag). See also `docs/websocket-implementation.md` for the broader board-presence / party-session architecture.

## Model

A board's **holder** is the **emitter of its most recent confirmed send** — `userId` for a logged-in client, or `conn:{connectionId}` for an anonymous one. There is no separate "claim": connecting a phone and lighting a climb (which fires `reportBoardClimb`) makes you the holder. It is **always-take** — the latest send wins, and Aurora controllers are last-connection-wins, so one phone is physically connected at a time and there is **no write-gate**. The holder is a **display + take** concept, not a lock.

Display states (client):

- **active** — connected, recent send → lit lightbulb, holder's avatar (or "?" for an anonymous holder).
- **idle** — holder unchanged for > 15 min → avatar gains a "?" badge (single threshold, no ticking countdown).
- **free** — no holder → "tap to take" (the unlit lightbulb).

## Redis keys (`packages/backend/src/pubsub/index.ts`)

- `board:{boardId}:writer` → the current holder's emitter id. Set atomically by `setBoardWriter` (`SET … EX … GET` so concurrent sends detect only a real hand-off); cleared by `clearBoardWriterIf` (Lua compare-and-delete — only the current holder can clear it). TTL = `BOARD_MEMBERSHIP_TTL` (12 h). Redis-only: without Redis the holder degrades to "no holder".
- `presence:board:{boardId}:user:{emitterId}` → proof-of-presence membership stamp (gates who may emit; `NX`, stores first-seen for the durable-write dwell gate).
- `board:{boardId}:cleared` → a hash (`seq`, `clearedAt`, `climbUuid`) for the latest "Turn off all lights". Written by `commitBoardClear`; TTL = the one-week history TTL. See [Turning off all lights](#turning-off-all-lights-7015).

## GraphQL surface (`packages/shared-schema/src/schema/board-presence.ts`)

- `type BoardConnectionHolder { userId, displayName, avatarUrl, lastSentAt }` — anonymous holders carry nulls.
- `BoardConnectionChanged { holder: BoardConnectionHolder | null, seq }` — a member of the `BoardPresenceEvent` union streamed by `boardNowPlaying`. Published on a real hand-off (holder changed) and on clear (`holder: null`).
- `query boardConnection(boardId): BoardConnectionHolder` — late-joiner initial state.
- `mutation reportBoardClimb(boardId, climb, angle)` — report a confirmed send (sets the holder).
- `mutation reportBoardDisconnect(boardId)` — release this client's hold (lightbulb-off / BLE drop).
- `mutation reportBoardClear(boardId)` — the holder turned every light off but kept its link. Publishes `BoardClimbCleared { clearedAt, seq, climbUuid }`.

## Auth model

Board presence is **auth-optional** so anonymous web/mobile users are first-class:

- **Emit / connect**: `reportBoardClimb`, `reportBoardDisconnect`, `resolveBoardForConfig`, `resolveBoardForUuid` are auth-optional (anon keyed by `conn:{connectionId}`). Anon may only **bind existing** boards — `resolveBoardForConfig` is bind-only for anon (create-on-miss requires auth), `resolveBoardForUuid` resolves only public boards for anon. Serial resolution and board create/own stay auth-required.
- **Read (live feed)**: `boardNowPlaying`, `boardRecentClimbs`, `boardConnection` are anon-watchable but `requireAnonReadableBoard` restricts anonymous viewers to **public + system-shared** boards (so an anon can't enumerate ids to watch a private wall). Logged-in users keep membership-free reads. `boardHistory` and `boardPresenceStats` remain auth-required.
- Proof-of-presence (`hasBoardMembership`) gates emits; a 60 s dwell gate filters durable `board_climb_events` writes; all entry points are rate-limited.

## Crash backstop

The clean release path is the client calling `reportBoardDisconnect` on BLE drop (BLE survives a WS blip). As a backstop for a crashed holder, the WebSocket `onDisconnect` hook (`packages/backend/src/websocket/setup.ts`) calls `roomManager.clearBoardWriterForConnection`, which frees the wall via the emitter-keyed compare-and-delete. It runs at the single WS-close chokepoint (covering both solo `removeClient` and party `disconnectClient` holders) and is recorded per connection by `roomManager.noteBoardWriter` (called from `reportBoardClimb`).

## Clients

- **Shared** (`@boardsesh/board-presence` + `@boardsesh/board-presence-react`): the reducer tracks `holder` + `lastConnectionSeq` (seq-gated `APPLY_CONNECTION_CHANGED` / `SEED_CONNECTION`); `useBoardPresenceCurrent()` exposes `holder`; the client interface gains optional `fetchConnection` / `reportDisconnect`.
- **Mobile**: on a board with LEDs, the lightbulb connects and auto-pushes the climb; pressing again disconnects and frees it. While a named session peer holds the board, tapping the drawer lightbulb commits a matching-board preview to the shared queue, which the holder sends through their link. Without a preview (including toolbar bulbs), the tap leaves the current climb alone. Accessibility labels distinguish connecting, disconnecting, relaying and a peer driving. `BluetoothAutoSender` mounts on `isConnected || virtualWallHeld` (no driver/preview write-gate). `BoardConnectionBadge` renders the holder beside the lightbulb. `reportBoardDisconnect` fires on explicit and unexpected BLE drops, and on a released virtual hold.

The relay suppresses connecting only for a session member identified by the authoritative board-presence holder. The best-effort session wall-lit flag can be stale and never suppresses reconnecting. `BluetoothProvider` remembers the account observed holding the board while its local BLE link was connected, scoped to the bound board and session. After a drop, every control—including one mounted later—can recognize a delayed self-release and reconnect. A scope change discards the old identity immediately. Presence identifies accounts rather than individual devices, so after a local hold, another device on that account can conservatively fall back to connecting. Relaying an unchanged current climb does not force a physical re-light; that requires a separate remote reassert path.

### No undo on a lightbulb disconnect (product decision)

A short tap on a lit lightbulb hangs up the board at once. There is no confirm and no Undo, on every bulb (MiniPlayer, toolbar, Android app bar, the header pill, the player). A climber who hangs up by mistake taps the bulb again to reconnect. A deliberate hang-up forgets the remembered board (`forgetConnectedBoard`), so that tap opens the board picker.

Decided 2026-10-28. #6997 built an 8 s "Board disconnected · Undo" snackbar for every bulb after a slip on the iPhone MiniPlayer, where the bulb now sits beside ⏭. It was declined: we don't want an Undo option here. Don't add a confirm or an Undo to the bulb's short tap. Long-press and the controls sheet's Disconnect stay as they are.

## Holding a wall with no light kit

`user_boards.has_leds` is a capability flag, `NOT NULL DEFAULT true`. The client type is `hasLeds?: boolean` and every branch tests `=== false`, so a stale snapshot or a query that omitted the field degrades to "has LEDs" — an LED wall can only lose its Bluetooth affordances through an explicit `false` from someone with edit access. 79% of production board rows have no serial number, so absence of hardware evidence is emphatically **not** evidence of absence.

**One commit seam, two backends.** `commitWallFrames` (`packages/mobile/src/providers/bluetooth-provider.tsx`) is what the auto-sender, `undoWallChange` and `relightPresenceClimb` all call:

1. `isConnected` → the real BLE write, byte-identical to a board with lights. **Tested first**, so a physical link always wins even in the window before the auto-release effect runs.
2. else the wall is held virtually → wait out `VIRTUAL_WALL_SETTLE_MS` (600 ms) and return `true`. Zero bytes are written.
3. else `false`.

The settle window exists because the drain loop's latest-wins coalescing only engages while a commit is in flight. Without it a five-climb swipe would land five durable `board_climb_events` rows instead of the two a BLE write produces.

**Who may hold.** `takeVirtualWall()` is guarded on `!isConnected` alone, deliberately _not_ on `ledless`: the device picker offers "this wall has no lights" after a scan that found nothing, on a board whose server flag still says it has them, and that offer takes the wall **session-locally only**. It never writes `has_leds` — an empty scan is weak evidence (box powered off, out of range, the Android RN 0.86 scan regression), and a wrong flip removes the connect affordance for every climber at that gym. The server flag is set only through the board edit form. The picker hands its action to `BluetoothProvider` immediately after dismissal; the provider waits `SHEET_SETTLE_MS` before taking, so the toast appears after the native sheet leaves. That timer survives the picker unmount, but a board switch, provider unmount, or Bluetooth connection cancels it.

**Exclusivity without a radio.** A BLE link is exclusive because the radio says so. A virtual hold has nothing, and the server keeps a single last-write-wins holder slot, so `VirtualWallHolderWatch` compares `holder.userId` against the viewer's and exposes `wallHeldByOtherUser`. Taking snapshots the current `lastConnectionSeq`; only a peer holder observed at a later sequence auto-releases that hold. This lets a deliberate take replace the existing holder even when the watcher first mounts or the profile resolves after the tap. Initial holder backfill keeps sequence zero. The comparison is **board-scoped and not session-gated** — production shows 413 of 1,162 boards with climb events have several distinct reporters while only 36 have any `board_sessions` row, so a session gate would miss the case this exists for. Anonymous holders carry no userId and cannot be compared; that is accepted, not guessed at.

**Hold lifetime and transport changes.** Each virtual hold captures its board identity and owns an abort controller. Giving it back, losing it to a peer, changing boards, or unmounting cancels pending settles, including undo and kiosk relight. Report continuations and membership retries check the operation generation before sending again or recording success. A Bluetooth connection replaces the virtual hold without broadcasting a disconnect and remounts the auto-sender, clearing virtual-send dedup state so the same climb receives a real physical write.

**Two connection values, on purpose.** `deriveBoardConnection` stays BLE-only: it is the Live Activity contract, read by the lock-screen bulb, the Dynamic Island, Prev/Next and both native iOS intents, every one of which acts by writing the radio. `deriveInAppBoardConnection` is the widened value that in-app surfaces read — it reports `connectedByMe` under a virtual hold, yields to `heldByPeer` when the server holder is someone else, and (on a ledless board only) reports a peer holder to a **bystander** who never took the wall. That last branch is restricted to ledless boards because on a wall with lights the holder can be a stranger sharing the board feed, and the session gate deliberately keeps them from lighting your bulb.

**Membership.** A report rejected for lapsed membership triggers one `restampBoardMembershipByUuid` and one retry. It calls the client resolver directly and never enters `beginResolution`, which would clear `boardId` and blank the wall screen mid-hold. Anonymous emitters are keyed `conn:{connectionId}` and lose membership on every socket reconnect, which is the case this covers.

## Turning off all lights (#7015)

"Turn off all lights" in the Bluetooth controls sheet blanks the board but keeps the link, so the holder slot does not change. Before #7015 nothing told the feed: every other phone kept showing the last climb as "On the wall".

**Server** (`reportBoardClear`, `packages/backend/src/graphql/resolvers/board-presence/mutations.ts`):

1. The caller needs board membership, like `reportBoardClimb`. The clear is refused (returns `false`) only when a _different_ emitter holds the wall. A free wall is accepted, because the WS-close backstop deletes the writer key on a socket reconnect while BLE stays up, and an anonymous holder's `conn:` id changes with that reconnect.
2. The seq is allocated with `nextBoardSeq` first. It may consult the Postgres floor, which can't run inside Lua.
3. `commitBoardClear` stores the clear with a compare-and-set on `seq`, so an older clear that loses the race never overwrites a newer one. It also deletes `board:{id}:lastReport`: re-lighting the same climb inside the 10 s dedup window is a wall change and must publish a fresh `BoardClimbSet`. `commitBoardClimb` sets that marker through a small Lua step that skips it when a stored clear has a higher seq, so a set that loses the race to a clear cannot put the marker back.
4. `BoardClimbCleared` names, as `climbUuid`, the newest climb in the history buffer whose seq is below the clear's. History is read after the seq is allocated, so a set numbered after the clear is never named. History and the holder are untouched.

**Late joiners.** The history backfill only carries climbs, so it would put the cleared climb back on the wall. `boardNowPlaying` replays the stored clear right after it subscribes, through the same iterator as live events, so it passes the per-event access gate. It replays only while the clear's seq is above every climb in the history buffer and the seq counter (`board:{id}:seq`) has reached the clear (`getActiveBoardClear`). A counter that went back (it expires a few ms before the clear key, and a durable-floor reseed never counts clears) would number every new climb below the clear, so the clear is treated as stale. The clear key lives as long as that buffer (one week). A 12 h TTL would let the buffer outlive it and re-light the climb. `getBoardDiscoveryClimb` (the anonymous marketing preview) returns nothing when the clear is newer than the newest climb, with the same counter check.

**Client.** The reducer already applied `APPLY_CLIMB_CLEARED` (wall to `null`, history kept). It now also keeps `lastClearedClimbUuid`: the event's `climbUuid`, or the climb that was current when an older server sends none. `selectClearedClimbUuid` returns it only while nothing has been lit since, and the provider exposes it as `useBoardPresenceClearedClimbUuid()`. Compare it with the climb on screen. Never read it as "the wall is dark": a peer's queue moves before the presence echo, and its new climb must not read as turned off.

**Not covered.**

- Seqs are numbered in allocation order. `reportBoardClimb` does database reads before `nextBoardSeq`, so a set and a clear sent close together can be numbered in the opposite order. The app waits for an in-flight report before sending the other kind.
- A seq-gap catch-up does not recover a missed clear. It re-reads history, which has no clear in it. Only a re-subscribe replays it: a socket reconnect re-subscribes, but a gap seen on a live socket does not.
- Only "Turn off all lights" reports a clear. The light-show stop and the party-session spill skip also blank the wall through `clearBoard()`, and peers keep the last climb.
- A peer has no way to re-light a cleared climb. The holder re-lights it from the bulb.

## Known limitations

- **Same-user multi-connection**: the writer is keyed by emitter, so if a logged-in user holds from two connections, either connection's drop frees the wall (re-acquired on the next send). Benign under always-take.
- **Anonymous `connectionId` is not stable across WS reconnects** — a blip briefly frees an anon hold, re-taken on the next send.
- **Anonymous WebSocket rate limiting** is per-connection (resettable by reconnecting); per-IP limiting is tracked in #2863.
