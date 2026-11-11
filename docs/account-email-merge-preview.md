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

## Approved one-off repair

The owner approved full consolidation for this historical batch, with fresh
sign-in for retired source accounts. The repair keeps the unique existing
lowercase-email account. The seven-member exception keeps its explicitly
approved Google-linked, sole data-holding account; approval binds exact prior
evidence, membership and survivor. This is not future linking by email.

Keep the retained account's password, display profile and existing sessions.
Move approved Google/Apple subjects without importing source passwords. Retire
source credentials, refresh tokens, sessions, recovery tokens and notification
devices, and mark source subjects deleted in the existing cutoff authority.
Keep source user rows as disabled tombstones. Source devices use ordinary
fresh sign-in and account-boundary behavior; this repair does not transfer
sessions or promise preservation of unsynced device queues. The owner declined
a mandatory device-drain campaign. Review that limitation before cutover.

Keep one exact duplicate tick with provider identities/provenance preserved.
Unexpected payload or upstream identity conflicts block the group. Preserve
inferred session names, goals, notes and social history with deterministic
precedence; explicit sessions stay distinct. Intersect effective privacy,
using owner-only visibility where the original audiences cannot be represented.
Preserve distinct playlists/climbs and never infer physical-board identity from
serial alone. Unsupported references or conflicting assignments abort.

The repair is an operator CLI. No GraphQL mutation or REST endpoint starts a
merge, and there is no automatic session handoff or client ownership migration.
The small importer compatibility patch must recognize former user-scoped keys:
re-importing an old export must not recreate moved climbs/playlists. Frozen
hash functions stay unchanged, exact aliases select existing identities, and
ambiguous matches fail instead of choosing by name.

## Operator command and deployment order

`packages/backend/src/scripts/consolidate-account-emails.ts` separates plan
and apply. Supply `ACCOUNT_CONSOLIDATION_DATABASE_URL` through a protected
operator environment; the tool never uses ambient `DATABASE_URL`. Store plans,
approvals, archives and JSONL receipts outside checkout in an owned private
0700 directory; input files must be owned regular 0600 files, not symlinks.

```sh
vp exec tsx packages/backend/src/scripts/consolidate-account-emails.ts \
  --plan --out /private/operator/consolidation-plan.json

vp exec tsx packages/backend/src/scripts/consolidate-account-emails.ts \
  --apply --plan-file /private/operator/consolidation-plan.json \
  --expected-plan-sha256 APPROVED_SHA256 --batch-id APPROVED_BATCH_ID \
  --out /private/operator/consolidation-receipt.jsonl
```

Planning defaults to a replica; `--allow-primary` permits a read-only primary
snapshot. Exceptional survivor selection requires `--exceptions` and
`--prior-plan`; a group label alone grants no authority. The fresh-sign-in
policy is version 2; earlier automatic-transfer plans cannot be applied.

1. Install the reviewed metadata schema and importer compatibility patch before
   the repair. The one-off CLI can run from its reviewed checkout; it is not a
   running service and does not require a new worker family.
2. Rehearse exact approved mappings on a protected restored copy without live
   provider/push/email delivery. Compare archives, ownership, privacy, counts,
   failure rollback, multi-group execution and resume. A synthetic fixture is
   not the exact protected-copy gate. Confirm retained login and source denial.
3. Pause and drain writers. The dedicated login must be
   `boardsesh_consolidation_operator`; every other capable login must be
   NOLOGIN and other primary sessions must be drained. The command verifies
   this fence and never changes roles or terminates connections.
4. Apply the exact approved plan checksum. Six explicit handlers, aliases,
   existing-family provider jobs and group audit commit atomically. Drift or
   unsupported conflicts roll back the affected group. Reuse plan/batch IDs
   with a new receipt path to resume; completed groups are not applied twice.
5. Verify the private final receipt and queued provider work before restoring
   writers. The five-minute limit stops further groups and requires inspection.
   The final global percentile refresh is derived work after all groups;
   individual group fingerprints describe their earlier commit boundary.

Importer readers need SELECT on membership/import/tick-alias metadata. The
operator needs the explicit repair privileges. No proof enrollment, session
exchange endpoint, new mobile release or auth-service grant expansion is part
of this fresh-sign-in repair. Retain applied import identities after the CLI
is archived; disabling importer provenance can recreate duplicates.

Private preimages exclude credential secrets and do not replace a protected
full database backup. Source devices must sign in again with the retained
account's password, provider login or normal recovery. Canonical sessions are
unchanged. No production application is authorized by creating or merging this
code: exact protected-copy rehearsal and separate cutover approval remain
required.
