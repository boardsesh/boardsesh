# Account email audit

This command measures the current account email store without changing it. It
supports the fresh collision evidence required by #4847 and #6975. It does not
resolve account ownership, import credentials, prepare reservations, enforce
uniqueness or activate Better Auth. No production audit was run to develop it.

## Run the audit

1. Supply `ACCOUNT_EMAIL_AUDIT_DATABASE_URL` through your normal secret manager.
   Use a direct primary PostgreSQL connection and a role with SELECT access to
   `public.users`, `public.user_credentials` and `public.accounts`. A dedicated
   role without write privileges provides an additional operational boundary.
   If RLS is enabled, the approved audit role must see the entire store; a
   policy-restricted view is rejected rather than treated as complete.
2. Leave `DEBUG_SQL` disabled. The command does not load dotenv files, use an
   application database singleton, or fall back to `DATABASE_URL`, `DB_URL`,
   `POSTGRES_URL` or ambient `PG*` connection fields.
3. Run the summary command, optionally requesting a private detail file:

   ```sh
   vp exec tsx packages/backend/src/scripts/audit-account-emails.ts
   vp exec tsx packages/backend/src/scripts/audit-account-emails.ts --details-file /secure/audit-details.json
   ```

4. Accept a report only when the process exits zero and stdout contains
   `status: "complete"`, `connectionClosed: true`, `reachedEof: true` and
   `countReconciled: true`. Match any detail file's bytes to the summary SHA-256
   and its `auditId`. Keep private details out of issues, CI logs and chat.
5. Record the timestamp, target fingerprint, normalizer version and counts with
   the migration review. Re-run for fresh evidence after writers change. A
   successful snapshot is an observation, not a deployed writer fence.

The command accepts only `--details-file`; it has no apply, merge, normalize or
delete mode. It never takes a database URL in command arguments. DNS names and
IPv4 are supported; bracketed IPv6 URIs are rejected deliberately. Remote
connections require certificate verification. The sole optional URL query is
`sslmode=verify-full`, or `sslmode=disable` for `localhost`/`127.0.0.1`; other
startup options and repeated parameters are rejected. Localhost and 127.0.0.1
default to plaintext for local fixtures. All other targets default to verified
TLS. Configure the normal Node CA trust when a private certificate authority is
needed; the command does not weaken certificate checks.

## What the report means

Normalization is exactly JavaScript `email.trim().toLowerCase()`, version
`js-trim-lower-v1`. Dots, plus suffixes, `%` and `_` remain literal. SQL `lower`,
database collation and provider aliases do not replace that policy. The pure
normalizer is byte-identical to the already reviewed migration-stack primitive
at the same backend path; this independently based tool does not claim that
the unmerged writer rollout already exists on main.

| Count | Meaning |
| --- | --- |
| `totalUsers` / `normalizedKeyCount` | Every visible user / distinct normalized address, including the empty key. |
| `exactDuplicateKeyCount` | Distinct raw stored email strings belonging to multiple user IDs. |
| `normalizedCollisionKeyCount` / `usersInCollisionGroups` | Normalized keys with multiple user IDs / their members, including plural empty-key groups. |
| `whitespaceUsers` / `nonNormalizedUsers` | Stored text differs from JS trimming / from the full normalization rule. |
| `emptyEmailUsers` | Normalized address is empty; this is not a general email syntax validator. |
| `verifiedUsers` / `passwordUsers` | A verification timestamp exists / a credential row exists. |
| `providerLinkedUsers` / `providerLinks` | Users with provider rows / their total provider-row count. |
| `usersWithoutLoginMethod` | Neither a password row nor a provider row exists in this snapshot. |

Verification and method presence do not establish verified ownership or prove
that a particular sign-in works. Provider subjects, tokens, hashes, names and
profile/product data are never selected. The private detail contains only
collision/empty-key groups, immutable UIDs, raw and normalized email evidence,
verification timestamp and method-presence counts. A group has no selected
winner. Product relationships, historical/deleted reservations, provider
provenance, recovery history and offline account boundaries require their own
review before any exceptional resolution.

