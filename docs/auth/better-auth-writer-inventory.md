# Existing identity writers and installed-client contracts

This inventory supports [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975),
especially BA-03 (#6977), BA-02 (#4847), and BA-04 (#6978). It describes the
`796746a5db` baseline inspected on 2026-11-04. It is source evidence, not a
production database audit or permission to change account ownership. The
[migration design](better-auth-migration.md) remains authoritative; the
[implementation record](better-auth-implementation.md) records prototype results.

## Identity and credential writers

| Entry point | Current writes and policy | Centralization requirement |
| --- | --- | --- |
| `packages/web/app/api/auth/register/route.ts` | Transaction inserts `users`, bcrypt `user_credentials`, profile, and optional email-keyed verification token. Email validation and exact-email existence check precede the transaction. No normalized uniqueness constraint prevents races. | One backend registration operation; normalize before validation and reserve the address in the write transaction. Preserve the web response and verification policy. |
| `packages/web/app/lib/auth/auth-options.ts` → `DrizzleAdapter` | The adapter creates/updates/deletes users and links/unlinks providers using the shared database. These writes are implicit in adapter methods, so text searches for `insert(users)` alone miss them. Google, Apple, and Facebook enable email-based account linking. | Inventory and fence every adapter mutation, including deletion and updates; the NextAuth adapter must not remain an independent credential writer. Preserve provider subjects and existing callbacks until proven safe to retire. |
| `auth-options.ts` → `signIn` callback | Updates `users.emailVerified` for OAuth users; currently best effort. Credential verification reads a user again by exact email. | Verification state and ownership decisions belong to the same backend operation as account resolution. |
| `packages/backend/src/handlers/native-auth.ts` → `handleNativeAuthRegister` | Lowercases/trims submitted email, checks an exact stored email, then inserts user, bcrypt credential, profile, and refresh token transactionally. Existing mixed-case stored addresses and concurrent inserts can bypass the pre-check. | Reuse the backend registration policy, normalized reservation, and current response facade. |
| `native-auth.ts` → `findOrCreateOAuthUser` | Resolves `(provider, sub)` first. Otherwise links the first exact normalized-email match when the provider verifies the email, or creates a user/profile/link. A conflict-ignored provider insert is not followed by confirmation of its persisted owner. | Serialize provider-subject and normalized-email resolution together; reject ambiguous ownership and check actual link ownership before issuing credentials. Preserve the linked-subject path when Apple omits email/name. |
| `packages/web/app/api/auth/forgot-password/route.ts` | Reads the first exact-email user with a password; deletes previous `password-reset:<email>` tokens and inserts the SHA-256 hash of a UUID token. The response and mail-failure response are generic. | Issue user-ID-bound, purpose-bound recovery records transactionally; ambiguous emails must not select a user. Preserve existing generic responses and old links safely. |
| `packages/web/app/api/auth/reset-password/route.ts` | Checks token/expiry, then binds the link to the one account storing its exact address and created before it was issued (`legacyLinkAccount`), before the write transaction. Updates/inserts bcrypt credential, sets verification for an unverified user, and deletes email-keyed tokens. | Atomically consume the token inside the credential mutation transaction, bind it to its original user, and commit revocation intent with the credential. Current SELECT-then-write permits simultaneous successful consumption. |
| `packages/web/app/api/auth/resend-verification/route.ts` | Picks the first exact-email unverified user; replaces email-keyed UUID verification tokens. Mail failure currently returns a distinguishable 500. | Share purpose-bound token issuance and generic anti-enumeration policy; reject ambiguous ownership. |
| `packages/web/app/api/auth/verify-email/route.ts` | Reads token and user outside the transaction, binds the link to the one account storing its exact address and created before it was issued (`legacyLinkAccount`), then verifies that user id and deletes the token. | One atomic user-ID-bound consume-and-verify operation; never verify multiple users by address. Preserve already-issued unambiguous links through a bounded legacy verifier. |
| `packages/web/app/api/internal/set-password/route.ts` | Authenticated NextAuth user without a password can insert bcrypt credentials and mark email verified in one transaction. Uses the credential PK to reject simultaneous inserts. | Backend-owned operation with explicit authentication-age policy, current session ownership, and mutation/revocation intent. Do not infer verified mailbox ownership merely from a stale or bridged session. |
| `packages/backend/src/graphql/resolvers/users/mutations.ts` → `deleteAccount` | Deletes product content and the `users` row in one retried transaction. Foreign keys cascade credentials, provider links, and refresh rows. Product tombstones, photo erasure, and analytics erasure have separate required behavior. | Wrap the existing deletion transaction in the authority's mutation/revocation contract. Keep revocation tombstones outside cascaded identity rows for still-valid signed credentials. Preserve product cleanup and post-commit behavior. |
| `native-auth.ts` → `generateTokenPair`, refresh/revoke, refresh cleanup | Inserts refresh hashes; rotation conditionally revokes the presented row and issues a successor in a transaction. Revoke ends all current refresh rows for the account and disables push devices. Cleanup deletes expired refresh rows and old revoked rows. | The future authority must own all issuance and revocation. Current rows lack family/provenance links; cleanup retention is not sufficient evidence for retiring bridge tombstones. |
| `packages/backend/src/graphql/resolvers/board-presence/shared.ts` → `ensureSystemBoardOwner` | Inserts a deterministic nonhuman owner row with conflict ignored. | Explicitly classify this as a system principal. Route/fence provisioning or provision it before restricting identity writes. Never grant human login eligibility accidentally. |
| `packages/location-sync/src/upsert.ts` → `ensureSystemUser` | Inserts a deterministic catalog owner with conflict ignored. This runs during scheduled location sync. | Include scheduled jobs in the writer fence. System-principal provisioning needs an explicit supported path, rather than an unnoticed bypass. |
| `packages/db/scripts/create-test-user.ts`, `seed-social.ts`, `seed-ios-performance.ts`; `packages/backend/src/scripts/seed-instructional-video.ts` | Direct fixture user/credential inserts. Some scripts have independent connection resolution. | Keep explicit disposable-environment guards; fixture writers must not inherit a production identity-writing capability. |

## Writer gate classification

Swept on 2026-11-16 (BA-03 #6977): every direct insert, update or delete of an
identity table under `packages/backend/src`, `packages/db` and
`packages/location-sync`. Identity tables are `users`, `user_credentials`,
provider `accounts`, `verificationTokens`, `mobile_refresh_tokens` and every
`auth_*` table. `user_profiles` (display name, avatar) is product data. The
auth `sessions` table has no writer: NextAuth issues JWTs, and the backend's
`sessions` is board sessions. The web writers above belong to #7596.

"Gated" means: the shared gate `pg_advisory_xact_lock_shared(6975, 2)`, then
the manifest read, in the same transaction as the write and before it, held
until commit; a manifest naming another writer refuses with `STALE_AUTHORITY`.
The order is gate, then `users`, then the climber's other rows.

| Writer | Where | Before | After |
| --- | --- | --- | --- |
| Native registration, legacy mode | `native-auth.ts:1056` preflight; write transaction `password-identity.ts:224` | Gated. The preflight before bcrypt only fails fast; the write transaction checks again before its first lock or write | Unchanged, comment added. Two-connection proof: `native-register-writer-gate.test.ts` |
| Native Google/Apple sign-in, legacy mode | `native-auth.ts:1399` | Gated before the link read | Unchanged |
| Native issuance, refresh, sign-out, refresh cleanup | `native-auth.ts:690`, `:1763`; `authority/native-revocation.ts:36`; `authority/native-refresh-retention.ts:45` | Shared gate, then `users`; no manifest refusal, by design: refresh is the long-lived native facade under either writer, and cutoff generations decide admission | Unchanged (session family) |
| Account deletion, legacy mode | `users/mutations.ts:347`, delete at `:427` | Gate at the first statement; refuses once any manifest exists | Unchanged |
| System board owner, legacy mode | `board-presence/shared.ts:1105`, insert at `:1107` | Gated | Unchanged |
| Fixed system identities, legacy mode | `current-store/system-identities.ts:101` | Gated | Unchanged |
| Account email resolution (BA-02 tool) | `email-resolution/resolution.ts:382`, update at `:425` | Shared gate but no manifest check: under a Better Auth manifest it still rewrote `users.email` and reservations | **Fixed.** `lockLegacyIdentityWriterManifest`; refuses with `STALE_AUTHORITY` (CLI code `STALE_AUTHORITY`); reuses that manifest for reservation bookkeeping |
| Staged commands | `auth/current-store/*` | `lockEnforcedProjection` or an authority receipt (`captureIdentityAuthority`, `revalidateIdentityAuthority`) | Unchanged |
| Authority module and its seams | `auth/authority/*` | Authority receipt, revalidated before commit | Unchanged |
| First-party web session issue and roll (#7596) | `authority/web-session.ts` | New. `issueWebSession`: receipt revalidated under the gate, then `users` in id order (KEY SHARE for the account signing in, FOR UPDATE for the presented one), then rows. `rollWebSession`: one conditional UPDATE of `expires_at` with no gate (owner decision 2); it changes no identity, generation or token, and every reader re-checks liveness | New; the boundary guard names the ungated roll in `UNGATED_AUTHORITY_WRITES` |
| Authority prepare and activation | `scripts/auth-authority.ts:71`, `authority/router.ts:101` | The gate exclusively: this is the switch | Unchanged |
| Batch system users, legacy mode | `packages/db/src/jobs/system-user.ts:31` | No gate | Documented legacy branch: the worker login has no auth grants to read the manifest; `CURRENT_STORE_BATCH_SYSTEM_USERS_MODE=backend-staging` routes it through the backend. The real fence is the role cutover (#7430) |
| Location sync owner, legacy mode | `packages/location-sync/src/upsert.ts:92` | No gate | Documented legacy branch, same reason; `CURRENT_STORE_LOCATION_SYNC_MODE` |
| Fixtures | `db/scripts/create-test-user.ts`, `seed-social.ts`, `seed-ios-performance.ts`, `backend/src/scripts/seed-instructional-video.ts`, `db/src/testing/dedup-replay.ts` | Local-target guards | Out of scope: disposable databases only |
| Password guess counter (#7656) | `auth/password-guess-windows.ts` (reserve, give back, clear, prune of `auth_password_guess_windows`) | No gate | Out of scope: counts rejected passwords by a keyed digest of the typed email or of the account's user id; no identity, credential, address or user id. Unknown emails add rows too, so the prune deletes in bounded batches. It fails open after 250 ms, so it must never wait on the gate |
| Expired replay-record cleanup | `current-store/command-context.ts`, `authority/*-maintenance.ts` | Deletes expired command and receipt records | Out of scope: no identity column |

`scripts/__tests__/better-auth-boundary.test.ts` ("identity writer catalog")
fails CI when a file outside `auth/authority/` and `auth/current-store/` gains
a direct identity write, when a listed file's count changes, or when a listed
legacy writer loses its gate call. It is a text scan: a reviewer still checks
that the gate comes before the write in the same transaction.

No manifest exists in production, so the only effect there is on the
resolution tool, an operator CLI: one `SHOW transaction_isolation` and one
manifest read after the gate it already took, instead of the manifest read it
made later. Live native registration, sign-in and refresh are unchanged.

The inspected application has no separate user-email change or provider-unlink
UI endpoint. The NextAuth adapter still exposes account and user mutations, so
absence of a current UI does not remove those methods from the fence inventory.
No scheduled job was found mutating a human Boardsesh password/provider identity;
the location catalog job does create its system owner. Aurora sync's `usersSchema`
in `packages/aurora-sync/src/sync/user-sync.ts` is `UNIFIED_TABLES.users`
(`board_users`), which stores upstream board users, not Boardsesh login identities.
Aurora/Kilter/MoonBoard integration credentials are upstream board credentials,
not this epic's first-party credential store.

## Read-only identity audit

`packages/backend/src/auth/identity-audit.ts` measures exact duplicates,
`trim().toLowerCase()` collision groups, case/whitespace variants, verification
state, sign-in-method presence, bcrypt shape, malformed email/provider records,
orphan credentials/provider rows, and conflicting provider-subject ownership.
Provider identity keys remain case sensitive. Plus aliases and dots stay intact.
The current schema's provider PK and FKs should already prevent some findings;
their checks remain useful for imported or synthetic snapshots.

Run only against an explicitly selected local disposable/restored database:

```sh
AUTH_IDENTITY_AUDIT_DATABASE_URL=postgresql://audit_reader:password@localhost:5433/restored_fixture \
  vp exec tsx packages/backend/src/scripts/audit-auth-identities.ts
```

The CLI never falls back to `DATABASE_URL` and rejects remote hosts and URL
options. It opens a single Postgres connection with read-only defaults, then
selects only required identity columns through Drizzle in a repeatable-read,
read-only transaction. Connection/query timeouts bound failed runs. It performs
no inserts, updates, deletes, schema changes, migrations, or automatic merges.
No audit against production is part of this implementation. A later separately
reviewed operational audit may need an explicit remote/TLS connection policy.

The output contains measured counts and keyed SHA-256 references. A fresh random
32-byte HMAC key remains in memory and is not printed, so public addresses cannot
be recovered by hashing a dictionary against the report. User IDs, emails,
provider names/subjects, password hashes, URLs, connection secrets, and the HMAC
key are not emitted. Different audit runs intentionally produce different
references. Keep a report private: relationships and small counts may still be
sensitive. An audit failure emits only a fixed error, since driver exceptions can
contain parameters and connection details.

This report cannot select an account owner or drive a merge. It does not prove
password validity, mailbox ownership, provider token validity, product-reference
completeness, or migration readiness. Email-shape checks use the existing native
registration shape and flag unusual addresses for review; they are not a full RFC
mailbox validator. Users without a sign-in method include intentional system and
fixture principals and need classification. Group-wide product-reference counts
and approved ownership resolution remain BA-02 work. No production collision
counts are assumed, copied from historical issues, or committed here.

## Session and compatibility contracts

| Surface | Contract and source | Migration consequence |
| --- | --- | --- |
| Web session issuance/read/sign-out | NextAuth JWT sessions; `auth-options.ts`, `api/auth/[...nextauth]/route.ts`, `lib/auth/secure-cookies.ts`. Both `next-auth.session-token` and `__Secure-next-auth.session-token`, chunked cookies, and legacy host-only cookies are supported. Production cookie scope covers `.boardsesh.com`; session cookie is HttpOnly/SameSite=Lax. OAuth flow cookies have deliberate Secure/SameSite=None behavior. | Preserve cookie reads, chunk cleanup, shared-domain behavior, callbacks, CSRF, and in-flight provider flows. Sign-out requires `expectedUserId` and `expectedAuthSessionId` and must not clear a newer login. |
| Browser-to-backend credentials | `api/internal/ws-auth/route.ts` returns the validated raw JWE, user ID, and optional `authSessionId`; `getServerAuthToken` and `getServerSession` are additional server readers. | Replace every reader and delivery path, not only login UI. `getServerAuthToken` currently reads only base cookie names, so chunked-cookie behavior needs explicit proof. |
| Native endpoints | Backend `/auth/native/{credentials,register,oauth,exchange,refresh,revoke}` in `native-auth.ts` and `server.ts`. Token response is `{ userId, jwt, refreshToken, expiresAt }`, optionally with an account-creation receipt. | Keep paths, statuses, errors, body fields, and receipts as a long-lived facade. Password recovery currently calls the web `/api/auth/{forgot-password,reset-password}` routes from both native and Expo web. |
| Native access JWT | Seven-day HS256 JWT signed with `NEXTAUTH_SECRET`; issuer `boardsesh`, audience `boardsesh-mobile`, subject is `users.id`. `middleware/auth.ts` accepts mobile JWS and NextAuth JWE. | Keep accepted legacy keys and claim shape while introducing purpose-specific authority keys. No original authentication time or session lineage is present in current native JWTs. Rolling `iat` is not freshness. |
| Native refresh | Opaque 32-byte random token encoded as hex; only SHA-256 stored in `mobile_refresh_tokens`. Rotation renews a 90-day expiry and returns the same response shape. | Active old clients do not drain naturally. Current rotation prevents two simultaneous successors for the same row, but has no family/reuse model and cannot by itself enforce reset/sign-out lineage. |
| Browser fallback transfer | `lib/auth/native-oauth-transfer.ts`, native callback/attempt routes, `native-auth.ts` exchange. HMAC payload carries user/next path, two-minute issue/expiry, and optional creation proof. Backend replay prevention uses Redis SET NX, with a single-instance memory fallback. | Transfer-token issue time is not fresh authentication. Preserve attempt and receipt binding; cross-instance replay/revocation guarantees require durable/shared authority state. |
| Provider sign-in | Native Apple/Google ID tokens are JWKS verified; Apple configured bundle audience, Google configured audience variants, optional nonce checks, subject-first account mapping. Web additionally supports configured Facebook. | Test missing Apple email/name, relay addresses, nonce/audience variants, cancellation, existing multi-provider users, and old in-flight callbacks. Do not substitute email matching for subject ownership. |
| Garmin | `/api/watch/pair-code` authenticates a first-party bearer and stores an eight-character, five-minute code in Redis; `/api/watch/pair` consumes with GETDEL and issues a native token pair. `handlers/session-auth.ts` accepts these credentials for watch HTTP controls. | Keep existing paired watches and new pairing. Redis is required; pairing deliberately has no memory fallback. Bind pairing issuance/consumption to canonical revocation. |
| HTTP/WebSocket validation | `middleware/auth.ts` positively caches validation for 60 seconds, currently without authoritative account/revocation lookup. HTTP GraphQL uses `graphql/yoga.ts`; WebSocket `onConnect` in `websocket/setup.ts` establishes a context once. `requireAuthenticated` checks that context's boolean. Upload, export, import, and board-credential handlers also call `validateToken`. | Add authority checks to every transport and invalidate caches across instances. A live socket needs explicit cutoff enforcement; handshake validation alone cannot satisfy reset/deletion revocation. |
| Native offline identity | `auth-store.ts` keeps `boardsesh_jwt`, `boardsesh_refresh_token`, `boardsesh_token_expires_at` through SecureStore namespace migration. It writes refresh/expiry before JWT, serializes mutations, and uses credential generations. `auth-session.ts`/`auth-provider.tsx` distinguish unavailable/degraded state from confirmed rejection. | Retain keys, write order, refresh deduplication, late-response guards, and account-scoped data boundaries. An outage must not become destructive sign-out. |
| Expo web | `auth-store.web.ts` reads the HttpOnly web session then obtains an in-memory backend token, matching user plus `authSessionId`. Cookie locks and cross-tab signals bind cleanup to the departing login. | Preserve owner/generation guards and cookie locking; never persist browser tokens in AsyncStorage/IndexedDB. Test www/app subdomains and stale responses, including same-user relogin. |
| iOS widget controls | `handlers/widget-auth.ts` checks a Live Activity push-token bearer bound to a climbing session, independent from a first-party identity JWT. | Inventory as an intentionally distinct session capability. Do not treat its APNs token as a partner or first-party login credential. Native Live Activity/BLE changes require their separately mandated reviewer. |

## Decisions and remaining gates

1. Keep this audit and inventory independent of runtime authentication. Neither
   changes the current credential writer nor bypasses BA-01's proof gate.
2. Use one backend service over the existing authoritative store before identity
   import. Database-enforced writer fencing must reject stale web adapters, old
   deployments, direct scripts, and delayed jobs; advisory locks alone cannot
   fence a caller that never acquires them.
3. Introduce immutable user-ID/purpose-bound recovery records and atomic
   consumption before normalizing stored addresses. Legacy links require a
   bounded verifier and explicit handling of ambiguous original ownership.
4. Keep unknown legacy authentication age non-fresh. Add durable lineage,
   cutoffs, and revocation intent before bridging; do not copy a password hash
   while allowing an unfenced reset to overwrite it later.
5. Treat a local audit, protocol fixtures, a restored-database rehearsal, and
   real-device/browser QA as separate evidence. Only recorded results plus
   independent review can pass a gate; this inventory does not complete BA-02,
   BA-03, BA-04, or authorize production rollout.

## Audit evidence

The audit author's separate validation passed **19 pure/URL-policy tests** and
**2 real-Postgres audit tests**. The latter reuse generated legacy migrations
0016/0017 in a newly created database, confirm all source rows remain unchanged,
then add a synthetic account and verify the next audit measures the new count.
The local database named `boardsesh_backend_test` did not exist during an initial
CLI probe; the CLI returned its fixed failure message. Successful audit evidence
comes from those isolated fixtures, not from an application or production audit.

This is not a first-party migration or partner-launch approval. The
[current test map](better-auth-implementation.md#current-test-map) identifies
live browser, recovery, refresh, watch and revocation coverage; the
[legacy web credential proof](better-auth-legacy-web-proof.md) describes the
surviving NextAuth verifier. The BA-01 HTTPS and process-replacement prototype
was removed in #7620. Its historical results do not establish deployed CORS,
forwarding, Safari, consent UI or device behavior. Production writer fencing,
normalized/provider uniqueness, every credential mutation, active WebSocket
revocation, ownership resolution and restored-database rollback remain separate
gates.
