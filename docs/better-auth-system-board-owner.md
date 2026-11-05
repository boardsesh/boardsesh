# BA-03 shared-board system identity

Implementation slice for [BA-03 #6977](https://github.com/boardsesh/boardsesh/issues/6977)
in [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975). The epic and
BA-03 remain incomplete. This slice builds on the web OAuth identity delegation
in [#7300](https://github.com/boardsesh/boardsesh/pull/7300).

## Mounted writer and selector

The existing `resolveBoardForConfig` GraphQL resolver creates a hidden shared
feed for a recognized board configuration. Its owner is the existing fixed
`00000000-0000-0000-0000-000000000000` user at `system@boardsesh.com`.
Previously its helper inserted that user directly with conflict-ignore behavior.

`CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE` independently selects `legacy` (the
default, including an unset or empty variable) or `reserved-staging`. The latter
calls `ensureReservedSystemBoardOwner(database, authority)`. It takes no caller
UID, email, provider assertion, password or session. Its fixed constants live in
the pure database constants entry; existing board-owner and serial-dedupe ID
exports retain exactly their old values.

Staging requires the existing projection ID, writer epoch and supported email
normalizer. Invalid mode/configuration, unsafe SQL logging, missing/stale
authority and SQL failure return the fixed GraphQL `SERVICE_UNAVAILABLE` error.
There is one fixed diagnostic category, without raw errors or identity material.
Enabled failures never invoke the old insert.

Existing-feed lookup still runs first, including anonymous reads. Anonymous
create-on-miss denial and catalog validation precede any identity command.
Board insertion, field defaults, slug race handling and membership publication
keep their existing order and contracts. Only the fixed owner is adopted here.

## Ownership state table

The command captures trusted authority before its first asynchronous boundary.
One READ COMMITTED transaction applies the existing five-second statement and
four-second lock timeouts, then locks the enforced manifest, fixed subject
cutoff, reservations and existing user. Authentication-artifact and membership
queries are read-only. It uses the primary database and Drizzle.

| Observed state | Result |
| --- | --- |
| Fixed UID and target reservation both absent; no cutoff or historical ownership/membership | Create user, reservation and sole membership together |
| Existing fixed UID; accepted normalized email; current owned reservation and sole matching member | Reuse without changing any stored field |
| User without reservation, or reservation without user | Reject; no repair or resurrection |
| Foreign, blocked, stale-basis or malformed reservation/membership | Reject; preserve evidence |
| Deleted subject cutoff | Reject even if a user row exists |
| Any retained cutoff while the user is absent | Reject historical identity recreation |
| Fixed UID owns or historically belongs to another normalized key | Reject; no address reassignment |
| Any password, provider account, session or mobile refresh row for the fixed UID | Reject; retain unexpected authentication history |

New creation writes only the user, reservation and membership. It does not add a
profile, verified address, password, provider link, session, refresh token,
cutoff or security event. Existing names, raw email representation, images,
verification/creation/update timestamps, profiles and a nondeleted cutoff stay
unchanged. Trim/case-equivalent existing email spelling is accepted only with
the complete matching ownership pair.

The new user insert is plain, with no conflict-ignore or compensation. A late
competing UID insert or SQL denial aborts the transaction and reservation.
After a completed commit whose caller loses its acknowledgement, another ensure
validates the same complete identity without rewriting it. Later board or
membership-publication failure retains the already committed identity, as the
previous separate owner transaction did.

## Decisions and limits

These are agent implementation decisions for conservative staging, not new
permanent account policy: incomplete pairs and any retained authentication or
other-address history require explicit review instead of automatic repair.
Expired/revoked session rows also count as unexpected history. Profiles and
content alone are allowed and preserved. No data merge, deletion, reassignment,
production preparation, activation, migration or grant change is performed.

This is a backend authority role, not the restricted database-job writer. The
Drizzle insert uses the ordinary users-table INSERT permissions; it does not
promise a three-column INSERT grant. Row locks require UPDATE privileges on the
locked tables. Credential, provider, session, refresh and membership evidence
queries do not require UPDATE privileges.

The software selector and enforced manifest are **not a deployed database role
fence**. The exact raw-email sanity check can detect an exact row omitted from
the projection; it cannot exclude an unfenced case-variant writer after
projection. Current projection/collision provenance, all-writer fencing,
nonhuman authentication denial and real deployed grants remain activation
gates. Email ownership alone does not establish that nobody can sign in as a
system UID. This helper issues no credential or authentication proof.

Recommendation/classifier jobs remain separate work. Their existing attempt
fence locks the job ledger during data transactions; adding a remote ensure
inside that transaction could bypass or deadlock the attempt contract. Their
eventual fixed machine protocol needs its own authorization and attempt fence.

The user's password decision remains unchanged: authenticated set/change retains
the requesting device and its original proven authentication age while revoking
others; forgotten-password reset revokes every session. This slice does not
adopt that policy or prove validator enforcement.

## Qualification ledger

Before implementation, a fresh worktree was created from main
`c2e1f09c6b179bc05cbcb9a50f7e27d6adb0dffa`, then the published prerequisite
`d1a26add39dfd238c5ef32fa91993003af86697b` was merged without conflicts. The
plan was saved before code changes. Dependencies were installed from the pinned
lock with `vp install --frozen-lockfile --offline`; the lock stayed unchanged.

Independent review approved the fixed-state matrix, six production files and
the isolated QA runner. Its actionable request to remove unnecessary artifact
and membership row locks was implemented and independently re-reviewed.

The first owned PostgreSQL 18 run passed 44 of 45 cases. The failure was fixture
setup removing a parent reservation before its restricted membership. That
fixture order was corrected without changing product behavior or weakening an
assertion. Additional authority-capture and actual old-snapshot isolation cases
raised the selection to **47 cases across two files**, all passing on PostgreSQL
18 in **11.16 seconds**. Backend type checking passed before those two additions;
the full canonical typecheck graph subsequently passed **59 tasks with zero
cache hits**. Independent review then isolated the stored-email fixture from
other-key history and asserted each registration-race caller's outcome. Four
additional cases isolate foreign/blocked reservations on an existing fixed UID.
That **51-case** selection passed on PostgreSQL 18 (**19.24 seconds**) and
independently on PostgreSQL 15 (**12.91 seconds**). The existing board-catalog
and board-presence suites passed **187/187 cases across two files** on PostgreSQL
18 (**36.19 seconds**).

Whole checking initially passed with zero errors and 629 warnings; six belonged
to the new test fixtures. A typed stable publication spy and equivalent string
prefix check removed those six warnings and were independently reviewed. The
final **51/51** selection passed again on PostgreSQL 18 (**14.25 seconds**) and
independently on PostgreSQL 15 (**12.12 seconds**). Final whole checking passes
with **zero errors and 623 existing warnings across 9,235 linted files**;
all 9,766 formatted files pass. The narrowed backend typecheck passed again
after these final fixture edits. These later edits change tests only; the
independently approved production helper remains unchanged.

The complete current-store/native-auth regression selection passes **606/606
cases across 26 files** on PostgreSQL 18 (**384.57 seconds**). It overlaps the
39-case new core selection; the 12 new resolver cases run in the separate pair.
These counts are not added into an inflated total. No schema changes or new
migration are introduced by this slice.

The tests cover the actual `resolveBoardForConfig` resolver with real database
operations; membership publication alone is substituted in the new consumer
selection. They prove anonymous/catalog guards, legacy-default behavior,
staged failure privacy/no fallback, same/different configuration races and
retained identity after a later publication failure. The core selection uses a
real restricted LOGIN role: denied users INSERT produces PostgreSQL `42501` and
rolls back the already attempted reservation; credentials UPDATE is denied.
Existing board regressions use their original fixtures and assertions.

The repeated-ensure case runs again after an observed successful commit. It
proves idempotent state validation; no dropped transport response is injected.
Resolver context is synthetic validated fixture context, not a public HTTP
authentication or real-device proof. Races use concurrent PostgreSQL
transactions in one test process, not independent deployed backend instances.

All database work is against newly salted owned local worker fixtures. Provider
keys, outbound mail, external application origins and telemetry are disabled.
No installed-device, physical board, real provider, production role or rollback
claim follows from these tests. Overlapping selections are reported separately.
