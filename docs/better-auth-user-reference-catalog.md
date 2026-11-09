# Fully migrated user-reference catalog proof

The Better Auth writer migration needs an actual catalog before it can claim a
complete fixed-owner lock inventory. Drizzle reflection alone misses the manually
managed `board_beta_links.created_by_user_id` foreign key from migration 0093.
The applied history also retains two controller-owner constraints: migration
0041 creates an inline FK, then 0052 adds the separately named canonical FK.
The backend worker test schema also reconstructs only selected historical SQL.

`test:db:user-reference-catalog` applies every migration to its own new PostgreSQL
18 cluster and compares physical inbound references to `public.users` against the
selected checkout's Drizzle declarations and that explicit migration exception.
The controller artifact adds one expected constraint when the canonical identity
has a single declaration. It does not manufacture an absent relation or add a
third constraint when both are already declared. Both actual constraints remain
in the multiset; an additional unreviewed duplicate or changed semantics fails.
It also captures the declared routine, trigger and dependency surfaces needed to
continue the writer audit. It does not change application locks or activate an
authentication authority.

## Run the proof

**The owned proof runs only on Linux, against a rootful Docker daemon.** It talks
to the fixed `/var/run/docker.sock`, ignores `DOCKER_HOST` and Docker contexts,
and bind-mounts a host Unix-socket directory into the container. Docker Desktop
on macOS reports that bind source as `/host_mnt/...`, so the ownership check
rejects it, and rootless Docker or Podman have no socket at that path. The
`--plan` mode, the unit tests and the TCP check under
[Check a real catalog](#check-a-real-catalog) run anywhere.

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
variables and a default root or ancestor `tsconfig.json`. These checks bind the
supported loader configuration; they cannot undo configuration reads that
occurred before the entrypoint started.

The selected source supplies its own migration journal, complete SQL files,
schema exports and runtime queue initializer. The harness supplies the collector
and fixture runner. Their tracked files are fingerprinted against the HEAD blobs
before selected runtime imports, and each checkpoint rechecks HEAD and a clean
worktree. A source change invalidates the result. A main checkout and an unmerged
auth stack need separate reports; their migration and reference counts need not
match.

The source fingerprint excludes top-level `embedded/` fixtures. Admitted inputs
retain HEAD blob and mode validation. A dangling input inside the Node source
still fails.

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

Each run therefore leaves a stopped container and a migrated data volume behind,
both labelled `org.boardsesh.catalog-proof`. Clear them when you no longer need
them; `docker rm` refuses a container that is still running:

```sh
docker ps -aq --filter label=org.boardsesh.catalog-proof | xargs -r docker rm
docker volume ls -q --filter label=org.boardsesh.catalog-proof | xargs -r docker volume rm
```

After the journal capture, the command invokes the selected checkout's actual
`initializeJobQueueSchema` through an explicit borrowed client, with supervision
and scheduling disabled and no role arguments. It captures again after queue
initialization. This records the queue objects the initializer creates, without
claiming deployed worker grants or queue-attempt lock behavior.

## Catalog contract

The collector observes one `REPEATABLE READ READ ONLY` transaction with
`row_security=off` and a catalog-only search path. It records the cluster/database
identity, server and extension versions, and both complete migration ledgers. The
owned proof requires a primary reached over its new Unix socket, so it also proves
the connection has no client address. A read-only TCP run reports what the server
saw instead: `transport`, `recovery` (primary or standby), `clientAddress`, and
the system identifier, or `null` when the role cannot read `pg_control_system`.

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
the semantic comparison contract. The owned proof reads no production catalog or
credential.

## Check a real catalog

The same collector and reconciliation run over a read-only TCP connection, so a
real database can be compared with a checkout's Drizzle declarations:

```sh
cd packages/db
USER_REFERENCE_CATALOG_DATABASE_URL=postgresql://reader@db.example.test/main?sslmode=verify-full \
  vp exec tsx scripts/reconcile-user-references.ts
```

The command takes that explicit URL only, never the application's `DATABASE_URL`.
The session defaults to read-only and every catalog read runs in the one `READ
ONLY` transaction above, so a primary or a standby both work. The role needs
ordinary catalog visibility and `SELECT` on `public.__drizzle_migrations` and
`drizzle.__drizzle_migrations`. Run it from the commit deployed to that database,
or a newly added or dropped foreign key will read as drift.

Its last line of output is one JSON object, so pipe it through `tail -n 1` before parsing; dotenv can print startup notices first. `status` is `matched`, `different` (exit 1, with each
difference) or `incomplete` (exit 1, with a fixed error category and never the
URL). `target` names the transport, primary or standby and the identifier the
server reported, so a report states which server it describes.

CI applies every migration to the `db-migrations` job's PostgreSQL 18 PostGIS
service and runs this command against it, so an undeclared foreign key to `users`
fails the job. That step does not stand in for the owned proof: it runs neither
the runtime job-queue capture nor the negative controls, so run the explicit
owned task for that evidence. CI also runs the pure collector regression and the
process-boundary tests when their inputs change.