## Consistency, limits and failures

All reads share one observed `REPEATABLE READ READ ONLY` transaction against
the primary. The command explicitly qualifies public tables, pages by the
unique user ID, reaches an actual empty page and reconciles its row count with
same-snapshot counts. It rejects recovery replicas and sets `row_security=off`:
PostgreSQL rejects a restricted role whose policies would otherwise hide rows,
rather than reporting that partial view as the complete store.
Function and aggregate lookup is pinned to `pg_catalog` for the transaction.
Concurrent committed changes appear in the next run.
No table write lock is requested. A long snapshot can still delay vacuum
cleanup, so run it with the recorded limits and ordinary operational care.

**Do not run the audit during a deploy.** The transaction holds `ACCESS SHARE`
on `users`, `user_credentials` and `accounts` for its whole scan, and the
migration runner sets no `lock_timeout`. A deploy's `ALTER TABLE users` would
queue behind the audit, and every later query on `users` would queue behind that
`ALTER`, which stalls sign-in and every users read until the audit ends.

Limits are 100,000 users/keys, 64 MiB of retained text, 4,096 bytes per identity
or email field, 1,000 users per page, and a 30-second scan budget. A real run
over 9,788 users took 16 seconds, so expect the budget to bind at around 18,000
users, where the audit fails with `TIME_LIMIT` rather than reporting part of the store. Oversized fields are capped in SQL before
driver allocation. Statements have a five-second timeout and lock waits a
one-second timeout; an in-flight statement must settle before cleanup, and a
result exceeding the scan budget is rejected.
Private output is streamed in bounded member chunks and stops at 16 MiB.
The scan budget includes awaiting the actual read transaction's COMMIT. Client
work that remains pending at the deadline is interrupted by ending the CLI's
dedicated read-only client with a one-second force-close bound. The actual
driver operation and end promise are awaited. `connectionClosed: true` means the
driver's `end()` settled: normally after the socket closed, or after its
five-second force-close bound, which cannot change a read-only report. An
incomplete standalone command flushes its fixed failure record and exits; it
cannot be held open by a half-closed connection.
PostgreSQL's statement timeout also bounds remaining read-only server work.
Private-file output happens after that connection is closed and is bounded by
the output-size cap.

Summary stdout contains counts, limits and noncredential provenance only. The
target fingerprint hashes observed database/address/port, never a DSN,
username or password. A private detail file is created exclusively with mode
0600, flushed and closed; an existing path is never overwritten. Its format is
`detail-only`: only the final complete summary binds it. An interrupted or
failed file may remain for diagnosis and is not completion evidence.

Missing configuration, unavailable authority, denied reads, invalid rows,
resource limits and output/cleanup errors exit nonzero with `status:
"incomplete"` and a fixed category. They emit no partial aggregate as a complete
result and never print the underlying SQL, URL or exception. Preserve failed
artifacts; fix the cause and use a new report path for the next run.

## Evidence report for shared addresses (BA-02)

`account-email-evidence.ts` turns the audit's collision groups into the private
worksheet the owner uses to pick keepers and send contact emails. It is
read-only and has no apply mode. Run it on the DR standby, so its per-table
counts put no load on the primary:

```sh
mkdir -p -m 700 ~/Private/boardsesh-ba02
ACCOUNT_EMAIL_EVIDENCE_DATABASE_URL='postgresql://<role>@<standby-host>/boardsesh?sslmode=verify-full' \
  vp exec tsx packages/backend/src/scripts/account-email-evidence.ts \
  --out ~/Private/boardsesh-ba02/evidence-$(date +%F).json
```

