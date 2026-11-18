# Boardsesh Garmin watch app (Connect IQ / Monkey C)

A Garmin Connect IQ watch app that attaches to an already-active Boardsesh
multiplayer session and drives it from the wrist. The watch **never** talks to
the climbing board — it mutates the shared backend session over plain HTTPS
(through the paired phone's Garmin Connect), and the phone reacts and repaints
the board over Bluetooth.

From the watch a climber can:

- see the current climb (name, grade, angle, `i / N` queue position),
- navigate next / previous through the queue,
- log an **attempt / send / flash**,
- re-send the current climb to the board, switch sessions, and end the activity.

Because Garmin gives Connect IQ apps **plain HTTPS only (no WebSocket)**, the
watch **polls** `/api/session/state` every 3s while the climb screen is in the
foreground. Real-time control is therefore foreground-only.

> This project is not a workspace in the root `package.json` and is not run
> by `vp test`. Invoke the Connect IQ SDK tools through `vp exec`. `garmin/bin/`
> and the `developer_key` are gitignored.

---

## 1. Install the Connect IQ SDK

The SDK and device profiles are separate downloads. Install the profiles for
all products in the manifest through Garmin's SDK Manager before compiling;
follow its sign-in requirements. A physical watch is not required for simulator
unit tests.

1. Install the **Connect IQ SDK Manager** from
   <https://developer.garmin.com/connect-iq/sdk/>.
2. Launch the SDK Manager and download the **SDK**
   (9.2.0 at the latest repair) and at least one **device** (e.g. `fenix7`). Accept the SDK license.
3. Make sure the SDK `bin/` is on your `PATH` so `monkeyc`, `monkeydo`, and
   `connectiq` (the simulator launcher) are available. The SDK Manager prints
   the install path; typically:
   - macOS: `~/Library/Application Support/Garmin/ConnectIQ/Sdks/<version>/bin`
   - Linux: `~/.Garmin/ConnectIQ/Sdks/<version>/bin`

Verify:

```bash
vp exec monkeyc --version
```

## 2. Generate a developer signing key (one-time, no account needed)

Every build is signed with a developer key. Generate one locally:

```bash
cd garmin
openssl genrsa -out developer_key.pem 4096
openssl pkcs8 -topk8 -inform PEM -outform DER \
  -in developer_key.pem -out developer_key -nocrypt
```

This produces `garmin/developer_key` (DER, PKCS#8) — the file `monkeyc -y`
wants. It is **gitignored**; never commit it. The same key must be reused for
store updates of a published app, so keep it somewhere safe if you ever publish.

## 3. Build

```bash
# from the repo root
vp exec monkeyc -f garmin/monkey.jungle \
  -o garmin/bin/boardsesh.prg \
  -y garmin/developer_key \
  -d fenix7
```

- `-d fenix7` picks a device from the manifest allow-list. Swap for any product
  id in `manifest.xml` (e.g. `venu3`, `fr965`).
- **Do not use `vp run build`** — that's the web/mobile toolchain and does not
  know about this project.

### Staging backend flavor

`source/config/BuildConfig.mc` exposes `baseUrl()` twice — a `(:production)`
copy (`https://ws.boardsesh.com`) and a `(:staging)` copy. The base build strips
`(:staging)`. Add the staging jungle overlay to strip `(:production)` instead.
Set the placeholder staging URL to your test backend before use:

```bash
vp exec monkeyc -f "garmin/monkey.jungle;garmin/monkey-staging.jungle" \
  -o garmin/bin/boardsesh-staging.prg -y garmin/developer_key -d fenix7
```

To point at a **local** backend during development, edit the `(:staging)`
`baseUrl()` to your machine's LAN URL (the watch reaches it via the phone, so
`localhost` won't work — use the host's LAN IP, e.g. `https://192.168.1.20:8080`,
and note the phone must trust the TLS cert). Rebuild with both jungle files in the `-f` list shown above.

## 4. Run in the simulator

```bash
# start the simulator (once)
vp exec connectiq

# side-load the built app into the running simulator
vp exec monkeydo garmin/bin/boardsesh.prg fenix7
```

The simulator can fake outbound HTTP. For the pairing flow you'll want a real or
mocked backend reachable from your machine.

## 5. Run the unit tests

The pure logic (`BsEndpoints`, UUID formatting, exact tick-queue removal,
saveTick reply classification, the dead-letter store, pre-G2 tick adoption,
navigation generations/wraparound, and poll reconciliation) has `(:test)`
functions under `garmin/tests/`. Build a **test** binary (`-t`) and run it with
`-t`:

```bash
vp exec monkeyc -f garmin/monkey.jungle \
  -o garmin/bin/boardsesh-test.prg \
  -y garmin/developer_key \
  -d fenix7 -t

vp exec monkeydo garmin/bin/boardsesh-test.prg fenix7 -t
```

`monkeydo ... -t` (equivalently `--unit-test`) runs every `(:test)` function and
prints a PASS/FAIL table. No network or account required.

The reply table is also checked from the backend side: `vp run
test:native-contract` replays the current `TickQueue` classifier and
`BsEndpoints` body builders (`garmin-tick-replies.contract.ts`) against replies
from the real graphql-yoga transport, `SaveTickInput` type, input schema and
production error mask.

## 6. Pairing flow (get a code, type it on the watch)

The watch authenticates with a short-lived **mobile JWT**. To obtain one:

1. In the **Boardsesh phone/web app**, while a multiplayer session is active,
   generate an **8-character watch pairing code**.
2. On the watch, open **Boardsesh** → the pairing screen. Use **UP/DOWN** (or
   swipe) to change the highlighted character, **START** to confirm each
   character, **BACK** to delete. Confirming the 8th character submits.
3. The watch calls `POST /api/watch/pair`, stores the returned
   verified `{ jwt, refreshToken, expiresAt, userId }` response in one versioned
   auth value, then resolves the active session and opens the climb screen.

Tokens are refreshed on a `401` via `POST /auth/native/refresh`. `/graphql`
answers an expired access token with HTTP 200 and the code-less error
`Authentication required to perform this operation` (the server reads the
bearer as anonymous), so that reply takes the same refresh and one retry. The auth envelope
binds credentials to the verified response owner, login scope and credential
revision. Requests capture their own JWT and scope; an old request never retries
with another login's credentials. Concurrent refreshes share only their own
scope's flight. A persisted rotation marker precedes the single-use refresh
request. Proven pre-send refusal (SDK no-connection or queue-full) and the
existing endpoint's explicit overload/admission-rollback/rate-limit responses
restore same-scope retry eligibility. Timeouts, lost responses and unrecognized
server failures retain the marker and never retry a potentially consumed refresh
secret. A known owner's existing access JWT and offline logging may continue;
a later access rejection requires explicit pairing. Unknown-owner bootstrap
cannot acquire an owner from an ambiguous result. A successful rotation whose
storage write fails never publishes its new tokens and requires explicit
recovery. Pending ticks remain stored throughout.

This distinguishes Garmin's documented pre-send refusal codes from timeout and
connection-loss outcomes; see
[Communications error meanings](https://developer.garmin.com/connect-iq/api-docs/Toybox/Communications.html).
The legacy refresh protocol cannot recover a committed token pair after its
response is lost. No idempotency or backend protocol change is claimed here.

### Shared-watch security and queued ticks

A paired watch holds native-session credentials in Garmin's plaintext application
storage, which is not a secure enclave. Treat it as signed into the account.
Re-pairing advances a persisted monotonic scope; clearing credentials preserves
that tombstone. Counter exhaustion refuses further changes rather than wrapping.
The V2 auth value remains authoritative even after sign-out or corruption; old
credential keys are never consulted once it exists. A verified legacy-credential
refresh binds only those credentials into a new scope; it never adopts old
queued ticks by itself (see the adoption rule below).

`TickQueue` persists the complete owner-partitioned `OwnedTickOutbox` envelope
before the first request and before FIT laps, counters or success feedback.
Logical capacity and storage failures refuse new logs without evicting saved
efforts. Each request owns an owner/scope/UUID lease. Nothing is ever deleted
without either the server's acknowledgement, a copy in the dead-letter store,
or the climber confirming a delete in the refused-ticks list.

#### Where a tick can be

| State | Storage value | Sent? | Leaves when |
| --- | --- | --- | --- |
| Queued under its owner | `bs.pendingTicks` `owners[<userId>]` | Only while that verified owner is signed in | The server acknowledges its exact UUID, or refuses it for good |
| Refused (dead letter) | `bs.rejectedTicks` | Only after Retry, under the same owner | The signed-in owner picks Retry all (back to the end of their queue) or confirms Delete all; while the store is full, another account's climber may confirm Delete others' ticks |
| On hold (pre-G2, owner unproven) | `bs.pendingTicks` `unowned` | Never, until adopted | The adoption rule below proves its owner |

#### Server replies

A drain (Save or Discard at the end of an activity) sends the signed-in
owner's ticks oldest first. The verdict on each reply comes from the
`saveTick` resolver (`packages/backend/src/graphql/resolvers/ticks/mutations.ts`)
behind graphql-yoga's `/graphql` transport. `saveTick` hands its callback the
raw GraphQL body so the error codes survive. Only verdicts about one tick's
own data dead-letter it; anything that would refuse every tick alike retries.

| Reply | Verdict | What the drain does |
| --- | --- | --- |
| 2xx, no `errors`, `data.saveTick.uuid` equals the sent UUID (a UUID the account already saved answers the stored tick) | Acknowledged | Removes it, sends the next |
| 2xx whose every error is `CLIMB_NOT_FOUND` (spray climb deleted or hidden), `TICK_UUID_CONFLICT` (another account owns the UUID), or the code-less `Invalid input: …` from `SaveTickInputSchema` | Refused | Moves it to the dead-letter store, sends the next |
| HTTP 400 whose every error is yoga's `got invalid value null at "input.<field>"` for a field the watch copies from session state (`boardType`, `climbUuid`, `angle`, `isMirror`, `isBenchmark`) | Refused | Same |
| Every other 400 (no body, unparseable body, unknown or missing input field, a constant field refused), `GRAPHQL_VALIDATION_FAILED` on the fixed query, SDK transport codes (below 0), 401 after the client's own refresh, 404/429/5xx from the edge or server, masked `INTERNAL_SERVER_ERROR`, `SERVICE_UNAVAILABLE`, `UNAUTHENTICATED`, the code-less `Authentication required …` an expired token gets (after the client's own refresh and retry), an acknowledgement for a different UUID, and any shape not listed above | Retry | Keeps the tick in place and stops the drain |

Auth failures and transport errors never dead-letter a tick: an unknown reply
costs a stuck queue until the next drain, never a refused effort. Whether the
SDK hands the watch a body with a 400 is not verified on hardware; without one
a 400 retries, as before this change.

Two guards bound a misread verdict. A second refusal with the same reason in
one drain stops the drain and keeps that tick queued, so a server fault that
refuses everything costs at most one tick per reason per drain (two ticks on
one deleted climb take two drains). The live log path never dead-letters: a
refused effort shows "Not saved to logbook" and stays queued for the exit
drain. A refusal is also kept queued when the dead-letter write fails or the
store is full. The dead-letter write comes before
the outbox removal, so a crash between the two leaves a copy in both stores and
the next drain's identical refusal adds no second entry.

The phone outbox (`packages/shared/offline-sync`) dead-letters any 400, 403,
409 or 422 and the codes `CLIMB_NOT_FOUND`, `GRAPHQL_VALIDATION_FAILED`,
`BAD_REQUEST`, `BAD_USER_INPUT` and `FORBIDDEN` on the first attempt, and
retries the rest ten times. Without a retry budget, the watch
instead dead-letters only per-tick verdicts, including the code-less
`Invalid input` and `TICK_UUID_CONFLICT`, and retries the schema-wide ones.

Unlisted spray walls are not loggable from the watch, by decision (#7636,
decision 1). A wall's `?wall=` uuid is its only capability, the one `saveTick`
checks as `boardUuid`, and session state never carries an unlisted spray
wall's uuid: a session invite is not the wall's link. The same endpoint checks
the current climb without the capability, so it returns `climb: null` for such
a wall and the watch cannot log there at all. The climber logs those climbs on
the phone, which holds the link.

`boardUuid` on the watch is a forward-compatible field that no server fills
today. The watch copies it from session state into every tick when the state
carries a 36-character string, and leaves the key out otherwise (the input
schema refuses a null). It is there so a later server change needs no new
watch build; reopening the decision would take both a stored per-member link
standing and that same uuid passed to the session-state climb check.

So a tick only reaches `CLIMB_NOT_FOUND` when a wall's or climb's visibility
changes between logging and the drain (made unlisted, a gym membership ended),
or when an admin hid the wall, which a uuid does not reopen for anyone but its
owner. That is why a dead-lettered entry may be a real send, and why the store
never drops one on its own.

`bs.rejectedTicks` is `{ version: 1, entries: [{ owner, tick, reason }] }`,
oldest first, capped at 25 entries (`BuildConfig.REJECTED_TICK_MAX`). A tick is
about 500 bytes, so a full store is roughly 15KB of its own 32KB value. Nothing
is ever evicted. When the store is full, the next refusal is treated as "retry
later": the tick stays at the head of the queue and the drain stops there, as
every refusal did before this change. The summary then says the store is full.
The climber empties it from the watch: Session menu (MENU) → Refused ticks,
shown when the signed-in owner has any, or when the store is full with other
accounts' entries (then the row's count reads "N from other accounts"). The
list has Retry all and Delete all (when the owner has entries), Delete others'
ticks (only while the store is full, below), and one row per refused tick of
the owner (status, local time, the server's reason).

- **Retry all** moves up to 5 of the owner's refused ticks (oldest first) back
  to the END of their queue, unchanged and with the same UUIDs, then starts a
  drain. It never fills the last 5 queue slots: a drain dead-letters only one
  tick per refusal reason, so a batch the server still refuses must not block
  new logs. `TICK_UUID_CONFLICT` entries never move, because another account
  owns that UUID and a resend can only be refused again; Delete clears them. The outbox write comes first, so a failure in
  between leaves a copy in both stores; the next retry only drops the stale
  entry. A resent UUID cannot become a second logbook entry: `saveTick`
  answers a UUID the account already saved with the stored tick. A tick the
  server refuses again returns to the list, once. Use it after a server-side
  fix (a climb restored, a wall made visible again) or after re-pairing the
  account whose ticks they are; a re-pair alone retries nothing.
- **Delete all** asks first, then drops the owner's refused ticks. It is the
  only deletion without a server acknowledgement.

Both act only on the signed-in owner's entries. Another account's refused
ticks stay until that account signs in on the watch again, and they still
count toward the 25-entry cap. The phone has no channel to the watch's
storage, so neither action exists on the phone.

- **Delete others' ticks** (#7636 decision 2) is the exit when other accounts'
  entries keep the store full. A full store keeps the signed-in climber's next
  refusal at the head of their queue, the drain stops there, and once the
  queue holds 25 ticks new logs are refused; the only other way out is
  reinstalling the app, which also wipes every account's queued ticks. The row
  is offered only while the store holds `REJECTED_TICK_MAX` entries and other
  accounts own some, and it names their count. It has its own confirmation
  ("Delete other accounts' refused ticks? They can't be recovered."). Yes
  removes only those accounts' already-refused entries from `bs.rejectedTicks`
  and re-checks the cap at press time. It never touches `bs.pendingTicks` for
  any account, and never the signed-in owner's entries. Delete all stays
  owner-only.

#### On-hold ticks from before G2 (#7445)

Builds before the owner-scoped queue stored a bare array with no owner. Their
pairing wrote new credentials before clearing that array, so an interrupted
pairing could leave the previous account's ticks beside new credentials.
Neither the current credentials, a verified refresh, nor a same-account
re-pairing proves whose those ticks are, and the watch never recorded how many
accounts an old build was paired to.

One thing is provable. Old builds wrote the access token (`bs.jwt`) first on
every pairing and refresh and signed every tick request with it, and no newer
build writes that key. So every tick the old app logged after the final
`bs.jwt` was issued was logged while it was signed in as that token's subject.
A drain adopts an on-hold tick into the signed-in owner's queue only when all
of these hold:

1. The signed-in owner was verified by the server (pairing or refresh).
2. The final pre-G2 token's `sub` claim is exactly that owner.
3. The tick has a UUID, fits the queue's depth bound, and its `climbedAt` is
   exactly the `YYYY-MM-DDTHH:MM:SSZ` form the app writes.
4. That `climbedAt` is at least 24 hours (`BuildConfig.LEGACY_ADOPT_SKEW_SEC`)
   after the token's `iat`. The margin covers a watch clock set fast by a
   wrong time zone (at most 14 hours). The proof assumes the watch clock was
   never more than a day fast while those ticks were logged.
5. The owner has no queued tick with the same UUID and the shared queue has
   room.

Adoption happens one tick at a time, only once the owner's own queue is empty,
so an offline drain leaves at most one adopted tick in the queue. The token's
signature is not checked: the value is the app's own storage, and its subject
must also match an owner the server verified. Everything else stays on hold,
including every tick logged before the final token or within a day of it, and
is never sent under any account.

The session summary (End activity) shows `N refused  M on hold` in orange when
either count is above zero, and `N refused, full` once the refused store is
full (any account's entries count toward it). Refused counts belong to the
signed-in owner. Reading the counts writes nothing.

Known-owner partitions survive re-pairing and become eligible only when that
verified owner signs in again. Stale requests may settle their own flight or
lease; they cannot acknowledge ticks, overwrite state, route, or exit a newer
login. Pairing saves any outgoing FIT activity before resetting session state.

Auth, outbox and dead-letter store use separate SDK storage values, so
credentials never share a value with potentially large queue data. Garmin
documents a 32KB per-value limit and exceptions when storage is full; adapters
catch failures and publish only after a successful write. This is one write per
value, with no claim of power-loss atomicity across keys. See the official
[Storage contract](https://developer.garmin.com/connect-iq/api-docs/Toybox/Application/Storage.html).

#### Older builds reading this storage

The outbox format is unchanged at version 2, and the dead-letter store is a new
key. A G2 build installed over this one reads the outbox as before, sends
adopted ticks under the owner they were adopted for, and never sees refused
ticks; it leaves `bs.rejectedTicks` untouched, so a later upgrade finds them
again. A G2 build retries a refused tick that is still queued and stops its
drain there, as it always did. Array-only builds from before G2 still cannot
read the version 2 envelope.

The application currently exists only on the owner's test watch; public
publication is planned for December. Existing queued test data, original-key
update safety, and real-watch queue/FIT QA remain activation/release gates in
owner runbook [#7430](https://github.com/boardsesh/boardsesh/issues/7430).
SDK simulation and ephemeral-key compiles do not close those gates. Safe
downgrade/recovery is unqualified, rather than an implicit rollback promise.

SDK validation must use the complete test report rather than its launcher exit
status: the local launcher can exit 1 even when every SDK test passes. Mutation
checks require a successful compile and an explicit named assertion failure;
compiler errors and incomplete reports never count as killed mutations.

## 7. How the board actually gets repainted (delivery model)

The watch only mutates the **shared backend session**. It does not speak
Bluetooth to the board. When the watch calls `navigate` / `take-control`, the
backend updates session state; the **phone** (subscribed over WebSocket) reacts
and drives the board's LEDs over Bluetooth.

That means board changes land while the phone is:

- in the foreground with the board connected, or
- backgrounded on iOS **with the board still connected** (BLE stays live).

If the phone is fully disconnected from the board, the watch's changes still
persist in the session and repaint the board as soon as the phone reconnects.

## 8. Connect IQ Store submission

1. Create a Garmin/Connect IQ **developer account** at
   <https://developer.garmin.com/connect-iq/> and agree to the developer terms.
2. Build a store package (`.iq`) with export mode `-e`:

   ```bash
   monkeyc -f garmin/monkey.jungle \
     -e -o garmin/bin/boardsesh.iq \
     -y garmin/developer_key
   ```

   `-e` builds for **all** products in the manifest (no `-d`). Reuse the **same**
   `developer_key` for every release, or the store will reject the update.
3. Replace the placeholder launcher icon (see below) with real branding before
   exporting.
4. Upload `boardsesh.iq` in the Connect IQ Store dashboard, fill in listing
   copy + screenshots, and submit for review.

## Launcher icon

`resources/drawables/drawables.xml` references `launcher_icon.png`, which **is
committed** as a plain 60×60 solid-colour **placeholder** so the project builds
out of the box. Replace it with a real Boardsesh logo export (a small square
PNG) at `resources/drawables/launcher_icon.png` before shipping. No AI-generated
art — use a real logo export.

## Project layout

```
garmin/
  manifest.xml            App metadata, product allow-list, Communications permission
  monkey.jungle           Default production build config
  monkey-staging.jungle   Staging annotation override
  README.md               This runbook
  source/
    BoardseshApp.mc       AppBase entry point + boot routing
    Services.mc           Shared BsClient locator
    Router.mc             Synchronous view transitions
    config/BuildConfig.mc Base URL (per flavor) + tunables
    net/BsEndpoints.mc    PURE URL/body/SaveTickInput builders (unit-tested)
    net/BsClient.mc       makeWebRequest wrapper: auth, 401-refresh-retry, GraphQL
    auth/TokenStore.mc    JWT/refresh/exp persistence in Application.Storage
    state/AppState.mc     Session state singleton + PURE nav reconciliation
    state/PollController.mc  3s foreground poll w/ backoff + optimistic reconcile
    state/TickQueue.mc    Reply classification, storage adapters, scoped flusher
    state/OwnedTickOutbox.mc  PURE owner-partitioned outbox + on-hold adoption
    state/RejectedTicks.mc    PURE dead-letter store for refused ticks (+ requeue/delete)
    state/LegacyTickProof.mc  PURE pre-G2 token subject/issue-time reader
    state/TickLogger.mc   Live log: persist, send once, settle the reply
    recording/ActivityController.mc  FIT recording (start/lap/save/discard)
    util/TimeUtil.mc      UTC ISO-8601 climbedAt helper
    util/Toast.mc         Transient feedback (showToast w/ vibrate fallback)
    views/                Views + delegates (Pairing, Loading, Climb, pickers, menus)
  resources/
    strings/strings.xml   All user-facing strings
    drawables/drawables.xml  LauncherIcon declaration
    drawables/launcher_icon.png  Placeholder icon (replace with real branding)
  tests/                  (:test) functions for the pure logic
```

## Validation status

Earlier PR discussion records successful compilation and simulator tests; the
old statement that this app had never compiled was stale. The September 22
repair compiled the app and test sources with the official Connect IQ 9.2.0
compiler using its generic target. Fresh device-specific builds and simulator
test execution still require installed device profiles. Generic compilation is
separate from executing the tests or checking a watch's memory/API limits.

On 2026-11-16 the dead-letter change compiled as a `fenix7` test build with SDK
9.2.0 and an ephemeral key, and the simulator ran 92 tests: 92 passed, 0 failed,
0 errors. Two SDK calls were replaced after the simulator showed they raise
uncatchable VM errors on bad input: `Gregorian.moment` for 31 February and
`StringUtil.convertEncodedString` for malformed base64. The SDK test runner
does not enforce the bytecode watchdog (a 50-million-iteration probe passed),
so whether the heaviest drain callback (refuse, then adopt, beside full queues)
fits on a real watch is a hardware check. Real-watch behaviour is not covered
by that run.

The backend pairing alphabet matches `PairingView.CHARSET`. SDK 9.2.0 documents
`Activity.SPORT_ROCK_CLIMBING`, `Gregorian.utcInfo` with numeric `FORMAT_SHORT`
fields, and the signed `System.getTimer` rollover. The staging build uses an
explicit jungle overlay rather than unsupported `--flavor` syntax.

Before store submission, compile every product in the manifest, run the Monkey C
unit suite, replace the launcher placeholder, and test pairing, queue navigation,
logging, reconnect, FIT save/discard and shared-watch re-pairing on hardware.
A phone OTA preview does not validate or install this Garmin application.
