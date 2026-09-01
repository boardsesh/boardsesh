# PostgreSQL secure network

This is the network contract for direct production database access. It is
separate from the public PgBouncer path used by the Boardsesh application.

```text
Vercel application -> public PgBouncer (mTLS + SCRAM) -> Railway-private Postgres

GitHub CI --Tailscale/WireGuard-->
homelab DR --Tailscale/WireGuard--> boardsesh-db-forwarder -> Railway-private Postgres
operator   --Tailscale/WireGuard-->
```

The forwarder is a TCP relay. It has no database credentials, does not terminate
PostgreSQL TLS, and is reachable only from the tailnet. Tailscale policy is the
network identity check; PostgreSQL SCRAM remains the database identity check.

The OTA `Postgres` Railway service is out of scope. Every target in this runbook
is a `PostGIS - PROD` source, candidate, or fenced predecessor.

## Fixed interface

The service in `deploy/postgres-tailscale-forwarder` exposes these tailnet ports:

| Port | Route | Configuration |
| --- | --- | --- |
| 5432 | Current writable primary | `FORWARD_PRIMARY_ADDR` (required) |
| 5433 | Read-only PG18 candidate | `FORWARD_CANDIDATE_ADDR` (optional) |
| 5434 | Fenced predecessor for forensics | `FORWARD_FORENSIC_ADDR` (optional) |

An optional route has no listener until its target is configured. Every target
must be a distinct `postgis[-name].railway.internal:5432` address. The service
refuses URLs, IP addresses, public hostnames, non-PostGIS services, other ports,
and duplicate targets. In particular, `postgres.railway.internal` (the OTA
service) is rejected at startup.

Runtime environment:

| Variable | Required/default | Purpose |
| --- | --- | --- |
| `TS_CLIENT_SECRET` | required | Unmodified `tskey-client-…` OAuth secret with `auth_keys` write for only `tag:boardsesh-db-forwarder` |
| `TS_STATE_DIR` | `/var/lib/boardsesh-tsnet` | Persistent tsnet identity directory |
| `FORWARD_PRIMARY_ADDR` | required | Current PostGIS private endpoint |
| `FORWARD_CANDIDATE_ADDR` | unset | PG18 private endpoint during migration |
| `FORWARD_FORENSIC_ADDR` | unset | Fenced PG16 endpoint after cutover |
| `FORWARD_MAX_SESSIONS` | `32` | Global cap across all routes (maximum 128) |
| `FORWARD_DIAL_TIMEOUT` | `5s` | Private target TCP dial timeout |
| `TS_STARTUP_TIMEOUT` | `30s` | Tailnet join deadline |
| `FORWARD_SHUTDOWN_GRACE` | `20s` | Session drain deadline |
| `PORT` | `8080` | Railway-private health/metrics listener |

`TS_AUTHKEY` and legacy `TS_AUTH_KEY` are rejected so they cannot silently take
precedence over the tag-scoped OAuth identity. The hostname and advertised tag
are compiled constants: `boardsesh-db-forwarder` and
`tag:boardsesh-db-forwarder`. The service itself adds
`ephemeral=false&preauthorized=true` while minting the one-time enrollment key;
operators cannot override those options or the control-plane URL.

The HTTP listener provides `/livez`, `/readyz`, and Prometheus `/metrics`.
Metrics and operational logs expose route names, counters, and bounded error
classes only, never private target addresses, credentials, client identities,
or query text.

## Provision without replacing live policy

1. Export the current tailnet policy and keep that exact file as the working
   copy. Never upload `tailnet-policy.fragment.json` as a complete policy.
2. Merge only the three `tagOwners`, three `grants`, and two `tests` from
   `deploy/postgres-tailscale-forwarder/tailnet-policy.fragment.json` into their
   corresponding existing sections. Preserve every unknown key, rule, group,
   posture, SSH rule, and test.
3. Preview the merged policy in the Tailscale editor. The included deny tests
   deliberately fail if an existing broad rule can reach the forwarder's SSH,
   health, or forbidden database ports. Narrow the conflicting live rule; do
   not delete the tests or add a wildcard exception.
4. Save only after the complete existing test suite and the new tests pass.
5. Create a Tailscale OAuth client with `auth_keys` write and exactly
   `tag:boardsesh-db-forwarder`. Store its secret as `TS_CLIENT_SECRET` on the
   new Railway service.
6. Let `Postgres Secure Network` publish
   `ghcr.io/boardsesh/boardsesh-postgres-tailscale-forwarder`. Verify its GitHub
   provenance, then configure Railway to pull the immutable digest, never a
   mutable tag.
