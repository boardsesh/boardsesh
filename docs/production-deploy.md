# Production deploys: the concurrency group, and what to do when main stops shipping

`production-deploy.yml` is the only production deployer (Vercel's native git
auto-deploy is off). Every push to `main` starts a run; the run builds web and
backend in parallel, gates on both builds passing, migrates, then deploys.

## Architecture during the cut-over

www (`packages/web`) is moving off Vercel onto a Railway container (epic
#4648). While that move is in progress, production is four services, each
answering to a different platform:

| Service                       | Runs on                                                      |
| ------------------------------ | ------------------------------------------------------------- |
| Web (`packages/web`)           | Vercel today; the Railway `web` container after the DNS flip. |
| Backend (`packages/backend`)   | Railway.                                                      |
| `app.boardsesh.com`            | Cloudflare Pages.                                              |
| Database                       | Railway PostgreSQL.                                            |

Every run of `production-deploy.yml` follows the same shape: `resolve-web-targets`
decides which web deployers this run is allowed to use, `build-web` and
`build-backend` build in parallel, the gated `migrate` job runs once every
attempted build has passed, and only then do the deploy jobs run —
`deploy-web` (Vercel), `deploy-web-railway` (Railway), and
`deploy-production-backend`. Which of the two web deploy jobs actually run is
controlled by the `WEB_DEPLOY_TARGETS` Production-environment variable — see
the table in [Web deploy targets](#web-deploy-targets) below.

## Web deploy targets

www has two possible deployers. Production traffic is on Vercel today; the
Railway `web` service (image `ghcr.io/boardsesh/boardsesh-web`, config
`railway.web.toml`) runs alongside it before the DNS flip. After the flip,
Railway deploys alone and the last-good Vercel deployment stays frozen as the
rollback for seven days. The Production-environment variable
`WEB_DEPLOY_TARGETS` picks which ones run:

| `WEB_DEPLOY_TARGETS` | Vercel | Railway | Notes                                          |
| -------------------- | ------ | ------- | ---------------------------------------------- |
| unset or empty       | yes    | no      | The default. Today's behaviour.                |
| `vercel`             | yes    | no      | Same, written out.                             |
| `railway`            | no     | yes     | Needs the Railway service ID and smoke origin. |
| `vercel,railway`     | yes    | yes     | Either order; whitespace and casing ignored.   |
| `none`               | no     | no      | The web hold. Discord gets `notify-web-held`.  |

Anything else — an unknown or empty list entry, `none` mixed with a real
target, a non-UUID `RAILWAY_WEB_SERVICE_ID`, or a `RAILWAY_WEB_ORIGIN` that is
not a direct HTTPS `*.up.railway.app` origin — fails `resolve-web-targets`,
which skips every web deploy and fires `notify-failure`. The resolver publishes
the validated service ID and origin as outputs; deploy jobs never reread the raw
variables after that point.

The GHCR image is built and pushed on **every** run regardless of the setting,
including under `none` and under an active Instant Rollback. The image is the
artifact; publishing it costs nothing and is what lets a later `railway
redeploy` promote without a rebuild.

`WEB_DEPLOY_TARGETS` is read by a job (`resolve-web-targets`) rather than by a
job-level `if:`, and that is load-bearing: a job-level `if:` is evaluated before
the environment is attached, so `vars.` there only ever sees **repository**
variables. An environment-scoped setting read that way would silently resolve to
empty.

Like every job in this workflow that reads Production-environment config,
`resolve-web-targets` declares `environment: Production` and so can park at the
environment gate the same way any other job can — see [The watchdog](#the-watchdog)
below for what that looks like and how it clears.

Production-environment config this needs:

| Name                     | Kind | Purpose                                                                    |
| ------------------------ | ---- | -------------------------------------------------------------------------- |
| `WEB_DEPLOY_TARGETS`     | var  | The switch above. Absent is fine — it means `vercel`.                       |
| `RAILWAY_WEB_SERVICE_ID` | var  | The Railway `web` service. Required before targeting railway.               |
| `RAILWAY_WEB_ORIGIN`     | var  | Direct `https://*.up.railway.app` smoke origin; custom domains are rejected. |

## Railway deploy identity and automatic recovery

Both Railway services use `.github/actions/railway-redeploy`. Before changing
anything, the action finds the latest successful deployment, verifies that its
`meta.image` exactly matches the image the workflow just built, and snapshots
the deployment IDs already present. This catches a web/backend service-ID swap
before it can mutate production. Application sleeping must remain disabled for
both services; the action refuses a `SLEEPING` baseline because it cannot prove
which sleeping deployment is the current rollback target. The action accepts
uppercase or lowercase UUID hex and normalizes service IDs to lowercase before
passing them to Railway's case-sensitive operations.

The action downloads the immutable Railway CLI v4.66.0 Linux X64 release asset,
checks its reviewed SHA-256 digest before extraction, and runs
`redeploy --from-source`; plain `redeploy` reuses the prior deployment snapshot
and does not resolve a moved image tag. The CLI must return its exact reviewed
JSON acknowledgement; a timeout, command failure, or malformed response emits
a dedicated reconciliation error, skips smoke, and stops without guessing
which deployment to recover. After a confirmed trigger, the action accepts
exactly one new deployment, verifies the same image, locks that
deployment ID, and polls only that ID. It requires three consecutive `SUCCESS`
list reads before returning so a delayed concurrent deployment cannot hide
behind an early success. Railway marks a queued deployment `CANCELLED` when a
newer one supersedes it, so exactly one superseded queue entry sitting beside
exactly one live successor counts as one redeploy, not two: the action ignores
the cancelled row and locks the live successor, and the post-lock fence ignores
it too. A cancelled row with no live successor visible is quarantined by ID
across the next polls and, if nothing succeeds it, fails without automatic
recovery — the successor may simply not be visible yet, and a rollback then
would race it. Two cancelled rows, multiple live new deployments, a cancelled
locked deployment, or an unknown status fail closed without automatic recovery.
Three consecutive read failures or a timeout before an exact lock do the same;
after a validated exact lock, they may enter the verified rollback preflight,
which rechecks that deployment as the sole newest row before mutating. CLI and
GraphQL calls have their own timeouts, and failure logs never dump raw production
output into GitHub.

After a confirmed trigger, transport failures while reading the deployment list
get three bounded tries. A readable list with a wrong image, timestamp,
identity, or candidate count is an identity failure and is not retried: waiting
for the rows to change could make the workflow adopt a different deployment
than the one it triggered.

Once the action has locked the exact new deployment ID, a known failed terminal
status, bounded read failure, timeout, or hard smoke failure can restore the
captured deployment through the shared `railway-rollback` action. If the
trigger response is ambiguous, the locked identity changes or disappears, the
locked deployment is cancelled, or no sole safe ID can be locked, recovery
deliberately stops instead of guessing; reconcile the service in Railway before retrying.
The helper requires Railway's
`canRollback=true`, requires the failed deployment to remain the sole newest
deployment, sends the project token with `Project-Access-Token`, and calls
Railway's Boolean rollback mutation once. It then discovers exactly one
post-mutation deployment and verifies its exact scope and target image before
requiring Railway to report that ID as both latest and solely active.

The preflight refuses visible in-flight or intervening successful deployments,
and post-mutation polling refuses any new concurrent ID. Railway does not offer
an expected-current compare-and-swap on this mutation, so do not start a manual
Railway deploy while the production workflow is running. A dashboard mutation
that lands in the final read/mutation race can make both deployments start; the
workflow detects the extra ID and stops, but cannot atomically prevent it.
The exclusion window begins when **Capture the last-known-good Railway
deployment** starts, not when the later CLI trigger runs, and lasts until the
action finishes or the reconciliation steps below declare the service quiet.

### Ambiguous trigger reconciliation

If **Trigger Railway redeploy from the configured image source** times out,
fails, or returns anything except the exact success acknowledgement, Railway
may still have accepted it. The action deliberately does not guess at a new ID
or fire a rollback mutation in that state.

1. Do not rerun the workflow. For web, set `WEB_DEPLOY_TARGETS=none`. Do not
   merge another production change; cancel only runs that are still queued and
   have not entered migration or deployment.
2. Open the affected Railway service's deployment list. Use the capture step's
   timestamp, previous deployment ID, and baseline IDs to identify every row
   created after capture, including `CANCELED` or `CANCELLED` rows.
3. If there is no post-capture row and the service is quiet, clear the web hold
   if applicable and rerun the failed workflow.
4. If there is exactly one live post-capture deployment, verify its service,
   environment, image, and commit, wait for it to finish, then run the same
   public smoke manually. Roll it back from the Railway dashboard to the
   captured previous deployment if any identity or smoke check fails.
5. If multiple live rows exist, the image is unclear, or the service is still
   changing, use Railway's dashboard to restore the captured previous
   deployment. Wait until it is the sole active successful deployment before
   clearing the hold or retrying CI.

The live smokes use the same recovery path. They bind both Railway's deployment
ID and the image's immutable `github.sha`. The backend smoke requires the exact
identity, a healthy `/health` response, the shipped GraphQL schema, and both
board-render cache paths. Postgres reachability is diagnostic data in `/health`;
a required Redis disconnect is unhealthy. Smoke makes up to 12 attempts at
five-second intervals before a persistent failure restores the prior backend. A
Railway-only web mismatch or functional smoke failure restores the prior web
deployment, verifies the restored service's functional surfaces, and then turns
the job red. During the dual Vercel/Railway shadow period, the Railway smoke
remains informational because Vercel still serves www, so it reports a warning
without changing the shadow service. Dual-target mode is pre-cutover only: never
leave it set after Railway owns DNS.

### Single replica (web)

The Railway web service runs **exactly one replica**. Off Vercel, Next's
`unstable_cache` and `revalidateTag` are per-instance: a second replica would
serve its own divergent cache, and a `revalidateTag` on one would leave the
other stale with nothing to reconcile them. Keep it at one replica until a Redis
`cacheHandler` exists (#4658). Scale the backend horizontally instead — it is
stateless and coordinates through Redis.


### Railway custom-domain verification (learned the hard way, 2026-09-01)

Railway attaches a custom domain only after TWO records exist, and its API
reports only one of them:

1. The CNAME (`www` → `<target>.up.railway.app`) — the only record
   `domain-status` ever lists. Behind the Cloudflare proxy it is invisible to
   Railway's checker, but that does not matter given record 2.
2. An ownership TXT: `_railway-verify.<host>` = `railway-verify=<token>`,
   shown **only in the Railway dashboard's domain panel**. Without it the
   domain sits at `verified: false` forever — while `domain-status` shows the
   DNS as `PROPAGATED` and the certificate as `VALIDATING_OWNERSHIP` with no
   error. The certificate may even be issued and waiting; the host simply
   never attaches, and Railway's edge serves `Application not found` (404)
   for the hostname.

TXT records pass through the Cloudflare proxy, so the domain verifies with
the proxy ON: no DNS-only toggle is needed, and the proxied flip is safe once
the TXT exists. Add the TXT (and confirm `verified: true`) BEFORE merging any
origin-flip PR, and never delete the `_railway-verify.*` records — `www`,
`updates` and `ota` each keep one.

## Deployment teardown (draining)

Railway's draining time — the gap between SIGTERM and SIGKILL on the outgoing
deployment — [defaults to **0 seconds**](https://docs.railway.com/deployments/deployment-teardown#draining-time).
Both signals arrive together, so an old replica is killed with requests still in
flight and the caller gets a severed response. Behind the Cloudflare proxy that
surfaces as a **504**, which is how this was found: a mobile sign-in against
`POST /auth/native/credentials` failed during a backend cutover.

`drainingSeconds` is set in config-as-code for both services:

| Service | File | Value | Force-exit timer |
| --- | --- | --- | --- |
| `boardsesh-backend` | `railway.toml` | 15s | 10s (`FORCE_SHUTDOWN_TIMEOUT_MS`) |
| `boardsesh-web` | `railway.web.toml` | 10s | none (Next owns the handler) |

**It must be an unquoted number.** `railway.schema.json` types the field as
`{"type": "number"}`. The prose docs at docs.railway.com show it quoted
(`"drainingSeconds": "10"`), contradicting their own schema — a string risks
being rejected and silently restoring the 0s default, which looks identical to
having configured nothing. `shutdown.unit.test.ts` fails on a quoted value.

Backend draining must stay **above** `FORCE_SHUTDOWN_TIMEOUT_MS`
(`packages/backend/src/shutdown-timing.ts`). Railway SIGKILLs once the window
closes, so a force timer above it would never fire and the process would die
mid-flush instead of exiting on its own terms. That invariant is pinned by a
test.

### Stop accepting before the slow teardown

`packages/backend/src/index.ts` starts `httpServer.close()` **first**, then tears
down the WebSocket server, then awaits the HTTP close. The order is deliberate.

`wss.close()` does not resolve until every client is gone — the server is
attached with `options.server`, so `ws` waits on `clients.size` — and a peer that
never answers our close frame holds it for ws's 30s `closeTimeout`, three times
`FORCE_SHUTDOWN_TIMEOUT_MS`. If the listener were only closed after that, one
stuck WebSocket would leave the process accepting new HTTP requests right up to
the force exit that then severs them: the very failure draining exists to stop.

Note that `close()` stops the listener but its callback waits for open
connections, so starting it early costs nothing. There is deliberately **no**
`closeIdleConnections()` call — since Node 19 `close()` drops idle keep-alive
connections itself, and we pin Node 22. (Verify with a keep-alive agent against
a throwaway server: `close()` alone settles in ~1ms.)

A successful graceful shutdown logs `HTTP server closed` and `Database pools
closed`. If those never appear, the window is not being honoured.

### The web service relies on Next's own handler

Next registers its own SIGTERM handler
(`dist/server/lib/start-server.js`), which calls `server.close()` and then
`nextServer.close()`, `flushAllTraces()` and `process.exit(143)`. Because Node
closes idle connections on `close()`, that settles once in-flight renders finish,
so the web replica drains and exits on its own inside the window.

Next calls `server.closeAllConnections()` only when `isDev`, and the generated
standalone `server.js` runs with `isDev: false` — but that is correct for
production: `closeAllConnections()` would kill *active* requests for a fast dev
restart, which is the opposite of draining. No custom handler is needed, and
writing one would mean owning the entrypoint (`NEXT_MANUAL_SIG_HANDLE` plus a
hand-written server) since the standalone `server.js` is generated at build time.

### No overlapSeconds

`overlapSeconds` (the other teardown knob) keeps both deployments serving at
once. It is deliberately unset. Overlap would double the backend's Postgres
footprint — 5 replicas x `DB_POOL_MAX` 10 — against a shared `max_connections`
of 200 that has been exhausted before (see
[db-connectivity.md](./db-connectivity.md)). Railway only sends SIGTERM once the
replacement deployment is already healthy, so there is no capacity gap for
overlap to cover; draining alone addresses the severed-request case.

## Cut-over sequence

Moving www's production traffic from Vercel to Railway happens in order, one
step at a time:

1. Set the Production-environment variable `WEB_DEPLOY_TARGETS=vercel,railway`.
   Both `deploy-web` and `deploy-web-railway` now run on every push, but Vercel
   still serves `www.boardsesh.com` — Railway is only building and shipping
   alongside it.
2. Set `RAILWAY_WEB_ORIGIN` to the service's direct
   `https://<service>.up.railway.app` origin, then verify the post-deploy smoke
   passes there ahead of any DNS change. Custom domains are deliberately rejected
   so stale DNS, redirects, or CDN caches cannot satisfy deployment identity.
3. Set `WEB_DEPLOY_TARGETS=railway` and let one deployment complete before the
   DNS change. This makes every later Railway smoke failure a hard failure with
   verified recovery; target membership must never be used as a proxy for who
   owns live traffic.
4. Flip `www.boardsesh.com` at Cloudflare to the Railway origin. Production
   traffic now serves from Railway. Keep the last Vercel deployment available
   but frozen for the seven-day rollback window; do not keep dual deploy mode.
5. After seven days, scrub: delete the Vercel-specific jobs and steps from
   `production-deploy.yml` (the Vercel half of `build-web`, and `deploy-web`),
   set `WEB_DEPLOY_TARGETS=railway`, and decommission the Vercel project.

### www → Railway cut-over (#4655, 2026-09-01)

This is step 3 of the sequence above, carried out by the flip PR. It moves
production traffic for www.boardsesh.com from Vercel to the Railway
`boardsesh-web` service. Steps 1 and 2 were already done ahead of the flip:
`WEB_DEPLOY_TARGETS` has been `vercel,railway` since 09:35Z, and the
post-deploy smoke has passed against `RAILWAY_WEB_ORIGIN` twice.

#### Pre-flight evidence (2026-09-01)

| Check                        | Result                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/production-smoke.ts` | 8 passed, 0 failed, 2 skipped (kiosk and embed fixtures unset) against the Railway origin. Run twice: manually, and by the `deploy-web-railway` job on production run 33497302050.                                                                                                                                          |
| `/api/auth/csrf` cookies      | Byte-identical to www: `__Host-next-auth.csrf-token; Path=/; HttpOnly; Secure; SameSite=Lax` and `__Secure-next-auth.callback-url; Domain=.boardsesh.com; Path=/; HttpOnly; Secure; SameSite=None`.                                                                                                                          |
| Page and API parity           | `/`, `/robots.txt`, `/sitemap.xml`, `/sitemaps/static.xml`, `/auth/login`, `/gyms`, `/docs`, `/legal`, `/es`, `/de/gyms`, `/api/v1/kilter/grades`, `/api/v1/tension/grades`, `/opengraph-image`, `/api/og/setter?username=nobody`, `/.well-known/apple-app-site-association`, `/.well-known/assetlinks.json` — all 200, all byte-identical to www. |
| Boot log                      | Clean. No canonical-origin or `NEXTAUTH_URL` warnings.                                                                                                                                                                                                                                                                        |
| Dual deploy                   | Green since `WEB_DEPLOY_TARGETS=vercel,railway` took effect at 09:35Z.                                                                                                                                                                                                                                                        |

#### Merge gates

The flip PR must not merge until every one of these is checked:

1. Web-only secrets are pasted onto the `boardsesh-web` Railway service, with
   Vercel's exact values where continuity depends on it: `NEXTAUTH_SECRET` and
   `CRON_SECRET`, plus `GOOGLE_CLIENT_SECRET`, `APPLE_ID`, `APPLE_SECRET`,
   `IRON_SESSION_PASSWORD`, `EMAIL_VERIFICATION_ENABLED`, and
   `BOARDSESH_EXPO_WEB_ORIGIN`. Check by hitting `/api/auth/providers` on the
   Railway origin and confirming it lists both `apple` and `google`.
2. #5027, the apex → www redirect, is merged and applied. Verify with
   `curl -sI https://boardsesh.com/x?y=1`: it must answer 301 to
   `https://www.boardsesh.com/x?y=1` with a `cf-ray` header.
3. The Cloudflare API token `deploy-cloudflare` uses carries
   `Zone → Dynamic Redirect → Edit`, the scope #5027's redirect rule needs.
4. A maintainer has signed in on www and confirmed the session survives the
   flip. Before the flip the only available check is that `NEXTAUTH_SECRET`
   matches Vercel's value exactly (gate 1) — a live cross-host cookie check
   isn't possible pre-flip, because the Railway origin and www don't share a
   session until DNS actually points there.
5. A low-traffic window is picked for the merge. The #1909 playbook's answer
   is Tuesday.
6. `WEB_DEPLOY_TARGETS` stays `vercel,railway` for seven days after the flip
   — it must not be set to `railway` early.

#### Flip procedure

1. Merge the flip PR only once every gate above is checked.
2. `deploy-cloudflare` PATCHes the `www.boardsesh.com` DNS record onto the
   Railway CNAME target on the next `production-deploy.yml` run.
3. Within a few minutes, `curl -sI https://www.boardsesh.com/` stops
   returning `x-vercel-id` and instead shows Railway's edge headers.
4. Purge the Cloudflare cache from the dashboard (Caching → Configuration →
   Purge Everything). There is no purge tooling and the CI token has no
   `Zone.Cache Purge` scope — see [cloudflare.md](./cloudflare.md).
5. Watch, for at least the first hour: Sentry error rate, PostHog session
   counts, Cloudflare 5xx rate and cache hit rate, the Railway
   `boardsesh-web` service's CPU, RSS and restart count, `pg_stat_activity`
   web connections (stay at or under 10), and `/api/health`.

#### Seven-day warm window

Keep `WEB_DEPLOY_TARGETS=vercel,railway` for seven days after the flip.
Vercel keeps deploying every commit and stays warm as the rollback origin even
though it no longer receives traffic, matching step 4 of the cut-over
sequence above.

#### Rollback

For a bad Railway image, use the [rollback runbook](#rollback-runbook-web-on-railway)
below. For the DNS flip itself: `git revert` the flip PR, and the next
`deploy-cloudflare` run converges the record back to the Vercel CNAME on
record in the PR body. If `deploy-cloudflare` is itself unavailable, make the
same change by hand in the Cloudflare dashboard: set www's CNAME back to the
Vercel target noted in the flip PR.

#### After seven clean days

1. Cancel the Vercel Pro subscription and the Speed Insights add-on.
2. Delete `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` from the
   Production environment.
3. Land the scrub PR (#4656): set `WEB_DEPLOY_TARGETS=railway` and delete the
   Vercel half of `build-web` and the `deploy-web` job, matching step 5 of
   the cut-over sequence above.

## Rollback runbook (web on Railway)

1. **Hold.** Set `WEB_DEPLOY_TARGETS=none` so further pushes to `main` stop
   shipping web images to either target while you work. The GHCR image still
   builds and pushes every run; `notify-web-held` pings Discord so the hold
   isn't silent.
2. **Dashboard rollback.** Railway → the `web` service → Deployments → pick the
   last-good deployment → Rollback. This is the same `deploymentRollback`
   GraphQL mutation the automated recovery uses after a failed redeploy or hard
   smoke.
3. **Belt-and-braces.** If the dashboard rollback isn't enough — the bad image
   is still tagged `:production` in GHCR — retag a known-good digest and
   redeploy:
   ```
   docker pull ghcr.io/boardsesh/boardsesh-web:sha-<good>
   docker tag  ghcr.io/boardsesh/boardsesh-web:sha-<good> ghcr.io/boardsesh/boardsesh-web:production
   docker push ghcr.io/boardsesh/boardsesh-web:production
   railway redeploy --service "$RAILWAY_WEB_SERVICE_ID" --yes --from-source
   ```
4. **Fix forward.** Revert the offending commit on `main` and let CI build and
   ship the corrected image, then clear the hold.

During the seven-day rollback window there's one more fallback: if Railway web
is wholly unavailable, repoint `www.boardsesh.com`'s Cloudflare origin to the
frozen last-good Vercel deployment, then set `WEB_DEPLOY_TARGETS=vercel` before
shipping a fix. That option goes away once Vercel is decommissioned.

## Migrations stay backward-compatible

A rollback reverts the running web image, never the database — `migrate` has
already run against the new schema and there's no down-migration. During any
redeploy window, the previous image and the new schema have to coexist, so
every migration must be additive: add columns and tables before code reads
them, keep old columns until no deployed image still references them, and
split destructive changes across releases. If a change can't be made
backward-compatible, it can't be rolled back by image alone.

## Required GitHub configuration

Web-specific config lives in the **Production** GitHub environment alongside
the backend and database secrets. This is what the workflow reads for the two
web deploy targets:

| Name                       | Kind   | Purpose                                                                          |
| --------------------------- | ------ | --------------------------------------------------------------------------------- |
| `WEB_DEPLOY_TARGETS`        | var    | Picks `vercel` / `railway` / `vercel,railway` / `none` — see the table above.    |
| `RAILWAY_WEB_SERVICE_ID`    | var    | The Railway `web` service. Required before targeting railway.                    |
| `RAILWAY_WEB_ORIGIN`        | var    | Direct `https://*.up.railway.app` smoke origin; custom domains are rejected.     |
| `RAILWAY_TOKEN`             | secret | Production-environment Railway project token used by both verified deploy paths. |
| `NEXT_PUBLIC_WS_URL`        | var    | Backend WS URL baked into the web image and the Vercel build.                    |
| `NEXT_PUBLIC_POSTHOG_KEY`   | var    | Public PostHog key baked into the web image. Client analytics goes dark without it. |
| `SENTRY_AUTH_TOKEN`         | secret | Source-map upload during the web image build.                                    |
| `SMOKE_KIOSK_GYM_SLUG`      | var    | Fixture the post-deploy smoke reads.                                             |
| `SMOKE_EMBED_BOARD_UUID`    | var    | Fixture the post-deploy smoke reads.                                             |
| `VERCEL_TOKEN`              | secret | Still read by `build-web` and `deploy-web` until the scrub.                      |
| `VERCEL_ORG_ID`             | var    | Still read until the scrub.                                                       |
| `VERCEL_PROJECT_ID`         | var    | Still read until the scrub.                                                       |

`RAILWAY_TOKEN` must be a project token created for the Boardsesh project's
Production environment, not a personal or team API token. The rollback helper
derives and checks its project/environment scope on every use. Rotate it in
Railway first, replace the GitHub Production-environment secret, then revoke the
old token after a green deploy.

## Why only one run moves at a time

```yaml
concurrency:
  group: production-deploy
  cancel-in-progress: false
```

One deploy at a time, and the one that is already executing is never killed —
you do not want a run cancelled between `migrate` and `deploy-web`. GitHub keeps
exactly one run queued behind the group and replaces it with each newer push, so
`detect-changes` baselines off the last **successful** deploy. The surviving run
therefore absorbs every push that was dropped while it waited; nothing is
skipped.

## The failure mode: a run that holds the group without running

`cancel-in-progress: false` protects a run that is doing nothing just as firmly
as one mid-migration. A job parked in the `waiting` state on the Production
environment gate holds the group for up to 30 days — that is GitHub's approval
timeout, and there is no shorter one. `timeout-minutes` does not help: a job's
clock starts when the job starts, and a parked job never starts.

Two things make this worse than a plain failure:

- **Nothing ships.** Every later push queues as `pending`, GitHub keeps only the
  newest, and main stops reaching production.
- **Nobody hears about it.** The parked run never fails, so `notify-failure`
  never fires and the Discord deploy channel stays quiet. Its own notify jobs
  run under `environment: Production` as well, so the gate silences them too.

This happened in August 2026: run #1337 finished `detect-changes` and
`deploy-app-web`, then parked on `check-rollback` at the environment gate — a
required-reviewer rule had been removed mid-run, and removing it does not
release a deployment already pending against it. Main went two days without a
production deploy and no alert fired.

## The watchdog

`production-deploy-watchdog.yml` runs every 15 minutes and cancels a run that
holds the group without executing anything: at least one parked job, no job
`in_progress`, and no movement for 45 minutes. Cancelling costs nothing — the
queued run takes the group immediately and redeploys from the last successful
baseline. If cancelling empties the group, the watchdog dispatches a fresh run
so the wedge ends in a shipped commit; it spends at most one dispatch per head
SHA, so a gate that stays broken produces one retry and an alert rather than a
deploy loop.

A run that is genuinely executing is never cancelled. Past 150 minutes it gets a
Discord ping and a human decides.

One operator-facing wrinkle: the retry budget cannot tell the watchdog's own
dispatch from your `gh workflow run production-deploy.yml` on the same commit,
because production-deploy declares no dispatch inputs to mark. So a manual
dispatch spends that SHA's retry — if the run you started then stalls, the
watchdog cancels and reports it rather than starting another one.

The watchdog deliberately does **not** declare `environment: Production` —
running under the gate it exists to break would park it too. That also means it
only reads repository-level secrets; if `DISCORD_DEPLOY_WEBHOOK` is scoped to
the Production environment, the notify step no-ops and the job summary carries
the report.

Decision rules and their tests: `scripts/production-deploy-watchdog.mjs`,
`scripts/production-deploy-watchdog.test.mjs`.

## Runbook: main has not deployed

1. Open the [Production Deploy runs](https://github.com/boardsesh/boardsesh/actions/workflows/production-deploy.yml).
   A run showing **waiting** is parked at the environment gate; one showing
   **pending** is queued behind it and is fine.
2. If a run is parked, either approve its pending deployment or cancel it. The
   queued run starts on its own once the group frees.
3. Check **Settings → Environments → Production** for a required-reviewer or
   wait-timer rule that should not be there. Removing the rule does not release
   deployments already pending against it — cancel those runs too.
4. If no run holds the group and main still has not shipped, dispatch one:
   `gh workflow run production-deploy.yml`. A dispatched run deploys every
   target rather than diffing against a baseline.
5. `Production Deploy Watchdog` → **Run workflow** with **dry run** ticked
   reports what it would cancel without touching anything.
