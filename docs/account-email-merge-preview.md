# Account consolidation preview

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

A normalized email, equal display name, verification timestamp, historical
provider link or recent activity is not sufficient evidence that one person
controls both accounts. A contact email can start support recovery; it cannot
by itself authorize moving another account's data. No deadline automatically
converts silence into merge consent.

Before authorizing a group, retain a private decision record bound to the
preview checksum and snapshot. It must name every source UID and the explicitly
chosen surviving UID, the ownership evidence for each account, consent and
reviewer, and the exact per-table treatment. Obtain fresh authenticated control
of each account through its existing login method or the separately reviewed
recovery procedure. Store references to that evidence, never passwords or
provider tokens, in the decision record. Groups that cannot establish control
remain separate and unresolved for consolidation.

Choose one surviving password identity explicitly; do not accept every former
password as a password for the combined account. Preserve approved provider
subjects without treating a shared provider email as proof. Profile/privacy,
board-service identities, relationships, grants and privileges need explicit
conflict decisions. Keep the original UID mapping and provenance for audit.

Existing sessions must never silently authenticate as the survivor. Specify
revocation and fresh sign-in for source accounts, and how their devices drain
or retain unsynced work before any identity change. Current offline ownership
stamps deliberately reject another user's cache; changing server-side IDs alone
cannot migrate those queues safely. Do not delete source accounts as cleanup.

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

Production merge approval is intentionally the final step. This tool has no
apply mode, decision-file consumer, authentication redirect or production data
writer.
