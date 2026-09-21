# Giving the production primary a real TLS certificate

The reviewed rollout and rollback path for replacing the certificate the
production PostgreSQL primary serves. Written before the change, because
[`spray-recognition-rollout.md`](./spray-recognition-rollout.md) requires it:
*"Certificate changes on the primary require a separate reviewed operator rollout
and rollback path; passing code tests alone does not resolve server trust."*

## Why

The primary serves the Debian snakeoil certificate from its base image. Measured
2026-09-21: the live certificate's SHA-256 is
`D9:F6:91:05:8E:A7:95:D3:23:FC:33:5F:E4:22:94:DC:73:44:6A:D4:0A:2F:2B:2D:7D:85:34:C4:53:4A:BF:50`,
byte-identical to `/etc/ssl/certs/ssl-cert-snakeoil.pem` inside the pinned base
`postgres:18.6-bookworm@sha256:1c59e2…`. **Its private key is published in that
public image layer.** Every application pool connects with `ssl: 'require'`
(`packages/db/src/client/postgres.ts`), which encrypts without verifying, so
anyone on the network path to the public proxy can terminate TLS with a key they
can `docker pull`.

It also blocks the homelab DR standby, which verifies chain and hostname, and the
hold-detector release gate.

## What is already in place

| Piece | Where |
|---|---|
| The image can install TLS material from `PG_TLS_SERVER_CERT` / `PG_TLS_SERVER_KEY` | `packages/db/docker/postgres-entrypoint.sh` |
| Both variables are declared, assert-only | `infra/railway/config.ts` |
| A hostname we control, DNS-only to the proxy | `pgdr.boardsesh.com` |
| A nightly probe of what the primary actually serves | `scripts/check-primary-tls.ts`, `railway-drift.yml` |

The probe currently **warns** rather than fails, because the certificate served
today is the one it rejects. `docs/pg-primary-tls.json` records that as
`pendingRollout`, with a `warnUntil` date after which it fails hard — so a stalled
rollout cannot go quiet.

## The PKI

A private CA, not a public one. A public certificate would mean a renewal every
90 days, each one a file delivery into a Railway container; with the DR standby as
the only verifying client, an expiry costs a full re-bootstrap (see the clock
below). A private CA with a multi-year leaf has no recurring failure mode.

`sslrootcert=system` would trust every public root — roughly 150 issuers — for a
link with a handful of known clients. Pinning one CA we control is strictly
narrower, and the ansible role verifies the anchor's SHA-256 against a literal in
git on every converge.

**CA** — 10 years. Rollover here is a PR plus a standby recreate, so a longer life
buys nothing, and a 2046 RSA root would sit past NIST IR 8547's 2035 date.

```
P-384 (or RSA-4096)
basicConstraints     = critical, CA:TRUE, pathlen:0
keyUsage             = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
```

**No `extendedKeyUsage` on the CA.** That is deliberate: an EKU there would stop
it issuing the `clientAuth` leaf that mutual TLS for the replication role needs
later.

**Leaf** — 3 years or less. RSA-2048 is 112-bit, which NIST deprecates after 2030,
so a longer-lived leaf needs a bigger key.

```
P-256 (or RSA-3072)
keyUsage               = critical, digitalSignature, keyEncipherment
extendedKeyUsage       = serverAuth
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid,issuer
subjectAltName         = DNS:pgdr.boardsesh.com, DNS:postgis---pg18.railway.internal
```

Those two names and no others. `postgis---pg18.railway.internal` is the primary's
Railway private endpoint — note the triple dash, and note that
`postgis.railway.internal` is the **frozen PG16 service**. A SAN for
`*.proxy.rlwy.net` is deliberately absent: it is a name Railway administers and
can reassign, which is what `pgdr.boardsesh.com` exists to avoid.

### Key ceremony

Keys are written to files and never echoed. 1Password items are created from
those files (`op item create … --field 'private_key[file]=…'`), scratch is
shredded, and the only values that reach a terminal are fingerprints.

Custody is 1Password item `Boardsesh DR primary TLS` in vault `Homelab`, **plus
one independent encrypted copy** of the CA key — age or gpg under a passphrase
held outside 1Password, on the Unraid `protected` mount or offline. One vault item
under one account is a single custodial point of failure, and the WAL-G key has
the same gap today; both deserve the second copy. Prove each copy by
round-tripping from it alone into an empty directory, then
`openssl verify -CAfile ca.crt server.crt`.

There is no CRL or OCSP, at this scale deliberately. **Revocation is
re-anchoring**: mint a new CA, PR its PEM and fingerprint, recreate the standby.

## Rollout

### 1. Audit and record first

Nobody has inventoried what is on this server. Capture, as evidence:

```sql
SELECT name, setting, source, sourcefile FROM pg_settings WHERE name ~ '^ssl';
SELECT name, setting FROM pg_settings WHERE sourcefile LIKE '%auto.conf';
```

plus the live `pg_hba.conf`. Two things are known to be undeclared: `ssl = on` was
applied by hand during the cutover, and a remote `replication` HBA line must
exist, because `IDENTIFY_SYSTEM` succeeds as `boardsesh_standby` and `host all
all` does **not** match replication connections — yet it appears in no Dockerfile
and no doc.

### 2. Turn connection logging on