- **Connection.** Only `ACCOUNT_EMAIL_EVIDENCE_DATABASE_URL`, with the same URL
  rules as the audit above. It never reads `DATABASE_URL`, takes no URL argument
  and refuses `DEBUG_SQL=true`. A primary is refused with `PRIMARY_NOT_ALLOWED`
  unless you add `--allow-primary`.
- **Snapshot.** One `REPEATABLE READ READ ONLY` transaction, 60 s per statement,
  15 minutes per run. The worksheet is written only after that snapshot was
  confirmed read-only and the connection is closed. A standby replay conflict
  ends the run with `STANDBY_CONFLICT` and a lock held for 5 s with
  `LOCK_TIMEOUT`; rerun either.
- **No IDs or addresses on the wire.** Every statement works out the
  shared-address members itself, from a subquery that groups by the JS trim
  and lowercase rule. Every bind parameter is a number from the code, so a
  server that logs slow or all statements records no user ID or address. If
  that SQL grouping and the JS normalizer find different members, the run stops
  with `GROUPING_MISMATCH`.
- **Tables.** Every foreign key to `users(id)` is read from the live catalog, so
  a new table counts without a code change. Partitions are counted once through
  their parent. References without a foreign key are not seen. Unlike the
  audit's q2 query, which skipped unindexed columns on tables of 256 MB or more,
  every column is scanned.
- **Runtime.** Expect 10 s to 2 minutes on the standby. About 100 statements
  each take tens of milliseconds. Each unindexed column on a large table adds
  one sequential scan, roughly 5 s per GB from a cold cache. One scan above about
  10 GB hits the 60 s statement timeout and ends the run with `TIME_LIMIT`.
- **Own data.** A member has data when any of their rows sits in a referencing
  column, with three exceptions:
  - identity housekeeping: profile, credentials, provider links, tokens,
    sessions, devices, `auth_*` and `oauth_*`;
  - `user_climb_percentiles`, which is computed for everyone;
  - rows other people caused: feed and notification recipient, follows
    received, follow requests received, community roles granted
    (`community_roles.user_id`), and pending invites from someone else
    (`resource_grants` rows that are `pending` with another user as
    `invited_by`).

  Analytics activity days count as own data. Excluded rows still appear in the
  worksheet as `excludedRows`.
- **Kinds.** A: two or more members have data, so the address gets the contact
  email. B: the only data holder is unstamped and an empty member is stamped; a
  bare stamp is not proof, so B follows the C/D rule with no email. C: one data
  holder, the rest have no live provider link or token. D: one data holder, an
  empty member still has a Google/Apple link or a live refresh token. E: nobody
  has data. Facebook-only links count as no login method.
- **Output.** The worksheet holds addresses, names, user IDs, the proposal per
  group and the contact list. It is created with mode 0600 and never overwritten.
  It must go in a folder you own with mode 0700, and is refused if that folder
  or any parent holds `.git`. That covers this checkout, a sibling worktree and
  any other repository. A failed write removes the partial file, so a rerun can
  use the same path. Stdout holds counts only, plus the worksheet's SHA-256.

Accept a run when stdout shows `status: "complete"` and all three `checks` are
`true`: kinds sum to the group count, SQL `lower()` agrees with the JS rule on
every row, and the rows without a login method are exactly the three fixed
system accounts. A `false` check means stop and report the counts, never the
worksheet.

If the run hits `TIME_LIMIT`, list the unindexed foreign-key columns by table
size first (the audit's Q0 query). The largest unindexed one is the likely
cause. Rerun when the standby is quiet, or report that column's name.

If the kind counts differ from the audit's (A 17, B 3, C 5, D 5), two changes
explain it:

1. This report scans the large unindexed columns that q2 skipped. A member whose
   only data sits there moves from C or D to A. Compare
   `catalog.unindexedColumns` with Q0's list.
2. It excludes three kinds of received rows that q2 counted. A member whose only
   data was one of them moves from A to B, C or D.

Report the counts by kind, never the worksheet.
