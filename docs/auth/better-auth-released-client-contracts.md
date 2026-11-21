# Released native and Garmin source contracts

N1 records the public Git sources for 20 Android/iOS release tags spanning
2.2.0–2.7.0, the pre-G2 Garmin checkpoint, and the final reviewed G2 checkpoint
`73e85b88102caeed139f5df8ee0db3517f227cd4`. The manifest records full commit IDs,
Git blob IDs, SHA-256 digests and provider/SQLite callback ranges. Since BA-06
it also records the phone's `watch-pairing.ts` and the shared pair-code parser
it imports (93 referenced blobs). Recording preserves older unreferenced blobs.
It does not prove installed builds, OTA coverage, device behavior or Garmin SDK
equivalence.

`vp run test:native-contract` runs the suite with one worker. It requires
`NATIVE_CONTRACT_DATABASE_URL` and `NATIVE_CONTRACT_REDIS_URL` pointing to isolated
loopback synthetic services. Every HTTP run creates a new random Postgres
database, applies the backend test schema, and closes the primary and admission
pools before dropping only that run's database. It never resets another database
or flushes Redis. CI runs the suite once, in the `test-auth-compatibility` job.

The native harness compiles and executes the recorded modules with Vite/Oxc and
Node VM modules. It adapts native/keychain/cache/telemetry I/O, refuses unknown
imports, and executes the recorded account-creation receipt parser. Real HTTP
controls mount the current native handlers and use Postgres and Redis for
credentials, registration, synthetic signed Apple/Google identities, refresh
rotation, browser transfer replay and watch pairing. Provider JWKS transport
returns locally generated public keys; signature, audience, issuer and nonce
verification are real. Recovery tests pin the frozen web request paths and error
handling; they do not claim a mounted Next.js recovery implementation.

Frozen refusal controls execute each tag's interceptor and OAuth fallback hook.
The 2.2 provider controls execute recorded callback and SQLite cleanup function
ranges, with React state observed at the I/O boundary and the recorded checkpoint helper
executed against real in-memory SQLite. A warm
session whose proactive refresh fails becomes signed out and deletes unsynced
user rows, including pending mutations. Cold initial-false startup takes the
lighter cleanup path and does not delete those rows. Downloaded board reference
rows survive both. The suite preserves this limitation; the N2 token limiter
cannot repair frozen cleanup behavior or a lost single-use refresh response.

Garmin replay executes selected recorded function bodies after bounded syntax
translation: refresh completion/policy and PairingView/LoadingView consumers.
Storage/network/UI inputs remain adapters. This source-only replay is not a
Connect IQ SDK, simulator, watch or FIT run, and makes no sound/hardware claim.
No production runtime adopts `@boardsesh/auth-protocol/native-v1` in N1.

## Released clients against each server mode

`released-http.contract.ts` runs the frozen clients against the legacy handlers
only: the fixture blanks every native selector. `released-server-modes.contract.ts`
runs the same released code paths against every server mode a native endpoint
reads, in rollout order, on one owned database and one mounted server. A mode is
a set of selectors plus the identity manifest state; the table lives in
`server-modes.ts`. Each mode gets one test per recorded release (20), plus a
startup check, so 210 cells in all.

| Mode | Manifest | Selectors on | Production startup today |
| --- | --- | --- | --- |
| legacy | none | none | starts |
| watch source-bound | none | `AUTH_WATCH_PAIRING_MODE=source-bound-staging` | starts |
| enforced current-store manifest | enforced, `current-store` writer | source-bound pairing | starts |
| native registration reserved-staging | enforced, `current-store` | + `CURRENT_STORE_NATIVE_REGISTRATION_MODE` | starts |
| native OAuth reserved-staging | enforced, `current-store` | + `CURRENT_STORE_NATIVE_OAUTH_MODE` | starts |
| canonical bridge shadow | enforced, `current-store` | + `AUTH_LEGACY_BRIDGE_MODE=shadow` | starts |
| native revocation generation | enforced, `current-store` | + `AUTH_NATIVE_REVOCATION_MODE=generation` | refused: Garmin blocker |
| every native stage, current-store | enforced, `current-store` | both staged writers, generation, bridge `on`, identity mirror `on` | refused: mirror, Garmin and web SID blockers |
| Better Auth authority, startable today | enforced, `better-auth` writer | both staged writers, source-bound pairing | starts |
| Better Auth authority, every native stage | enforced, `better-auth` | staged writers, generation, bridge `on` | refused: Garmin and web SID blockers |

