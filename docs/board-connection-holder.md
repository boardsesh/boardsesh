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

There is no idle timer any more. Bluetooth auto-disconnect (a timeout since 2.6) was replaced in 2.7 by **Disconnect Bluetooth when driving ends** (`disconnectWhenDrivingEnds`, default off). When it is on and a drive ends because the climber or the timer ended it (`stopped`, `window_ended`, Turn off all lights, or a crewmate's put-up taking the board; never a `window_ended` that Settings › Board caused, `keepLink`), the phone lets go of the link with trigger `driving_ended`, once any write in flight on the link has landed (5 s at most) and reports `reportBoardDisconnect`, so the holder frees at once. It keeps the board remembered with no time limit, so the next Put on board reconnects silently. Link drops, failed connects, session or board changes and sign-out already release the hold and never use this path. Climbers who had auto-disconnect on were migrated once (`settings/migrations.ts`): the switch turns on and their old timeout becomes Stop driving after; see `docs/climb-view-options.md`.

## Clients

- **Shared** (`@boardsesh/board-presence` + `@boardsesh/board-presence-react`): the reducer tracks `holder` + `lastConnectionSeq` (seq-gated `APPLY_CONNECTION_CHANGED` / `SEED_CONNECTION`); `useBoardPresenceCurrent()` exposes `holder`; the client interface gains optional `fetchConnection` / `reportDisconnect`. A catch-up (`REFRESH_CONNECTION`) moves `lastConnectionSeq` through every stats and history event it repaired even when it reads back the same holder, so the reducer also keeps `lastHolderChangeSeq`: set by every live push, and by a catch-up only when it reads a different holder (another account, signed in vs anonymous, held vs free; two anonymous holders count as the same). Ask that one whether someone took the board after a given sequence.
- **Mobile**: on a board with LEDs, the lightbulb connects and auto-pushes the climb; pressing again disconnects and frees it. While a named session peer holds the board, tapping the drawer lightbulb commits a matching-board preview to the shared queue, which the holder sends through their link. Without a preview (including toolbar bulbs), the tap leaves the current climb alone. Accessibility labels distinguish connecting, disconnecting, relaying and a peer driving. `BluetoothAutoSender` mounts on `isConnected || virtualWallHeld` (no driver/preview write-gate). `BoardConnectionBadge` renders the holder beside the lightbulb. `reportBoardDisconnect` fires on explicit and unexpected BLE drops, and on a released virtual hold.

The relay suppresses connecting only for a session member identified by the authoritative board-presence holder. The best-effort session wall-lit flag can be stale and never suppresses reconnecting. `BluetoothProvider` remembers the account observed holding the board while its local BLE link was connected, scoped to the bound board and session. After a drop, every control—including one mounted later—can recognize a delayed self-release and reconnect. A scope change discards the old identity immediately. Presence identifies accounts rather than individual devices, so after a local hold, another device on that account can conservatively fall back to connecting. Relaying an unchanged current climb does not force a physical re-light; that requires a separate remote reassert path.

### No undo on a lightbulb disconnect (product decision)

A short tap on a lit lightbulb hangs up the board at once. There is no confirm and no Undo, on every bulb (MiniPlayer, toolbar, Android app bar, the header pill, the player). A climber who hangs up by mistake taps the bulb again to reconnect, and that tap reconnects silently: a hang-up keeps the board remembered for 10 minutes (`HANG_UP_REMEMBER_MS`). Every deliberate Disconnect works this way: the bulb, the board sheet, the controls sheet and long-press.

One exception: while this phone drives the wall, a tap on any bulb only stops driving and keeps the link (owner, 2026-11-03, from the 2.7.0 TestFlight: "we should only stop driving, not also immediately disconnect", then "Yes, every bulb"). That is every bulb: the MiniPlayer's own bulb, the last pick's Put on board bulb and the tablet or open-Duo bulb (iOS 26 accessory and floating Material bar), the toolbar's (glass, or the rail's native item), the Android app bar's, the Climbs header's You have the board pill, the create-climb editor's and the player's first-row bulb. It holds during Put on board's timed drive, an open-ended drive or Always drive the wall's. It is the stop the player's You are driving the wall button and the Lock Screen bulb make (`stopDrivingForLink`): Always drive the wall then waits for the link to drop or the next Put on board, and Disconnect Bluetooth when driving ends still lets go of the board when it is on (a screen reader hears "Board disconnected" once the link drops; the header pill goes with the hold, so the Climbs header says it for the pill). The next tap, once the drive is over, hangs up as above; a second tap inside 600 ms of the stop, or any tap inside 2 s of a timed drive running out, is dropped. With no drive (none, or one still arming) every bulb hangs up on a tap, as above. Details: `docs/climb-view-options.md`, "A tap on any bulb during a drive only stops driving".

