# Session encoding, publication and reader boundaries

This source-preserving follow-up to [BA-03 #6977](https://github.com/boardsesh/boardsesh/issues/6977)
resolves assumptions needed before adding current-store web sources. It follows
the [App Router proof](./better-auth-app-router-oauth.md). It adds no production
route, source table, credential marker, authentication mode, writer or validator.
The accepted migration and user password policy remain unchanged.

## Decision before adding source records

Independent review rejected proceeding directly from a successful password
verdict to a global JWT-encode publication hook. The next implementation must
distinguish an encoded token from a credential actually returned to a browser,
and must address delayed responses writing the shared browser cookie.

These are agent engineering decisions, not new account-selection policy:

1. Do not create authoritative publication records from every `jwt.encode` call.
2. Preserve the released 30-day rolling session lifetime and stable login SID.
3. Never infer original authentication age from a renewed token's `iat` or `jti`.
4. Do not claim backend validation makes browser `Set-Cookie` conditional.
5. Keep source-schema/adoption work gated on actual reader and publication paths.

No production migration, account backfill, owner reassignment, grant change or
activation is part of this follow-up. Existing V2 commands remain unchanged.
An eventual source API must derive authority from the actual password proof
inside its final transaction; the current one-request UID verdict is not an
exchangeable continuing credential.

## Actual server reads and rolling renewal

The pinned NextAuth version is 4.24.15. Its public one-argument
`getServerSession(authOptions)` path obtains the exact request cookie through
`next/headers`, runs the session action, then passes generated cookies to a
response object with no-op setters. It removes `expires` from the returned
session. This happens for API handlers using that call form as well as server
components; an API file does not automatically select the three-argument API.

The focused normal tests call that actual public function inside the owned
request context, with the shipping options and actual public JWT codecs. The
fixture forwards its JSON result over owned HTTPS without adding auth cookies.
The codec observer records only token digests, fixture IDs, signed timestamps,
maxAge and fixed booleans. It never records raw JWEs, grants, passwords or error
text. Observation-only decoding cannot change a successful encoder result and
uses the same salt. The real codec's failure and success semantics are retained.

The tests distinguish these paths:

| Path | Generation and transport boundary |
| --- | --- |
| One-argument server read | Exact raw JWE reaches decode; a new JWE is encoded; no cookie is returned |
| Repeated server reads | Each read generates a distinct JWE while the presented cookie stays the same |
| Public GET session | A new JWE is sent in the actual auth cookie, with a full 30-day deadline |
| Public POST session update | Actual JSON update input renews the cookie; client owner/SID fields do not replace the login |
| Invalid cookie | Server read returns null without a cookie; the public route sends an auth-cookie deletion |

Cookie-chunk tests compare the exact reassembled JWE digest at both decoders,
rather than asserting that a UID found later proves access to the original
credential. Renewal tests use a real public-encoder one-day fixture parent and
capture request start/end clocks around actual GET/POST handling. They do not
mock the clock, change production lifetime or claim an original authentication
age for that synthetic parent. The previous parent remains cryptographically
valid through its own deadline; ordinary renewal does not revoke it.

A global encode/finalize hook would therefore create records for unpublished
server-read JWEs and could extend a source's retention horizon without any
browser receiving a credential. Renewal receipts must track actual publication,
not merely generation.

## Reader inventory for eventual adoption

At the reviewed parent, there are thirteen one-argument `getServerSession`
calls across eleven production files. They fall into these groups:

| Group | Current entries and required future boundary |
| --- | --- |
| Public server rendering | Profile, profile statistics and playlists; validate the presented raw cookie before returning identity |
| Account and administration | Set-password, profile reads/updates, admin checks, controller operations and cache revalidation; decoded UID alone is insufficient |
| Native handoff | Native callback; retain the raw credential's authority and original age across transfer |
| Feature evaluation | Server distinct-ID lookup; distinguish anonymous, invalid and unavailable outcomes without granting identity |
| Other credential readers | WebSocket auth `getToken`, sign-out guard/core decode, backend token entry and WebSocket operation context; do not stop at the App Router GET wrapper |

Raw credentials are available at those entry points, not from a decoded session
object after the fact. The current backend positive cache can retain an accepted
identity for 60 seconds, and WebSocket connection setup reduces the credential
to identity/expiry before later operations reuse context. Those paths still
need explicit adoption; this inventory is not an effective-revocation claim.

The pinned callback and sign-out internals also decode current cookies.
Malformed, reserved or future source markers must eventually be recognized
before any generic legacy dispatch. No such marker is issued here, and arbitrary
legacy cookies must not be upgraded from their UID or local `authSessionId`.

## Browser response ordering and activation boundary

Four Chromium cases demonstrate the existing races: a delayed renewal restores
A after B's completed login; a delayed expired-cookie cleanup deletes B's cookie.
Both outcomes occur with same-origin pages and with same-site pages at different
origins. B's actual credentials callback, nonempty new SID and stored cookie are
verified before releasing A. A fresh browser session read then confirms A or an
anonymous session. This is counterexample evidence, not a claim to fix either
race.

The browser proof holds a completed public session response before its headers
are sent. A different account then completes the actual credentials callback.
The test must establish that the browser stores B's cookie before releasing A;
only then can it measure the delayed renewal or cleanup response's effect.
Holding a response body after headers have arrived would not establish this
boundary.

The two-origin case uses the same HTTPS host on different owned ports. Cookies
share that host, while origin-scoped Web Locks do not share an origin. Native
form navigation and unwrapped requests are not protected by a fetch-only lock.
The shipping lock is additionally gated by the Expo auth-bridge installation
and restricts itself to same-origin fetches. A matching lock name does not
coordinate `www` and `app` origins.

Any measured overwrite is a characterization of the current cookie slot, not a
new authority defect introduced by this test. A future final database check may
deny a stale credential but cannot restore B's cookie after a delayed response
overwrites or deletes it. A broker, coordinator or cookie-slot protocol must be
reviewed against actual supported clients and origins before implementation;
this follow-up silently changes none of those account behaviors.

Turning off future fresh-source issuance must retain capable marked-cookie
validation and rolling renewal. Rolling sessions have no guaranteed retirement
30 days after first enablement. Every actually published renewal needs evidence
through its own signed deadline and applicable tolerance; coalescing away a
still-valid parent would change current behavior. Operational traffic, storage
and retention must be measured before selecting that schema.

## Evidence scope

The four browser cases passed on owned PostgreSQL 18 in 13.12 seconds; an
independent reviewer ran the same four on PostgreSQL 15 in 12.57 seconds.
Both processes closed successfully, all four browser/transport source hashes
stayed unchanged, and the reviewer found no remaining owned probe or Chromium
children. These are four distinct cases, not eight. A second reviewer approved
the source and re-reviewed bounded teardown, unclaimed gate cancellation and
nonempty B-SID fixes before final qualification. The stock old-A cookie is
explicitly public-encoded fixture lineage; B performs genuine bcrypt-backed
credentials login. The proof runs the actual route exports through an owned
HTTP bridge, not a full Next server, external provider or device.

The nine normal cases passed on owned PostgreSQL 18 in 9.72 seconds and
separately on PostgreSQL 15 in 8.37 seconds. These are the same nine cases,
not eighteen distinct tests. An independent reviewer then passed all **99 normal
App Router cases across five files on PostgreSQL 15 in 73.38 seconds**, including
the new nine once. The reviewed JSON-update, codec-observation and redacted
failure assertions are included. The complete current-store selection plus the
five existing native suites then passed **483 tests across 22 files on
PostgreSQL 18 in 253.84 seconds**. This contains those same nine cases and the
preceding 474; it is not additional distinct coverage to add to the earlier
selections. All four normal processes closed successfully;
ordinary salted worker databases remain. Normal and
browser runs are qualified separately. The normal tests run in the
backend project; the browser proof has explicit selection and requires an
installed Chromium and owned services. Passing a normal CI selection never
implies a browser was installed or that browser ordering passed. Actual run
counts and independently reviewed results are recorded after qualification.

The four existing OAuth browser cases also passed against the updated shared
transport on PostgreSQL 18 in 17.95 seconds. All **59 canonical typecheck tasks**
passed with zero cache hits. Repository checking passed with **zero errors and
623 existing warnings**, 9,206 linted files and 9,737 correctly formatted files.
Compilation used deliberate offline backend/app URLs; it is not a live-backend
or device claim. The authored scope is eight test/documentation files.

An independent read-only catalog audit after all runtime runs found zero
`ba01_*`/`ba03_*` fixture roles and zero `boardsesh_ba01_*` prototype databases
on both owned clusters. Ordinary worker databases remain: 52 on PostgreSQL 15
and 133 on PostgreSQL 18, including the isolated preview namespace. No role,
database or application data was changed by that audit.

The earlier repaired ten-candidate combined tree passed 474 normal cases, all
702 isolated migration cases, 39 header cases, four separate browser cases and
all 60 uncached typecheck tasks. Its automatic prerequisite merges and frozen
install preserved source and lock hashes. Those counts describe that earlier
tree and are not new distinct coverage from this follow-up.

The full-Next preview at the repaired parent also qualified five bounded legacy
auth UI flows across two retained browser runs: login, actual guarded sign-out,
wrong-password rejection, invalid-email recovery and invalid-reset rejection.
The first run stopped after three qualified flows at a cold-form timeout; the
later run separately observed handler readiness before qualifying recovery.
A separate negative-only replay found the expected credentials 401 and reset
400 console messages and no unexpected console/page errors. Independent review
approved the evidence. No valid reset, SMTP, real provider, native/watch device,
source-backed session or all-session revocation was exercised.

The recovery first-hop header gate remains open. Pinned Next drops accumulated
configured headers when returning its automatic redirect, before middleware
runs. A scoped ingress response rule is a possible follow-up; changing global
trailing-slash normalization is not part of this work. Actual ingress/cache
ordering, encoded/repeated-slash paths and direct-origin behavior need proof.

## Reproducing the focused cases

The nine normal cases use the standard backend infrastructure:

```sh
vp test run --project backend app-router-session-publication.test.ts --reporter=agent
```

The browser file is deliberately outside ordinary test discovery. With an owned
local test cluster and installed Playwright Chromium, select its explicit config:

```sh
BOARDSESH_AUTH_PROOF_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:15478/boardsesh_backend_test \
  vp test run --config packages/backend/auth-proofs/session-publication.vite.config.ts --reporter=agent
```

The separately owned PostgreSQL 15 service uses port 15475; the browser config
owns the Redis destination on port 15476. These are local fixture contracts,
not application or production connection settings.

## Review-stack repair

Initial implementation and qualification started at main `eceaa2d61e`, with an
automatic prerequisite merge `0e09a59`. The complete qualified commit `4743c2d`
and tree `f698cec607004640d55c712fd6fb9db1ffb83e7f` remain backed up. CI then
correctly rejected generated changelog changes inherited from main when compared
with the older stacked PR target. Its guard permits no import waiver.

The repair replays only the eight-file follow-up onto published parent `aa4a6e5`.
Before updating these notes, the resulting `5762e33` merged automatically with
the same main to reproduce the **exact qualified tree** above. All six TypeScript
files are byte-identical to the qualified source. This removes unrelated
already-merged main changes from the review diff without reverting them on main
or changing the guard. The later repair-note and review-guide changes are prose
only. The original main-integrated qualification and the cleaned review branch
remain distinct. Fresh canonical typechecking passed all **59 tasks**, with four
cache hits, before the repaired push. The unchanged generated-changelog guard
also passed against the exact cleaned base/head commit identities.