7. Create a persistent Railway volume at `/var/lib/boardsesh-tsnet`, attach the
   service to the same private network as `PostGIS - PROD`, set the runtime
   variables above, and use its checked-in `railway.toml` health check.
8. Do **not** create a Railway public domain or TCP proxy for the forwarder.
   Confirm the Railway service has no public networking before continuing.
9. Confirm the tsnet node is non-ephemeral, advertises only the forwarder tag,
   has the expected MagicDNS name, and survives a Railway restart without
   creating a second node. If the state volume was lost, remove the stale node
   before enrolling the replacement so MagicDNS cannot add a numeric suffix.

`autogroup:admin` owns the three initial tags and supplies break-glass operator
access to ports 5432-5434. CI has only 5432/5433; homelab DR has only 5432. Move
human access to a named operator group later only as a separate reviewed policy
change with known tailnet login identities.

## GitHub production database jobs

The rollout is deliberately split. The foundation change publishes the image
while leaving every database consumer on its current route; cutting consumers
over in that merge would race the first Railway deployment. The separate
activation change switches the jobs below and must remain a draft until the
forwarder is deployed and probed and every role exists with audited grants.

Create a Tailscale federated identity with `auth_keys` scope and permission to
mint only `tag:boardsesh-db-ci` nodes. Its GitHub trust policy must require the
`boardsesh/boardsesh` repository, `refs/heads/main`, the protected `Production`
environment, and an allowlist of the six exact `workflow_ref` values ending in
`production-deploy.yml`, `export-board-snapshots.yml`,
`refresh-climb-grades.yml`, `refresh-content-model.yml`,
`refresh-hold-features.yml`, or `refresh-recommendations.yml`, each at
`@refs/heads/main`. Do not trust the environment name by itself. Configure these
common values on that environment before merging the activation PR:

