# Account consolidation preview and repair

This read-only operator tool supports the investigation requested in
[#7430](https://github.com/boardsesh/boardsesh/issues/7430) and the ownership
resolution gate in [BA-02 #4847](https://github.com/boardsesh/boardsesh/issues/4847).
It does not change the owner's retirement runbook, select an account to keep,
send contact emails, merge accounts or delete records. The original
[evidence worksheet](./account-email-audit.md) remains a separate artifact.

## Generate private planning evidence

Supply `ACCOUNT_EMAIL_MERGE_PREVIEW_DATABASE_URL` through the normal secret
manager. Use the DR standby and a read-only role with catalog and table access.
The command accepts no database URL argument and never falls back to application
connection variables. Remote TLS verification is required. Leave `DEBUG_SQL` off.

```sh
vp exec tsx packages/backend/src/scripts/account-email-merge-preview.ts \
  --out ~/Private/boardsesh-ba02/merge-preview-2026-11-11.json
```

The destination directory must already exist, belong to the operator and have
mode 0700. Every parent must be outside Git repositories and worktrees. The
report is created exclusively with mode 0600; an existing file is never
replaced. `--allow-primary` explicitly permits a primary read, but a standby is
preferred to avoid primary load and deploy lock queues.

Accept only an exit-zero receipt with `status: "complete"` and
`connectionClosed: true`. Verify its SHA-256 and byte count against the private
file. Complete means the planning report was collected and written; it does not
mean a merge is safe. Stdout contains aggregate counts and snapshot metadata,
never addresses, user IDs, names, hashes, tokens or the private report itself.
Keep the report outside chat, issues, pull requests and CI artifacts.

All account evidence and additional conflict counts share one
`REPEATABLE READ READ ONLY` transaction. The existing evidence collector's
normalizer reconciliation, catalog guards and limits remain in force. The
whole CLI is bounded to 15 minutes and each statement to 60 seconds. Each query
derives shared-address membership on the server rather than sending addresses
or user IDs in bind parameters. A new snapshot must be taken before any later
production decision; this report does not fence concurrent writers.

## Read the preview

Every group is `blocked_pending_ownership_and_rehearsal`, with a null
`survivingUserId`, even if all conflict counts are zero. The report includes:

1. Existing member data, login-method presence, role and pending-link counts.
2. Unique-index collisions for the hypothetical consolidation, with unsupported
   index shapes called out explicitly rather than reported as zero conflicts.
3. Possible duplicate tick events; counts are candidates, never deletion orders.
4. Board mappings with different upstream identities and multiple-password flags.
5. Explicit limits covering non-FK state, checks/triggers, offline queues,
   incremental cursors, delayed jobs and derived statistics.

Counts do not choose how to resolve conflicts. Two accounts holding the same
playlist or favorite require a reviewed relationship policy. Different profile
privacy settings, roles, votes or board credentials must not be combined by
silently choosing the newest value or greatest privilege. Repeated ascents may
be real; preserve IDs and provenance until duplicate evidence is reviewed.

The FK catalog is useful discovery, not a full account-move inventory.
`logbook_changes.user_id`, `sync_deletions.user_id` and durable current-store
security records deliberately lack user FKs. Existing tick ownership-change
triggers record old and new owners in the logbook feed, but that alone does not
prove all offline tables, deletion records or cursors will reconcile.

## Ownership and exact mapping review

The original preview proposed fresh proof of control for every account and
fresh sign-in for retired identities. The owner subsequently approved the
specific historical consolidation policy below, without a contact campaign
or mandatory device-drain campaign. That approval replaces those original
requirements for this batch only.

Retain the exact source membership, selected survivor, preview/evidence hashes
and per-table treatment in private approval evidence. A normalized email or
similar profile is not a rule for future automatic account linking. A group
label, a deadline, or silence cannot select a survivor or authorize a new batch.
Never store passwords or provider tokens in the public plan or audit output.
Source user rows remain disabled tombstones rather than being deleted.

## Restored-database rehearsal gate

The preview is preparation for this gate, not an implementation of a merge.
Do not run a proposed merge against production to discover what it changes.

1. Restore a protected database copy into an isolated environment without live
   SMTP, provider sync, push delivery or production credentials. Apply the
   reviewed schema and compare the live reference catalog with the checkout.
2. Implement a separately reviewed, explicit mapping executor with default
   dry-run behavior, current evidence validation, bounded locking, writer/job
   fencing and atomic transactions. Reject drift and unknown constraints;
   never use blanket FK replacement or `ON CONFLICT DO NOTHING` to lose rows.
3. Rehearse each approved mapping, compare exact before/after record identities,
   ownership and totals, and exercise failure rollback, retries and stale
   sessions/jobs. Verify ticks, playlists, sessions, boards, social links,
   privacy, roles and provider login ownership against the decision record.
4. Exercise the supported mobile app's offline pending writes, account switch,
   fresh sign-in and complete incremental pull. Verify moved data becomes
   visible, old-owner access stops, and deduplication/recompute policies preserve
   climbing history. A SQL-only rehearsal cannot establish this behavior.
5. Present the exact mapping, verified rehearsal receipt, backup/restore plan
   and cutover order for owner approval before production application. Resolve
   email uniqueness and prevent new collisions through BA-02's separate gates.

Production merge approval is intentionally the final step. The original preview command remains read-only; the separate consolidation command described below provides an explicit apply path.

## Approved consolidation implementation

The owner subsequently requested full account consolidation. The repair keeps
an existing unique lowercase-email account; the seven-member exact-duplicate
exception keeps its Google-linked, sole data-holding account. This rule applies
only to the explicitly reviewed historical batch. It is not a rule permitting
future account linking by email alone.

Keep the canonical account's password, if any, and existing Google/Apple subject
links. Do not import passwords from retired accounts. Keep canonical display
fields, intersect privacy, and preserve original settings in audit evidence.
Source user rows remain disabled tombstones. Source security history does not
become canonical security history.

Eligible existing sessions should transfer automatically. Native refresh keeps
its existing response contract with optional consolidation metadata. The bridge
must recheck original expiry, source and target revocation state, generations
and retirement reason under locks. Preserve authentication age, including
unknown age. Source access JWTs do not become generic canonical authorization.
Web cookies require established revocation lineage and a response capable of
committing the canonical cookie; otherwise normal sign-in remains necessary.
Canonical reset/sign-out must also invalidate pending or transferred bridges.

A phone identity transfer advances the credential epoch and journals the
transition, fencing old HTTP, WebSocket, query and outbox completions. Preserve
pending writes while resetting server-derived caches and changing the ownership
stamp. The owner declined a mandatory device-sync campaign or separate queued
work recovery feature; this does not establish compatibility for older clients.

Exact duplicate ticks keep the canonical account's existing row where present,
otherwise the lowest numeric tick ID. Preserve upstream identity and provenance
and retain owner-scoped retired-ID aliases. Unexpected payload or upstream
identity conflicts block a group. Importers must account for user-scoped tick,
circuit and climb identities without changing their frozen hash functions.

Combine inferred sessions automatically, preserving distinct names, goals,
notes and social history with deterministic precedence and stricter privacy.
Do not use the current reconciler's destructive merge path unchanged. Keep
explicit sessions distinct; incompatible assignments block a group. Preserve
distinct playlist/climb identities, collapse duplicate relationship edges, and
never merge physical boards based only on a reused serial number.

Implementation is staged: deterministic read-only plan, durable mapping/audit
schema, explicit data handlers, session bridge and client transition, then a
protected full-database rehearsal. An unavailable handler or unknown reference
must be reported as a blocked capability, never as executable readiness.
Production application still requires the exact private plan hash and a
separate owner approval after rehearsal. Pause and drain writers for cutover;
the five-minute window is a rehearsal target. No production application is
authorized merely by building or merging this tooling.


## Operator command and deployment order

`packages/backend/src/scripts/consolidate-account-emails.ts` has separate plan
and apply invocations. It never uses the ambient `DATABASE_URL`; supply the
explicit `ACCOUNT_CONSOLIDATION_DATABASE_URL` through the operator's protected
environment. Keep credentials, exceptions, plans and receipts outside checkout.
The output directory must be private (0700); plans and evidence must be owned
regular files (0600), with no symlink traversal.

```sh
vp exec tsx packages/backend/src/scripts/consolidate-account-emails.ts \
  --plan --out /private/operator/consolidation-plan.json

vp exec tsx packages/backend/src/scripts/consolidate-account-emails.ts \
  --apply --plan-file /private/operator/consolidation-plan.json \
  --expected-plan-sha256 APPROVED_SHA256 --batch-id APPROVED_BATCH_ID \
  --out /private/operator/consolidation-receipt.jsonl
```

The plan defaults to a replica; `--allow-primary` permits a read-only primary
snapshot. The exceptional survivor requires both `--exceptions` and
`--prior-plan`; the exception binds the exact evidence hash, former plan hash,
full membership and survivor. A group label or email spelling alone cannot
select the exceptional survivor.

1. Deploy generated migration 0305 before code that consults durable aliases.
   Deploy backend, web and the supported mobile clients; enable
   `ACCOUNT_CONSOLIDATION_BRIDGE_MODE=enabled` for proof enrollment/exchange.
2. Rehearse the exact approved mappings on a protected restored copy without
   external delivery. Review archives, counts, conflicts, failure rollback,
   resume and offline client behavior. A synthetic fixture pass is not this gate.
3. For the approved cutover, establish a separate
   `boardsesh_consolidation_operator` login. All other capable database login
   roles must be NOLOGIN, and other sessions must be drained. The command only
   verifies this fence; it never changes roles or terminates connections.
4. Apply the exact private plan checksum. Each group commits atomically with
   its aliases, queued jobs and audit. Drift, unsupported references or domain
   conflicts roll back that group. Reuse the batch ID and original plan to
   resume, with a new receipt path. Completed groups are not applied twice.
5. Verify the private final receipt, group audits and queued provider/statistics
   work before restoring ordinary writer access. The five-minute limit is a
   stop boundary; partial completion requires inspection and deliberate resume.

Before deploying admission and security writers, provision their existing
PostgreSQL roles explicitly: admission readers need SELECT on
`account_consolidation_members` and `account_consolidation_session_proofs`;
credential/security writers need SELECT and UPDATE on both, plus their existing
`mobile_refresh_tokens` permissions. The guarded web enrollment service also
needs INSERT on session proofs. Tick writers need SELECT, INSERT and UPDATE on
tick/import aliases and SELECT on members; session reconciliation needs the
corresponding session-alias permissions. These grants remain necessary when
new exchanges are disabled. Use the reviewed role-provisioning procedure;
do not grant roles ownership, DDL rights or unrestricted schema access.

Once applied, data aliases and session revocations remain authoritative even
when automatic session exchange is disabled. Disabling the bridge does not
undo account consolidation. Source user rows remain disabled; restoring a
pre-cutover backup requires a coordinated full rollback, not deleting mappings.
Archive originals before any production run. The preimage files intentionally
exclude credential secrets; they are not a replacement for a protected database
backup.

Native refresh preserves single-use rotation: a lost response can require
normal sign-in. Web sessions without previously enrolled revocation lineage
require sign-in. Transferred cookies retain original issuance, expiry and
known authentication time. Older clients may still invoke their ordinary
account-switch behavior; the supported updated clients journal the transition,
preserve pending mutations, reset derived caches and resume under the canonical
owner. The owner accepted this older-client residual risk without a mandatory
device-sync campaign.

Retired tick UUIDs remain save aliases after session exchange is disabled. A
stale create returns the canonical event; it cannot recreate a deleted event.
An edit or delete addressed to a retired UUID returns `CONFLICT` when the
canonical event changed after the merge, preserving the newer edit. The app's
existing outbox failure handling retains that rejected operation for review.
Editing the canonical UUID directly continues through the normal ownership
checks. Source authentication credentials never gain access through a data alias.

Retired inferred session addresses route only for their canonical owner. Old full-session edits return a conflict to protect combined notes. Later inferred merges retarget aliases transactionally; emptied sessions leave tombstones. If an aliased inferred session would merge into an explicit session, reconciliation refuses the operation and its surrounding tick mutation rolls back. This preserves history until that unsupported merge has an explicit metadata and social-reference policy.

Ordinary reconciliation also refuses to discard any aliased session with a title, goal, notes, edits, social history, privacy rules, or attached session resources. Empty aliased inferred sessions can still retarget or become tombstones. Rejected reconciliation rolls back the surrounding tick write.
