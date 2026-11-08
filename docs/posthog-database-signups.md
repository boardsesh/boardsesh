# Database signup reporting in PostHog

The acquisition dashboard uses database account creation dates for total signups.
Client `Signup Completed` events remain a separate tracking diagnostic: analytics
consent, app versions and historical capture gaps limit their coverage.

## Reporting contract

`posthog_reporting.daily_signups` contains two columns:

- `day`: `public.users.created_at` cast to a date. The source column is a
  timestamp without time zone containing UTC, so the cast is independent of the
  connection's time zone.
- `signups`: the number of accounts created on that day, including accounts
  without analytics consent. No account IDs, email addresses or individual
  timestamps leave the database.

The view counts all current `users` rows, matching the signup population in
`/admin/retention`. Weekly totals sum daily counts into Monday–Sunday UTC weeks.
The current day and week are incomplete. Full refreshes reflect deleted accounts;
these are current-state signup counts, not an immutable account-creation ledger.

This aggregate does not recover campaign attribution or permit person-level
joins with PostHog events.

## Database access

The dedicated `posthog_ingest` login has no superuser, role creation, database
creation, replication or row-security bypass privileges. Its password and public
CA certificate live in the Boardsesh 1Password vault's **PostHog ingestion —
Boardsesh production** item, not in this repository.

Apply the generated reporting-view migration as the migration owner, then grant
the ingestion login access to the aggregate:

```sql
GRANT USAGE ON SCHEMA posthog_reporting TO posthog_ingest;
GRANT SELECT ON posthog_reporting.daily_signups TO posthog_ingest;
REVOKE SELECT (created_at) ON public.users FROM posthog_ingest;
```

Keep the view's default owner-rights behavior. `security_invoker = true` would
require granting the ingestion login access to the underlying account table.
Do not grant account-table access to work around connector permission errors.

The connection uses verified TLS with the database's private CA and its
certificate-matching hostname. Client certificates and SSH tunneling are not
required. Rotate credentials through 1Password and PostHog's secure connection
form without printing passwords in logs or chat.

## PostHog configuration

Project: `412845`. Production source: `01a1bc5e-f2e2-0000-76cc-ce74bfcb29f4`.
The warehouse prefix is `boardsesh_prod`; the connection schema is
`posthog_reporting`. Enable only `daily_signups`, with a full refresh every
24 hours. Keep automatic syncing of newly discovered tables off.

The connector's initial `public.users` timestamp-only import failed with
`permission denied for table users` despite column selection. That table must
stay disabled. The aggregate view supplies the table-level read access the
connector needs without exposing individual accounts.

After each connection or schema change:

1. Confirm that only the aggregate view is enabled.
2. Confirm that the latest full refresh completed and contains only `day` and
   `signups`, apart from connector bookkeeping columns.
3. Compare completed UTC weeks against the database retention dashboard at the
   same observation time. Check the source refresh time before investigating a
   mismatch.

The central dashboard is [Acquisition, Signups and Campaigns](https://us.posthog.com/project/412845/dashboard/2320854).
Database signup metric proposals still require human approval in PostHog's
Data Catalog before they are governed definitions.
