# Backend ownership of registration and email verification

These three dependent BA-03 slices move the default registration, resend and verification family
out of the Next.js identity writer. It does not activate a projection, copy an
identity, resolve an email collision, change production configuration or remove
`LEGACY_WEB_IDENTITY_WRITERS`.

## Three deployment boundaries

1. **Backend first.** Add the private `/api/internal/auth/current-store/registration/v1/`
   register, resend-verification and verify-email commands. Existing staged URLs
   and their mode/proof requirements remain unchanged. Default native registration
   shares the same creation boundary; with verification enabled, its initial UID
   receipt commits with identity, profile, credential and refresh persistence.
   Its public response contains no mail plan or mailbox capability. Resend can
   deliver a successor. This step sends no new web verification format itself.
2. **Capable web readers.** Deploy the strict registration-family client and the
   default verification consumer, while leaving the released default sign-up and
   resend issuers in place. The consumer accepts both existing UUID links through
   the explicit compatibility verifier and UID-bound `ev1_` proofs through the
   backend. Complete this deployment across every public reader before adopting
   the next step. A released reader returns retryable 503 for `ev1_` and retains
   the receipt; that is an outage counterexample, not evidence of capability.
3. **Web issuance and delegation.** Replace default registration and resend SQL
   with private commands and postcommit delivery. Keep this PR draft until the
   preceding consumer deployment and actual RPC/credential configuration are
   evidenced. The source stack alone cannot prove that every public replica has
   been replaced. An old backend answers the new private paths unavailable; the
   web never retries a command or falls back to its own identity SQL.

The backend requires `CURRENT_STORE_AUTH_RPC_SECRET` and a qualified dedicated
`AUTH_IDENTITY_DATABASE_URL`, with `AUTH_IDENTITY_DATABASE_CONTRACT=private-registration-v1`.
The web requires the same distinct RPC secret and an explicit
`CURRENT_STORE_AUTH_BACKEND_ORIGIN`. Set `BASE_URL` or `NEXTAUTH_URL` to the trusted
public mail origin; only development/test loopback origins may fall back to the
request origin. Both services must use the intended verification policy. These
are deployment prerequisites, not new evidence flags or permissions to change
production settings. No real email is sent by the proof suites.

## Authority and creation contract

The compatibility context admits only an absent manifest or a prepared
current-store manifest with the current normalizer. It holds the existing shared
`(6975, 2)` authority gate through every write and commit. A manifest changing
during bcrypt makes the final transaction unavailable. A participating writer
already holding the gate commits before an exclusive enforcement attempt can
proceed. An enforced/current-store or canonical manifest is never permission for
an unreserved compatibility write: these new paths answer 503. Explicit
`CURRENT_STORE_WEB_AUTH_MODE=backend-staging` still uses the existing qualified
staged paths. `captureIdentityAuthority` remains strict.

Web and default native creation take the same normalized-address advisory lock,
then recheck the current live group before inserting. Preparation is not trusted
as a live reservation. Before cleanup, stored whitespace and Unicode case rules
must match JavaScript `trim().toLowerCase()` exactly, so this temporary path scans
live addresses with the shared normalizer. It rejects every occupied group and
never selects or reassigns an existing UID. This is intentionally an O(user-count)
lookup on infrequent registration/resend operations; a later indexed path needs
its own reviewed invariant. Bcrypt remains outside the write transaction.

Old OAuth adapters, scripts and replicas that do not take the advisory lock can
still write around it. The proof contains a real counterexample, followed by a
restricted-LOGIN refusal. Global single-writer and collision-prevention claims
still require adoption of the remaining writers and the actual role/pool fence.

## Receipt and compatibility behavior

New mailbox proofs use the existing UID/purpose/deadline tables and the same
receipt primitives as the staged authority path. Resend advances a durable
purpose generation and supersedes prior active receipts. Consumption snapshots
and rechecks the immutable binding, locks the bound UID, cutoff, purpose state
and receipt, and checks the database clock after waits. Terminal consumption,
purpose advancement and verification commit together. An existing verification
timestamp survives. Verification consumption issues no session, first-party
cookie or fresh authentication. Native registration retains its existing login
and refresh response; the mailbox proof does not create that authentication. Security-generation changes and deletion deny older proofs.

The pre-enforcement UUID verifier preserves the released exact-address and
inferred-issuance compatibility rule (a 24-hour lifetime and 60-second
account-creation clock tolerance), rechecks it under locks, and conditionally
consumes one legacy row. It never imports a guessed owner into UID provenance,
extends a deadline or selects a case sibling after the original account is gone.
Protected identifiers and unknown versioned namespaces never fall back to legacy
storage. Oversized historical secrets remain retryable rather than being deleted
as invalid. Historical original-owner evidence or measured issuer retirement and
expiry remain separate rollout requirements. The tolerance cannot prove the
original owner of a same-address replacement created inside that clock window;
this compatibility behavior must never be presented as immutable ownership.

Public schemas, finite statuses, attempt limits and resend's 1500 ms floor stay
in place. The backend owns the verification-policy verdict and committed mail
recipient/token. SMTP happens after commit. Registration still returns 201 with
`emailSent: false` after SMTP failure; default resend retains its released 500
mail-failure response, while the explicitly staged facade retains generic 200.
Unknown commit/protocol/authority/configuration state is 503 with no retry or
local fallback. Diagnostics never include raw SQL errors, submitted secrets,
mail recipients or SMTP causes.

## Evidence and its limits

`vp run test:registration-credential-writer` runs backend-only private HTTP,
qualified current-profile, native creation and transport-admission proofs. It
imports no future web adapter and can run on the first PR tree.

`vp run test:registration-web-consumer` runs the consumer-only boundary against
frozen released issuer/reader sources. It demonstrates existing UUID delivery
and consumption, an old reader's retryable refusal of a retained UID receipt,
and the capable reader consuming that same receipt before new web issuance.

`vp run test:registration-web-issuer` runs the complete route-export → strict
client → real private HTTP → authenticated restricted LOGIN → PostgreSQL graph.
The final matrix covers absent/prepared web/native races; live whitespace holders
after stale preparation; both authority interleavings; resend/consume ordering;
expiry after a lock wait; changed/deleted UID; UID and legacy single use; final
verification and native refresh rollback; SMTP failure; unknown committed reply;
and old reader, old backend and unfenced writer counterexamples.

These suites use an isolated copy of a fresh fully migrated PG18 proof database.
Public route exports execute through test wiring; the backend RPC is actual
loopback HTTP. Mail is an offline sink. This does not establish a full Next.js
browser flow, deployed ingress, production role/pool retirement or real-device
behavior. The normal development-server smoke and metadata check are separate
local framework evidence. CI preserves the historical private-web receipt and
runs the new exact `private-registration-v1` profile independently. Its users
shape has a dedicated source file; a future BA-02 unique-index upgrade must
update that current receipt in a reviewed change, never accept both shapes or
silently rewrite historical receipts.
