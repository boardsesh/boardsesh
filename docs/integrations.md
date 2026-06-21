# External platform and board account integrations

Boardsesh exports finished climbing sessions to external fitness platforms.
The mobile Connected apps screen also manages board account links used for
Aurora-family data sync/import. These integration kinds have different trust
models:

- **Platform integrations** (Strava today): server-side OAuth. The backend
  holds encrypted tokens and uploads activities; mobile only drives connect /
  disconnect / toggle UI over GraphQL.
- **Device integrations** (Apple Health today): device-local. The phone writes
  workouts through a native module; the server never holds credentials and
  only stores a workout id for dedupe (`board_sessions.health_kit_workout_id`).
- **Board account integrations** (Aurora-family boards): server-side credential
  storage plus manual JSON import. Web and mobile talk to the same backend
  REST endpoints.

v1 exports explicit (party/recorded) sessions only. `integration_exports.
session_type` already accommodates inferred solo sessions for later.

## Code map

| Piece                              | Location                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Provider abstraction + Strava impl | `packages/backend/src/integrations/{types,strava,registry}.ts`                                                |
| Credential store + token refresh   | `packages/backend/src/integrations/credentials.ts`                                                            |
| Export/claim/dedupe service        | `packages/backend/src/integrations/export-service.ts`                                                         |
| Signed handoff/state tokens        | `packages/backend/src/integrations/state.ts`                                                                  |
| Browser OAuth HTTP handlers        | `packages/backend/src/handlers/integrations-oauth.ts`                                                         |
| GraphQL resolvers                  | `packages/backend/src/graphql/resolvers/integrations/`                                                        |
| DB tables                          | `packages/db/src/schema/auth/integration-credentials.ts`, `packages/db/src/schema/app/integration-exports.ts` |
| Mobile registry + orchestration    | `packages/mobile/src/lib/integrations/`                                                                       |
| HealthKit native module            | `packages/mobile/modules/health-workouts/` (+ `plugins/with-healthkit.js`)                                    |
| Mobile UI                          | `packages/mobile/src/components/integrations/`, `app/(tabs)/profile/integrations.tsx`                         |
| Board account REST handlers        | `packages/backend/src/handlers/aurora-{credentials,import}.ts`, `kilter-credentials-oauth.ts`                 |
| Board account services             | `packages/backend/src/services/aurora-credentials.ts`, `board-credential-state.ts`                            |
| Shared Aurora JSON importer        | `packages/aurora-sync/src/sync/json-import.ts`, `packages/shared-schema/src/aurora-import.ts`                 |
| Mobile board account UI/client     | `packages/mobile/src/components/integrations/BoardAccountsSection.tsx`, `src/lib/aurora-credentials.ts`       |

## Mobile availability and flags

The mobile Connected apps route always shows board account cards for signed-in
users. Strava is hidden until the `strava-integration` feature flag is enabled;
static app builds can force it on with `EXPO_PUBLIC_STRAVA_INTEGRATION=true`.
The More tab subtitle follows the same flag so unreleased Strava copy does not
appear when the card is hidden. Apple Health remains device-gated by native
availability checks.

## OAuth connect flow (mobile, cookie-less)

The session JWT never enters a URL — query strings persist in access logs,
proxies, and browser history. Instead:

1. Mobile calls the authenticated GraphQL mutation
   `createIntegrationOAuthHandoff(provider)` (JWT stays in headers). The
   backend returns a **handoff code**: an HMAC-signed payload
   `{purpose: 'oauth-handoff', userId, provider, nonce, iat, exp}` with a
   60-second lifetime.
2. Mobile opens `GET <backend>/integrations/:provider/start?handoff=<code>`
   in `openAuthSessionAsync`. The handler verifies the handoff (purpose-bound:
   a handoff can never replay as an OAuth state, or vice versa) and consumes
   its nonce in Redis (`SET NX`) for single use — failing **closed** if a
   connected Redis errors, degrading to expiry-only when Redis isn't
   configured (local dev).
3. The handler signs an OAuth **state** (10-minute lifetime, same envelope,
   `purpose: 'oauth-state'`, carries the userId) and 302s to the provider's
   authorize URL.
4. The provider redirects to `GET <backend>/integrations/:provider/callback`.
   The handler verifies the state (identity comes from it — no cookies),
   checks the granted scope (`activity:write`, entries trimmed), exchanges
   the code server-side, encrypts tokens (`@boardsesh/crypto`), and upserts
   `integration_credentials`.
5. Every callback exit 302s to the deep link
   `com.boardsesh.app://integrations/<provider>?status=connected` or
   `?status=error&reason=<allowlisted enum>` — nothing attacker-controlled is
   reflected. The in-app browser closes on this redirect.

Signing keys are HKDF-derived from `NEXTAUTH_SECRET` with a purpose-specific
info string (`state.ts`), domain-separating these tokens from NextAuth
session tokens without a second deployed secret.

## Upload + claim-based dedupe

Uploads happen in two paths, both through
`syncPartySessionForUser` (`export-service.ts`):

- **Auto**: `endSession` fire-and-forgets `autoSyncSessionToIntegrations`,
  which fans out over every participant × connected provider with
  `auto_sync_enabled` and an `active` credential.
- **Manual**: the `syncSessionToIntegration` mutation (summary screen button).
  Authorization is one atomic query: creator-or-has-tick via an EXISTS
  subquery on the session SELECT.

