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

Tokens are refreshed on a `401` via `POST /auth/native/refresh`. The auth envelope
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
refresh may bind only those credentials into a new scope, never old queued ticks.

`TickQueue` persists the complete owner-partitioned `OwnedTickOutbox` envelope
before the first request and before FIT laps, counters or success feedback.
Logical capacity and storage failures refuse new logs without evicting saved
efforts. Each request owns an owner/scope/UUID lease. Only a typed successful
response acknowledging the exact UUID under the current scope removes a tick.
Every other result, including permanent HTTP errors and GraphQL errors, retains
the tick and stops the drain. Recovery from a permanently rejected tick is
intentionally deferred; there is no automatic discard path.

Legacy arrays remain unowned forever. Historical pairing wrote new credentials
before clearing the queue, so neither current credentials, a verified refresh,
nor same-account re-pairing proves those ticks' owner. They remain quarantined.
Known-owner partitions survive re-pairing and become eligible only when that
verified owner signs in again. Stale requests may settle their own flight or
lease; they cannot acknowledge ticks, overwrite state, route, or exit a newer
login. Pairing saves any outgoing FIT activity before resetting session state.

Auth and outbox use separate SDK storage values to avoid combining credentials
with potentially large quarantine data. Garmin documents a 32KB per-value limit
and exceptions when storage is full; adapters catch failures and publish only
after a successful write. This is one write per envelope, with no claim of
power-loss atomicity across keys. See the official
[Storage contract](https://developer.garmin.com/connect-iq/api-docs/Toybox/Application/Storage.html).

The application currently exists only on the owner's test watch; public
publication is planned for December. Existing queued test data, original-key
update safety, and real-watch queue/FIT QA remain activation/release gates in
owner runbook [#7430](https://github.com/boardsesh/boardsesh/issues/7430).
SDK simulation and ephemeral-key compiles do not close those gates. Older
array-only builds cannot consume the V2 envelope; safe downgrade/recovery is
also unqualified, rather than an implicit rollback promise.

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
    state/TickQueue.mc    Owner-partitioned durable outbox + scoped flusher
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

The backend pairing alphabet matches `PairingView.CHARSET`. SDK 9.2.0 documents
`Activity.SPORT_ROCK_CLIMBING`, `Gregorian.utcInfo` with numeric `FORMAT_SHORT`
fields, and the signed `System.getTimer` rollover. The staging build uses an
explicit jungle overlay rather than unsupported `--flavor` syntax.

Before store submission, compile every product in the manifest, run the Monkey C
unit suite, replace the launcher placeholder, and test pairing, queue navigation,
logging, reconnect, FIT save/discard and shared-watch re-pairing on hardware.
A phone OTA preview does not validate or install this Garmin application.