How the 10 minutes work (`use-board-bluetooth.ts`, `remembered-board-expiry.ts`):

- The hang-up still frees the board for the next climber. It reports `Bluetooth Disconnected` with `reason: 'user'` and `disconnectTrigger: 'explicit_user'` as before, and releases the holder.
- It stamps the remembered board, and that board's per-board handle (#7076), with `forgetAfter` = now + 10 minutes. On iOS it also keeps the native pairing (`disconnectKeepingBoard`, from #7214), so the Live Activity bulb can reconnect too. A reconnect, by any route, stores the board again with no stamp.
- Once the stamp has passed, the board counts as forgotten wherever it is read: a timer while the app is on screen, coming back to the foreground, every `connect()` (a tap that read its target just before the timer ran opens the list), the read on launch, the picker's target and native adoption. When JS forgets the board it kept, it also forgets the iOS native pairing (`forgetNativeKeptBoard`), unless a link or a connect is live, or the Lock Screen bulb already reconnected it (next point). It then pushes one Live Activity update (`nativeBoardForgets`), because the card reads the pairing only when it redraws and would otherwise keep offering "Tap to reconnect".
- The kept native pairing also lasts only while the route shows that board, the same rule as the JS memory. A switch to another board forgets it natively. Native keeps the hung-up board's LED map, and a bulb reconnect lights the queue's current climb, which names no board, so after a switch that tap would light the old wall with the new board's climbs (the #7122 class). The JS handle keeps its stamp, so walking back within the 10 minutes still reconnects silently from the app. A switch that lands while a connect is still running forgets once that connect settles, so a connect that fails before its preparation (Bluetooth off, permission denied) doesn't leave the old pairing behind. Disconnect Bluetooth when driving ends and a link drop still keep the pairing across a board switch; that gap stays with #7122.
- Native has no clock for the 10 minutes (that needs a native release). If the app sleeps past them, the Lock Screen still offers "Tap to reconnect", and a tap reconnects and lights the wall. The app keeps that link (owner's call, 2026-11-02: "keep the tapped link"). Before an expired stamp makes native forget, the app asks native what it holds (`forgetNativeBoardUnlessTakenBack`). A link the bulb made to that board (`connectOrigin: 'liveActivityIntent'` and the same config key, `isLockScreenTakeBack`) is the climber taking the board back: the app remembers the board again with a fresh stamp, keeps the native pairing and adopts the link, which clears the stamp as any reconnect does. That holds on launch, on the expiry timer, on foreground and in the adoption path, and for a tap made inside the 10 minutes that the app first sees after them. It holds too when a native forget or disconnect failed earlier (a board switch whose native forget threw, or a hang-up whose native disconnect did), which otherwise leaves adoption shut: native's answer is the proof the bulb holds that board. Any other native link, or none, and the expiry applies: JS forgets the board and native forgets the pairing. A link found while the route shows another board is remembered again but not adopted, so the board-switch rule above forgets it natively. A reconnect native is still making when the app runs is not connected yet, so it is forgotten like no reconnect at all.
- A hang-up forgets at once, as before (`forgetConnectedBoard`), after a wrong-box connect. That means a box picked through the board-config mismatch's "Connect anyway", or one advertising another board type. It also forgets at once when nothing was remembered for the box (a Woods box, for example).
- A sign-out (manual, forced or an account change, never a signed-out cold start) forgets every remembered board and the native pairing (`remembered-boards-sign-out.ts`).
- There is no setting for any of this.

Serial-less Kilter-built boxes (`Kilter Board`, `isKilterBuiltBox`) are remembered by their BLE device id, as MoonBoards are, when the name is this board's type. For a gym or saved board, the picker lists the target group first: that board's own controller by serial, and the box this phone remembers for the board by id. Then come controllers it cannot identify (MoonBoards and bare-name boxes advertise no serial). Only controllers that are positively another board stay hidden until "Search for any board". The three groups are in `docs/ui/12-bluetooth.md`.

Decided 2026-11-02 (board-connection plan, item 2). Until then a hang-up forgot the board, so the tap that undid a slip opened the picker. In the 30 days to 2026-10-31 there were 5,201 hang-ups. Each turned the next connect from a 91% silent reconnect into a 75% picker attempt.

The no-Undo rule was decided 2026-10-28. #6997 built an 8 s "Board disconnected · Undo" snackbar for every bulb after a slip on the iPhone MiniPlayer, where the bulb now sits beside ⏭. It was declined: we don't want an Undo option here. Don't add a confirm or an Undo to the bulb's short tap. Long-press and the controls sheet's Disconnect stay as they are.

## Holding a wall with no light kit

`user_boards.has_leds` is a capability flag, `NOT NULL DEFAULT true`. The client type is `hasLeds?: boolean` and every branch tests `=== false`, so a stale snapshot or a query that omitted the field degrades to "has LEDs" — an LED wall can only lose its Bluetooth affordances through an explicit `false` from someone with edit access. 79% of production board rows have no serial number, so absence of hardware evidence is emphatically **not** evidence of absence.

**Lit by a wall device.** `user_boards.lit_by_wall_device` (`NOT NULL DEFAULT false`, client `litByWallDevice?: boolean`) marks a wall that an internet-connected wall device lights: a laser projector or an LED controller that follows `boardNowPlaying(boardId)`. The owner, or anyone with edit access (the same rule as `has_leds`), turns it on in Edit board › Lights › "Lit by a wall device"; the row shows while "Board has LED lights" is on, and on a spray wall on its own. Every climber on such a board takes the wall with no Bluetooth link, exactly as on a wall with no light kit, and every climb they put up reaches the device through `reportBoardClimb`. A live Bluetooth link still wins (`derivePlayDrawerLightbulbPressAction` returns `disconnect`, `commitWallFrames` writes the radio first).

Two helpers in `packages/mobile/src/lib/boards/board-lighting.ts` decide every site, and the two questions stay apart:

- `drivesWithoutBluetooth(board)`: `has_leds = false` or `lit_by_wall_device = true`. The bulb's press path, the Bluetooth context's `ledless`, the Wall display's empty-state CTA, the first-connect card, the move-then-connect gate and the session board path (a wall-device board keeps its `/b/{slug}` identity, so a joiner reports to the feed the device reads).
- `boardHasLights(board)`: false only for a wall with no light kit and no wall device. Copy that says "this wall has no lights" (the empty state, the kiosk idle lines, the gym wall switcher) and the player's wall button, lit state and frost ask this one, so a wall-device board keeps its wall button and never reads as dark-by-design.

`Wall Taken` / `Wall Released` keep `ledless` as the server's no-light-kit flag and add `wallDevice`.

**One commit seam, two backends.** `commitWallFrames` (`packages/mobile/src/providers/bluetooth-provider.tsx`) is what the auto-sender, `undoWallChange` and `relightPresenceClimb` all call:

1. `isConnected` → the real BLE write, byte-identical to a board with lights. **Tested first**, so a physical link always wins even in the window before the auto-release effect runs.
2. else the wall is held virtually → wait out `VIRTUAL_WALL_SETTLE_MS` (600 ms) and return `true`. Zero bytes are written.
3. else `false`.

The settle window exists because the drain loop's latest-wins coalescing only engages while a commit is in flight. Without it a five-climb swipe would land five durable `board_climb_events` rows instead of the two a BLE write produces.

**Who may hold.** `takeVirtualWall()` is guarded on `!isConnected` alone, deliberately _not_ on `ledless`: the device picker offers "this wall has no lights" after a scan that found nothing, on a board whose server flag still says it has them, and that offer takes the wall **session-locally only**. It never writes `has_leds` — an empty scan is weak evidence (box powered off, out of range, the Android RN 0.86 scan regression), and a wrong flip removes the connect affordance for every climber at that gym. The server flag is set only through the board edit form. The picker hands its action to `BluetoothProvider` immediately after dismissal; the provider waits `SHEET_SETTLE_MS` before taking, so the toast appears after the native sheet leaves. That timer survives the picker unmount, but a board switch, provider unmount, or Bluetooth connection cancels it.

**Exclusivity without a radio.** A BLE link is exclusive because the radio says so. A virtual hold has nothing, and the server keeps a single last-write-wins holder slot, so `VirtualWallHolderWatch` compares `holder.userId` against the viewer's and exposes `wallHeldByOtherUser`. Taking snapshots the current `lastConnectionSeq`; only a peer holder observed at a later sequence auto-releases that hold. This lets a deliberate take replace the existing holder even when the watcher first mounts or the profile resolves after the tap. Initial holder backfill keeps sequence zero. The comparison is **board-scoped and not session-gated** — production shows 413 of 1,162 boards with climb events have several distinct reporters while only 36 have any `board_sessions` row, so a session gate would miss the case this exists for. Anonymous holders carry no userId and cannot be compared; that is accepted, not guessed at.

**Losing the wall mid-drive.** The auto-release itself stays silent (no toast). If this phone was driving the wall when a later holder took it, the drive's watcher says so once, beside the board art: the holder's name when presence has one, else "Another phone has the board" (`use-board-lets-go.ts`, the same notice a Bluetooth link that drops mid-drive gets; see "When the board lets go mid-drive" in `docs/climb-lists-and-queue.md`).

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

**Mobile.** The controls sheet's "Turn off all lights" calls `BluetoothProvider.turnOffAllLights()`. The spill skip (#7047) blanks the wall the same way when the auto-sender can't light the current climb on this board: in a party session, for a climb on another board at this gym, and in a solo queue with nothing compatible left. Both go through `blankWallAndReportClear(write)`. Only the write differs: "Turn off all lights" passes the tagged `clearBoard`, the spill skip an untagged write, so Board Lights Cleared counts only the button. The helper bumps the wall-operation epoch before the write, so a report of the pre-clear wall (or its membership-restamp retry) can't settle afterwards, and gives up if the epoch or board moved during the write. Once the write succeeds:

1. It forgets the physical frames the auto-sender's dedup compares against. Without that, a drain re-run that doesn't write (a crew FullSync with a new item object, the current-change clock moving) would confirm the turned-off climb and report it as lit.
2. It forgets the last accepted report, so re-lighting the same climb reports it again.
3. It calls `reportClearForBoard`, after any climb report still in flight, with one membership re-stamp and retry like a climb report. Every climb report goes through one fence, `sendFencedClimbReport`: the auto-sender's, Undo's and the "Light this" relight's. A climb report sent while the clear report is in flight waits for it, and a clear waits for every climb report in flight. A climb written after the clear can't overtake it: the hook queues writes in order (`writeChainRef` in `use-board-bluetooth.ts`), and the clear report is registered as soon as its write lands, before the next climb's write can finish. The clearing phone keeps its own `wall-cleared-store`. A crewmate's player reads `usePresenceClearedClimbUuid()`, and `resolveWallLit` (`play-drawer/wall-lit.ts`, since the #7000 wall button replaced the badge) reads the current climb on screen as not lit when it is the cleared one: the board control's bulb drops from filled amber to an amber outline and the lit glow goes. The phone holding the link ignores the feed's copy, because a re-light would otherwise read dark until the echo arrives.

**Not covered.**

- Seqs are numbered in allocation order. `reportBoardClimb` does database reads before `nextBoardSeq`, so a set and a clear sent close together can be numbered in the opposite order. The app waits for an in-flight report before sending the other kind.
- A seq-gap catch-up does not recover a missed clear. It re-reads history, which has no clear in it. Only a re-subscribe replays it: a socket reconnect re-subscribes, but a gap seen on a live socket does not.
- A peer has no way to re-light a cleared climb. The holder re-lights it from the bulb.
- A virtual hold (a wall taken with no Bluetooth) never reports a clear. The blanking write needs a radio, so with none `blankWallAndReportClear` stops before the report, and a spill skip on a virtual hold leaves the previous climb as the feed's lit climb.

## Driving the wall (#7113)

Put on board, a swipe on the player's wall button, its "Light every climb" action or the board sheet's row makes
this phone drive the wall: it connects if needed, lights the climb on screen, and from then on every change of
climb lights the wall. Since 2.7 Put on board's drive is timed by Stop driving after (45 s after the last lit climb
by default; in a crew only with In a session too, on by default). Since 2026-11 a MoonBoard follows that rule like
every board: its own Until I stop choice and its crew exception went. A swipe or Light every climb drives with no
end, in a crew too. It changes nothing on the server: the
phone holds the board through its link like any holder, and each climb it lights is an ordinary
`reportBoardClimb`. The drive lives on the phone (`drive-mode-store.ts`, in memory). It ends when the climber
presses the frosted button or Turn off all lights, a timed drive's time runs out, a crewmate's put-up ends a timed
drive, Settings › Board turns the choice to Right away (or In a session too off as a crew forms), this phone's link
drops, the connect fails or arming times out, the session or the board changes, or the climber signs out
(`DriveModeExitReason` in `drive-mode-store.ts`). A crewmate's board offers no swipe, by design (and a drive the runner can't
start answers `held_by_crew`): their phone holds it, and Put on board relays the climb to that phone. See `docs/climb-view-options.md`, "Swipe to drive".

## Known limitations

- **Same-user multi-connection**: the writer is keyed by emitter, so if a logged-in user holds from two connections, either connection's drop frees the wall (re-acquired on the next send). Benign under always-take.
- **Anonymous `connectionId` is not stable across WS reconnects** — a blip briefly frees an anon hold, re-taken on the next send.
- **Anonymous WebSocket rate limiting** is per-connection (resettable by reconnecting); per-IP limiting is tracked in #2863.