The claim names and action permissions follow the official
[Tailscale workload identity](https://tailscale.com/docs/features/workload-identity-federation)
and [GitHub OIDC](https://docs.github.com/en/actions/reference/security/oidc)
references.

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `TS_OAUTH_CLIENT_ID` | Federated identity client ID |
| Secret | `TS_AUDIENCE` | Federated identity audience |
| Variable | `POSTGRES_FORWARDER_HOST` | Full `boardsesh-db-forwarder.<tailnet>.ts.net` MagicDNS name |

Use a different SCRAM URL and exact login role for every trust surface. The
`application_name` is part of the URL contract as well as a per-database role
default, so an unexpected job is visible in `pg_stat_activity`.

| Workflow | Protected secret | Required login role | `application_name` | Connection limit |
| --- | --- | --- | --- | --- |
| Production migration | `MIGRATION_DATABASE_DIRECT_URL` | `boardsesh_migrator` | `boardsesh-ci-migrate` | 2 |
| Snapshot export | `SNAPSHOT_DATABASE_DIRECT_URL` | `boardsesh_snapshot_exporter` | `boardsesh-ci-snapshot-export` | 10 |
| Climb grades | `CLIMB_GRADES_DATABASE_DIRECT_URL` | `boardsesh_climb_grades_refresh` | `boardsesh-ci-climb-grades` | 2 |
| Content model | `CONTENT_MODEL_DATABASE_DIRECT_URL` | `boardsesh_content_model_refresh` | `boardsesh-ci-content-model` | 2 |
| Hold features | `HOLD_FEATURES_DATABASE_DIRECT_URL` | `boardsesh_hold_features_refresh` | `boardsesh-ci-hold-features` | 2 |
| Recommendations | `RECOMMENDATIONS_DATABASE_DIRECT_URL` | `boardsesh_recommendations_refresh` | `boardsesh-ci-recommendations` | 2 |

Every role must be a login with `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`,
`NOREPLICATION`, and `NOBYPASSRLS`; own no schema or table; and have only the
table, sequence, and function grants its workflow proves it needs. The snapshot
role is read-only. The migrator retains only the separately audited `SET ROLE`
path documented in `docs/postgres-18-migration.md`. Verify `current_user`, role
attributes, memberships, owned objects, and effective privileges with each
stored credential before enabling its workflow.

### Guarded task-role provisioning

`scripts/production-db-task-roles.mjs` is the reviewed manifest, diff, apply,
audit, and rollback path for these six roles. It does not call Railway,
Tailscale, or GitHub and is not run automatically. It accepts only a command on
argv. Administrator and generated credentials enter through the environment or
a protected file, and neither URLs nor passwords are printed.

The manifest grants relation-level privileges proven by the checked-in workflow
queries:

- `boardsesh_migrator`: no direct schema or relation privileges; `SET TRUE`,
  `INHERIT FALSE`, and `ADMIN FALSE` membership in the existing restricted
  `boardsesh_owner` role only.
- `boardsesh_snapshot_exporter`: `SELECT` on `board_climbs`,
  `board_climb_stats`, `board_climb_grades`, and every table in
  `CATALOG_SNAPSHOT_TABLES`. It has `default_transaction_read_only=on` and must
  use the primary, not a replica, because of snapshot cursor ordering. Its
  connection limit matches the exporter's checked-in pool maximum of 10.
- `boardsesh_climb_grades_refresh`: `SELECT` on its climb, tick, alias, history,
  board, and embedding inputs; write access only to `board_grade_coefficients`
  and `board_climb_grades`; `TEMPORARY` only for the refresh key table.
- `boardsesh_content_model_refresh`: `SELECT` on its hold/climb/placement
  training inputs; write access only to `board_climb_embeddings` and
  `board_climb_similar`.
- `boardsesh_hold_features_refresh`: `SELECT` on geometry and climb inputs;
  `INSERT` on the reserved system user; and upsert access only to
  `board_hold_features` and `user_hold_classifications`. PostgreSQL upserts need
  `SELECT` as well as `INSERT/UPDATE` on those two targets.
- `boardsesh_recommendations_refresh`: `SELECT` on climb and stats inputs;
  relation-level writes only to the generated setter/send stats, generated
  playlists, ownership/climbs, weekly history/cursor, reserved system user, and
  the playlist-delete trigger's `sync_deletions` target.

For an `INSERT` target backed by an owned sequence, the tool derives and grants
only `USAGE` on that sequence. It grants no default privileges, grant options,
routine execution, object ownership, role creation, replication, or RLS bypass.
The audit covers direct database, schema, relation, sequence, column, routine,
type, large-object, parameter, language, foreign-data, server, tablespace, and
default-ACL privileges. It also resolves PostgreSQL's implicit `PUBLIC` ACLs
with `acldefault` for every connectable database; every non-system,
non-extension schema; and every non-extension application relation, sequence,
column, routine, user-defined type, and large object in scope. It also inspects
`PUBLIC SET`/`ALTER SYSTEM` parameter ACLs. Any non-extension schema outside
the exact `public`/`drizzle` manifest is itself a blocker, even when its current
ACL is empty. `PUBLIC CONNECT` is allowed only on `railway`, because it is
inside all six explicit database contracts.
`PUBLIC` access to another connectable database, `PUBLIC TEMPORARY`, schema
`CREATE`/`USAGE`, and application-object privileges are outside at least one
role's contract and therefore fail audit. This prevents a leaked cluster-wide
credential from bypassing the pinned URL by naming `postgres`, `template1`, or
another database. The migrator deliberately has no direct schema `USAGE`; it
reaches `public` and `drizzle` only after the guarded owner transition. Only the
climb-grade refresh gets `TEMPORARY`.

Future objects are covered too. The audit resolves the migration owner's global
defaults for tables, sequences, routines, types, schemas, and large objects,
then inspects its schema-local defaults where PostgreSQL supports them.
PostgreSQL's built-in `PUBLIC EXECUTE` routine and `PUBLIC USAGE` type defaults
must already have been removed by the reviewed PG18 owner/runtime transition.
Extension-owned objects are excluded from this task-role manifest; their vendor
ACLs and extension membership are handled by the PG18 catalog audit. Any
unexpected ownership, membership, default ACL, schema, or grant option, plus
any RLS policy naming a managed role, stops apply for manual review.

No task role receives application-type `USAGE`. PostgreSQL 18 defines that
privilege as permission to create schema objects that depend on a type, not as
permission to read or write values of that type in existing table columns (see
the [PostgreSQL privilege contract](https://www.postgresql.org/docs/18/ddl-priv.html)).
The latest schema snapshot pins the only task-table enum values to
`boardsesh_ticks` and `user_hold_classifications`, and pins task-table routine
defaults to the built-in `pg_catalog.now()`. The PG18.6 smoke revokes PUBLIC
type access, proves enum and domain reads/writes still work without direct
`USAGE`, and proves the playlist deletion trigger fires without granting its
application routine `EXECUTE`. A direct call to that routine remains denied.
If a future workflow creates a dependent object, explicitly casts through a
new privilege boundary, or adds an application routine default, update the
manifest and smoke rather than restoring a PUBLIC default.

Generate credentials once in an operator-only directory outside the repository.
The existing parent must be owned by the operator and inaccessible to group and
other users. The tool resolves that parent and the real repository root before
accepting the destination, so a symlink cannot redirect the bundle into the
checkout. The destination must not already exist and is opened with exclusive,
no-follow flags at mode `0600`; apply reads the same single-link file through
its already-verified descriptor:

```sh
install -d -m 700 /secure/operator/boardsesh-db-rollout
export ROLE_CREDENTIALS_FILE=/secure/operator/boardsesh-db-rollout/task-roles.json
export POSTGRES_FORWARDER_HOST=boardsesh-db-forwarder.example-tailnet.ts.net
node scripts/production-db-task-roles.mjs generate
```

Keep the file out of shell history, CI artifacts, issue attachments, and chat.
Transfer each `databaseUrl` to its matching protected `Production` environment
secret through the GitHub UI or a secret-manager integration that reads the
value from stdin. Never pass a URL to a CLI argument. Retain the file in the
approved password manager only for the rollout and credential-revocation
window.

Before changing a database, enter the administrator URL with terminal echo
disabled. The tool requires the exact `railway` database, `sslmode=require` for
the sole URL query parameter, the exact `POSTGRES_FORWARDER_HOST` on port 5432,
the pre-existing restricted `boardsesh_owner`, and a PostgreSQL superuser so
every possible direct ACL can be inspected and reconciled in one transaction.
This makes the forwarder's PostGIS-only target validation part of the database
guard and prevents accidentally provisioning the separate OTA `Postgres`
service:

```sh
export POSTGRES_FORWARDER_HOST=boardsesh-db-forwarder.example-tailnet.ts.net
read -rsp 'PostGIS - PROD admin URL: ' ADMIN_DATABASE_URL
printf '\n'
export ADMIN_DATABASE_URL
node scripts/production-db-task-roles.mjs plan
```

Review and retain the sorted `[task-role-diff]` output as the before-state. It
contains object names and privilege types, never credentials. A cluster-wide
line includes an exact candidate `REVOKE` or `ALTER DEFAULT PRIVILEGES` statement
for review. Do not paste those statements into production as a bundle: they can
change access for every database login. Reconcile them through the reviewed
PG18 owner/runtime transition, or approve a narrowly scoped cluster-policy patch
with before/after ACL evidence. This task-role tool never executes a `PUBLIC` or
migration-owner default-ACL remediation; `apply` refuses while any such boundary
diff remains.

After that separate review is complete, apply has a second boundary check inside
its advisory-locked transaction, rotates all six passwords to client-built SCRAM
verifiers, prints its pre-apply diff, and fails unless the post-apply diff is
empty:

```sh
export APPLY_TASK_ROLE_CHANGES=APPLY_EXACT_SIX_TASK_ROLES
node scripts/production-db-task-roles.mjs apply
unset APPLY_TASK_ROLE_CHANGES
node scripts/production-db-task-roles.mjs audit
unset ADMIN_DATABASE_URL ROLE_CREDENTIALS_FILE POSTGRES_FORWARDER_HOST
```

Do not run `apply` until the foundation is merged, the PG18 owner/runtime ACL
transition is complete, the cluster-wide and six-role grant diffs are reviewed,
and a rollback owner is named. This repository change itself does not execute
any command above against production.

Rollback is deliberately narrower than `DROP OWNED`: it refuses partial or
drifted roles, unexpected membership, default ACLs, grant options, or owned
objects. First disable the six workflows and revoke their GitHub secrets. Then
obtain a fresh hidden administrator URL, run `audit`, and only after the empty
diff proves the exact managed state:

```sh
export POSTGRES_FORWARDER_HOST=boardsesh-db-forwarder.example-tailnet.ts.net
read -rsp 'PostGIS - PROD admin URL: ' ADMIN_DATABASE_URL
printf '\n'
export ADMIN_DATABASE_URL
export ROLLBACK_TASK_ROLES=DROP_EXACT_SIX_TASK_ROLES
node scripts/production-db-task-roles.mjs rollback
unset ROLLBACK_TASK_ROLES ADMIN_DATABASE_URL POSTGRES_FORWARDER_HOST
```

Rollback holds the task-role advisory lock across two committed phases. Its
first transaction changes all six roles to `NOLOGIN` and commits that durable
fence. Only then does it inspect `pg_stat_activity.usesysid`, which remains the
authenticated login identity even after `SET ROLE boardsesh_owner`. If any such
session remains, rollback refuses without revoking membership or dropping a
role. The safer `NOLOGIN` state is intentional: `plan` exposes it as role drift,
`audit` refuses activation readiness, and a later rollback invocation accepts
the fence, checks the sessions again, and resumes. Drain the reported sessions
and rerun the same command. If rollback must instead be abandoned, review the
state and rerun guarded `apply` with the original protected credential bundle;
do not restore `LOGIN` manually.

After an empty session proof, the second transaction rechecks the complete
fenced contract and session set, revokes the exact direct grants and
`boardsesh_owner` membership, and drops only the six ownership-free roles. It
does not change application data, schemas, the migration owner, the forwarder,
tailnet policy, or Railway. Running it again after all six roles are absent is a
no-op.

The local `connect-production-db` action uses workload identity federation, an
ephemeral CI node, and immutable pins for both the official action and the
Tailscale client. Its dependency-free Node validator receives the URL only
through its environment and rejects any hostname, port, database, query
override, or login role outside the exact workflow contract. The URL remains
scoped to the validator and the command that needs it, where it is mapped to the
command's existing `DATABASE_URL` variable. Do not put any direct URL in Vercel.

Each protected URL must contain exactly two query parameters:
`application_name=<the value in the table>` and `sslmode=require`. The validator
rejects duplicate parameters, fragments, every PostgreSQL `options` value, and
all other query parameters. This keeps the route auditable and encrypts the
forwarder-to-PostGIS leg inside Railway's private network.

OIDC permission is job-wide, not step-wide. Every external action in these jobs
is pinned to a reviewed commit. Node installs use the frozen workspace lock;
the content-model Python install uses `--require-hashes`, binary artifacts only,
and `ml/climb2vec/requirements-ci.lock`. Regenerate that lock from its `.in`
file with the exact command recorded in the lock header. No long-lived
Tailscale key is stored in GitHub.

Before relying on PostgreSQL `sslmode=verify-full`, the database certificate
must cover the hostname clients connect to. The Tailscale tunnel already
encrypts and authenticates the transport, but it does not replace SCRAM. Never
weaken SCRAM or embed credentials in workflow YAML.

## Activation and rollback

1. Merge the foundation PR, publish its attested image, and deploy the verified
   immutable digest. Keep the existing PostGIS public TCP proxy.
2. Merge the stacked task-role tooling PR. Review its `plan` evidence, run its
   guarded `apply` through the PostGIS-only forwarder, store the six generated
   URLs in their exact protected secrets, and retain the empty `audit` evidence.
3. Prove `/readyz`, tailnet policy allow/deny tests, restart identity
   persistence, and every task-specific credential before merging consumers.
4. Merge the separate activation PR only after its external actions and
   dependency surfaces are immutable. From protected manual dispatches, prove
   the Tailscale ping and a rollback-only database probe for each direct URL.
5. Run the migration job, each refresh workflow in dry-run mode where offered,
   and one snapshot watermark probe. Confirm the database role and
   `application_name` for each session.
6. Observe 24 hours with zero forwarder dial errors or session rejections. Alert
   on `/readyz != 200`, any increase in `dial_errors_total` or
   `rejections_total`, active sessions above 24 for five minutes, and node
   identity changes.
7. Add the homelab node as `tag:boardsesh-dr` and prove it can reach only port
   5432. Do not use this route as an application read replica.
8. Remove the PostGIS public TCP proxy only as a separately approved Railway
   change after all direct consumers pass. This repository change does not
   remove it.

Rollback before public-proxy removal is to restore the previous workflow
revision and `DATABASE_URL` secret, then investigate the tunnel. After proxy
removal, rollback is to restore that proxy temporarily under incident approval;
never broaden the tailnet grants.

During PG18 migration, configure candidate port 5433 only after the candidate is
read-only and audited. At cutover, update port 5432 to PG18, put the fenced PG16
address on 5434, and restart the forwarder in the write freeze. Remove 5434
after the 72-hour acceptance window; remove 5433 when the candidate route is no
longer needed.

## Local validation

```sh
vp run test:postgres-forwarder
vp test run --project scripts scripts/postgres-secure-network-contract.test.ts scripts/production-db-task-roles-contract.test.ts --reporter=agent
bash scripts/production-db-task-roles-smoke.sh
docker build -f deploy/postgres-tailscale-forwarder/Dockerfile deploy/postgres-tailscale-forwarder
```

The unit suite never joins a tailnet or opens a database connection. The task
role smoke starts only the digest-pinned official PostgreSQL 18.6 base selected
by the upgrade project. PostGIS is unnecessary because the fixture exercises
core role, ACL, RLS, SCRAM, and catalog behavior only. It provisions
all six roles, proves allowed and denied operations, injects an unexpected
grant, proves audit and rollback refusal, repairs it, and verifies idempotent
rollback without losing the owner role or fixture data.
