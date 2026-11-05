# BA-03 location batch preparation

Preparation for [BA-03 #6977](https://github.com/boardsesh/boardsesh/issues/6977)
in [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975), following
[batch system identities #7302](https://github.com/boardsesh/boardsesh/pull/7302).
Published as draft [#7303](https://github.com/boardsesh/boardsesh/pull/7303);
current-head CI and review feedback are monitored.
No location writer is delegated to a new authority by this slice. Both issues
remain open; production authority, grants and schema remain unchanged.

## Preserved boundaries

Public location sync currently ensures the fixed zero-UID owner before applying
gym, alias and board changes. Worker callers supply a transaction for each
batch of 25 complete gyms. Direct CLI and daemon callers can supply a plain
pool; their existing sequence can commit partially. Adding an outer transaction
to those direct calls would change behavior, so this preparation does not do it.

The pure batch planner preserves first-seen gym order, order within each gym,
duplicates and invalid-coordinate groups. It does not deduplicate or split a
gym. The legacy upsert still ensures its owner at the same point and shares one
internal data-write implementation with the new transaction-taking entry point.
That new entry point requires an existing owner and a caller-owned transaction;
it neither creates a user nor decides the outer commit.

A nonempty all-invalid batch still ensures the owner and reports the existing
skips. Empty batched input runs no transaction and creates no owner. A direct
legacy upsert with empty input still reaches its existing owner ensure. Existing
signal handling remains between batches.

## Cooperative SQL checkpoints

An optional synchronous assertion runs around SQL operations, including nested
gym resolution and its transaction/savepoint. Callers can use it to stop issuing
later statements after a deadline or cancellation. Existing callers do not
supply it, so their SQL and commit boundaries remain unchanged. The callback
must not perform network or other I/O.

These checks do not cancel a running statement, impose a database timeout or
make a plain-pool call atomic. The owner of an outer transaction must combine
appropriate SQL limits with its final validation before commit. Batched callers
check inside the supplied callback before it returns; a new assertion after an
outer committed batch would falsely suggest that commit had rolled back.
Cancellation or a lost HTTP acknowledgement never proves remote rollback.

## Why compound location authority remains separate

An early owner-only RPC would commit the owner even if the first 25-gym batch
fails. Preserving current rollback requires a compound owner/reservation/data
transaction. Independent source review found that the obvious composition can
introduce a lock-order cycle: the identity core holds the fixed owner's user
row FOR UPDATE before writing locations, while existing account deletion locks
content first and later transfers ownership through a foreign key that needs
KEY SHARE on that user. This is a source-level concurrency finding; it is not
presented as a completed real-database race proof.

Weakening the identity lock would weaken exclusion of concurrent authentication
artifacts. Taking KEY SHARE early in two helpers would also be insufficient:
account deletion already holds other content locks before its board helper;
admin gym reassignment can target the zero UID after locking a gym; shared-feed
creation releases its separate ensure transaction before the board INSERT; and
plain-pool CLI/daemon calls would release an early lock before later writes.
Generic merge paths that copy historical zero-UID foreign keys add a data-history
gate. All affected writers and caller lock boundaries need an adversarial proof
before a compound command is mounted. Compensating deletion, network calls
inside worker transactions and automatic retry are not substitutes.

## Future admission and timing decisions

The current MoonBoard catalog emits 14 configurations per marker, so 25 distinct
markers normally produce 350 board records. The existing worker comment that
mentions 225 is historical and cannot establish a bound. Duplicate markers with
the same gym key remain in the same group, so there is no source-guaranteed
records-per-batch ceiling. Text fields are not bounded by the current database
schema. A future wire format must project explicit fields: the builder also
spreads a layoutName property beyond its narrower declared record type.

Any finite staging byte or record cap must reject a complete oversized batch
before writes, without truncation, deduplication or splitting a gym. Nonfinite
coordinates need an explicit wire representation while retaining the original
source keys and record-level skip behavior. Configuration tuples should use one
shared catalog. No body limit, transport budget or new selector is introduced
here; the earlier 16 KiB request limit and eight-second auth budget have not
been shown adequate for a compound location batch.

A future timing proof must measure actual PostGIS work, every SQL await, global
auth-manifest hold time and concurrent authentication success/rejection. A final
deadline check alone does not bound hundreds of statements. Provider requests
must remain outside transactions. Missing-credential no-ops, CLI queued-path
guards, actual run/queue fencing, first/second-batch rollback, aliases and owner
curation, frozen rows, committed reply loss and all writer lock orders remain
separate adoption requirements.

## Qualification ledger

A fresh worktree starts from main c2e1f09c6b179bc05cbcb9a50f7e27d6adb0dffa
and merges published prerequisite d352006078c3b8f79558884bc76efec75b789e40,
then its reviewed image-packaging correction fc39334871b8b0cceaaa3f72299a2b4971453c36.
Pinned dependencies install offline with the frozen lockfile unchanged. The
pre-implementation plan records the compound-command rejection and the smaller
preparation scope before source changes. Independent source review approves the
shared extraction and 21 expanded unit cases. The focused selection passes
49/49 cases across two files (4.28 seconds); all pure package tests pass 78/78
across five files (4.90 seconds). These selections overlap. Package types and
scoped checks pass; no integration or service result is inferred from pure tests.

The first focused run passed 48/49: its new signal test evaluated the expected
abort reason before the asynchronous abort occurred. The fixture now uses one
stable pre-created error while retaining the one-committed-batch assertion.
Independent re-review approved that test-only correction; product code did not
change. A pre-execution review of the real PostgreSQL fixture also identified
three missing read grants used by the physical-match query. The fixture adds
those grants while retaining explicit user INSERT and SELECT denial. This is a
NOLOGIN/SET ROLE permission proof, not a separate LOGIN or deployed-IAM proof.
The first isolated PostgreSQL 18.6 fixture was created successfully, with a new
container and volume, loopback-only port, database OID and cluster identity.
The first runner invocation stopped before claiming a schema stage: PostgreSQL's
JSON rendering represented an OID as text while the guard expected a number.
A read-only diagnostic confirmed every identity field; explicit OID text
projection and strict comparison fixed the helper without relaxing identity.
Both reviewers approved the correction before any schema action.

Legacy-table stubs, PG18 development roles and the cutoff helper then passed in
that fixture. The actual Node migrator failed when applying all 294 pending
entries in one transaction: PostgreSQL rejected use of the new enum value
social_entity_type.session before commit (55P04). Migration 0058 adds it;
0120 uses it. The assumption that this Node path could bootstrap the complete
empty history was wrong. No integration case passed in this attempt. Its
failed claim, database, volume and private log remain retained without retry,
reset or deletion; ordinary application code and the production migrator are
unchanged.

The replacement fixture uses the exact checked-in image migration helper,
which commits each SQL file and its two hash/time ledger rows together.
The host already has jq; the PostgreSQL container has psql. A reviewed transport
adapter streams each exact checked-in SQL file and forwards the helper's
original ledger commands to one container psql process, retaining its single
transaction per file. This introduces no migration SQL or reconstructed ledger.
Only this child receives the adapter directory before the original PATH;
ordinary Vite+ children retain their system paths. No package installation or
host-library copying is required. The replacement fixture and transport were reviewed separately before their
qualification below.

The replacement PostgreSQL 18.6 container was created once with a different
port, database, volume and cluster identity; the failed fixture remains intact.
The unchanged canonical helper then applied all 294 files and both original
ledgers successfully (54.88 seconds). The actual Node migrator subsequently
verified all 294 journal hashes and initialized the normal job queue schema
(1.75 seconds). It had no pending historical enum change to combine in one
transaction. Both reviewers approved the exact transport, public ownership
binding and retained phase evidence before schema execution.

Eighteen pure transport cases passed with zero failures or skips (274.22 ms),
including actual canonical-helper invocation against a recording psql and exact
SQL-byte/ledger forwarding. Review corrected an oversized-byte oracle before
execution: its matching digest now prevents a separate hash rejection from
masking a missing byte cap. These pure tests invoke no Docker or PostgreSQL.

The required location project then passed 89/89 cases across seven files, with
zero skips: 78 pure cases, seven existing real freeze/curation cases and four
new transaction cases. Vitest reports 3.68 seconds; the owned runner's complete
wall time is 5.13 seconds. The new cases prove actual user INSERT/SELECT denial
under a NOLOGIN role, successful geography and alias writes through the supplied
transaction, caller rollback, rollback after a completed board INSERT when its
checkpoint throws, and unchanged invalid-coordinate skips. Existing real
fixtures retain aliases, claims, frozen edits and serial behavior. Each outer
fixture rolls back, and its new role grants and pool are cleaned up. This is
PostgreSQL 18 evidence; no full-schema PostgreSQL 15 result is claimed.

The first whole check found two missing Gorhom type declarations because this
fresh worktree had not installed the isolated Expo web runtime. Running the
same unconditional preparation used by CI resolved that setup error without
source changes or rule suppression. The repeated canonical check passes with
zero errors and 623 existing warnings across 9,249 linted files; all 9,780
formatted files pass (51.4 seconds). Frozen installs leave both lockfiles
unchanged. Independent runtime-evidence review confirms actual closed exits,
zero skipped integration cases and bounded child cleanup.

## Clean replay and preview

Source commit 07ee7e57e42c629014c5e738c30122178d1bcc56 passed the real hooks
with exactly six reviewed files. A preserved backup retains the main-based
candidate. Replaying only that patch onto published parent
fc39334871b8b0cceaaa3f72299a2b4971453c36 produces clean head
0e314e9c6e13982d5feaa2936a12a1851d436724. Range-diff is equal and all six
patch blobs are byte-identical. Merging main c2e1f09c6b179bc05cbcb9a50f7e27d6adb0dffa
with the clean head reproduces saved source tree
c999bb013ee51f77817d9454e77ec7cec90ed54c. Independent review checked the replay
and head-only guard update. The three TypeScript blobs remain identical to the
passed 89-case claim. The complete canonical type graph then passed all
59 tasks at that clean head, with zero cache hits (165.98 seconds).

After tests, the actual canonical test-user script seeded the fixed synthetic
UID ending in 0001 once (2.03 seconds). A precheck proved its UID/email and
credential absent; postchecks confirmed the exact user, test email, credential
and profile. The script also creates its normal synthetic playlist fixtures.
This is isolated QA data, not a production identity import or backfill.

A new version3 preview receipt explicitly acknowledges reuse of this same
owned full-schema QA database. It does not claim a second database creation.
Its reviewed guard binds the original container, fresh volume, database OID,
cluster identifier, all successful schema/test/seed claims and current source.
The launcher preserves default memory protection, cached TLS, dedicated ports,
source/private-environment suppression and all six legacy selectors. QA notes
were written before startup. Actual startup printed their path, and the real
metadata GET returned 200 with matching branch, notes and notes path.

One fresh private Chromium run passed all five baseline authentication flows:
fixture login with repeated session reads retaining the same browser SID,
actual sign-out, wrong-password 401, invalid-email validation with no recovery
POST, and invalid-reset 400 with an empty session. It allowed eight AST-checked
GraphQL query posts and five owned HMR connections; external traffic,
unexpected mutations, unexpected console errors and page errors were all zero.
The expected 401/400 console messages were classified separately. Browser and
context closed, and the preview remains running. The bounded result is retained
locally as
6977-location-preparation-preview-ui-853a0754-a96e-431b-8aad-fb1c6a57e8cc.json.
Independent evidence review approved the final result and all 31 fingerprints.

This is a desktop legacy-auth baseline, not location-writer adoption, valid
recovery delivery, provider/device/BLE behavior or continuing credential
authority. Later evidence-only documentation commits deliberately stale the
startup receipt; the running preview is retained and must not be restarted
against that stale receipt. PR #7303 remains an unmerged review candidate.
These implementation results neither adopt a location authority nor complete
BA-03 or the epic.
