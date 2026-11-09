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
or email field, 1,000 users per page, and a 30-second scan budget (a real run
over 9,788 users took 16 seconds). Oversized fields are capped in SQL before
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
