# OTA homelab deployment

Issue [#5841](https://github.com/boardsesh/boardsesh/issues/5841) moves the OTA
server and its databases to a dedicated Debian 13 VM on Proxmox/Ceph. The
committed `infra/ota/hosting.json` is the deployment owner: `railway` during
preparation, `homelab` after the verified cutover. Changing it does not copy data
or switch DNS by itself.

## Client and data contract

Keep `https://updates.boardsesh.com/manifest`, the app ID
`007e6fd7-f200-448c-9449-8d48ba5d51fc`, the production channel, `pr-*` branches,
and the committed signing certificate unchanged. Observe remains at
`/observe/{appId}`. No native release or fingerprint change belongs in this move.

The database migration includes the dedicated Railway **Postgres** service's
`railway` database and ClickHouse's **expo_observe** database. `PostGIS - PG18`
is the application's production primary and is not part of this migration.
ClickHouse is active telemetry and rollout-health storage, including aggregate
tables and materialized views; it must not be discarded as an unused image.

Copy `DB_KEYS_MASTER_KEY_B64` unchanged with the control-plane database. Preserve
the signing keys, JWT secret, admin credentials, application identity and token
state. A newly generated master key cannot unseal the existing signing key.
Keep secrets in the Homelab 1Password item `Boardsesh OTA homelab`; no secret
values belong in a PR, workflow receipt, command log, or this document.

The VM runs dedicated Postgres 18.6 (`plpgsql` and `pg_trgm`), the existing lean
ClickHouse image, and a fresh Redis cache. Shared Railway Redis stays with the
backend. `STORAGE_MODE=s3`, the R2 `boardsesh-ota-v3` bucket and
`https://ota-assets.boardsesh.com` remain unchanged. Keep `BUNDLE_DIFFING=true`
and `BUNDLE_DIFFING_CDN_REDIRECT` unset: full assets redirect to R2, while binary
patches stream through the server with their `im` and `expo-base-update-id`
headers.

## Infrastructure ownership

The private `marcodejongh/blackheathdc-ansible` repository owns the VM, Compose
stack, database backups, firewall, monitoring and tunnel connector. Its OTA
inventory and manual provisioning playbooks are separate from general host
rollouts. The initial allocation is VM 171, `boardsesh-ota.web.lan`,
`172.16.0.171` on VLAN 172, hosted by `ms01-alpha`: 2 vCPU, 4 GiB RAM and 64 GiB
Ceph storage. Provisioning verifies the reservation and live VMID before writing.

One dedicated remotely managed Cloudflare Tunnel targets `http://ota:8080`.
Its connector token lives in 1Password. `infra/cloudflare/config.ts` owns the
proxied CNAME for `updates.boardsesh.com` once hosting switches to `homelab`.
Set its `OTA_TUNNEL_ID` from the created tunnel before cutover; a missing UUID
blocks homelab DNS reconciliation. The ownership switch triggers Cloudflare apply.
Preserve the existing GeoIP header transform, asset compression/cache rules and
the exclusion of the update hostname from crawler challenges. Database ports
and `/metrics` are private. `/hc` and `/ready` remain externally probeable.

For remote administration from a network also using `192.168.1.0/24`, use the
NAS's Tailscale address as the SSH jump host. The overlapping local route is not
evidence that the cluster is down. Do not change local routing to deploy OTA.

## Release and publishing gate

`infra/ota/server.json` declares `version`, `repository` and an immutable OCI
`digest`. The image-bump tool resolves the tag's digest before modifying this
file and the publishing CLI pin together. `infra/ota/server.ts` exports their
typed values. While Railway owns hosting it retains the existing tag reference;
the homelab always runs the declared digest.

`ota-server-deploy.yml` runs only on `main`, on GitHub-hosted runners with the
`Homelab` environment. The existing `HOMELAB_DISPATCH_TOKEN` needs **Contents:
write** and **Actions: read** on the private Ansible repository. Set
`HOMELAB_DEPLOY_ENABLED=true` there before activating homelab ownership. With
homelab ownership, a disabled deployment fails; it cannot silently acknowledge a
required server upgrade. This workflow holds no database or SSH credentials.

Before freezing writers, keep `provider: railway`, set
`HOMELAB_DEPLOY_ENABLED=true`, and manually run **OTA Server Deploy** on `main`.
In this preparation state the sender only GETs the private receiver workflow's
run list and repository artifact list. Both must be readable with the existing
`HOMELAB_DISPATCH_TOKEN`; missing permission, an unregistered receiver or an
invalid response fails the run. A green **credential preflight passed** message
proves those Actions reads without dispatching or changing infrastructure.
Disabled preparation explicitly reports **preflight not run**. This does not
prove Contents-write access, a deployment receipt or public service readiness;
those remain separate cutover checks.

The sender dispatches `boardsesh-ota-release` with
`{source_sha, version, digest, request_id, source_run_url}`. The request ID is
the public workflow's `<run_id>-<run_attempt>`. The receiver verifies that exact
source commit belongs to Boardsesh main, compares its release declaration,
rejects stale or diverged requests, serializes deployment, and records the pin.
It verifies the running digest and service behavior before uploading
`boardsesh-ota-receipt-<request_id>/receipt.json`. The receipt identifies the
request, source SHA, version, digest, receiver run ID, and `status: verified`.

The sender waits for the exact `Boardsesh OTA <request_id>` receiver run and
validates its receipt. An accepted dispatch (HTTP 204), another successful run,
or a missing receipt never proves deployment. Budgets are 10 minutes to appear,
80 minutes for the receiver, 95 minutes for the sender and 100 minutes for its
outer workflow. The publishing gate allows 110 minutes on homelab, and retains
Railway's existing 85-minute wait before cutover.

`mobile-ota-server-ready.mjs` selects the provider's workflow at the publishing
commit. On homelab, it finds the latest deployment-input change on main's first
parent history, then waits for a successful main push run at that change or a
later ancestor of the publisher. That run's source hosting and release declaration
must match the publisher's version, repository and digest. The sender's success
proves the exact receiver receipt for that source. A mobile-only commit therefore
waits for an earlier pending upgrade; a multi-commit push is acknowledged at its
push head. A newer eligible run must finish even if an earlier run succeeded.
The lookup is bounded to the latest 100 main push deployment runs and fails
closed if no qualifying deployment can be found. Before cutover, Railway keeps
its exact-commit gate and uses the push's `before` SHA to detect multi-commit
changes. Trigger paths match both workflows. Failure, cancellation, timeout,
skipped deployment or a required missing run blocks publishing. A failed deployment may have applied database migrations: fix forward
or explicitly restore matching databases and image; do not blindly downgrade.

## Cutover

1. Assign #5841, prepare both repositories, and merge the receiver and portable
   release code while `provider` remains `railway`. Verify the dispatch token's
   permissions and rehearse the local isolated restore and acceptance checks. The
   receiver dispatch requires homelab ownership and is verified after that switch. Provision
   the stack with OTA and the public connector disabled until restored data is
   ready. Create the tunnel without changing the production DNS record.
2. Rehearse `pg_dump`/`pg_restore` and native ClickHouse `BACKUP`/`RESTORE` into
   isolated destinations. Include migration metadata, materialized views and
   aggregate state. Verify restored schema and logical totals, signed production
   manifests for existing iOS/Android runtimes, asset hashes and differential
   downloads. Do not publish, collect production telemetry or run cleanup against
   the rehearsal copy. Measure the full transfer and recovery procedure.
3. Freeze and drain publishers, rollout controllers, preview cleanup and OTA
   upgrades. Disable and drain **Railway Config** before fencing Railway: an old
   workflow rerun checks out historical code and can still redeploy the retained
   service despite the new provider filter. Stop the old OTA process, including
   its background jobs and health projectors, and fence every listener, including
   its Railway-generated hostname. Network fencing alone does not stop database
   writes. Then take final consistent backups.
   The agreed OTA-only interruption is at most **30 minutes**. Abort back to the
   fenced source's normal operation before accepting new writes if that budget
   cannot be met.
4. Restore final data, start healthy dependencies before OTA, and verify the
   restored signing identity, readiness, manifests and Observe history. Activate
   `provider: homelab` and apply the tunnel DNS record only at this controlled
   cutover. Verify the exact release receipt and public endpoints, then unfreeze
   publishing and Observe ingestion. Measure manifest latency from a US GitHub
   runner and record it below. Keep the old server fenced.
5. Observe **seven clean days** and test recovery. Keep old Railway databases and
   volumes intact. Before re-enabling Railway automation, prevent historical
   workflows from changing the retired services (remove their mutating credential
   path or keep Railway Config disabled through retirement); the provider filter
   only protects runs of new code. Obtain explicit confirmation before deleting
   exactly `boardsesh-ota-v3`, `boardsesh-ota-clickhouse`, dedicated `Postgres`,
   and their database volumes. Keep the ClickHouse image used by the homelab.

## Backups, rollback and evidence

The private R2 bucket `boardsesh-ota-backups` has no public custom domain or
`r2.dev` access. Hourly Postgres and daily ClickHouse backups use `scheduled/`
and expire after 14 days. `rehearsal/` and `cutover/` do not expire automatically;
keep cutover copies until retirement completes. The VM also participates in the
existing nightly Proxmox backup job. Restore drills must prove the databases
and their unchanged master key work together.

Before the homelab accepts writes, rollback restores the Railway route and
unfences its server. After any homelab writes, freeze writers and reverse-copy
the latest databases into fresh Railway destinations before switching DNS.
Switching DNS alone would discard publications, token changes, and telemetry.

The owner explicitly waived the issue's UPS/NUT prerequisite on 2026-11-20.
Backups and restore checks remain required; UPS protection is not represented
as installed or proven.

Record cutover time, source and destination release digests, backup IDs and
checksums, restore timings, schema/data checks, signed-manifest and asset checks,
Observe ingestion/history checks, US manifest latency, reboot recovery, and the
earliest retirement date in #5841 and the private Ansible runbook. Until those
checks are recorded, this document describes the migration procedure, not proof
that the live service has moved.
