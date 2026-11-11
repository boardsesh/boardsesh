# Private account email resolution (BA-02 PR 4)

The owner runbook is [issue #7430](https://github.com/boardsesh/boardsesh/issues/7430).
It is the single list of production actions. This document describes the file
format and guarantees; it does not authorize production changes.

`resolve-account-emails.ts` uses only `ACCOUNT_EMAIL_RESOLVE_DATABASE_URL`. It
never falls back to application credentials. `--confirm-host` must exactly match
the explicit URL's hostname. Remote connections require certificate verification;
local synthetic rehearsals may use loopback without TLS. SQL debugging is refused.

## Private files

Evidence, decisions and plans stay outside Git repositories in an owner-owned
0700 directory. Every input is an owner-owned regular 0600 file; symlinks are
refused. Plan output is created exclusively with 0600 permissions and is never
overwritten. The CLI prints counts and a SHA-256, and fixed error codes only.

The evidence input is PR 3's unchanged worksheet. A decision file has this shape
(the group/member labels are examples, not selected owners):

```json
{
  "formatVersion": 1,
  "evidenceSha256": "<SHA-256 of the exact evidence file bytes>",
  "normalizeStandalone": true,
  "groups": [
    {"group": "G01", "keeper": "A", "evidenceKind": "mailbox-reply"}
  ]
}
```

Each group has an explicit keeper. Unselected groups stay untouched and their
count is reported. Allowed evidence kinds are `owner-knows`, `batch-approved`,
`mailbox-reply`, and `no-reply-14-days`. Kind A cannot be batch-approved. The
no-reply choice also needs an ISO `contactedAt` at least 14 days before planning,
and must select the worksheet's unambiguous most recently active member. Tied or
unknown activity needs another explicit decision. The tool never promotes the
worksheet's proposal to a decision.

## Plan and apply contract

Plan mode is the default, or explicit `--plan`. Its required flags are
`--evidence`, `--decisions`, `--plan-file`, and `--confirm-host`. It uses one
repeatable-read read-only snapshot. The private plan includes each member's
before/after address, opaque group labels, evidence/decision digests, a target
fingerprint and a fresh batch identifier. The SHA-256 covers the exact saved
bytes, including the newline.

Apply mode takes `--apply --plan-file --plan-sha256 --confirm-host`. It validates
the file and exact digest before opening a database connection. A plan cannot
be applied to another host/database. Each ready group is a separate transaction;
completed groups survive an interruption and are skipped on an exact-plan retry.
A fresh plan is needed after a deferral expires or a decision changes.

`--swap-keeper G01` is a plan-only flag. The owner updates that group's keeper
in a new private decisions file, uses the same evidence file, and creates a new
plan file. It requires a prior resolution record and checks the current group
still has exactly one keeper with the expected retired siblings. The former
keeper is retired before the new keeper receives the address, so the swap works
after the unique index is present. It preserves every account and login method.

## Transaction and delivery guarantees

Apply takes the shared authority gate, sorted email advisory keys, sorted users
row locks, then reservation locks. Changed/missing members or newly joined
members are skipped. Live legacy email-keyed reset or verification links defer
the entire group. Legacy forgot/resend issuance now locks its original users row
and rechecks the stored address before saving a token: issuance either commits
first and resolution sees its link, or resolution commits first and issuance
abandons the stale address without sending mail.

Only `users.email`, `users.updated_at`, reservation bookkeeping and the resolution
log change. A retired address is an opaque placeholder under
`retired.boardsesh.invalid`. Password bytes, provider subjects, refresh tokens,
security generations and product data are untouched. A prepared/enforced
reservation projection is reconciled in the same transaction, including keeper
swaps. Backend and shared web mail transports reject `.invalid` recipients
before SMTP.

`auth_email_resolution_log` stores batch, opaque group reference, user ID, action,
evidence kind and time. It has no email column and no foreign key to users.
Nothing about merging this PR applies a resolution; the generated migration only
adds that empty table and its index.

Legacy account creation must be deployed with BA-02 PR 2 before resolution. Its
case-insensitive existing-account check prevents creation against these occupied
addresses. The final audit and unique-index build remain required: until the
index exists, two simultaneous registrations of a previously unused address can
still create a new collision. No staged writer mode is activated by this tool.