Prerequisites the code enforces are part of each row. An enforced manifest
refuses legacy pair codes (503), so every enforced row runs source-bound pairing.
Generation needs source-bound pairing. Bridge `on` needs generation and the web
SID denial writer (`CURRENT_STORE_WEB_SIGNOUT_MODE=backend-staging`). The identity
mirror needs both staged native writers and delegated web set-password, which
needs required web credential proofs. Those web selectors appear only as
prerequisites: no native endpoint reads them otherwise.

The startup column comes from running the four guards `index.ts` runs
(cutoff enforcement, identity mirror, native revocation, web session writer) on
each row's selectors. Every cell asserts the exact refusal list, so lifting a
blocker changes this file. A refused row is still exercised, reached by
test-only routes and never by weakening a guard:

- The manifest is prepared under the users table lock and marked `enforced`
  directly (no production API sets that phase yet), as the authority suites do.
- The switch to `better-auth` first copies every identity with `syncIdentity`
  (the import primitive), then runs the real `switchIdentityAuthority`.
- Generation replaces only the `currentNativeRevocationMode` lookup inside the
  test, as `native-ancestry.contract.ts` does. `parseNativeRevocationMode`,
  the startup guard and `NATIVE_REVOCATION_ACTIVATION_BLOCKERS` stay as shipped.

### What each cell proves

Every cell runs the released client's own exports through the recorded
interceptor, parser and keychain code, then checks the wire with the same
`assertPair` as the legacy suite plus the request reader (`validateToken`) that
GraphQL and the socket use:

1. A phone and both Garmin checkpoints signed in during the legacy cell refresh
   again in every later cell: a session from before a mode exists survives it,
   and an already-paired watch stays paired across the authority switch.
2. Password sign-in, `deduplicatedRefresh` rotation, and the consumed refresh
   secret replayed: 401 `Invalid refresh token`.
3. `signInWithApple` and `signInWithGoogle` (the platform buttons, Apple with
   its nonce) return to the existing account.
4. A new Apple subject creates an account on one phone and returns without an
   email on a second; a new Google subject does both on one phone. 2.6.0 and
   2.7.0 also parse their account-creation receipts.
5. `registerWithCredentials` creates an account; the same address again gives
   the released parser `{ success: false, status: 409 }`.
6. The phone's own `requestWatchPairingCode` (now recorded with the shared
   pair-code parser it imports) issues codes; the reviewed G2 watch and the
   pre-G2 watch pair with them through their recorded `PairingView.onPairResult`,
   a replayed code gets 401, and both watches refresh. On G2 the recorded
   `AuthState.accept` must take the real reply, and the request waiting in the
   refresh flight (an offline tick upload) re-fires with the rotated token
   through the recorded `BsRequest.retryWith`. Pre-G2 re-fires its retry queue.
7. The first phone runs the released `signOut`: its revoke gets 200, its
   keychain is empty, its old refresh secret gets 401. Then the second phone of
   that account asks for a pair code, and both of that account's watches
   refresh. The outcome depends on revocation mode; see below.
8. Stage evidence: after the flows the database and Redis must show the mode
   really ran (reservation rows for staged writers, Better Auth `auth_account`
   rows, a canonical `auth_session` for bridge `on`, a native-generation cutoff
   for generation, a v2 capability or bare user id in Redis), so a selector that
   fell back to legacy fails its cell.

Better Auth rows also assert that legacy native writers are not an option there:
with both staged writers unset, registration and Google sign-in for a new
account both answer 503 for every release, and the client keeps no tokens.

All 210 cells pass on `a80b0bcaeb`. No released client needed a protocol change
in any mode.

### Signing out on one device under `generation` (owner decision)

Under `AUTH_NATIVE_REVOCATION_MODE=generation`, app sign-out on one phone moves
the account's native generation. Every other native credential of that account
is refused at its next request. Under `legacy` the same sign-out already retires
every refresh row of the account, but leaves issued access JWTs (7 days) usable,
so the other devices keep working until their next refresh. Recorded behaviour:

