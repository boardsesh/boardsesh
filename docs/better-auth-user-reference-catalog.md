# Fully migrated user-reference catalog proof

The Better Auth writer migration needs an actual catalog before it can claim a
complete fixed-owner lock inventory. Drizzle reflection alone misses the manually
managed `board_beta_links.created_by_user_id` foreign key from migration 0093.
The backend worker test schema also reconstructs only selected historical SQL.

`test:db:user-reference-catalog` applies every migration to its own new PostgreSQL
18 cluster and compares physical inbound references to `public.users` against the
selected checkout's Drizzle declarations and that explicit migration exception.
It also captures the declared routine, trigger and dependency surfaces needed to
continue the writer audit. It does not change application locks or activate an
authentication authority.

## Run the proof

Install the pinned workspace dependencies first. Docker must already have an
unseeded PostgreSQL 18.6 image with PostGIS 3.6.4 libraries available. Provision
the repository's **portable** artifact from
[the image digest manifest](./postgres-image-digests.json) separately, then bind
its registry digest and platform to its exact local `sha256:` image ID. Record
the actual published build revision with the result.

The image must begin without application objects or extra template databases.
The upstream PostGIS distribution image initializes extensions and
`template_postgis`, so it fails this prerequisite. The proof never pulls or
builds an image and accepts no floating tag or database URL.

Choose clean source and harness commits and a new private output path:

```sh
vp run test:db:user-reference-catalog -- \
  --source-root /absolute/path/to/source-checkout \
  --source-head <source-commit> \
  --harness-head <proof-command-commit> \
  --image sha256:<local-image-id> \
  --out /private/new-catalog-report.json
```

The task requires its arguments and performs the proof; it does not silently skip
when Docker or a prerequisite is unavailable. The script's separate `--plan` mode
describes its boundaries without creating a fixture.

Run from the harness checkout root using the task's fixed Node import arguments.
Proof admission rejects ambient Node/tsx/esbuild overrides, service connection
variables, proxies and a default root or ancestor `tsconfig.json`. These checks
bind the supported loader configuration; they cannot undo configuration reads
that occurred before the entrypoint started.

The selected source supplies its own migration journal, complete SQL files,
schema exports and runtime queue initializer. The harness supplies the collector
and fixture runner. Their source and execution dependencies are fingerprinted
before selected runtime imports and checked throughout execution. A source change
invalidates the result. A main checkout and an unmerged auth stack need separate
reports; their migration and reference counts need not match.

The execution manifest follows declared runtime dependencies and installed
optional dependencies, including the actual esbuild platform binary. Runtime
peers used by this proof are admitted explicitly, including `postgres` for the
Drizzle adapter. Each selected runtime import must resolve to an already
fingerprinted file. Missing required packages or an unadmitted actual peer
prevent completion. Package metadata lookup supports type-only and binary-only
packages while retaining package-name, real-root and content checks.

The Node input manifest excludes top-level `embedded/` fixtures. Admitted inputs
retain HEAD blob and mode validation, and runtime imports remain closed to the
fingerprinted files. A dangling input inside the Node source still fails.

## Fixture boundary

Each run claims a new container, a uniquely named PostgreSQL volume and a private
host directory. The container has no network access or published ports. The only
host mount is its new Unix-socket directory inside a parent accessible only to the
invoking user. No checkout, environment file, service credential or Docker account
configuration is mounted or loaded.

The runner follows the pre-data development-image route: checked-in empty legacy
Aurora stubs, development roles, the exact cutoff-helper privilege contract, then
every journal entry in journal order. Each complete migration file and both
exact-time/hash ledger writes share one transaction. No high-water shortcut,
ledger baseline exemption, downloaded board snapshot or development identity seed
substitutes for an executed migration.

Roles and memberships belong to this new cluster. Creating another database in a
running QA cluster would not provide that boundary. The proof never repairs or
adopts an existing fixture. Containers and volumes remain available for inspection
after success or failure; the runner stops only the container it claimed.

After the journal capture, the command invokes the selected checkout's actual
`initializeJobQueueSchema` through an explicit borrowed client, with supervision
and scheduling disabled and no role arguments. It captures again after queue
initialization. This records the queue objects the initializer creates, without
claiming deployed worker grants or queue-attempt lock behavior.

## Catalog contract

The collector observes one primary, Unix-socket, `REPEATABLE READ READ ONLY`
transaction with `row_security=off` and a catalog-only search path. It records the
new cluster/database identity, server and extension versions, and both complete
migration ledgers.

Every inbound foreign key to the actual `public.users` relation is captured
across schemas, including ordered source/target columns, actions, match mode,
validation, deferral, delete-column subsets and partition-parent provenance.
Reconciliation uses a multiset of semantic references. Equal counts cannot hide a
missing, duplicated, unexpected or structurally changed constraint.

The report includes application-schema relations and RLS state, internal and
application triggers, event triggers, application-schema routine declarations
including extension members and aggregates, scoped `pg_depend` edges, extension
membership counts, policies and default privileges. Opaque PL/pgSQL and dynamic
SQL bodies still require source/caller analysis; dependency rows do not prove
every runtime call.

SQL replaces a catalog record larger than 64 KiB with a rejecting sentinel before
transport. A cursor fetches at most 16 records at a time. The collector validates
runtime fields and enforces cumulative limits of 50,000 rows and 32 MiB, with
bounded statements. Callers may lower those limits, not raise them.

Physical OIDs, cluster identity and generated internal-trigger names remain in
the detail evidence. A separate portable digest normalizes allocation identities
so two independently created fixtures can be compared without confusing OID
allocation with structural drift.

## Results and limits

The private detail report is created exclusively with mode 0600. A final complete
stdout receipt binds its bytes and digest only after migration, reconciliation,
capture, source checks, actual connection closure and owned-container shutdown.
A retained detail or incomplete report alone does not establish completion.

After the positive journal and runtime captures, nine controlled self-checks
exercise the same collector and ledger gate. They introduce an extra user FK,
remove the manual beta FK, recreate it unvalidated, change its delete action,
declare an oversized unused routine, exceed row and byte budgets, deny catalog
access to a restricted role, and change one fixture ledger hash. Each expected
failure must be observed. No application rows are deleted.

The retained fixture is intentionally drifted after these checks: its manual FK
action and public migration ledger no longer match the positive baseline. The
receipt identifies this explicitly. A complete proof binds the earlier baseline
captures and successful negative checks; it does not assert that the retained
database still matches that baseline.

This proves a fully migrated **user-reference catalog**, not equality of every
PostgreSQL schema object, complete producer coverage, deployed role fencing,
historical fixed-UID absence, authentication denial, queue/advisory order or
contention bounds. General column/index definitions and table/column ACLs are not
the semantic comparison contract. No production catalog or credential is read.

The password policy remains unchanged: authenticated set/change must preserve the
requesting device and its original proven authentication age while revoking
others; forgotten-password reset revokes every session. This tooling does not
adopt that policy in production.

Qualification evidence is added after the isolated runs and independent review.

CI runs the pure collector regression and the real process/import/socket tests
when their inputs change. That job's stock PostgreSQL service does not stand in
for the complete PostgreSQL 18/PostGIS journal proof; run the explicit owned task
for that evidence.
