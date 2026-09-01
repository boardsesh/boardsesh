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

This foundation change deliberately leaves all existing database consumers on
their current route. Cutting them over in the same merge would race the first
image publication and Railway deployment. A separate draft activation PR may
be prepared, but it must remain unmerged until the forwarder is deployed and
probed and every role below exists with audited grants.

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

Use a different SCRAM URL and exact login role for every trust surface:

| Workflow | Protected secret | Required login role |
| --- | --- | --- |
| Production migration | `MIGRATION_DATABASE_DIRECT_URL` | `boardsesh_migrator` |
| Snapshot export | `SNAPSHOT_DATABASE_DIRECT_URL` | `boardsesh_snapshot_exporter` |
| Climb grades | `CLIMB_GRADES_DATABASE_DIRECT_URL` | `boardsesh_climb_grades_refresh` |
| Content model | `CONTENT_MODEL_DATABASE_DIRECT_URL` | `boardsesh_content_model_refresh` |
| Hold features | `HOLD_FEATURES_DATABASE_DIRECT_URL` | `boardsesh_hold_features_refresh` |
| Recommendations | `RECOMMENDATIONS_DATABASE_DIRECT_URL` | `boardsesh_recommendations_refresh` |

Every role must be a login with `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`,
`NOREPLICATION`, and `NOBYPASSRLS`; own no schema or table; and have only the
table, sequence, and function grants its workflow proves it needs. The snapshot
role is read-only. The migrator retains only the separately audited `SET ROLE`
path documented in `docs/postgres-18-migration.md`. Verify `current_user`, role
attributes, memberships, owned objects, and effective privileges with each
stored credential before enabling its workflow.

The local `connect-production-db` action uses workload identity federation, an
ephemeral CI node, and immutable pins for both the official action and the
Tailscale client. Its dependency-free Node validator receives the URL only
through its environment and rejects any hostname, port, database, query
override, or login role outside the exact workflow contract. The URL remains
scoped to the validator and the command that needs it, where it is mapped to the
command's existing `DATABASE_URL` variable. Do not put any direct URL in Vercel.

OIDC permission is job-wide, not step-wide. Before a consumer job gains
`id-token: write`, pin every external action to a reviewed commit. Do not run an
unlocked package installer in that job; the content-model workflow needs a
hash-locked Python dependency set or a reviewed digest-pinned tool image first.
No long-lived Tailscale key is stored in GitHub.

Before relying on PostgreSQL `sslmode=verify-full`, the database certificate
must cover the hostname clients connect to. The Tailscale tunnel already
encrypts and authenticates the transport, but it does not replace SCRAM. Never
weaken SCRAM or embed credentials in workflow YAML.

## Activation and rollback

1. Merge the foundation PR, publish its attested image, and deploy the verified
   immutable digest. Keep the existing PostGIS public TCP proxy.
2. Prove `/readyz`, tailnet policy allow/deny tests, restart identity
   persistence, and every task-specific credential before merging consumers.
3. Merge the separate activation PR only after its external actions and
   dependency surfaces are immutable. From protected manual dispatches, prove
   the Tailscale ping and a rollback-only database probe for each direct URL.
4. Run the migration job, each refresh workflow in dry-run mode where offered,
   and one snapshot watermark probe. Confirm the database role and
   `application_name` for each session.
5. Observe 24 hours with zero forwarder dial errors or session rejections. Alert
   on `/readyz != 200`, any increase in `dial_errors_total` or
   `rejections_total`, active sessions above 24 for five minutes, and node
   identity changes.
6. Add the homelab node as `tag:boardsesh-dr` and prove it can reach only port
   5432. Do not use this route as an application read replica.
7. Remove the PostGIS public TCP proxy only as a separately approved Railway
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
vp test run --project scripts scripts/postgres-secure-network-contract.test.ts --reporter=agent
docker build -f deploy/postgres-tailscale-forwarder/Dockerfile deploy/postgres-tailscale-forwarder
```

The unit suite uses in-memory connections and never joins a tailnet or opens a
database connection.