| Client | `legacy` revocation | `generation` revocation |
| --- | --- | --- |
| Other phone, every release 2.2.0 to 2.7.0 | Next request succeeds; its next refresh gets 401 | Next request gets 401, refresh gets 401, the interceptor fires forced sign-out once, clears the keychain and sends a revoke (401) |
| Other phone's local data, 2.2.x (executed) | Untouched until the refresh fails | The provider's recorded forced sign-out handler runs the full cleanup: all 8 unsynced tables are emptied, including `pending_mutations`; downloaded board tables survive |
| Other phone's local data, 2.3.0 to 2.7.0 (source read) | Same path at the refresh failure | The handler forces the full cleanup (`handleSignedOutTransition(epoch, true)`), which runs `clearUserData`; the recorded list holds `pending_mutations` |
| G2 watch (recorded `refreshFinished`) | Access JWT admitted; refresh gets 401 | Access JWT refused; refresh gets 401 |
| Pre-G2 watch (recorded `_onRefreshResponse`) | Access JWT admitted; refresh gets 401 | Access JWT refused; refresh gets 401 |

On that refresh 401, G2 fails the waiting request with 401, clears its token
store and reports auth loss; `refreshFinished` does not clear the tick queue
(what the app's auth-loss handler then does is outside the replayed functions).
Pre-G2 also clears its `TickQueue`, so its offline ticks are lost.

The consequence for the owner to accept: with `generation`, one app sign-out
ends the account on every other phone and watch at their next request. Anything
those devices still hold offline at that moment is deleted: `pending_mutations`
on phones of every release, the `TickQueue` on pre-G2 watches. The refusal
arrives before the queue can upload. Under `legacy` the other devices keep a
working access JWT for up to 7 days, so queued writes can still upload before
their refresh fails and the same cleanup runs. The pre-G2 half is why
`NATIVE_REVOCATION_ACTIVATION_BLOCKERS` holds
`GARMIN_OFFLINE_TICK_QUEUE_PRESERVATION`; the phone half has no blocker.

### Cells left out

- `AUTH_CUTOFF_ENFORCEMENT=observe`: staged writers refuse to start with it, and
  with legacy selectors it matches the legacy row while no cutoff exists.
- `EMAIL_VERIFICATION_ENABLED=true`: not a staged switch; native registration
  keeps 201 and usable tokens either way (`docs/auth/better-auth-native-registration.md`).
- `AUTH_IDENTITY_MIRROR=on` with the Better Auth writer: the mirror copies
  current-store writes and refuses that direction once Better Auth writes.
- Account deletion, set-password, web sign-in and the other web selectors: no
  native endpoint reads them, and the released app deletes accounts through a
  GraphQL mutation that is not in the recorded modules. The refresh issuer's 401
  for a deleted account is not driven through a frozen client here.

### What these tests cannot prove

- The fixtures pin the git source of each release tag. Phones run the store
  binary plus whatever OTA bundle they last downloaded; neither is checked.
- Recorded modules run through Oxc in Node VM modules, not Hermes, with the
  keychain, SQLite, browser, analytics and connectivity as adapters.
- Garmin replay is syntax translation of selected functions, not Connect IQ.
- The mobile offline outbox drainer is not recorded. The cells check its
  precondition only: after a refresh the rotated JWT is admitted by the reader
  its GraphQL calls go through.
- 2.3.0 to 2.7.0 local-data cleanup after a forced sign-out is read from source,
  not executed.
- Real-device sign-in, offline and reconnect, deep links and a real watch remain
  manual QA (#6980 validation 2).

The matrix runs inside the existing `vp run test:native-contract` step of the
`test-auth-compatibility` job; it adds no job. Locally it adds about 100 seconds
of test time (one bcrypt-12 registration per cell is about half of it).

## Refresh-capacity fixture compatibility

The mounted overload probe presents a missing refresh secret. Its test-only
adapter selects the missing-secret capacity helper when the runtime has one,
then falls back to the earlier refresh-only and shared-auth helpers. Each
checkpoint still has to return the actual HTTP 503 body; the fixture never
substitutes a response or edits a frozen source recording.

On 2026-11-13, all 445 cases passed against the revised #7447 runtime
`4d9552e87a`, using only the native-contract test tree, its Vitest configuration,
the pure `native-v1` test helper and that helper's package export as an overlay.
Every other runtime file remains the exact target commit. This source-contract
execution does not close installed-client, original-key Garmin update,
hardware, full-rehearsal or activation gates in #7430.
