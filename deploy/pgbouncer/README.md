# Boardsesh PgBouncer image

This image runs PgBouncer 1.25.2 in transaction-pooling mode. Deploy exactly
one replica: its 45-connection database and upstream-user limits are per
PgBouncer process, so replicas would multiply the PostgreSQL connection budget.
Client connections are disconnected when a query waits more than 5 seconds for
an upstream connection. Clients must reconnect and retry transient failures with
bounded backoff; this deliberately fails fast during pool saturation or
PostgreSQL outages.

The container listens on port `6432`, requires TLS from clients, and verifies
the upstream PostgreSQL certificate and hostname. Configure these secret
environment variables:

- `PGBOUNCER_UPSTREAM_HOST` and optional `PGBOUNCER_UPSTREAM_PORT` (default `5432`)
- `PGBOUNCER_DATABASE_NAME`, `PGBOUNCER_UPSTREAM_USER`, `PGBOUNCER_UPSTREAM_PASSWORD`
- `PGBOUNCER_CLIENT_USER`, `PGBOUNCER_CLIENT_PASSWORD`
- `PGBOUNCER_ADMIN_USER`, `PGBOUNCER_ADMIN_PASSWORD`
- `PGBOUNCER_SERVER_TLS_CA`

The admin username must be distinct from both application and upstream users,
and the upstream username must differ from the application username. The HBA
rules allow application identities to reach only the configured application
database and the admin identity to reach only PgBouncer's admin console.

Restrict network ingress to the Boardsesh application workloads that use the
pool, plus an explicit operator source when remote admin-console access is
needed. TLS and HBA authentication do not replace a service-level firewall or
private-network allowlist.

The IPv4-only `listen_addr = 0.0.0.0` and HBA rules are intentional for the
current private network. Review both the HBA rules and network allowlist before
enabling IPv6 listeners.

Set both `PGBOUNCER_SERVER_TLS_CERT` and `PGBOUNCER_SERVER_TLS_KEY` when the
upstream requires a client certificate. `PGBOUNCER_LISTEN_PORT` defaults to
`6432`. Set both `PGBOUNCER_CLIENT_TLS_CERT` and `PGBOUNCER_CLIENT_TLS_KEY` to
inject a stable client-facing identity. When omitted, the container generates a
one-year self-signed certificate at boot; clients should use `sslmode=require`
unless the generated certificate is distributed as a trust anchor. Supply PEM
contents directly; the entrypoint writes all generated files with owner-only
permissions and does not print their contents.

Secret environment variables remain visible to operators with container or
platform inspection access. The client username and password must remain in the
container configuration because Docker starts health checks independently of
the PgBouncer process. Restrict deployment-secret and container-inspection
permissions to trusted operators.

`PGBOUNCER_RUNTIME_DIR` is an internal deployment/test-only override. Production
should leave it unset and use `/run/pgbouncer`. If a controlled test or
deployment must set it, use only a trusted absolute path made from letters,
digits, `_`, `.`, `/`, and `-`, without `..` path segments. Never derive it from
request or application input.

Rotate client credentials with two PgBouncer deployments:

1. Set `PGBOUNCER_CLIENT_USER_NEXT` and `PGBOUNCER_CLIENT_PASSWORD_NEXT`; deploy.
2. Move every client to the next credentials and confirm old traffic reaches zero.
3. Promote the next credentials to the primary variables, remove `_NEXT`; deploy.

The two PgBouncer deployments keep both application identities valid during
the client rollout. The next username must differ from every active identity.
Do not use this overlap for upstream or admin credentials. Rotate the upstream
database role in a controlled database/PgBouncer change, and rotate the admin
identity separately from application traffic; health must pass after each.

Set the container's open-file limit to at least `2048`. The configured ceiling
alone can use 500 client sockets plus 45 upstream sockets, before PgBouncer's
listening sockets, DNS activity, health checks, and runtime overhead.

Production deployments should resolve the full-commit tag to its immutable OCI
digest and deploy `ghcr.io/boardsesh/boardsesh-pgbouncer@sha256:...`, never the
mutable `:production` tag directly. Verify its GitHub provenance first:

```sh
gh attestation verify \
  oci://ghcr.io/boardsesh/boardsesh-pgbouncer@sha256:DIGEST \
  --repo boardsesh/boardsesh
```

Database migrations require a direct PostgreSQL URL that is distinct from the
pooled `DATABASE_URL`. Production fails before migrations when
`DATABASE_DIRECT_URL` is absent or exactly equals `DATABASE_URL`; it never falls
back to PgBouncer or retains the pooled URL as a durable migration fallback.
