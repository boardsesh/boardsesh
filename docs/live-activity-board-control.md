# Live Activity Board Control Roadmap

Control the climbing board from the lock screen while the app is backgrounded. The Live Activities widget should keep queue state current via WebSocket and illuminate LEDs on the physical board as you navigate climbs.

## BLE ownership

The **React Native layer** (`packages/mobile/src/lib/ble/`) owns BLE for the Expo app — it uses `react-native-ble-plx` with `restoreStateIdentifier: 'boardsesh-ble-restore'` and AppState-based foreground reconnection. The Capacitor/Swift layer this doc was originally written against (`mobile/ios/`) was retired with the Capacitor app; the Swift sections below are historical.

## Current State

**What works today:**

- A native `URLSessionWebSocketTask` owned by `SessionWebSocketManager` feeds the Live Activity while the app is backgrounded (the JS-side `graphql-ws` socket suspends on lock). The JS webview owns its own `graphql-ws` client — the same one web and Android use — separate from this native connection; they are not shared. See `docs/websocket-implementation.md` (iOS Live Activity Integration).
- Widget shows current climb name, grade, angle, queue position, and board thumbnail, restyled to the Velvet Send design system (see `docs/ai-design-guidelines.md`) — `targets/BoardseshWidgets/ClimbSessionLiveActivity.swift`.
- Widget reflects **connection ownership** (see below): the lightbulb is lit and Previous/Next are shown only while _this_ device holds the BLE link; once a peer takes the board the bulb goes out, the controls hide, and the card just shows the climb on the wall ("<name> is on the wall").
- Next/Previous buttons navigate the queue optimistically (App Group UserDefaults) and POST the backend `/api/widget/navigate` REST endpoint (not the native WS) with the registered Live Activity bearer token. They are only shown when this device holds the board (the App Intent's `navigationAllowed` guard and the widget's `boardConnection == connectedByMe` agree). The endpoint rejects a stale token whose session ended (410) or whose user is no longer a participant (403).
- The widget always shows the queue's current climb, which is the climb on the wall: never an in-app preview or the
  MiniPlayer's last look, so since 2.7 the two can differ. `/api/widget/navigate` (and the watch's
  `/api/session/navigate`) names the token's account as the mover (`currentChangedBy`, via `sessionParticipantId` in
  `session-queue-actions.ts`), so the climber's own Lock Screen Next is read as their own step and does not end the
  Put on board drive their phone is running; a legacy token with no account still names nobody. A Lock Screen Next or
  Previous moves the queue, which ends the MiniPlayer's last pick (`LastPickWatcher`), and starts or renews a drive by
  Put on board's rule; the drive and its countdown show on the card (see "Driving the wall on the Lock Screen, in the
  Dynamic Island and the Android notification" below).
- Tapping the widget lightbulb POSTs `/api/widget/take-control` with the registered Live Activity bearer token. The endpoint requires the token row to have a bound `userId` and re-asserts (re-broadcasts `CurrentClimbChanged` for) the current climb; it returns 200.
- All queue delta events (FullSync, ItemAdded, ItemRemoved, CurrentClimbChanged, Reordered) are processed natively and persisted to App Group
- Message buffering when webview is backgrounded, with flush or resync on foreground
- Rust board renderer (`packages/board-renderer-wasm/`) compiles to WASM, used in both Node.js backend (server-rendered thumbnails) and web frontend (Web Worker). Already has `HoldData` types, frame string parsing (`p<hold_id>r<state_code>`), and Aurora hold state color mapping
- Native iOS `BoardBle` owns the CoreBluetooth connection for Aurora boards, writes UART packets from Swift, and stays additive so old app shells without the plugin keep using the existing Capacitor BLE adapter
- The native BLE manager reads queue state from App Group, stores the board configuration in App Group, and uses generated Swift placement data for LED lookup and mirroring

**What's still missing for full lock-screen board control:**

1. Widget has no add, remove, or reorder controls from the lock screen
2. Rust board renderer has no Swift/iOS bindings -- only targets WASM today
3. MoonBoard remains on the existing Capacitor BLE path; the native background BLE path currently targets Aurora boards only
4. Cross-device repaint when _another_ user navigates: if your phone is suspended, your board stays stale until you unlock the phone. Tracked in issue #2174 (presence/ack design) and ultimately solved by the planned WS-enabled board controller.

## Android notification queue navigation

Android's notification receiver forwards Next/Previous's absolute queue index and
correlation ID to JavaScript. `LiveActivityBridge` requests publication through
QueueProvider's existing optimistic `setCurrentClimb` mutation path, preserving
the native correlation ID for immediate resolved publication and server echo
suppression. Unresolved targets reuse the existing deferred hydration path: once
hydrated, a fresh JS correlation ID is dispatched and published together. iOS remains local-only in
this listener because its App Intent already publishes the server mutation.

Publication happens when the existing JS event executes; this does not add a
killed-process network path. Native buffered navigation still identifies a queue
index rather than a session and queue-item UUID, so stale buffered events retain
the existing identity limitations.