The two paths can race (the share button appears seconds after auto-sync
starts), so dedupe is a **claim row**, not a SELECT check:
`integration_exports` has a unique index on
`(provider, user_id, session_type, session_id)`, and a claim is an
`INSERT ... ON CONFLICT DO UPDATE SET status='pending' WHERE` the existing row
is `'error'` (manual retry) or a stale `'pending'` (abandoned upload, >10
min). Postgres only RETURNING-includes rows actually written, so exactly one
concurrent caller wins (pinned by a real-Postgres race test in
`integration-export-claim.test.ts`). A `'success'` row is permanent dedupe; a
loser returns the blocking row instead of uploading twice. The winner
resolves provider + credential _before_ claiming so no failure path strands a
pending row.

`start_date_local` is real wall-clock time: `endSession` accepts the device's
IANA timezone (stored on `board_sessions.timezone`), and the export converts
the UTC start with `utcIsoToLocalWallClock` (UTC fallback for pre-timezone
sessions).

## Token refresh

`getFreshAccessToken` (`credentials.ts`) refreshes when the token expires
within 5 minutes, and is concurrency-safe:

- Re-reads the credential row at entry (the caller's row may be stale).
- Persists rotation behind an optimistic lock on the exact refresh-token
  ciphertext it read — a concurrent winner's newer tokens are never
  clobbered.
- A 400/401 refresh failure re-checks for a concurrent refresher before
  marking the credential `expired` (the failure may just mean another request
  already used the rotated token). `expired`/`revoked` credentials require a
  re-connect; the `integrations` query surfaces that to the UI.

## Apple Health (device-local)

`runSessionEndExports` fires after `endSession` resolves on the phone. The
auto-save orchestration (`apple-health.ts`) mirrors the legacy web
`healthkit-auto-save.ts` semantics: a module-level per-session state map
(`saving`/`saved`/`savedWithoutEnergy`/`failed`) doubles as the dedupe guard
and powers the summary button UI. Authorization is probed with the read-only
`getAuthorizationStatus` native call; the consent sheet only ever appears for
a never-decided user (first session end, or an explicit toggle/button tap).
Before it writes, mobile loads `sessionHealthExport(sessionId)`, which is
filtered to the authenticated viewer's own ticks and includes any existing
per-user workout id. That keeps party sessions from exporting another
climber's sends into a personal Apple Health workout and lets manual saves
after app restart keep lap data. The native module also checks HealthKit for
an existing workout with `HKMetadataKeyExternalUUID = sessionId` before
creating one. The workout itself (`HealthWorkoutsModule.swift`) writes an
`HKWorkout` (.climbing) with indoor + Boardsesh brand metadata, MET-estimated
active energy (latest HealthKit body mass, 70 kg fallback), and per-climb
`.lap` events carrying climb name, grade, status, attempt count, board type,
and angle. Workout ids persist via `setSessionHealthKitWorkoutId` for dedupe.

## Board account links and imports

Mobile board account linking uses backend REST endpoints because it cannot call
Next internal routes:

- `GET/POST/DELETE /api/aurora-credentials` reads, saves, and deletes
  per-board credentials. Non-Kilter boards use Aurora username/password login.
- `GET /api/aurora-credentials/unsynced` returns pending local ticks/climbs
  that have not synced back to the upstream board account.
- `POST /api/board-credentials/kilter/handoff` creates a short-lived signed
  OAuth handoff, then `/board-credentials/kilter/start` and
  `/board-credentials/kilter/callback` return a completion token to the app.
- `POST /api/board-credentials/kilter/finalize` verifies that completion token
  against the signed-in user and saves the Kilter account link.
- `POST /api/aurora-import` streams newline-delimited progress events while
  importing Aurora JSON export chunks through the shared importer.

The JSON import parser is shared with web so mobile previews and server-side
validation agree on board mismatches, missing users, and item counts.

## Adding a provider

1. Implement `IntegrationProviderImpl` (`integrations/types.ts`):
   `buildAuthorizeUrl`, `exchangeCode`, `refreshTokens` (persist rotation!),
   `uploadSessionActivity`, `activityUrl`, `revoke` (must not throw).
2. Register it in `integrations/registry.ts` (`SUPPORTED_PROVIDERS`, provider
   map, enum↔db mapping) and add the value to the GraphQL
   `IntegrationProvider` enum + zod schema (`validation/schemas/
integrations.ts`), then `vp run codegen`.
3. The OAuth handlers, claim/dedupe, credential refresh, auto-sync fan-out,
   GraphQL surface, and the mobile hooks/registry/UI are provider-generic —
   the mobile side needs a card component, an `INTEGRATIONS` registry entry,
   and i18n strings (all three locales).
4. Env: client id/secret read lazily inside the provider impl; the redirect
   URI is `${BACKEND_PUBLIC_URL}/integrations/<provider>/callback` and the
   domain must be registered with the provider.

Device-kind integrations (Health Connect) skip all of the server pieces:
they're an `INTEGRATIONS` entry with `kind: 'device'`, an
`autoExportOnSessionEnd`, and a native module.

## Environment

- `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` — from the Strava API app.
- `BACKEND_PUBLIC_URL` — public backend origin (prod: `https://ws.boardsesh.com`);
  must match the provider's registered callback domain.
- `NEXTAUTH_SECRET` — HKDF source for the token signing key (already set).