`ALTER SYSTEM SET log_connections = on` and reload. There is no authentication log
on this cluster today, so non-use of a credential can never be proven. This window
handles a private key. Decide to keep it on and declare it, rather than leaving a
fourth undeclared setting.

### 3. Enforce TLS for the replication role

Convert the replication line to:

```
hostssl replication boardsesh_standby all scram-sha-256
```

`verify-full` already refuses plaintext on the client side; `hostssl` is what
stops a leaked `boardsesh_standby` password being used with `sslmode=disable`.
Leave the application's `host all all` line alone.

### 4. Publish, set variables, deploy once

Publish the image (reviewer-gated dispatch, `postgres-image-publisher.yml`), set
`PG_TLS_SERVER_CERT` and `PG_TLS_SERVER_KEY` with `skipDeploys`, then deploy the
new digest **once** so the image and the variables land together.

Budget **6 minutes**, not 2, and keep `redeploy` ready. **Probe the database
itself — never trust Railway's `state: live`.** During S5 a restart wedged with
`stacker-hooks precreate: exit status 2`: Postgres shut down cleanly, the
container never returned, and the control plane still reported `live` with a
SUCCESS deployment.

### 5. Verify

```bash
openssl s_client -starttls postgres -connect pgdr.boardsesh.com:17963 \
  -CAfile ca.crt -verify_hostname pgdr.boardsesh.com -verify_return_error </dev/null
```

`-verify_return_error` is not optional: without it `s_client` prints the failure
and still exits 0 — measured against this endpoint, an untrusted chain reports
`Verify return code: 18` and exits 0, as does a hostname mismatch.

Then `vp exec tsx scripts/check-primary-tls.ts`, `/health/db` returning 200, and
the server log clean of `SSL configuration was not reloaded` — a permission
mistake is silent at reload and fatal at the next restart.

### 6. Hygiene, in the same window

- `ALTER SYSTEM RESET` the cutover-era `ssl_cert_file` / `ssl_key_file`. The
  entrypoint passes them on the command line, which outranks
  `postgresql.auto.conf`, so the old values are dead — but leaving them there
  misleads the next operator.
- Move the digest pin in `docs/postgres-image-digests.json`,
  `.github/workflows/ci.yml` and `Boardsesh DR artifacts.postgres_image_digest`.
- Clear `pendingRollout` in `docs/pg-primary-tls.json` and fill `expected` with
  the new fingerprint, SAN set and a `minDaysRemaining` floor.

## Rollback

**Redeploy the previous image digest.** Not `ALTER SYSTEM RESET ssl_cert_file`.

That distinction is load-bearing. `ssl = on` is live while the certificate sits
under `/etc/ssl`, so the path must already be set explicitly in
`postgresql.auto.conf` — otherwise Postgres could not have started. `RESET`
therefore reverts to the PGDATA-relative default `server.crt`, which does not
exist: a silent no-op at reload and **FATAL at the next restart**, with
`railway ssh` unable to help because it needs a running container.

Nothing in the application path can break either way: every pool uses
`ssl: 'require'`, which does not verify, so a changed chain is invisible to it.

## Expiry has a two-day fuse

WAL accrues at ~7.3 GiB/day against a 16 GiB slot cap. An expired certificate
stops replication, and the slot is invalidated in roughly **2.2 days**. The
standby has no `restore_command` — it replays by streaming only — so recovery is a
full base backup over the WAN, not archive catch-up.

The application pools will not notice, because they do not verify. **The standby
is the only canary.** That is why the nightly probe fails on a certificate with
fewer than `minDaysRemaining` left, rather than waiting for the alert that fires
after replication has already stopped.

## Rotation

**Leaf** (routine, every ≤3 years): mint from the same CA, update the two Railway
variables, redeploy, verify, update `expected` in the manifest. The standby needs
no change — it trusts the CA, not the leaf. Rehearse this once during the DR
drills while the certificate is fresh, not in three years.

**CA** (rare — rotation or compromise): mint a new CA, PR its PEM and SHA-256 into
the ansible role, converge the standby with
`RECREATE_VERIFIED_STANDBY_FOR_PINNED_CONFIG_DRIFT`, then issue and install a new
leaf.

Impact of a leaked CA key, stated honestly: it lets an attacker impersonate the
primary to the standby. SCRAM does not hand over the password, so the exposure is
DR data poisoning or denial — not access to the primary.

## The fresh-volume trap

The failback runbook provisions a fresh Railway volume. Because the material comes
from variables rather than from the volume, the entrypoint writes it at boot and a
fresh volume works — **provided both variables are set on that service**. Add
installing them to any procedure that creates a new primary service or volume.

## What must never be done

- **Never move a private key through SQL.** No `COPY … TO PROGRAM`: statement text
  reaches `pg_stat_statements`, `log_min_duration_statement` and Railway's log
  retention.
- **Never put the key under PGDATA.** `pg_basebackup` copies the whole data
  directory and excludes only a fixed list of runtime files, so a key there is
  copied onto the standby's disk and into every WAL-G backup — breaking the DR
  rule that the backup host holds only the encryption *public* key.
- **Never bundle a cipher-list change with a certificate rollout.** Tightening
  `ssl_ciphers` or raising `ssl_min_protocol_version` to TLSv1.3 is a separate,
  separately reviewed change, so a connectivity regression has one cause.