Session-presence updates from JavaScript catch native rejections and retry once
after one second. A newer update, session change, queue-item change, or teardown
cancels the retry. Update failures keep the session active so a later queue or
climb change can recover. Diagnostics contain only a fixed error message and
option field names, presence, and types; they exclude payload contents. This
contains rejected updates without claiming to fix Android's unconfirmed native
Record-decoding failure (#6595).

### Background bulb reconnect and paused JS timers

React Native's `JavaTimerManager` stops firing JS timers while the activity is
paused, but the JS thread keeps running. The notification bulb's reconnect runs
in exactly that state, so its watchdogs cannot rely on `setTimeout` alone (#7038):

- **Scan timeout (30 s) and the Bluetooth power-on wait (2.5 s)** race their JS
  timer against SessionPresence's native `delay` (`setBackgroundSafeTimeout` in
  `packages/mobile/src/lib/ble/background-safe-timeout.ts`). A binary without
  `delay` keeps the JS timer, so an OTA'd bundle on an older build behaves as
  before. Cancelling is a JS flag; the native delay is never cancelled.
- **Connect timeout (12 s)** also goes to ble-plx as `connectToDevice(id, { timeout })`,
  which runs on an RxJava timer. The JS race stays.
- **Grace window (10 s)** is never scheduled for a connect that started while the
  app was not `active`. That is decided once, at the tap: such a connect never
  shows a list, so the saved board keeps the whole scan to show up and
  auto-connect, even if the climber opens the app part-way through.
- **The picker** of a connect that started in the background is never shown. If
  its scan ends without the saved board, it rejects with `No boards found`, so
  `connect()` shows the standard "board not found" alert and clears its in-flight
  guard; a later bulb tap scans again. Android holds that alert until the app is
  on screen. A sheet the climber did see keeps its empty state instead, whatever
  the app state when the scan ends.

Two more rules keep the bulb honest (#7087):

- **No remembered board, no background reconnect.** Without a remembered serial
  or device id, a reconnect can only end in the board list. From the
  notification that list would land on a paused activity, and the connect would
  hold its in-flight guard until someone opened the app. So the bridge sends
  `bulbOpensApp` on every update, and `BoardSessionService` makes the outline
  bulb an activity PendingIntent (the launcher intent, the same as tapping the
  card) instead of the `ACTION_BULB` broadcast. The climber lands in the app and
  connects from the in-app bulb, with the list on screen. It has to be the
  notification's own PendingIntent: Android 12+ does not let a broadcast
  receiver started by a notification tap open an activity. The lit bulb
  (`connectedByMe`) still re-lights the wall by broadcast, or, while this phone
  drives, stops driving (see the driving section below).
- **"Connecting…" while a connect runs.** `connect()` ignores a second tap while
  one is in flight, so the bridge sends `boardConnecting` (the Bluetooth
  context's `loading`) and the outline bulb reads `connectingLabel` until the
  connect ends. The action stays a broadcast, so a repeat tap still lands on the
  in-flight guard and does not cancel anything; the label is what tells the
  climber the first tap landed.

Both flags default to false when an older bundle leaves them out, and iOS pins
them to false (ActivityKit draws its own bulb).

Limits: the native clock stops in deep sleep, so with the screen locked the scan
ends, and the alert is raised, after the phone wakes. Android keeps one pending
alert, with no age limit. A process death loses it, and so does an activity that
is gone (the app swiped away while the foreground service keeps the process):
`DialogModule` then has no fragment manager and drops the alert. The other JS timers on
this path (the queue's move re-send fallback, the presence update retry, the
WebSocket's reconnect) still pause with the activity.

## Mirroring from the Lock Screen and Android notification

On supported layouts (Tension except layout 11, Decoy, and Woods), the BLE holder
sees a Mirror climb button in the iOS Lock Screen / expanded Dynamic Island and
the Android foreground notification. The button becomes Unmirror climb when the
current queue slot is mirrored. Previous, Next, and the lightbulb remain available.
Android uses a custom notification-content button to preserve all three action slots.

Mirroring is an absolute, server-confirmed update to the current queue slot.
iOS calls `POST /api/widget/mirror` with its registered bearer token, session ID,
queue-item UUID, and desired orientation. Android forwards the same identity and
orientation to the existing GraphQL mutation. Requests for an old current slot are
rejected. A failed/offline request leaves the climb unchanged; retrying cannot
flip twice. The active-session in-app button uses the same shared mutation.
Solo climbs and previews retain their local mirror controls.

The backend publishes `ClimbMirrored` and includes orientation and queue-item UUID
in APNs content. iOS persists a confirmation receipt until JS applies that sequence
or a newer authoritative snapshot. Reopening the app replays the receipt through
the queue sync gate. If JS has no sequence baseline yet, it fetches the complete
queue before acknowledging the receipt. Mirror deltas update their exact queue
slot even when optimistic navigation already selected another climb. Native queue
snapshots reject older sequences; a fresh socket
subscription can rebaseline after a server sequence reset. Queue sequence metadata
travels with the rendered JS state so older renders cannot overwrite native mirror
confirmations. ActivityKit updates read the latest committed snapshot before publishing.
Woods reflects its per-size native LED map using the same row geometry as JS.

**A confirmed mirror always reaches the widget and the wall.** The 200 is the
authority, so `MirrorClimbIntent` publishes the committed snapshot to ActivityKit
and writes the board from it rather than making either conditional on the local
bookkeeping agreeing. `SharedMirrorState.apply` finds the slot by queue-item uuid,
so a widget Next landing mid-request cannot discard a confirmed result, and an
older receipt leaves the committed snapshot alone instead of displacing it. The
freshness recheck before the BLE write asserts same slot, same orientation, still
holding the board — never sequence equality, because the write happens after an
await on Bluetooth readiness and any unrelated queue event in that window would
otherwise cancel it silently. The pre-request gate is `connectedByMe` plus the
queue containing the tapped item; `navigationAllowed` is deliberately not checked,
for the same drift reason Prev/Next dropped it.

**A tap the server never answered is parked, not lost.** A retryable failure writes
`bs_pending_mirror_request` and the main app hands it to JS as a `request`-kind
`queueMirror` event once a listener is attached, which replays it through the same
mutation the Android notification button uses. Distinct from `bs_pending_mirror`,
which holds a receipt the server already confirmed. The widget falls back to the
committed App Group snapshot for orientation and queue slot when the pushed fields
are absent — mirroring is an absolute write, so a stale label would make the next
tap send the opposite orientation.

Deploy the additive backend schema/endpoint before shipping new native iOS and
Android builds. Old binaries omit the new optional fields and keep existing controls.
An OTA update alone cannot install these native buttons or App Intents.

## Connection ownership (lightbulb + Previous/Next)

The Live Activity reflects a tri-state `boardConnection`, from **this device's** point of view, in `ClimbSessionAttributes.ContentState` (optional fields `boardConnection` + `holderDisplayName`, so older binaries decoding a newer push — and vice-versa — never fail; `nil` ⇒ `connectedByMe`):

- **`connectedByMe`** — this device holds the BLE link → lightbulb lit (warm amber glow), Previous/Next shown and active (they write BLE to the wall).
- **`heldByPeer`** — a session member I can id-match drives the board → lightbulb out, Previous/Next hidden, card shows the wall climb + "<name> is on the wall". An **anonymous** holder (a `conn:` holder with no `userId`) is treated as `heldByPeer` **only on the foreground/JS derivation** — via the session wall-lit flag in `deriveBoardConnection`. The **APNs push path can't attribute an anonymous holder**: `resolveBoardHolder` normalises it to `null`, so `board-connection.ts` returns no usable state and `sendGroupedNotification` **omits `boardConnection` entirely** (the fallback path below), rather than emitting `heldByPeer`. The device then keeps its last-known App-Group state — which may be a **stale `connectedByMe`** for the previous holder until a foreground update or a re-resolvable push corrects it.
- **`disconnected`** — nobody we can tie to is driving → lightbulb out, Previous/Next hidden. What the footer offers depends on whether BoardBleManager still pairs a board (`SharedBoardReconnect.footer`, read from the stored pairing `bs_ble_board_config`, the same thing `ReconnectBoardIntent`'s guard reads):
  - **A board is paired** → "Tap to reconnect" (`ReconnectBoardIntent`). Disconnect Bluetooth when driving ends keeps the pairing (`BoardBleManager.disconnect(forgetBoard: false)`, JS `disconnectKeepingBoard`), and so does an unexpected drop. Since 2026-11-02 an in-app hang-up keeps it too, for 10 minutes and only while the route shows that board: JS then forgets the board and calls the plain native `disconnect`, which forgets the pairing (`forgetNativeKeptBoard`; see `docs/board-connection-holder.md`).
  - **The last tap failed** → "Board didn't answer. Tap again", or "Turn on Bluetooth, then tap" (`bs_ble_reconnect_failure`, written by the intent, cleared by any connect that comes up).
  - **Nothing is paired** → "Open Boardsesh to connect", with no button: tapping the card opens the app. An in-app Disconnect forgets the board once its 10 minutes are up (at once after a wrong-box connect, or on sign-out), and a cancelled or failed in-app connect leaves nothing paired (`prepareBoardConnection` clears it first), so a lock-screen reconnect could only fail there. Before this the card offered "Tap to reconnect" anyway, and the tap did nothing. The widget reads the pairing only when it redraws, so when the app forgets a pairing it kept it pushes one update (`nativePairingRevision` in `useLiveActivity`, from `nativeBoardForgets`), and the card switches to this footer.

    Known limit: that update can be dropped. The revision is not forwarded to native, so the push carries the same content state as the one before it, and `LiveActivityModule.updateActivity` skips an unchanged push that lands within `SharedConstants.liveActivityDedupWindow` (0.5 s) of the last native update unless a wall-control field moved. When a forget lands that close to another push (a climb change just as the 10 minutes run out), the card keeps offering "Tap to reconnect" until the next update, and that tap fails. The fix needs a native release: forward the revision in `UpdateActivityOptions` and fold it into `wallControlChanged`, as a board-look change already is.

  A reconnect that succeeds writes `connectedByMe` to the App Group and redraws, so the bulb lights before the app's JS runs. When it does run, JS adopts the native link (`connectOrigin: 'liveActivityIntent'`) even after its own driving-ends teardown or hang-up, which otherwise suppress adoption. It adopts that link after a hang-up whose 10 minutes ran out too (owner's call, 2026-11-02: "keep the tapped link"). Native has no clock for the 10 minutes, so the card offered the tap after them. The bulb's own reconnect of the hung-up board is the climber taking it back: JS remembers the board again and keeps the native pairing. Only with nothing connected, or a link the bulb did not make, does the expired stamp make JS forget the board and the native pairing (see `docs/board-connection-holder.md`). It adopts nothing after a hang-up that forgot the board at once. A tap that iOS launches the app for in the background waits for the new central's first state (up to 3 s, `reconnectFirstCentralStateTimeout`, so the scan and connect after it still fit: 19 s at worst) rather than failing on `.unknown`. Only an outcome the climber can act on reaches the card (`BoardReconnectOutcome`): a tap that a second tap or a connect took over, or that raced a Disconnect, records nothing, and a second tap while the first still scans settles the first at once.

The derivation is shared with the in-app lightbulb so they can never disagree: `deriveBoardConnection(...)` in `packages/mobile/src/components/play-drawer/lightbulb-control.ts` (the existing `deriveLightbulbLit` is re-expressed as `deriveBoardConnection(...) !== 'disconnected'`), surfaced by the `useBoardConnectionState` hook (`packages/mobile/src/components/ble/use-board-connection-state.ts`), which both `useLightbulbControl` and `LiveActivityBridge` consume.

Three update paths set `boardConnection`:

1. **Foreground (JS)** — `LiveActivityBridge` → `useLiveActivity` threads it through to `updateActivity`/`startSession`; the native module mirrors it into the App Group (`SharedWidgetWallControlState.saveBoardConnection`) so widget intents and the native-WS builder have a fallback.
2. **Backgrounded (APNs push)** — the backend stamps it **per token**: it resolves the session's board holder once per send (`session:{id}:board` → `resolveBoardHolder`) and groups tokens by derived state, so the holder's device gets `connectedByMe` and peers get `heldByPeer`. See `packages/backend/src/services/apns/board-connection.ts` + `sendGroupedNotification` in `apns/index.ts`. A board hand-off (peer takes over) isn't a queue event, so `reportBoardClimb` kicks a debounced push when the writer changes. When the holder/board can't be resolved (no Redis, no mapping, anonymous holder) the fields are omitted and the device keeps its own App-Group state.
3. **Native WebSocket (backgrounded queue events)** — `LiveActivityManager.buildContentState` preserves the last-known `boardConnection` from the App Group so a peer's climb change doesn't reset the bulb.

The widget resolves the effective state per render with `resolveBoardState(...)`: pushed `context.state.boardConnection` → App Group mirror → derive from `navigationAllowed` (true ⇒ connectedByMe).

## Rest timer on the Lock Screen and in the Dynamic Island (#6513)

The rest timer counts down on the Lock Screen card, in the Dynamic Island (compact, minimal and expanded) and in the Android session notification. JS owns the state machine (`src/lib/rest-timer-store.ts` plus the `restTimer*` settings); the native side only draws it.

**Where the state lives.** `buildRestTimerLiveActivityPayload` (`src/lib/live-activity/rest-timer-payload.ts`) reduces the store and settings to a status (`running`, `paused`, `waiting`, `queueEnded`, `countUp`), the current window's start and end in epoch ms, the fixed-window length, and a frozen value for the two states that do not move (`paused`, `waiting`). `queueEnded` is a live clock like the in-app pill: it carries the same window as the `running` (or `countUp`) snapshot it replaces and is drawn muted, never red. `LiveActivityRestTimerSync` (mounted by `LiveActivityBridge`) sends it through the optional `updateRestTimer` native method, and `null` takes it off. On iOS that writes the App Group key `bs_rest_timer` (`SharedConstants.restTimerKey`, `SharedRestTimerState`), then re-renders the activity by bumping `ContentState.restRevision`.

**Why not in `ContentState`.** The backend re-sends the whole content state on every queue change and every 90 s, and `LiveActivityManager.buildContentState`, `ClimbNavigationIntent` and `MirrorClimbIntent` all build fresh states. None of them know about the rest timer, so a pushed field would be wiped by the next of those updates. `restRevision` is only a change trigger, so `nil` from those paths is harmless. The backend is untouched.

**When JS speaks.** Only on a change: a rest-timer store event, a rest setting, the climber's "Show on Lock Screen" switch (`restTimerShowOnLockScreen`, default on), each successful Live Activity start (native clears the key in `endSession`, and in `startSession` when it belongs to another session), an app-state change, and one timeout at each deadline. Never once a second: the countdown itself is `Text(timerInterval:)`, `Text(date, style: .timer)` and `ProgressView(timerInterval:)` on iOS, and a chronometer on Android.

**What the widget cannot do.** It runs no code at a deadline; it only re-renders on an update. `ResolvedRestTimer.resolve` decides at render time whether a running rest is over and rolls a fixed window on to the current one, but between renders only the timer views move. So, while the app is in the background:

- an after-tick rest holds at 0:00 until the next update turns it into the red overrun;
- a fixed window holds at 0:00 until the next update rolls it on;
- auto-advance never fires (JS timers are suspended), which is why the widget never shows it.

**How soon that next update comes is only partly known.** The backend's heartbeat push arrives every 90 s while a push token is registered. The first push after the app's last local update always differs from what the app last drew (it carries `restRevision: nil` where the app wrote a number), so ActivityKit applies a new state and the widget redraws. Later heartbeats re-send a byte-identical content state; we expect ActivityKit to redraw on those too, but that is not verified on a device. If it does not, an after-tick rest can sit at 0:00 until the climber next opens the app or the queue changes, and a 60 s fixed window can sit through several beats. Verify on a phone before relying on the 90 s figure; tracked in #6538.

Android does not share this gap: the foreground service keeps running and re-posts its own notification at the deadline (the digits turn red and the caption swaps to `androidOverCaption`) and at every fixed-window beat.

## Driving the wall on the Lock Screen, in the Dynamic Island and the Android notification (2.7)

Put on board's timed drive (Settings › Board › **Stop driving after**: Right away, 30 s, 45 s, 60 s, 2 min, 5 min or Until I stop; default 45 s, the same on every board) and an open-ended drive (a swipe, Light every climb, Until I stop) both reach the phone's outside surfaces. In the app both are the frosted "You are driving the wall" button; the timed one adds an m:ss clock and its frost shrinks toward the bulb as its time runs out. Only the phone that holds the board (`connectedByMe`) draws them; a crewmate's card shows nothing about the holder's drive. The card keeps showing the wall's climb (the queue's current), never the MiniPlayer's last pick, and a press steps from that climb.

**What the climber sees.**

- iOS Lock Screen and expanded Dynamic Island: during a timed drive an amber ring drains around the bulb (the in-app frost shrinking toward the bulb, `ProgressView(timerInterval:)`); during an open-ended drive a full amber disc sits behind the bulb; while picks are previews the bulb stands alone. No digits sit beside the ring: the ring alone shows the time left (owner decision, 2026-11-02). The bulb and its ring are one VoiceOver element: the label is "Driving the wall" for either drive or "Wall lit", the value is "Every climb you pick lights up" for either drive or "Picks are previews", with no live number, and the hint is "Stops driving" while a drive is on, else "Lights the climb again".
- Compact Dynamic Island: the ring (or disc) in the leading slot; the grade stays in the trailing slot for either drive. The minimal view shows the ring (or disc) alone. In both, the ring (or disc) and its bulb are one VoiceOver element labelled "Driving the wall" (`LightingBulbGlyph`); the Lock Screen's control ignores its children, so it isn't read twice there. The rest timer wins both compact slots and the minimal view whenever it runs.
- The app's MiniPlayer bulbs draw the same ring (see "Driving on the MiniPlayer" in `docs/climb-view-options.md`).
- Android notification: the header's sub-text says "Driving the wall" for either drive. A timed drive adds the system's own countdown chronometer beside it (`setUsesChronometer` + `setChronometerCountDown`, `setWhen(end)`); an open-ended drive has no clock. The small icon becomes the bulb while picks light. The line rides `ACTION_START` from JS (`mobile.session.notification.drivingTheWall`, `lightDrivingLabel`). The rest timer keeps the content Chronometer.

**Where the state lives.** Like the rest timer, never in `ContentState`, so a crewmate's queue edit (the backend re-sends the whole content state) can't wipe the countdown:

- iOS: App Group key `bs_lighting_window` (`SharedConstants.lightingWindowKey`, `SharedLightingWindowState`: `mode` off | window (timed drive) | driving (open-ended), `endsAtMs`, `windowSeconds`, `family`, `source` app | lockScreen, `updatedAtMs`). `ContentState.lightingRevision` (optional, nil from pushes) is bumped by `LiveActivityManager.rerenderForLightingWindow` only to make ActivityKit redraw; the JS dedup ignores it like `restRevision`. `LightingRenderPhase.resolve` decides at render time whether a timed drive is over. The manager arms one more redraw just after its end; if the app is suspended first, the ring sits empty at 0:00 until the next update.
- Android: SharedPreferences `boardsesh_lighting_window` (`LightingWindowStore`), and `ACTION_LIGHTING` with `lightState` + `lightWindowEndMs` for the service. Absent extras mean off, so an older bundle draws today's card. The service re-posts at the end + 250 ms and on `SCREEN_ON` / `USER_PRESENT`.

**Who writes it.** JS, from the drive store's seam (`getDriveLightingSnapshot` + `subscribeDriveMode`), through `LiveActivityLightingSync` (mounted by `LiveActivityBridge`, `src/lib/live-activity/live-activity-lighting.tsx`), only when the native module reports `supportsLightingWindow`. Arming reads as off. A timed drive's `endsAtMs` is the drive store's own `expiresAt`: nothing clamps it since auto-disconnect went. On iOS JS also mirrors Settings › Board's Stop driving after (`updateKeepLightingConfig`: the choice, In a session too, the roster's crew, and `enabled`, from `lockScreenPressKeepsLighting`: false with the swipe flag off or where Always drive the wall drives, `alwaysDriveApplies`) after every Live Activity start and on every change. JS still sends a MoonBoard choice (the general one) and `moonboard: false` on every board, which the 2.7.0 binary reads for its retired MoonBoard rule, so a press on a MoonBoard's card follows the general rule there too. The binary after it has neither field (`SharedKeepLightingConfig`, `KeepLightingConfigOptions`) and one rule for every board in `SharedKeepLighting.plan(for:)`. A JS from before #7218 that still sends `moonboard: true` gets that rule as well: its general choice, with In a session too deciding in a crew. A timed drive it starts says `family: "general"`; a stored `"moonboard"` family from an older JS reads the same. Android has no native reader for them, so nothing is mirrored there (`sessionPresenceMirrorsKeepLighting`). Native clears the drive (and, on iOS, the settings) on `endSession`, and the drive on a start for another session.

**Lock-screen Next and Previous start or renew a drive.** Each press starts or renews one by the same rule as Put on board in the app, and only once the wall is lit. Under **Right away** the press lights that one climb and starts no drive. Who writes it depends on who lights the wall.

iOS lights it without JS: `ClimbNavigationIntent` writes BLE through `LiveActivityBleBridge`. Only after that write succeeded, in the app process (the widget-extension fallback can't reach BLE and starts nothing), `SharedLightingWindowRuntime.recordPress` writes the drive natively, before the Darwin post:

- an open-ended drive goes on as it is;
- a timed drive still running is renewed by its own length (`windowSeconds`), whatever the setting says now;
- otherwise the mirrored settings decide, as `resolveKeepLightingPlan` would: a timed drive of that many seconds, an open-ended drive for Until I stop, or one lit climb and no drive for Right away (`off`).

That drive starts at the press and ends where native said; JS adopts that end as it is.

**The intent stamps the press in flight.** Native writes the press's drive only after the board write, under Right away it writes none, and JS hears the press only at the Darwin post after that. So before its server request and board write the intent stamps the press in the App Group (`bs_lock_screen_press`, `SharedLockScreenPress.begin`: an id and an expiry 8 s out, 18 s when a party session asks the server first). Once any drive it starts is stored, just before the Darwin post, it settles the stamp (`settledAtMs`). A press the party server turns down settles its stamp too, though no Darwin post follows: removing it could uncover an earlier press whose stamp it replaced while that press is still writing the board. A press only touches its own stamp, so two quick presses can't settle each other's. Ending the session (`SharedLightingWindowRuntime.endSession`) clears the stamp with the drive. Only the app process stamps: the widget-extension fallback writes no board. JS reads it synchronously (`getLockScreenPress`).

Android lights it through JS: `BoardSessionActionReceiver` only forwards the press as `queueNavigate`, and JS's auto-sender writes the climb. So the receiver writes no drive, and JS starts it the way Put on board does (`armNotificationPressDrive`, from `DriveModeWatcher`): with nothing driving, the press arms a drive (`startedBy: 'lock_screen'`) from `lockScreenPressKeepsLighting` + `resolveKeepLightingPlan`, and the wall's lit confirm takes it live and starts the clock there. Under Right away the plan is null and nothing arms. A press the party server turns down, or whose write fails, never lights, so arming times out (`arming_timed_out`) and the notification never shows a drive for it. A timed drive already running renews at the confirm (`noteDriveClimbLit`), and an open-ended one goes on. The header appears once the climb is lit, not at the tap, the same moment the iOS ring does. A press whose index the queue doesn't hold (the bridge drops it) arms nothing.

**JS adopts an iOS lock-screen write once.** `DriveModeWatcher` reads the stored drive (`getLightingWindow`, synchronous) when the app comes to the foreground, on the press's own `queueNavigate` event, when the link comes up, and at the top of its own timed-drive end check, so a renewed drive is never ended as overdue. `resolveLockScreenAdoption` (`src/components/play-drawer/lock-screen-lighting.ts`) starts a live drive with no arming (`startedBy: 'lock_screen'`, ending where native said), takes the later end of a timed drive already running (`extendDriveWindow`), or makes a timed drive open-ended. It waits while there is no link or a drive is arming, and settles each write by its `updatedAtMs`, so a drive the climber stopped in the app is not restarted by the next foreground. Until it is settled, the JS writer never covers a running lock-screen drive with "off".

**A press follows the in-app drive's rules.** Like a pick in the app, a press reads a timed drive's end off the wall clock, never the watcher's timer, which a suspended app or Android's paused JS timers (#7038) hold back. A timed drive already over by the press is not one it renews: native finds it over too (`afterPress`) and starts a new one, so JS ends the old drive at its own end (`window_ended`) and starts the press's (`replacesLapsedWindow`). Under Right away native writes nothing, so the press's own `queueNavigate` ends the old drive (`endTimedDriveOverAtPress`, after adoption). On Android `armNotificationPressDrive` ends it before arming, so its confirm can't renew it. Either way that end keeps the link (`keepLink`): with **Disconnect Bluetooth when driving ends** on, the press is the climber at the wall lighting a climb, so the board is never let go under it. When JS's own end check finds a timed drive over (the foreground catch-up, or its timer), it reads the press stamp first (`endTimedDriveAtClock`, `resolveTimedDriveEndAtClock`):

- a press in flight: the drive stays on and JS looks again every 250 ms until the press settles or its stamp runs out. A stamp claiming more than 20 s from now (the clock moved back) counts as no press;
- a press that settled at or after the drive's end: the drive ends keeping the board, as the press's `queueNavigate` would end it, even when that event hasn't arrived yet. A press the party server turned down then counts the same way, the safe side: its stamp may cover an earlier press still writing;
- no press, a stamp that expired unsettled, or a press that settled before the end (it renewed the drive, or the server turned it down in time): the drive ends at the clock, and the setting lets go of the board.

A Lock Screen mirror tap (`MirrorClimbIntent`) also writes the board natively and stamps nothing yet, so a clock end can still land during its write. Follow-up: #7241.

Android needs no stamp: its receiver forwards the press to JS at once, with no native write or server request first, and JS ends a lapsed drive keeping the board in that same handler, before anything lights. The only gap left is JS's own event queue between the broadcast and the handler, a few milliseconds.

A crewmate's put-up ends a timed drive (`useDriveCrewPutUp`), and one a press started that JS has not adopted yet is adopted first and ended with it, so the next foreground can't bring it back. The climber's own press is never a crewmate's: `widget-navigate` names the token's account as the mover (`currentChangedBy`), and the press's own `queueNavigate` registers its correlation id.

**A relaunch starts with nobody driving.** The App Group outlives the app, so a lock-screen write JS never adopted (the app was killed, or its JS reloaded, between the press and the next foreground) is still there when JS starts again. JS treats any lock-screen write from before its own start as settled: it is never adopted, and the first write from the new JS (off, with nothing driving) takes it off the card. A press while the app was killed usually runs in the widget extension, which can't light the wall and writes no drive. iOS may instead launch the killed app in-process for the intent: then the wall lights and native writes the drive, which the new JS adopts when it started before that write, and otherwise covers with "off" like any earlier JS's write.

`SharedLightingWindowStore.clear(unlessSession:in:)` (start), `SharedLightingWindowRuntime.endSession(in:)` (end) and `SharedLightingWindowStore.write(_:to:)` (JS's write, which skips the redraw when the card would draw the same) live in `SharedConstants.swift`, so `ios-tests/LiveActivityWidgetTests.swift` covers them; `LiveActivityModule` only calls them.

**The bulb stops a drive.** While the card draws a drive (the ring or the disc), a tap on the bulb stops driving, as the frosted button does in the app: reason `stopped`, the wall keeps its climb, the next pick is a preview, and the link stays unless **Disconnect Bluetooth when driving ends** is on, which frees the board without forgetting it (so "Tap to reconnect" then works). With previews the bulb re-lights the climb, as before.

- iOS: the widget runs `StopDrivingIntent` instead of `ReconnectBoardIntent` while `LightingRenderPhase` is a drive. The intent needs no Bluetooth: `SharedLightingWindowRuntime.recordStop` stores mode off with `source: 'lockScreen'` (nothing when the drive already ran out), redraws the card, and posts the Darwin `driveStop` notification, which `LiveActivityModule` hands to JS as `lockScreenDriveStop`. JS adopts the stop like a press (`resolveLockScreenAdoption` → `{ kind: 'stop' }` → `stopDrivingForLink()`), with no link needed and only for a drive that started before the tap; the app coming back adopts a stop it slept through. Until then the JS writer never puts the stopped drive back on the card (`isUnsettledLockScreenStop`). The intent waits up to 2 s for JS to write its own "off", which keeps a just-woken app running while JS adopts the stop. It does not cover the board release: JS writes that "off" as it stops the drive, a moment before the driving-ends effect calls `disconnectKeepingBoard`. The release usually runs in the same wake; if iOS suspends the app first, it runs when the app next resumes, and the card already reads the stop from the App Group meanwhile. The widget offers the stop only when the mirrored settings say JS takes one (`SharedKeepLightingConfig.lockScreenStop`), so an older bundle keeps re-lighting rather than meet a stop it would undo.
- Android: while a drive is on, the lit bulb reads `stopDrivingLabel` (`mobile.session.notification.stopDriving`, sent on `ACTION_START`) and its PendingIntent carries `stopsDrive`; the receiver dispatches `boardControl` `stopDriving`. JS reads the drive again (the notification may be older than the drive's end, #7038) and stops it, or re-lights when it is already over. Without the label (an older bundle) the lit bulb keeps re-lighting. The re-post at a timed drive's end, and JS's own "off", turn the bulb back into a relight.

This is a native change (new fingerprint, store build) in the live-activity module, so it needs a Fable or Astra review. Push-testing steps: `docs/live-activity-push-testing.md#test-driving-the-wall`.

## Architecture Decision: Where Does BLE Live?

The widget extension **cannot** hold a CoreBluetooth connection (extensions have strict memory/runtime limits and Apple kills them after ~30s). The main app process must own the BLE connection.

`LiveActivityIntent` is the iOS 17+ mechanism that lets us drive the main app from a Live Activity button tap. When the intent type is compiled into **both** targets (widget extension + main app) and the user taps a button on the Live Activity, iOS performs the intent in the main app's process — background-launching the app if it was suspended or terminated. The widget acts as the UI host; the actual work runs where the BLE connection lives.

The flow for lock-screen LED control:

```
Widget (lightbulb tap)
  │ system invokes LiveActivityIntent
  ▼
Main app process (background-launched if needed)
  │ LiveActivityIntent.perform() runs here, not in the widget
  │ POSTs to /api/widget/take-control with the registered Live Activity token
  │ the endpoint re-asserts the session's current climb (no driver to claim)
  │ updates ActivityKit so the lightbulb turns on
  ▼
Navigation is always available — sessions are always-live, any member may navigate

Widget (Next/Previous tap)
  │ system invokes LiveActivityIntent
  ▼
Main app process (background-launched if needed)
  │ LiveActivityIntent.perform() runs here, not in the widget
  │ saves new currentIndex to App Group UserDefaults
  │ optimistically updates ActivityKit content state
  │ ┌─────────────────────────────────────────────────┐
  │ │ BoardBleManager.displayCurrentItemAwaitingReady │
  │ │   awaits CoreBluetooth state restoration        │
  │ │   issues UART write inside beginBackgroundTask  │
  │ │   awaits write-queue drain                      │
  │ └─────────────────────────────────────────────────┘
  │ POSTs to /api/widget/navigate so backend / other party clients see the change
  ▼
Physical board LEDs update
```

Two critical enablers in `mobile/ios/App/App.xcodeproj/project.pbxproj`:

- `NextClimbIntent.swift`, `PreviousClimbIntent.swift`, and `WidgetNetworking.swift` are members of **both** the `App` and `BoardseshWidgets` targets. Without `App`-target membership the intent type is not registered in the main app's `AppIntents` package and iOS has no candidate process to background-launch.
- The widget target sets `OTHER_SWIFT_FLAGS = "$(inherited) -D WIDGET_EXTENSION"`. The intent files gate the main-app-only paths (BLE writes, `UIApplication.beginBackgroundTask`) behind `#if !WIDGET_EXTENSION` so the widget-extension compile excludes symbols it cannot link.

The main app process can maintain a CoreBluetooth connection in the background if it declares the `bluetooth-central` background mode (already done in `Info.plist`). State restoration via `CBCentralManagerOptionRestoreIdentifierKey` makes the peripheral connection survive a process restart — but for the restore callback to actually fire, `CBCentralManager` must be constructed **during launch**, before the run loop services other events. In the Expo app, `BoardBleModule`'s `OnCreate` (Expo creates every module at app start) touches `BoardBleManager.shared`, which constructs the central there whenever `CBManager.authorization` is already answered. While it is still `.notDetermined` the central waits for the first scan, or for JS's `requestBluetoothAuthorization` at the scan or connect tap, so a fresh install sees the Bluetooth alert when the climber first looks for a board instead of at launch. Nothing can be restored without permission, so the deferral costs restoration nothing (see `BoardBleManager.shouldCreateCentralManagerAtLaunch`).

`BoardBleManager.shared` lives as long as the process, but each JS runtime gets its own `BoardBleModule`. A JS reload (an OTA `reloadAsync`, a dev `r`) therefore leaves two module instances alive for a moment. React Native's `RCTHost` starts the new instance while the old runtime is still tearing down on its own JS thread. Expo creates the new module, whose `OnCreate` installs the scan, connect and disconnect handlers, as soon as the new runtime starts. The old module's `OnDestroy` runs only when the old runtime finalises, so it can land after that. The handlers are therefore registered with an owner token (`setEventHandlers(owner:)`), and `OnDestroy` calls `clearEventHandlers(owner:)`, which does nothing when a newer module owns them. Before #7023 the destroy cleared the handlers unconditionally. After an OTA reload the scan still ran, but no result reached JS, so the picker said "No boards found nearby" until the app was restarted. The ordering is read from the React Native and Expo sources (`RCTHost` reload, `RCTInstance invalidate`, `ExpoReactNativeFactory didInitializeRuntime`, and the `AppContext` native state that ties its lifetime to the runtime), not from a traced device run. Any other module that writes into a process-wide singleton needs the same owner rule.

## Phases

### Phase 1: Native CoreBluetooth Manager [IMPLEMENTED FOR AURORA + MOONBOARD + WOODS]

Move BLE from JS-only to a native Swift layer that can run when the webview is suspended.

> **Board coverage (2026):** the Swift layer now encodes all three protocol families —
> Aurora (binary packets), MoonBoard (`l#…#` ASCII, #3392), and Woods (`led,role,…,!`
> ASCII with acknowledged writes, #3314). Woods' LED tables live in
> `packages/mobile/modules/live-activity/ios/WoodsBoardData.swift`, generated together
> with the TS maps by `packages/board-constants/scripts/generate-woods-led-maps.ts` and
> drift-tested against the docs JSON. Because OTA'd JS can run on binaries older than
> the encoder they need, JS gates every native board behaviour on the module's
> `nativeBoardControlBoards` constant (`nativeBleSupportsBoard` in
> `packages/mobile/src/lib/ble/native-ios-adapter.ts`); an old binary keeps Woods on
> the ble-plx adapter with widget navigation hidden.

**Files to create:**

- `mobile/ios/App/App/BoardBleManager.swift` -- CoreBluetooth central manager, scan/connect/disconnect, UART write
- `mobile/ios/App/App/BoardBlePlugin.swift` -- Capacitor plugin exposing native BLE to JS (replaces or wraps `@capacitor-community/bluetooth-le` on iOS)
- `mobile/ios/App/App/BoardBlePlugin.m` -- ObjC bridge

**Key work:**

- Implement CoreBluetooth scan, connect, service/characteristic discovery for Aurora boards
- Port the UART packet encoding from `packages/web/app/lib/ble/` (Aurora protocol: placement data → LED bytes)
- Declare `bluetooth-central` in `Info.plist` background modes
- Keep the existing JS Capacitor BLE adapter as a fallback for non-iOS or when native BLE is unavailable
- `BoardBleManager` is a singleton like `SessionWebSocketManager`, owns the `CBCentralManager` and `CBPeripheral` connection

**UART encoding approach -- Rust vs Swift:**

The UART packet encoding (frame string → LED bytes) already exists in the TypeScript BLE layer (`packages/web/app/lib/ble/`). Two options for the native side:

- **Option A: Rewrite in Swift.** The encoding is ~100-150 lines. Simple byte packing, no complex logic. Easiest to debug and maintain alongside the existing Swift codebase. No new build dependencies.
- **Option B: Add UniFFI bindings to the Rust board-renderer crate.** The crate (`packages/board-renderer-wasm/`) already has `HoldData` types and frame string parsing. Adding a `ble_encode(frame_string, holds) -> Vec<u8>` function plus UniFFI `.udl` definition would generate Swift bindings automatically. This shares the frame parsing logic with the WASM build and creates a single source of truth for the Aurora protocol.

Recommend **Option A** for Phase 1 -- keep it simple, ship fast. Revisit Option B if we add more shared logic to the Rust crate (see Phase 3b).

**Hold data requirement:** To illuminate LEDs, the native layer needs hold positions and LED mappings. The implementation uses compiled-in Swift placement data generated from the board constants package, so the native layer can resolve any queued Aurora climb's LEDs independently without a live webview.

**Definition of done:** Board LEDs light up when navigating climbs via the Lock Screen widget while the app is in the background.

### Phase 2: Background BLE Connection Persistence [PARTIALLY IMPLEMENTED]

Ensure the CoreBluetooth connection survives app backgrounding and can recover.

**Key work:**

- `bluetooth-central` background mode in `Info.plist` (allows CoreBluetooth to run in background)
- State preservation and restoration (`CBCentralManager` `restoreState` option)
- Handle `centralManager(_:willRestoreState:)` to reconnect to known peripherals after process termination
- Reconnection logic: if the BLE connection drops while backgrounded, attempt to reconnect with exponential backoff
- Battery impact assessment: CoreBluetooth in background is efficient (no scanning needed, just maintaining an existing connection), but test real-world drain

**Definition of done:** BLE connection persists through backgrounding and app suspension. LED writes work reliably after returning from background.

### Phase 3: Embedded Hold/LED Placement Data in Native Code [IMPLEMENTED FOR iOS BLE]

> **Historical note (Capacitor retired):** the pipeline below originally targeted the
> Capacitor app via `generate-ios-board-placement-data.ts` →
> `mobile/ios/App/App/BoardPlacementData.swift`. That app, its Swift file, and the
> generator have been removed from the repo. The React Native app keeps its own copy at
> `packages/mobile/modules/live-activity/ios/BoardPlacementData.swift`. The design below is
> retained for reference.

The native layer needs hold positions and LED mappings to illuminate the board. Rather than sending this over the WebSocket (which would bloat every message), embed the static board data directly in the compiled Swift code -- the same approach already used for TypeScript and the ESP32 controller.

**Generated data pipeline:**

- `packages/board-constants/scripts/generate-board-constants.ts` produces the committed TypeScript board constants:
  - `packages/board-constants/src/generated/product-sizes-data.ts` -- hold placements as `HoldTuple[]` (`[placementId, mirroredPlacementId, x, y]`), indexed by `boardName` → `"layoutId-setId"`
  - `packages/board-constants/src/generated/led-placements-data.ts` -- LED strip positions as `Record<placementId, ledIndex>`, indexed by `boardName` → `"layoutId-sizeId"`
- `packages/board-constants/scripts/generate-ios-board-placement-data.ts` reads those committed constants and writes `mobile/ios/App/App/BoardPlacementData.swift`
- `packages/board-controller/esp32/scripts/generate-led-mapping.js` reads the TS LED data and generates a C++ header (`led_placement_map.h`) for the embedded controller

**Key work:**

- Add a second codegen step that converts the TypeScript constants to a Swift file (`mobile/ios/App/App/BoardPlacementData.swift`) with static dictionaries
- Include mirrored hole placements and LED placements
- The Swift data is compiled into the app binary -- no runtime fetching, no App Group, no WebSocket overhead
- Each climb's `frames` string (already in `SharedQueueItem`) contains `p<placementId>r<stateCode>` pairs. The native BLE manager looks up each placementId in the embedded data to get the LED index, then encodes the UART packet.

**Generator output structure:**

```
packages/board-constants/scripts/generate-board-constants.ts
  -> packages/board-constants/src/generated/product-sizes-data.ts (existing, TypeScript)
  -> packages/board-constants/src/generated/led-placements-data.ts (existing, TypeScript)
packages/board-constants/scripts/generate-ios-board-placement-data.ts
  -> mobile/ios/App/App/BoardPlacementData.swift (new, Swift)
packages/board-controller/esp32/scripts/generate-led-mapping.js
  -> packages/board-controller/esp32/src/config/led_placement_map.h (existing, C++)
```

**Trade-off:** Board data changes require regenerating and recompiling the app. This is fine -- board hardware configurations are static and change at most once per board revision (years). Run the board-constants generator or its iOS-only generator script to refresh the Swift output after board-constant changes.

**Definition of done:** The native layer can look up LED positions for any hold placement without the webview, using data compiled into the app binary. `BoardBleManager` can encode a UART packet from a frames string alone.

### Phase 4: Expanded Widget Controls

Add more actions to the Lock Screen widget, including workout support.

**Queue controls:**

- Mirror toggle (flip the current climb)
- Skip/remove current climb from queue
- Tick/log the current climb as sent

**Variable-speed playback (future, issue #2232 follow-up):**
The web client now drives multi-frame Aurora climbs through a JS-side playback engine and broadcasts a `PlaybackStateChanged` WebSocket event so party peers stay in sync. The Live Activity does NOT yet consume those events — the widget will still show only the climb's first frame. When this lands on the widget, the native handler should: (a) decode the new event in `SessionWebSocketManager`, (b) drive `BoardBle` to send the active frame on each tick, and (c) optionally render a frame counter in the expanded layout. The pace clamp (50 ms minimum) lives on the engine side in `packages/web/app/components/board-renderer/util.ts` (`MIN_PACE_MS`) — mirror that constant when the native side schedules its own writes.

**Workout controls (future):**
When workouts land in Boardsesh, the Live Activity becomes the primary workout interface on the wall. The widget will need to display and control:

- Current set and rep within the workout (e.g., "Set 2/4, Rep 3/6")
- Rest timer countdown between sets (the session rest timer already reaches the Live Activity; see "Rest timer on the Lock Screen and in the Dynamic Island" above for how a workout's rest could reuse it)
- Start/complete rep buttons
- Skip set or end workout early

The workout state lives server-side and arrives via the same WebSocket subscription. The widget complexity grows (more UI states, timer logic, conditional layouts) but the underlying transport stays the same: WS event → `SessionWebSocketManager` → App Group → Live Activity update. The native Swift state machine may need a workout-specific event type alongside the existing queue events, but the plumbing is identical.

**Design constraints:**

- iOS widget interaction is buttons only, no complex input
- Each action follows the same pattern: optimistic App Group update → `LiveActivityIntent.perform()` in main app → BLE write (if owner) + HTTP POST to backend → server confirms → all clients update
- Lock Screen expanded view has ~160pt height -- plan layouts for queue mode and workout mode

### Phase 5: Android Parity (Future)

If/when the Android app needs the same capabilities:

- Kotlin `BluetoothGattCallback` for BLE (mirrors `BoardBleManager`)
- Android foreground service for background BLE persistence
- Media notification or custom notification for lock-screen controls (Android doesn't have Live Activities)
- Same WebSocket consolidation pattern as iOS (native WS → Capacitor bridge)

## Pre-Phase 1: Golden Test Fixtures for Queue State Machine

Before reimplementing the queue state machine in Swift, establish a shared test suite that both implementations run against. This catches drift between platforms without shared code.

### What to test

The pure `queueReducer(state, action) => state` in `packages/web/app/components/queue-control/reducer.ts` is the primary target. It handles all delta event types:

| Action                       | Reducer case                                  | Behavior |
| ---------------------------- | --------------------------------------------- | -------- |
| `DELTA_ADD_QUEUE_ITEM`       | Idempotent insert at position or end          |
| `DELTA_REMOVE_QUEUE_ITEM`    | Filter by uuid, clear current if removed      |
| `DELTA_REORDER_QUEUE_ITEM`   | Validate indices, splice-based reorder        |
| `DELTA_UPDATE_CURRENT_CLIMB` | Echo detection via correlationId/clientId     |
| `DELTA_MIRROR_CURRENT_CLIMB` | Toggle mirrored on current climb + queue copy |
| `INITIAL_QUEUE_DATA`         | Full state replacement (maps to FullSync)     |

Secondary targets:

- `insertQueueItemIdempotent(queue, item, position?)` in `persistent-session/event-utils.ts`
- `evaluateQueueEventSequence(lastSequence, eventSequence)` returning `'apply' | 'ignore-stale' | 'gap'`

### Fixture format

A JSON file with an array of test cases:

```json
[
  {
    "name": "add item to empty queue",
    "initialState": { "queue": [], "currentClimbQueueItem": null, "lastReceivedSequence": 0 },
    "event": { "type": "DELTA_ADD_QUEUE_ITEM", "item": { "uuid": "a", "climb": { ... } }, "position": 0 },
    "expectedState": { "queue": [{ "uuid": "a", ... }], "currentClimbQueueItem": null, "lastReceivedSequence": 1 }
  }
]
```

### How both platforms consume fixtures

- **TypeScript (Vitest):** Load JSON, loop through cases, call `queueReducer(initialState, action)`, deep-equal against `expectedState`
- **Swift (XCTest):** Load same JSON from test bundle, decode into Swift types, apply the equivalent Swift state machine function, assert equality

The fixture file lives in `packages/shared-schema/test-fixtures/queue-state-machine.json` (or similar shared location accessible to both test targets).

### Existing test coverage

- `packages/web/app/components/queue-control/__tests__/reducer.test.ts` -- existing Vitest tests for the reducer
- `packages/web/app/components/persistent-session/__tests__/event-utils.test.ts` -- tests for utility functions
- These should be refactored to load from the golden fixtures instead of inline test data

## Technical Notes

### Aurora Board BLE Protocol

The board BLE communication uses a UART service. Key characteristics:

- Service UUID and characteristic UUIDs are in `packages/web/app/lib/ble/uuid.ts`
- Packet format is in `packages/web/app/lib/ble/` -- holds are encoded as placement data with position, color, and role bytes
- The native Swift implementation needs to replicate this encoding exactly

### Background Execution Budget

iOS gives backgrounded apps limited execution time. For our use case:

- **CoreBluetooth background mode**: unlimited for maintaining connections and responding to peripheral events
- **`LiveActivityIntent.perform()`**: iOS gives the intent a few seconds of background runtime to complete. `BoardBleManager.displayCurrentItemAwaitingReady` wraps the BLE write in `UIApplication.beginBackgroundTask` to extend that window through state restoration + UART chunk flushing
- **URLSessionWebSocketTask**: continues receiving messages in the background for a limited time, then iOS may suspend it. The `isDisconnectedCallback` and reconnection logic handle this gracefully

### State Synchronization

The App Group UserDefaults is the shared state layer between the main app, widget extension, and (in the future) the BLE manager. All writes must be atomic and the widget must tolerate stale reads. The current `SharedQueueState.save()`/`load()` pattern handles this correctly.

### Existing Rust Crate

The board renderer at `packages/board-renderer-wasm/` is a production Rust → WASM pipeline:

- **Crate:** `board-renderer-wasm`, edition 2024, `tiny-skia` for 2D rendering
- **Build:** `wasm-pack build --target web`, output in `pkg/` (~465KB WASM binary)
- **Backend:** `packages/backend/src/handlers/board-render.ts` serves the Railway renderer; `packages/backend/src/services/board-render.ts` loads WASM, renders hold overlays, and composites with `sharp` to WebP
- **Frontend:** `packages/web/app/lib/board-render-worker/board-render.worker.ts` runs WASM in a Web Worker with OffscreenCanvas
- **Types:** `HoldData { id, mirrored_hold_id, cx, cy, r }`, `HoldStateInfo { color }`, frame string parser
- UniFFI could be added to generate Swift/Kotlin bindings if needed for BLE encoding, but not planned currently

### What We Decided Not To Do

**Shared Rust/WASM state machine**: The queue state machine is ~200 lines in Swift and ~150 in TypeScript. The queue is an ordered list with a cursor -- comparable to a collaborative Spotify or YouTube playlist, not a document editor. Operations are add, remove, reorder, and change current position. The server is authoritative, conflicts resolve trivially (last write wins), and there are no concurrent character-level edits requiring OT or CRDTs. This will stay simple even with workouts (just another event type through the same transport). Maintaining two small, language-idiomatic implementations is simpler than UniFFI bindings and cross-compilation CI for code that rarely changes.
