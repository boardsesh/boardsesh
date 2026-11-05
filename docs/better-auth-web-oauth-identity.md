# Backend-owned web OAuth identity writes

This implements another default-off part of [BA-03 #6977](https://github.com/boardsesh/boardsesh/issues/6977)
in [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975). It follows
the [configured-provider proof](./better-auth-app-router-oauth.md) and
[publication boundary investigation](./better-auth-session-publication.md).
The accepted direction remains [better-auth-migration.md](./better-auth-migration.md).

This note records the implemented scope, qualification and decisions before
activation; it is not a production readiness claim.
No shared or production database was migrated, no account was reassigned or
deleted, and no deployment, production grant change or authority switch occurred.

## Resulting boundary

`CURRENT_STORE_WEB_OAUTH_MODE` defaults to `legacy`. Opting the web delegate and
backend into `backend-staging` selects the independently versioned private
`/api/internal/auth/current-store/web-oauth/v1/intent` and `/resolve` commands.
Password and native mode selectors remain independent. Existing V2 command
shapes and endpoints are unchanged. An invalid or unavailable enabled authority
does not fall back to local identity writes.

The configured Google, Apple and Facebook providers still authenticate through
the installed public NextAuth handler. Only after its provider verification does
the web delegate send provider/subject/profile assertions to the authenticated
backend command. The private backend trusts that authenticated delegate; it does
not independently re-run a vendor token exchange.

The backend transaction owns normalized reservation, new user, default profile,
plain provider-account insert and durable flow consumption. It requires the
existing enforced projection prerequisite. That software prerequisite does not
establish deployed writer fencing. Request-local adapter methods prevent stock
web email heuristics, account linking and identity/profile writes in this mode.

Continuing credentials remain the existing NextAuth JWE and 30-day rolling
session. No canonical source, fresh-age evidence, replacement session family or
all-validator revocation authority is issued by these identity commands.

## Decisions retained for review

1. **Provider subject determines an existing owner.** A known provider account
   retains its immutable UID, stored email, name, image, verification timestamp
   and creation time, including missing or changed provider email. An unknown
   subject cannot take an occupied normalized email or auto-link by email.
   New web OAuth accounts preserve the verified assertion email supplied by
   NextAuth and start with a null verification timestamp, matching stock first
   creation. The installed public NextAuth `getProfile` lowercases vendor email
   before calling sign-in; preserving its assertion does not claim preservation
   of the vendor's original letter case. Reservations use
   the shared trim/lower normalizer; the native resolver keeps its own previously
   accepted normalized-email and verification policy.
2. **An old cookie binds browser identity without granting freshness.** The
   backend verifies the actual raw legacy JWE and stable login SID. The observed
   UID/SID and cutoff generation fence a pending flow against identity changes;
   they are negative consistency checks. The same UID with a different login SID
   fails the binding. A renewed JWE may retain the same SID despite a new `jti`.
   Neither identifier establishes original authentication age or proves that
   every old validator has observed revocation.
3. **Sensitive linking stays gated on genuine recent authentication.** Existing
   linked-owner sign-in works. Adding an unlinked provider while presenting an
   age-unknown legacy actor is temporarily unavailable until the source-bound
   reauthentication continuation exists. This implements the accepted migration
   requirement; it is not a permanent policy disabling provider linking.
4. **Unknown outcomes do not trigger deletion or an automatic retry.** A lost
   successful private reply, late event failure or encoder failure may leave a
   complete identity and consumed flow while the web response withholds its new
   session cookie. That durable state is retained. A subsequent separately
   initiated provider sign-in can find the same exact account. There is no
   compensating account deletion or claim to revoke a continuing credential.
5. **Password policy remains the user's decision.** Authenticated password
   set/change keeps the requesting device signed in and revokes other credentials,
   preserving its original proven authentication age. Forgotten-password reset
   revokes every session. The isolated prototype proves that policy; this OAuth
   identity slice does not adopt it into production password routes.

## Apple continuation and browser cookies

Apple's cross-site POST cannot reliably carry the Lax actor cookie. After
validating its signed, per-flow state, the route holds the bounded POST in a
purpose-separated encrypted HttpOnly cookie and redirects to the same canonical
callback using an opaque scope. The same-origin GET restores the actor cookie
and reconstructs the POST before the public provider exchange. The URL carries
no provider code or raw state. There is no process-local flow map.

The continuation has a nominal 60-second lifetime and permits at most five
seconds of issuer-ahead clock skew; a positive age of 60 seconds is rejected.
It is restricted to the canonical Apple callback
path, has at most two bounded chunks, and binds origin, path, provider, scope and
state. It uses the installed public NextAuth codec and shared deployment secret,
with its own purpose and salt. Replica key availability remains an operational
prerequisite. The stateless cookie alone is not described as a one-use store;
provider-code use and transactional backend intent consumption provide that
boundary.

State, PKCE, nonce and callback URL cookies have per-flow names. At most two
pending scoped state cookies are admitted; the per-flow callback URL has a
15-minute lifetime. A terminal callback with authenticated state retires only
the exact observed cookie names for its flow, including when a buffered handler
response is withheld. Cleanup cannot target a sibling flow or a current session
cookie. Unverified state does not authorize flow-cookie cleanup.

Review found that replacing a failed buffered response could discard NextAuth's
state/PKCE deletion headers and exhaust the pending-flow limit. It also found
that a newly scoped callback URL otherwise inherited an unbounded session-cookie
lifetime. Explicit authenticated cleanup and a 900-second callback URL lifetime
address those findings. Independent regression qualification is recorded below.

## Transport, schema and privacy

The shared private transport retains the existing 16 KiB request and 64 KiB reply
limits, strict UTF-8, bounded stream/deadline handling, fixed path allowlists,
dedicated bearer secret and no redirects or automatic retries. No browser Cookie
header is forwarded to the private endpoint; the exact raw actor credential is
an explicit authenticated command field. Errors expose fixed categories without
raw SQL, provider profile, cookie or response bodies. Profile-refresh failure
logging uses a fixed event instead of the original database error in every mode.

Generated migration `0293_auth_web_oauth_identity` adds two tables: short-lived
flow intents and consumed command nonces. Actor fields have an explicit
all-or-none database check. The generated migration and registry preserve all
prior artifacts and add no user foreign key, account rewrite or deletion.
Normal worker tests load this generated SQL; they do not hand-write a substitute.
No expiry-pruning job is introduced; physical row retention and operational
capacity must be settled before activation.

OAuth sign-in/callback responses receive no-referrer, private no-store, CDN
no-store and noindex headers through route responses and the Next configuration.
The public Next configuration matcher tests do not prove automatic trailing-slash
308 first-hop protection; the previously recorded ingress gate remains open.

## Qualification record

The following completed selections overlap; their counts must not be summed as
distinct coverage:

| Selection | Completed evidence |
| --- | --- |
| Strict protocol plus existing parser cases | 54 passed; independently rerun |
| Private HTTP client plus existing password client | 65 passed across two files; independent source review |
| Apple continuation codec and bounded-body cases | 46 passed; independent rerun |
| Backend identity/actor on PostgreSQL 18 | 62 passed across two files; 16.36 seconds total |
| Independent backend identity/actor on PostgreSQL 15 | 62 passed across two files; 14.87 seconds total |
| Backend canonical type checking | 13 tasks passed |
| Public Next matcher/header parity | 70 passed across two files; 3.20 seconds |
| Authenticated flow-cookie cleanup | Nine passed; 0.625 seconds total; independent source review |
| Strengthened App Router/provider/backend integration on PostgreSQL 18 | 22 passed; 55.91 seconds total |
| Independent strengthened integration on PostgreSQL 15 | 22 passed; 56.69 seconds total |
| Real Chromium Apple continuation on PostgreSQL 18 | Four passed; 17.61 seconds total |
| Independent Chromium continuation on PostgreSQL 15 | Four passed; 16.72 seconds total |
| Full auth regression selection on PostgreSQL 18 | 567 passed across 25 files; 325.28 seconds total |
| Aggregate canonical type checking | 59 tasks passed; five cache hits |
| Local migration registry | 294 entries, consistent |
| Full web auth unit selection | 347 passed across 15 files; 13.83 seconds total |
| Generated schema drift | No schema changes; no migration applied |
| Actual migration-journal regressions | 14 passed, zero skipped; owned throwaway databases |
| Whole repository check | Zero errors; 623 existing warnings across 9,230 files |

The 59-task canonical run preceded the final assertion-only receipt helper.
The strengthened test also passed the repository's type-aware, type-checking
`vp check`. Clean review-stack qualification is recorded separately when complete.

Final publication checks remain in progress. No normal test result implies a real vendor UI, Safari/iPhone,
installed native/watch client, production provider registration or SMTP proof.

The HTTP fixture initially failed before server admission because a forced-close
case reused a pooled origin. Each case now owns a unique ephemeral listener with
bounded admission and teardown. Assertions, deadlines and transport retries were
not relaxed. Final 65-case runs passed twice; the retained fixture commit counter
is not database commit evidence. Backend qualification separately uses actual
PostgreSQL transactions and restricted role failures.

The first actual route integration run passed 17 of 21 cases. Four failures
shared one fixture assumption: expected vendor letter case did not account for
the installed public NextAuth lowercasing step. The retained source inspection
confirmed that behavior before correcting the tests. New cases include leading
and trailing whitespace to distinguish framework lowercasing from backend
reservation normalization. No product behavior, timeout or retry changed.
The final 22-case run additionally revokes real profile SELECT permission from
the web LOGIN, independently observes SQLSTATE 42501, and completes actual Google
sign-in with one fixed profile-refresh warning and zero unknown warning arguments.

Final review found that the actual-route cases had not yet asserted the native
account-creation receipt override. Assertions were added to the same existing
new/returning cases, with no product change or additional case count. Google and
Apple must expose the exact canonical UID/creation date/provider, correct new or
returning flag, and matching SID through both the actual JWE and public session
JSON. Their attribution timestamp must fall inside the measured callback window;
it is not original authentication-age proof. Facebook must acquire no new
receipt. The strengthened PostgreSQL 18 selection passed all 22 cases in 55.91
seconds; an independent PostgreSQL 15 run passed those same cases in 56.69 seconds.

The privacy observer exists only in the explicit identity-proof child. It
counts exact canonical safe records at the `console.warn` boundary, never
retaining or forwarding raw arguments; production console functions are not
patched. This is evidence for that warning path, not a claim to inspect every
possible logging or telemetry sink.

The four explicit browser cases use actual Chromium cookies on distinct owned
HTTPS sites. They cover anonymous Apple creation, returning same-owner sign-in,
different-owner replacement and a new SID for the same owner while the provider
page is open. Actual POST omission of the Lax actor and restoration on the GET
are asserted. Replacement actors are real public-codec fixture JWEs installed
through browser cookie I/O, not a second completed password/UI login. The earlier
publication investigation separately exercises that actual credentials-login
boundary. Normal backend test discovery does not select this browser proof.

## Gates that remain open

Before activation, adopt and fence every identity and credential writer, resolve
production normalized-email ownership with read-only evidence, implement genuine
sensitive-action reauthentication and canonical legacy migration, and make every
HTTP/WebSocket/native/watch/refresh validator enforce one authority. Database
generation checks here do not fix a reset after identity resolution but before
legacy cookie issuance.

The measured browser publication races remain open: delayed old responses can
overwrite or clear a newer shared session cookie. This slice uses request-local
identity results and exact buffered publication checks, but it does not claim to
coordinate all browser tabs/origins or all existing session responses. Provider
registration, deployed IAM, historical receipts, delivery, capable-reader
retention and mutation-safe restored-database rollback remain launch gates.
Partner OAuth acceptance is separate from first-party authority migration.
