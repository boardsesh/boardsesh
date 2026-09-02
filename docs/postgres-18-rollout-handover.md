# PostgreSQL 18 rollout — handover

State as of 2026-08-23, `main` at `6a699e564`. Written to move this to a machine that can run Docker.

Everything up to and including image publication and consumer pinning is **done and merged**. Nothing has touched the Railway production database except one read-only audit. The remaining work is the production cutover, and it is blocked on two things this machine could not resolve.

---

## 1. What is merged

| PR                                    | What                                                    | Merge commit                               |
| ------------------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| #4497                                 | Trusted PostgreSQL image publisher                      | `577c5c021`                                |
| #4474                                 | PG18 producer A — migration and cutover tooling         | `a5795a08eee7514986339e3278e791248a40b222` |
| #4695                                 | Consumer B — pin every consumer to the attested digests | `6a699e564`                                |
| marcodejongh/blackheathdc-ansible#344 | Homelab PostgreSQL standby and DR                       | merged                                     |

### Published images — these are the accepted artifacts

Publisher run [32616607289](https://github.com/boardsesh/boardsesh/actions/runs/32616607289), source `ca308bd225519bd1062dfdbab288e7b063e253c9`.

| Image                                                                 | Digest                                                                    | Platforms     | Attestation                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------- |
| `ghcr.io/boardsesh/boardsesh-postgres-postgis` (portable, production) | `sha256:4ebf346a8407761a86cb21998a81b4848080ed1d2fd72afdcf968eda02b12713` | amd64 + arm64 | [44607477](https://github.com/boardsesh/boardsesh/attestations/44607477) verified |
| `ghcr.io/boardsesh/boardsesh-dev-db` (seeded, dev/CI)                 | `sha256:f776350fa627c626f4d70bbf6bb0451e27ff6b1c8ccf6d02220e0b2d261ee058` | amd64         | [44607481](https://github.com/boardsesh/boardsesh/attestations/44607481) verified |

Handoff artifact copied to `docs/postgres-image-digests.json`. It records `deployment_identity: "digest-only"` and `tags_are_mutable: true` — a `sha-<commit>` tag is a lookup aid, never a deployment pin.

### Repo configuration applied

- Environment `postgres-image-publisher`: required reviewer `marcodejongh`, `can_admins_bypass=false`, custom branch policy of exactly `main`.
- **`prevent_self_review = false`** — a deliberate, accepted risk. Single maintainer, and a GitHub App cannot be an environment reviewer. The three audits now require the field to be present and boolean rather than `true`, so a missing or reshaped API field still fails closed, and the mutation test was retargeted rather than deleted. Rationale in `docs/postgres-image-publishing.md`. Flip it back to `true` the moment a second reviewer exists — no code change needed.
- Repo variable `RETIRED_DB_IMAGE_DIGESTS = none`.

---

## 2. Open work

### PR #4475 — snapshot fencing (green, ready for review)

**28 passing, 0 failing** at `c9579a444`. Migration renumbered to **0205** after main took 0200-0204, and main has not moved past it. No unresolved review threads; `mergeStateStatus` is `BLOCKED` only on `REVIEW_REQUIRED`, so a human approval is the last thing it needs.

Two things worth knowing before touching it:

- The journal entry kept its original `when`, older than main's newest. Both appliers order by `when`, so it would have been **silently skipped** — not a loud failure. `check:db-migrations` caught it; restamped by hand following `db-renumber`'s own `nextWhen` convention. See issue #4696: `check:db-migrations` tells you to run `vp run db:renumber`, but that tool only inspects the migration _number_ and no-ops on a stale `when`.
- `test-location-sync-integration` was red for the whole rollout because it ran on PG17. Consumer B fixed it — it now passes.

### Consumer B left `vp run db:up` broken — fixed separately

#4695 pinned `docker-compose.yml` to the seeded digest but not the PG18 storage contract: the volume stayed mounted at the PG16 `/var/lib/postgresql/pgdata`, and `scripts/dev-db-up.sh` kept looking for `pg_hba.conf` under that dead path, so the script died before migrations ran and the seeded cluster was thrown away with the container. No CI job noticed because none of them use either file. Fixed in #4698 — worth knowing about because it is the first thing anyone picking this up will run.

### Branch `agent/split-seeded-image-publisher` — reviewed, three P2s open

Tip `5c1ccfdd7`. Splits the seeded dev image into its own publisher workflow (issue #4694). Contract suite **157/157**.

An independent security review ran and returned **CHANGES_REQUIRED**, but the trust boundary itself came back intact in both workflows. It re-derived every hash with the file's own algorithm and found exactly 12 changed — 6 run bodies, 5 job hashes, and `CONTRACT_WORKFLOW_METADATA_SHA256` for the added trigger path. `validate-main`, `smoke-portable` and `smoke-seeded` hash identically to their pre-split values, which is good evidence the reviewed text was moved rather than retyped.

Its P1 was about the commit, not the code: an earlier commit here snapshotted the worktree while the agent was still writing, so the tip was missing the eight lines that stop the two publishers re-coupling — the `forbiddenIdentifiers` loop and the `setup-qemu-action` ban for the amd64-only seeded image. Fixed in `5c1ccfdd7`; suite re-run green. Worth knowing as a general hazard: committing an agent worktree mid-run can capture a partial state that still looks coherent.

Three P2s remain before merge:

1. Both publishers validate both Dockerfiles, deliberately, to keep two privileged run bodies byte-identical and hash-shared. Fail-closed, but it means removing or relocating either Dockerfile breaks **both** publishers — document it in the `validate-main` bullet.
2. Both publishers declare `environment: postgres-image-publisher`, so the seeded developer publisher holds the same environment-scoped OIDC identity as the production one. Nothing currently trusts it beyond GitHub's attestation API, but any future external trust policy must key on `job_workflow_ref`, never on the environment name.
3. `vp check` is red on the branch with two `TS2339` errors in `scripts/expo-web-e2e.ts` (`Property 'unref' does not exist on type 'number'`). **Confirmed pre-existing** — both reproduce at `scripts/expo-web-e2e.ts:40` and `:84` on a docs-only branch off `main`, so the split does not introduce them. It is DOM-vs-Node `setTimeout` typing and belongs in its own fix. Note CI's `lint` job does not report them, so whatever selects the `scripts/` project differs between a local run and CI — worth understanding before trusting a local `vp check` as the gate.

### Filed issues

| Issue                                                       | What                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [#4508](https://github.com/boardsesh/boardsesh/issues/4508) | Build dev-db from offline snapshots instead of scraping six APKs from a third-party mirror |
| [#4513](https://github.com/boardsesh/boardsesh/issues/4513) | Teardown wedges on a disabled subscription — bites during the WAL emergency itself         |
| [#4514](https://github.com/boardsesh/boardsesh/issues/4514) | Rename the Neon-era replication script (landed — see below)                                |
| [#4694](https://github.com/boardsesh/boardsesh/issues/4694) | Split the seeded image out of the production publish path                                  |
| [#4696](https://github.com/boardsesh/boardsesh/issues/4696) | `db:renumber` no-ops on a stale `when` that `check:db-migrations` rejects                  |

The #4514 rename has landed: `scripts/neon-to-railway-replication.sh` is now `scripts/postgres-logical-replication.sh` (same for its `.test.sh`), with all 11 referencing files updated together — the workflow path filter and contract file list must move together because `scripts/postgres18-workflow-contract.test.sh` fails closed on a half-done rename. The rename was originally deferred until after the cutover so an operator would never reach for a script name that had moved out from under them mid-run; landing it early was a deliberate reversal of that call, made while the cutover had not started (no replication run has ever executed against production, so no operator history or printed runbook names the old path) and after the prepared patch went hard-broken — its `vite.config.ts` hunk anchored on an inline command that later moved into `scripts/postgres18-contract.sh`, which red-flagged the `pg18-artifacts` job on every DB-path PR in the queue. The patch was deleted with the rename; the drift guard in `scripts/__tests__/pg18-artifact-drift.test.ts` now treats zero committed patches as the healthy state. The `NEON_*` environment variables were kept — the script already accepts `SOURCE_DATABASE_URL` / `SOURCE_REPLICATION_DATABASE_URL` as the generic spellings.

---

## 3. Production audit — read-only, 2026-08-23

No credential appears anywhere in this file. Everything below is read-only configuration output: a system identifier is minted by `initdb`, authenticates nothing, and is the only cheap way for the next operator to prove the cluster being cut over is the one audited here — a Railway service recreate mints a new one and silently invalidates every number in this section.

Credentials came from 1Password `Boardsesh` vault, item **`RAILWAY Postgres PROD (readonly)`**, used via a mode-0600 passfile and deleted afterwards. Naming the item is deliberate: it stops the next operator minting a second, untracked readonly credential. The same convention is already published in `docs/aurora-sync.md` and `packages/aurora-sync/.env.1password`. Nothing was mutated.

|                                             |                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------- |
| Version                                     | **PostgreSQL 16.9** (Debian, x86_64)                                  |
| System identifier                           | `7635874554056458274`                                                 |
| Database                                    | `railway` (canonical, matches the runbook)                            |
| Size                                        | 11 GB                                                                 |
| Encoding / collate / ctype                  | UTF8 / en_US.utf8 / en_US.utf8                                        |
| `data_checksums`                            | **off**                                                               |
| `wal_level`                                 | **replica**                                                           |
| `max_replication_slots` / `max_wal_senders` | 10 / 10                                                               |
| PostGIS                                     | **3.7.0dev** (`3.6.0rc2-339-g6d7299047`), GEOS `3.15.0dev`            |
| Publications / replication slots            | none — clean slate                                                    |
| Roles (non-system)                          | `postgres` (superuser), `boardsesh_readonly`                          |
| Schemas                                     | `public` 464, `tiger` 120, `neon_auth` 30, `topology` 10, `drizzle` 3 |

Railway runs the database from image `postgis/postgis:16-master` **with auto-updates enabled** — a mutable dev tag on production.

---

## 4. The two blockers

### Blocker 1 — `wal_level = replica`

Logical replication needs `wal_level = logical`. Changing it requires a **restart of the Railway Postgres service**, i.e. a short production outage before any migration work starts. `max_replication_slots` and `max_wal_senders` are already 10, so nothing else needs changing.

### Blocker 2 — PostGIS version

Production is on `3.7.0dev`; the attested image ships stable **3.6.4**. `docs/postgres-18-migration.md` §1 blocks the catalog audit unless both sides match, on the basis that a downgrade is not assumed wire-compatible.

**The gate is four enforcement points, not one.** Budget the work accordingly:

| Where                                         | What it compares                                               | Knob                       |
| --------------------------------------------- | -------------------------------------------------------------- | -------------------------- |
| `scripts/postgres-migration-audit.sh:1771`    | source `pg_extension.extversion` vs `EXPECTED_POSTGIS_VERSION` | `EXPECTED_POSTGIS_VERSION` |
| `scripts/postgres-migration-audit.sh:2024`    | target, same comparison                                        | `EXPECTED_POSTGIS_VERSION` |
| `scripts/postgres-migration-audit.sh:1943`    | whole-extension manifest, source vs target, version included   | none                       |
| `scripts/postgres-logical-replication.sh:1412` | same manifest, as a hard `fail` before any restore             | none                       |

Note that `docs/postgres-18-migration.md` §1 says "There is no override flag", but `postgres-migration-audit.sh:16` is `EXPECTED_POSTGIS_VERSION="${EXPECTED_POSTGIS_VERSION:-3.6.4}"` and documents it at `:87` as an optional control. It relaxes the first two rows only; the manifest comparisons have no knob at all. That contradiction is corrected in the runbook alongside this handover.

`tiger` / `topology` are not simply ignorable either. Leaving them off the target trips three independent gates — `unclassified_schemas()` at `:1263`, the cluster-wide extension manifest at `:1943` (which has no allowlist mechanism), and `assert_superuser_catalog_precreated` before the dump even starts. Dropping them on the **source**, where they hold 0 live tuples, is the only path that satisfies all three unchanged.

**PGDG has no stable 3.7 for PG18.** Available for `postgresql-18-postgis-3` on `bookworm-pgdg/amd64`:

    3.6.2+dfsg-1.pgdg12+1
    3.6.3+dfsg-1.pgdg12+1
    3.6.4+dfsg-2.pgdg12+1   <- newest, what the image ships

So "upgrade the target to match" is not possible from packages. Production is only on a dev build because the service tracks the `master` tag.

**But the actual exposure is tiny.** Full spatial usage in the app schemas:

| Column                        | Type                    | Rows | Populated |
| ----------------------------- | ----------------------- | ---- | --------- |
| `public.gyms.location`        | `geography(Point,4326)` | 4875 | 3114      |
| `public.user_boards.location` | `geography(Point,4326)` | 6375 | 3318      |

Two partial GiST indexes:

    gyms_location_idx              USING gist (location) WHERE deleted_at IS NULL AND is_public = true
    user_boards_location_gist_idx  USING gist (location) WHERE is_public = true AND deleted_at IS NULL

No geometry, raster or topogeometry columns anywhere. And `tiger` / `topology` are **empty scaffolding** — `tiger.geocode_settings` has 0 rows, 0 live tuples across `tiger`, `tiger_data`, `topology`. Not installing those two extensions on the target removes 130 objects from the migration surface.

`geography(Point,4326)` plus GiST is among the oldest and most stable parts of PostGIS, unchanged in API and storage across 3.x. Nothing here uses a 3.7-only feature.

**Open decision, not taken.** Three candidate paths, no consensus reached:

1. Keep the target at 3.6.4 and narrow the audit from "versions equal" to "target supports every spatial type and function actually in use", failing loudly if new spatial usage appears.
2. Prove it by restoring a real Railway dump into the attested PG18/3.6.4 image and confirming both geography columns, their data, and both partial GiST indexes survive. This doubles as the §4 rehearsal the checkpoint needs. **This is the natural first task on a machine with working Docker.**
3. Treat the dev-build drift as the actual bug: pin the Railway service to a stable PostGIS 16 image with auto-updates off, then revisit.

---

## 5. What to do next

1. **Fix [#4513](https://github.com/boardsesh/boardsesh/issues/4513) before any replication run.** `teardown` disables the subscription and then drops it as two autocommitted statements; if the drop fails because the publisher is unreachable — the same incident that made you run teardown — the subscription is left disabled, and `assert_subscription_contract` requires `subenabled`, so a re-run refuses to drop anything while the source keeps retaining WAL. This is the one filed issue that bites _during_ an emergency rather than during development, and the fix is one contract predicate.
2. **Pin the Railway Postgres image with auto-updates off, before anything restarts it.** The service tracks the mutable `postgis/postgis:16-master` tag, so a restart can silently pull a newer `3.7.x-dev` and invalidate every number in §3 and in `docs/postgres-18-postgis-audit.md`. This has to precede step 4.
3. **Rehearse the restore** (§4) and **decide Blocker 2** on that evidence. Verify the two geography columns, their row counts, and both partial GiST indexes survive into `ghcr.io/boardsesh/boardsesh-postgres-postgis@sha256:4ebf346a…`.
4. **Schedule the `wal_level` restart** with the write interruption it implies. Confirm no `production-deploy` run is queued or executing first: a restart during its `migrate` job fails that job, and the `production-deploy` concurrency group then holds main until someone re-dispatches. `/health` is Redis-governed and will not flap; `/health/db` is the alertable endpoint.
5. **Run the PG16 role transition** (`docs/postgres-18-migration.md` §"Ordered PG16 production-role transition"). **This is the blocking security item, not a housekeeping step:** none of `boardsesh_owner`, `boardsesh_runtime` or `boardsesh_migrator` exist yet, so until it runs, any leaked connection string is full cluster control rather than a scoped role. Confirm the current identity first with a read-only `SELECT current_user, usesuper FROM pg_user WHERE usename = current_user;` — that the app connects as `postgres` is inferred from the role list, never observed. `scripts/postgres18-production-role-transition.sh` has bounded `lock_timeout`, a wall-clock hold ceiling, and a long-running-transaction pre-flight — validated against a real PG16 in CI.
6. **Then** the Phase 4 checkpoint, then replication.

### Publishing again — read this first

The publisher binds to the exact live `main` head and rechecks before registry login, before OIDC attestation, and before the digest artifact upload. The recheck happens **after both image builds**.

Measured: portable **1 m 39 s**, seeded **16 m 52 s**, ~19 min dispatch to recheck. Observed cadence on `main` is ~1 commit per 24 minutes, and every merge also fires an automated `chore(changelog)` commit.

Two attempts were lost to this before the third succeeded behind a deliberate merge freeze:

| Run         | SHA         | Outcome                                                                                                           |
| ----------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| 31924828661 | `a5795a08…` | aborted at the pre-auth recheck; main moved during the ~2 h approval wait. Never authenticated, nothing published |
| 31929880126 | `b61480a1…` | main moved before approval could be given; cancelled                                                              |
| 32616607289 | `ca308bd2…` | **success**                                                                                                       |

So: announce a freeze, dispatch, approve within a few minutes, and expect a second approval prompt for the attestation job. Do not weaken the exact-main guard — re-dispatch for the new head instead. #4694 exists to shrink this window.

---

## 6. Environment notes from this machine

Things that cost time here and may not apply on the new machine:

- **Docker was entirely unusable.** The VM stopped booting — every command returned `Bad response from Docker engine`; `dockerd.log` showed `healthcheck failed fatally` and containerd `setns` errors. A full Docker Desktop restart did not recover it. `Docker.raw` was 119 GB against 34 GB free host disk. Reclaiming 48.8 GB of build cache did not help. This blocked the dev-db image build, the `postgres18-image` smoke, and the ansible offline suite at ansible-core 2.16.3 — all of which CI ran instead. **Resolved** — Docker Desktop has since been reset and the engine is healthy. What remains is that `psql`/`pg_dump` are not installed at all; run the catalog tooling from inside the portable image instead, the way `scripts/postgres18-image-smoke.sh:846-871` already does.
- **`grep` here is `ugrep`, not GNU grep**, and `/usr/bin/grep` is BSD. Two real portability bugs came from this class: `stat -f` is BSD-only (on GNU, `-f` means `--file-system`), and the runners have no `ripgrep` at all. That second one was worse than a broken test — the credential test's argv guard was _fail-open_ in CI, because an empty result from a missing binary is indistinguishable from "no forbidden match".
- **Local `psql` is 14.22**, connecting to a PG16 server. Fine for the audit queries used, but worth upgrading before the cutover.
- A fresh git worktree needs `vp install --frozen-lockfile` before `vp` will run.

## Release Notes

none
