# Development identity seed targets

This is a bounded writer-admission follow-up for [BA-03 #6977](https://github.com/boardsesh/boardsesh/issues/6977) and [epic #6975](https://github.com/boardsesh/boardsesh/issues/6975), following [deleted-account readers #7316](https://github.com/boardsesh/boardsesh/pull/7316). It does not complete either issue or activate Better Auth.

## Decision and scope

The development image's `create-test-user` and `seed-social` entry points create authentication users, profiles and, for the test account, credentials directly. They are development fixture tools. Their configured URL resolver also accepts remote URLs; its existing Vercel/local check is not a prohibition on production seeding.

These two entry points need a development-target check immediately after URL resolution, before reporting a target, constructing a database client or starting seed work. They receive no remote override. General migration/import tooling and the shared development-host classifier keep their existing contracts. The image's explicit local PostgreSQL target must remain supported.

The target check must follow the installed PostgreSQL driver's routing behavior, including decoded authorities and startup/environment overrides. Parsing a URL and recognizing its displayed hostname alone is insufficient. Unsupported or ambiguous routes fail with a fixed error that does not include the URL, credentials or a secret-bearing cause. Target diagnostics use the existing safe host formatter.

The shared classifier retains its existing IPv6 loopback classification. These seed entry points reject bracketed IPv6 URLs because the installed driver parses that form into an unsupported route. They also reject noncanonical dotted IPv4 spellings and startup query overrides. Docker's explicit `localhost/main` target, ordinary loopback IPv4 and the existing Tailscale development host forms remain supported.

This is a tool-entry-point guard. Development host classification does not establish the physical database behind a tunnel or prove that deployed roles prevent direct writes. Backend writer ownership, old-binary fencing, exceptional collision resolution and the recorded cutover/reconciliation boundary remain required before any additive credential copy. This change performs no production grants, backfill, account merge/deletion or authority activation.

## Qualification boundary

Qualification must exercise the real negative CLI entry points as well as adversarial driver-routing inputs, without running seed or cleanup operations against an existing database. The development image build provides the positive whole-script path against its newly created fixture. Source and tests require independent review and re-review of fixes. Completed local and current-head CI evidence will be recorded after the source is frozen.

The focused Node selection passes all 40 reported cases with zero failures or skips in 10.07 seconds. Eight negative CLI subcases execute the actual entry points with PostgreSQL-constructor and unexpected-socket sentinels, so a target-guard regression cannot reach a database. The static PostgreSQL image-input contract also passes. Completed owned launchers observe actual child closure, drained processes and unchanged source fingerprints. These focused results precede final combined canonical checks and CI.

The first focused attempt reports 30 passes and ten failures, including two parent totals: the socket sentinel counted the installed `tsx` loader's expected local IPC pipe. The fixture now permits only the exact current-parent pipe, without a host or port, and still rejects PostgreSQL client construction and every other socket. Independent review rechecks that exception against installed loader source. Product behavior and fixture contents remain unchanged by that test correction; the failed run is retained.

After adopting the reader-recovery prerequisite `5407c6fdf6`, the combined selection again passes all 40 cases with zero failures or skips in 11.92 seconds; this repeats the same cases. The static image-input contract passes. Repository checking reports zero errors and 623 existing warnings across 9,268 files in 71.8 seconds. All 59 canonical type tasks are satisfied from cache; none is re-executed in this run. All four owned launchers confirm actual child closure, drained processes and unchanged source fingerprints. The separate frozen Expo web lint/type dependency install also passes without changing the lockfiles.

The user's password decision remains unchanged: authenticated set/change preserves the proven requesting device and original authentication age while revoking other credentials; forgotten reset revokes every session. Development fixture seeding does not establish device lineage, fresh authentication or mailbox ownership. Canonical lineage and the remaining writer gates remain separate work.
