# BA-03 batch-job system identities

Implementation slice for [BA-03 #6977](https://github.com/boardsesh/boardsesh/issues/6977)
in [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975), building on
[#7301](https://github.com/boardsesh/boardsesh/pull/7301). Published as draft
[#7302](https://github.com/boardsesh/boardsesh/pull/7302), with current-head CI and
review feedback monitored. Both issues remain open. This adopts two existing account writers; it does not activate the
production authority migration.

## Mounted callers and configuration

The recommendations job creates `system-recommendations` at
`recommendations@boardsesh.com`. The hold-features job creates
`system-hold-classifier` at `hold-classifier@boardsesh.com` only when
`!dryRun && shadow`. Both previously inserted their three user columns through
an initial, separate worker transaction. Later data batches already had the
durable job-attempt fence described in [background-workers.md](./background-workers.md).

`CURRENT_STORE_BATCH_SYSTEM_USERS_MODE` independently selects `legacy` (unset,
empty or explicit legacy) or `backend-staging`. Legacy keeps the exact
three-column INSERT and initial separate transaction. Staging passes a captured
`systemUserAuthority` capability from actual `executeBackgroundJob` dispatch
through the family into the job body. It calls the backend before any data
transaction. Invalid configuration, protocol, network or authority response
never permits a direct INSERT fallback. HTTP performs no automatic retries.

The worker uses `CURRENT_STORE_BATCH_SYSTEM_USERS_ORIGIN` and a dedicated
`CURRENT_STORE_BATCH_SYSTEM_USERS_RPC_SECRET`. The trimmed secret must contain
at least 32 UTF-8 bytes and differ from the human auth RPC, NextAuth and cron
secrets. Remote destinations require HTTPS; HTTP is allowed only for explicitly
local development/test origins. No path, credentials, query or fragment is
accepted in the configured origin. Workers receive no backend database login or
auth-foundation grants.

The two direct scripts reject staging before creating their script database
client and instruct the caller to use the existing queue operator. This is an
**agent staging decision**, not a permanent removal of direct operator tools.
An unqueued script cannot manufacture a current queue attempt. Legacy CLI
behavior remains available under the legacy selector. Direct manual authority
would require its own explicit capability scope; it is not implicitly granted
by the worker's machine secret. The CLI staging guard also applies to script
dry-run invocations; queued classifier dry-run/no-shadow execution needs no
identity command.

## Private wire contract and authority

The independently versioned v1 path is:

```text
POST /api/internal/auth/current-store/batch-system-users/v1/ensure
```

The strict request contains version, operation, canonical correlation UUID,
issuance time and the actual run/attempt UUIDs. It accepts no user ID, email,
identity kind, family, worker role, projection or credential. Its issuance
window is 30 seconds with five seconds of future clock tolerance. The caller
and server use an eight-second command budget; SQL statements and lock waits
are bounded to five and four seconds respectively.

The backend authenticates the dedicated secret before reading the bounded
body or entering SQL. Origin-bearing browser requests are denied and cookies
confer no authority. Only exact JSON POST requests reach the command. Replies
contain correlation and an ensured/rejected result, never an identity or
credential. Known rejections have fixed codes; unexpected failures use one
fixed diagnostic category without raw causes, URLs, SQL, headers or bodies.
Responses carry private no-store, no-referrer and noindex headers.

The shared fetch-injected private transport preserves the existing 16 KiB
request and 64 KiB response limits, fatal UTF-8 decoder, redirect refusal,
deadline and fixed sanitized error. The existing web server-only adapter keeps
its original public API, configuration keys and defaults. It now delegates to
that shared implementation instead of maintaining a second copy. Human v2
DTOs and selectors are unchanged.

Inside one READ COMMITTED transaction, the backend applies SQL limits **before
the first ledger lock**, then acquires:

```text
run → active pg-boss attempt → enforced auth manifest → cutoff → reservation → user
```

The extracted transaction-level job helper is the same existing predicate,
callback and final deadline/lease recheck. Existing database-owning callers
delegate to it; the identity command does not open a nested pool transaction.
Under the run lock, the backend requires the batch role and queue and derives
the fixed identity from the persisted allowed family. It reuses the same pure
family payload validators as actual worker dispatch, including the classifier
write condition.

The command claims a hashed one-use nonce in the existing verification-record
table under `ba03-batch-system-user:v1:` and ensures the identity in that same
transaction. The entire machine namespace is reserved from legacy verification
orphan cleanup, including future versions. Exact replay is rejected. An
unsuccessful transaction consumes neither nonce nor identity. Request freshness
is rechecked after asynchronous waits, and the job deadline/lease is checked
again before commit.

## Identity and failure decisions

The pure catalog centralizes the existing IDs, email addresses and names with
their old exports preserved. One transaction-level identity core also serves
the earlier board-owner wrapper without changing that public signature.

Fresh creation requires an absent UID and reservation, no cutoff and no
other-address ownership/membership history. Reuse requires an existing fixed
UID, accepted normalized email, current owned reservation and sole matching
member. Mismatched or incomplete pairs, blocked/deleted history and any
password/provider/session/refresh artifact fail without repair or deletion.
Existing user/profile/cutoff fields stay unchanged. No profile, verification,
credential, session or security generation is created.

These conservative staging rules are agent decisions that preserve evidence
for explicit review. They do not decide permanent address-release or account
recovery policy. The user's password decision remains separate: authenticated
set/change retains the requesting device and original proven authentication
age while revoking others; forgotten reset revokes all sessions. This slice
neither changes nor proves that password policy.

The identity's initial transaction still commits separately from later job
data batches. If a later real batch is denied, the complete committed owner is
retained. If a successful reply body is lost, the caller cannot acknowledge it
or write locally; the committed identity and consumed nonce remain. A later
valid attempt with a fresh command validates the existing pair. Queue retry
and settlement remain governed by the existing run/pg-boss machinery.

Worker shutdown or client cancellation is **not evidence of remote rollback**.
The worker checks its local signal before and after the call, but a backend
transaction that still owns a valid durable lease may commit. No network call
runs while a worker data transaction holds the ledger lock.

## Deliberate limits and remaining writers

The worker currently has whole-table ledger INSERT/UPDATE and pg-boss DML.
Persisted family/token checks fence stale cooperating handlers; they are not
tamper-proof assignment provenance against a compromised worker. The narrow
machine secret and fixed catalog do not grant arbitrary human identity writes,
but stronger ledger/queue provenance and deployed IAM remain activation gates.
Software selectors and the enforced manifest do not replace a real old-writer
database fence. No production grants are changed by this implementation.

Location sync is a separate writer of the fixed zero-UID board owner, including
Aurora public locations/gym crawling, Kilter catalog locations and MoonBoard
locations, plus CLI/daemon callers. It currently ensures the user **inside each
25-gym data transaction**. Moving it before the batch would retain the owner
after a failed first batch; that rollback decision and all its callers require
separate adoption. Account-deletion board transfers only look up the existing
system owner; they do not create it. Demo/seed/operator permissions remain
writer-fencing work too. These are not hidden behind a claim that all
nonhuman writers are already centralized.

## Qualification ledger

A fresh worktree began at main `c2e1f09c6b179bc05cbcb9a50f7e27d6adb0dffa`
and merged published prerequisite `1e57f569625753f93008b23de6dd695360bb1411`
without conflict. The plan and staging decisions were recorded before code.
Existing pinned dependencies were installed through Vite+. The only lockfile
change is the DB workspace link to the already existing auth-protocol package;
no external dependency or version changed. No schema migration is added.

Independent implementation peers cross-reviewed the identity/fence core,
worker/CLI adoption, protocol, transport and configuration. A third security
review covered the completed private endpoint and transaction composition.
Source review found no remaining actionable production finding.

Independent portable qualification passes **84/84 protocol cases across four
files** (1.19 seconds), **65/65 existing web private-client cases across two
files** (1.61 seconds), and **35/35 new machine-client cases** (1.03 seconds).
The client's streamed-byte test initially used invalid JSON, which could hide
a missing byte cap. Review replaced it with a valid reply padded beyond the
limit and re-reviewed the correction before the run.

The first PostgreSQL 18 integration attempt stopped in fixture initialization:
pg-boss's explicit BEGIN/COMMIT was passed to a multi-connection pool, causing
`UNSAFE_TRANSACTION`. All 36 then-existing endpoint cases were skipped; none
are recorded as passing. Fixture-only initialization now uses the single owner
connection, matching the existing queue fixtures. Backend/worker pool budgets
and product/assertion behavior were unchanged, and the fix was re-reviewed.

Fresh PostgreSQL 18 qualification then passes **47/47 endpoint, real worker and
CLI cases across two files** (24.32 seconds), independently repeated on
PostgreSQL 15 (**47/47**, 28.71 seconds). Both use actual HTTP, real job/queue
rows, separate restricted LOGIN roles and real worker/family bodies. The
worker's user INSERT is revoked and auth-table reads are denied while the
backend command succeeds. Existing shared-board identity/resolver regressions
pass **51/51** on PostgreSQL 18 (11.41 seconds) after the common-core extraction.

The causal timeout test deliberately disables backend connection-level limits
so only production SET LOCAL protects the first ledger wait. The manifest-wait
test observes an actual backend lock wait, asserts the database clock is still
before the run deadline, then observes expiry before releasing the lock. Every
failure path releases and settles its blocker/request. Actual committed 200
headers are observed before the fixture destroys the withheld reply body.
The later-attempt case updates owned queue retry state and uses the real claim
helper; it does not claim an installed worker retried that dropped response.

No PostgreSQL test uses port 5433 in this qualification: the reviewed wrappers
pin owned clusters on 15475/15478 and fresh salted worker namespaces before
global setup. The committed fixture also supports the canonical local/CI
5433 workflow with explicit environment and exact worker-name/URL checks; that
exception trusts the test workflow, not proof of Docker ownership. Local
`SKIP_TEST_INFRA=1` cannot select that exception. No shared or production data
was accessed. All new fixture role/pool/listener/child cleanup completed;
ordinary salted worker databases remain retained.

An additional actual-consumer case passes a real committed machine nonce to
`consumeEmailVerification`: it must be invalid as a verification record, retain
the exact machine nonce and still reject machine replay. Without the reserved
namespace guard it would be classified as a live unbound legacy receipt.
Independent review also removed unsafe finally-flow and four test-only lint
warnings without suppressions or weakening assertions. Final qualification is
**48/48** on PostgreSQL 18 (**27.95 seconds**) and independently **48/48** on
PostgreSQL 15 (**22.45 seconds**). The final client suite is **35/35**
(1.06 seconds). Earlier 47-case results above remain historical checkpoints.

The full current-store/native-auth selection passes **689/689 cases across
29 files** on PostgreSQL 18 (**367.06 seconds**). Existing worker lifecycle,
family-adapter and batch-body suites pass **79/79 across three files**
(37.89 seconds); the original queue-role, transaction and server-deadline
selection passes **9/9 across three files** (47.14 seconds). These selections
overlap; they are not added into a larger total. The complete canonical
typecheck graph passes **59 tasks with zero cache hits**. Whole checking passes
with **zero errors and 623 existing warnings across 9,247 linted files**; all
9,778 formatted files pass. An initial whole-check format failure in one test
was fixed, followed by removal and independent re-review of the new test
warnings. No test or commit hook was bypassed.

## Clean replay and isolated preview

The source commit `5b3a1f5b8eb2c6981d5977ee64b1014a4b12c60e` passed the
real staged checks and commit hook. A preserved backup retains that main-based
candidate. Clean replay onto published parent `1e57f569625753f93008b23de6dd695360bb1411`
produces `7f79b2a9f5c76bf05f978d0c53fe61241ce95d93`. Range-diff is equal,
all 39 patch files are byte-identical, and merging fresh main into that clean
head reproduces the exact qualified tree `c7f284271ad83a87ff2709ecd58a7a14eab98634`.
Independent review verified those comparisons and the source-guard repins.
The clean-head canonical graph then passed all **59 tasks, with four cache
hits**. This is separate from the earlier zero-cache-hit main-based run.

A read-only preflight verified an absent fresh owned PostgreSQL 18 namespace
and an empty exclusive Redis database. Exactly one acknowledged creation
hydrated that new database and seeded one synthetic fixture account. No
existing preview namespace was reset or deleted. The launcher rechecked the
source fingerprints, database OID, TLS, free ports, environment isolation and
six legacy selectors before invoking the development orchestrator with the
written QA notes. Startup printed the expected notes path; the actual metadata
GET returned **200** and matched branch, notes and notes path.

One fresh private Chromium run passed all **five baseline legacy-auth flows**:
fixture login with the same browser session ID, actual sign-out, wrong-password
401, invalid-email validation with no recovery request, and invalid-reset 400
with an empty session. It observed eight allowed read-only GraphQL posts and
five owned development HMR connections, with zero unexpected requests,
mutations, console errors or page errors. The expected 401/400 console messages
were classified separately. The context and browser closed successfully, and
the preview remains running. The bounded result is retained locally as
`6977-batch-system-users-preview-ui-d5829902-1c20-465c-a980-7815b60a0803.json`.

This preview keeps all delegation modes on legacy. It proves the ordinary
fixture browser baseline on the clean source head; the restricted-role staged
command is qualified by the separate integration suites. It does not prove
valid recovery delivery, real providers/devices, production IAM or a migration
rollout. Later evidence-only documentation commits deliberately invalidate the
source receipt for restart; they do not change the already running preview.

## CI packaging correction

The first final-head CI run exposed a standalone dev-database image packaging
failure: its explicit workspace-dependency strip list omitted the newly added
DB dependency on auth-protocol. Installation stopped with
ERR_PNPM_WORKSPACE_PKG_NOT_FOUND before the seeded image was built. This was a
real failed check; retrying unchanged could not fix it. The image now strips
that dependency consistently with its existing standalone install. Only the
two batch CLI mode guards import it at runtime; the image's migration, snapshot
loading and seed entry points do not load those scripts. No protocol source or
new external dependency is needed in the seed image.

Executing the actual Dockerfile manifest-preparation command on a temporary
copy removes every workspace reference while preserving all other dependency
versions. Independent closure and source review qualify the correction; the
new-head seeded-image CI remains the complete build gate. The Dockerfile is an
additional path after the earlier historical 39-file source qualification.

Passing these implementation checks does not
complete BA-03, collision cleanup, source/validator migration, production
rollout, restored-database rollback or the separate partner OAuth launch.
