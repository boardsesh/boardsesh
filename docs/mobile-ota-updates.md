# Mobile OTA updates (production: self-hosted expo-open-ota V3)

How JS/TS-only fixes reach the `packages/mobile` app without a new native build.

`expo-updates` speaks an open protocol, so we self-host the manifest + asset server with
[expo-open-ota](https://github.com/mercuretechnologies/expo-open-ota) (the mercuretechnologies fork)
instead of paying for EAS Update hosting (upstream renamed the project **expo-open-ota → xprem** at
v3.1.0; the old image name is still published). We run it in **V3 control-plane mode**: a
Postgres-backed server that owns channel↔branch mapping, code-signing keys, and progressive
rollouts itself, so there's no dependency on Expo's API and no MAU/bandwidth billing. The only thing
we still keep from Expo is a free account/token for the EAS free-tier _preview_ path (below).

## One server: V3 live (V2 destroyed 2026-08-25)

We migrated to V3 green-field rather than upgrading V2 in place, because a V2→V3 upgrade needs a
destructive storage re-path and an in-place stateless→control-plane key-sealing migration. We were
cutting a new native build anyway, so instead we stood up a fresh V3 server on an empty bucket + new
Postgres and left V2 running untouched while its fleet drained. The URL cutover landed 2026-07-27
(#3969) and V2 was torn down 2026-08-25. Only V3 remains:

| Server             | Host                    | Version                                                                                           | Who hits it                                                                                     |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **V3 (live)**      | `updates.boardsesh.com` | mercuretechnologies xprem, control-plane ([which tag](#versions-the-cli-pin-and-the-server-image)) | Every current binary (V3 URL + V3 cert + `expo-app-id` header baked in). CI publishes only here. |
| **V2 (destroyed)** | `ota.boardsesh.com`     | axelmarciano V2, stateless — **gone**                                                             | Nothing. Service + bucket deleted 2026-08-25.                                                   |

- **A pre-V3 binary now gets no OTA at all.** Binaries built between 2026-06-10 (when V2 went live)
  and the 2026-07-27 cutover baked in `ota.boardsesh.com`. That Railway service is deleted, so the
  CNAME still resolves but Railway answers with its default `*.up.railway.app` wildcard cert — the
  TLS handshake fails before any HTTP happens. `expo-updates` can't fetch a manifest and silently
  runs the **embedded** bundle. That is *not* an emergency launch, so `vp run mobile:ota-health-check`
  will not flag it: the fleet looks healthy while those installs sit frozen on the JS baked into
  their binary. Only a **store update** recovers one.
- There is no cross-server backport and V2 cannot be revived — its bucket is gone. Recovery for a
  stranded install is store-side only.
- V3 is the Railway service `boardsesh-ota-v3` (image `ghcr.io/mercuretechnologies/xprem:v3.2.5` —
  see [Versions](#versions-the-cli-pin-and-the-server-image)), backed by a dedicated Railway Postgres
  and the S3-compatible bucket `boardsesh-ota-v3`. Verify its current provider through the storage
  migration gate below; the bucket name alone does not distinguish R2 from Tigris. Its endpoint is
  managed in Railway so a stale checked-in value cannot undo a storage-provider migration. Railway
  currently pulls that exact release through the **pre-rename** repository path
  (`ghcr.io/mercuretechnologies/expo-open-ota`, same tag) — upstream
  renamed expo-open-ota → xprem at v3.1.0 and still publishes both names, so a Railway service that
  doesn't say `xprem` is not a sign the server is behind. Branch surfing answering on the live server
  confirms the running build: that route first shipped in v3.1.2-beta2.
- **Recovery on V3 is forward-only:** publish a fixed OTA, or roll back on V3.
- **The URL cutover already happened (2026-07-27).** The repo variable `EXPO_UPDATES_URL` (consumed
  by the native build workflows + the OTA publish workflow) now reads
  `https://updates.boardsesh.com/manifest`. It flipped **when the V3 client PR merged** — no earlier,
  no later. Keep that ordering for any future server move: flip it early and publishes from `main`
  break against the old server; flip it late and the first native build on the new server bakes the
  stale URL into the binary.

### Versions: the CLI pin and the server image

One version governs both halves of the self-hosted path, and each half has a constant:
`EOAS_PACKAGE_SPEC` in `scripts/lib/eoas.ts` (currently **`eoas@3.2.5`**) is the CLI we publish with,
and `OTA_SERVER_VERSION` in `infra/railway/config.ts` is the image Railway runs
(`ghcr.io/mercuretechnologies/xprem:v3.2.5`). `scripts/__tests__/eoas-version-parity.test.ts` fails CI
if this doc, the setup runbook or the rollback helper drifts off either — root `scripts/` has no
typecheck task, so nothing else would catch it.

**Upgrading is a PR, not a dashboard edit.** `vp run ota:image-bump` opens it — one draft PR for the
newest stable release and, separately, one for the newest prerelease — bumping both constants in the
same commit. Merging it rolls the image, waits for the deployment, probes the server and rolls back
if it does not answer. See [railway.md](./railway.md).

**The CLI and the server move together.** Neither side exchanges a version and there is no version
endpoint. `infra/railway/plan.ts` blocks an image ahead of the pin, and the version-parity test
asserts the same without touching the API. The older rule, that the CLI may lead the server, stopped
holding at 3.2.0 (below): across that line neither side may lead.

#### The 3.2 upgrade (3.1.2 to 3.2.5)

**History.** On 2026-09-26, #5861 moved everything to 3.2.4, and two applies rolled it back
automatically (#5864 reverted the pins). Both times `/ready` answered 503 throughout, because of the
first boot, not the server:

- 3.2.2 added a Postgres migration, `backfill_update_asset_mapping`, that reads the bucket once per
  existing update to fill `updates.asset_mapping`. In 3.2.4 it ran in ONE transaction and logged
  nothing until it ended, so each rollback threw its work away.
- Until migrations finish, xprem serves `/hc` = 200 but answers every other path, manifests
  included, with 503 "storage migration in progress". Railway's healthcheck is `/hc`, so it swaps
  the booting container in, and devices get 503 on update checks for the whole backfill. They keep
  running their current bundle.

**What changed for the retry.**
- **3.2.5 is resumable.** Upstream fixed it after we reported it (xprem#277, xprem#278). The
  backfill commits per update and logs `Backfilled i/N` every 100, so an interrupted boot resumes
  instead of restarting.
- **The probe waits for the migration.** `probeService` treats that specific 503 body as "still
  booting" and waits up to 30 minutes for it without spending probe attempts. Any other 503 still
  rolls back. Watch the deployment's logs for the `Backfilled` lines.
- **The control center stays on 3.2.4.** 3.2.5 changed only the server migration, and 3.2.5 of the
  package was under pnpm's one-day release-age floor.

The 3.2 SQL migrations from the first attempt stay applied, and 3.1.2 ignores them.

What the retry has to respect:


- **The upload protocol broke in both directions.** `requestUploadUrl` now takes a `files` list
  (path, SHA-256 hash, md5 cache key, role) instead of `fileNames`, and "no changes" moved from a
  406 on `markUpdateAsUploaded` to a 406 on `requestUploadUrl`. eoas 3.2.x against a 3.1.x server
  fails with `No file names provided`; eoas 3.1.x against a 3.2.x server fails too, because the
  server rejects the previous upload shape. `scripts/mobile-ota-promote.ts` speaks this protocol itself, so it moves
  with `EOAS_PACKAGE_SPEC` as well.
- **One PR moves the image, the CLI and the promote script.** On that push, Railway Config rolls the
  server while production-deploy stages the OTA. `scripts/mobile-ota-server-ready.mjs` makes the
  staging publish and the promote step wait for the Railway Config run on the same commit, and
  fail if it did not succeed. Every other push returns from it at once.
- **Assets are content-addressed from 3.2.0.** Uploads land at `{appId}/cas/<sha256>` and each update
  maps its files there (`updates.asset_mapping`). Updates published before the upgrade keep being
  served from their old folders. The first boot runs the Postgres migrations for this (`blobs`,
  `bundle_patches`, `updates.asset_mapping`, `apps.git_url`) plus a backfill.
- **Rolling back is a one-way door after the first 3.2 publish.** 3.1.2 knows nothing about the
  `cas/` layout, so it cannot serve an update published on 3.2. Going back means reverting the
  version PR, so `OTA_SERVER_VERSION`, `EOAS_PACKAGE_SPEC` and the promote script move back
  together (the version-parity test fails on a partial revert), and then republishing the current
  JS with the old CLI. The 3.2 schema changes can stay; 3.1.2 ignores the new tables and column.
- **Bundle diffing is on** (`BUNDLE_DIFFING=true`). On each publish xprem computes a bsdiff patch from
  each of the five previous updates on the same branch, runtime and platform, and keeps one only when
  it is at most 30% of the gzipped bundle. expo-updates has asked for patches by default since
  56.0.13, so no build was needed. A device more than five updates behind gets the full bundle.
  The historical per-merge production cadence of about 14 updates a day limited useful patch history
  to hours. Daily stable publication extends that history; independent staging and beta publishes
  do not evict production's previous updates. Each diff job peaks at about six times the bundle size
  in memory (about 125 MB) and two run at once.
- **Patches come from the server, never the CDN.** `BUNDLE_DIFFING_CDN_REDIRECT` stays unset.
  expo-updates rejects a patch without the `im: bsdiff` and `expo-base-update-id` response headers
  and retries the full bundle with patching disabled. Both native downloaders implement this fallback;
  a rejected patch still wastes transfer and launch time. The edge would need a Worker to add the second header,
  because the value comes from the request path. `BUNDLE_DIFFING_CDN_REDIRECT` is a forbidden
  variable in `infra/railway/config.ts`, so setting it by hand shows up as drift.
- **Turning diffing off is a one-line PR:** set `BUNDLE_DIFFING` to `'false'` in
  `infra/railway/config.ts`. Removing the entry does nothing, because `railway:apply` never unsets a
  variable.

After any bump: re-verify `/hc` = 200, `/ready` = 200, a header-carrying manifest + asset probe, and
run `eoas doctor`.

### Standing rules

- **Never drop `expo-app-id`, `expo-channel-name`, or `xprem-branch`.** Self-hosted clients bake all
  three in `updates.requestHeaders`; xprem's branch API overrides only `xprem-branch`.
- **Move the `eoas` pin and the V3 server image in one commit.** A CLI that trails the server can 404
  on app-scoped routes, and since 3.2.0 a CLI that leads it cannot upload at all. `vp run
  ota:image-bump` moves both together, `infra/railway/plan.ts` blocks an image ahead of the pin, and
  the publish waits for the server to roll (see [The 3.2 upgrade](#the-32-upgrade-312-to-324)).
  Re-verify after every bump (above).
- **Dashboard creds are production-release creds.** `/dashboard` mints API keys, exports the cert,
  remaps channels, and runs rollouts — treat the admin login as production-release access (one admin,
  read-only members).

## Two hosting paths (don't mix them up)

|                | Preview / dev                            | Production                                                                                                                                                                      |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built by       | `eas build` (`mobile:preview-build`)     | bare `expo prebuild` + xcodebuild/gradle (the `ios-testflight-rn` / `android-apk-rn` workflows)                                                                                 |
| Hosting        | EAS free tier (`u.expo.dev`)             | self-hosted expo-open-ota V3 (`updates.boardsesh.com`)                                                                                                                          |
| Channel source | `channel` in `eas.json`                  | `expo-channel-name` request header baked in by `expo prebuild`                                                                                                                  |
| Publish        | `vp run mobile:publish` (→ `eas update`) | auto on push to `main` (`mobile-ota-production.yml`); manual: publish one platform, then immediately run `mobile:upload-sourcemaps` (→ `eoas publish` + Sentry Debug ID upload) |

A third path rides the **same self-hosted server**: per-PR `pr-<number>` branches that let any user
validate a specific PR on a compatible store/TestFlight build via **Test a PR preview** —
see [Per-PR preview branches](#per-pr-preview-branches-self-hosted) below.

The split is decided in `packages/mobile/app.config.ts` (`resolveUpdatesConfig`): when
`EAS_BUILD` is set it returns the EAS URL; otherwise it uses the self-hosted server — but **only
when both `EXPO_UPDATES_URL` and the signing cert `certs/certificate.pem` are present** (fail
closed). Until both exist it falls back to the EAS URL so builds still succeed and OTA is simply
inert. The cert gate matters: baking the self-hosted update URL into a binary _without_ code
signing would let a compromised manifest host (or a network MITM) push arbitrary JS to every
install, since the device couldn't verify the manifest came from us.

## How the production path works

1. **Build time** (`expo prebuild`): `app.config.ts` injects literal request headers
   `expo-channel-name: production` and `xprem-branch: ''` into `Expo.plist`
   (`EXUpdatesRequestHeaders`) and `AndroidManifest.xml`. `updates.url` points at V3
   (`https://updates.boardsesh.com/manifest`). The build also bakes an **`expo-app-id`** request
   header — `007e6fd7-f200-448c-9449-8d48ba5d51fc`, the V3 server's internal app id (set in
   `app.config.ts` as `OTA_APP_ID`, env-overridable via `EXPO_PUBLIC_OTA_APP_ID`). This is **not**
   the EAS project id `87499648-…`; that value survives only as the cert's CN. V3 routes every
   request on `expo-app-id`, so a build that drops the header can't be served. The public
   code-signing cert (`certs/certificate.pem`, exported from the V3 dashboard) is embedded, and the
   app signs manifests with `keyid: 'main'` / `rsa-v1_5-sha256` (V3 hardcodes `keyid='main'`).
2. **Runtime**: on launch the app asks `<server>/manifest` with its app id, production channel,
   optional surfed branch, and runtimeVersion headers. V3 returns the latest signed update on the
   surfed branch when one is selected, otherwise the branch mapped to the production channel
   (see [Production channel mapping and branch surfing](#production-channel-mapping-and-branch-surfing)); the app verifies the
   signature against the embedded cert. The update applies on this launch when it downloads
   inside the launch update gate's cap, and on the next launch otherwise (see
   [What a launch runs](#what-a-launch-runs)).
3. **runtimeVersion** uses the **`fingerprint`** policy — a hash of the native project (deps,
   config plugins, entitlements, native dirs), resolved by the exact-pinned, patched
   `@expo/fingerprint@0.20.11` installation behind Expo's `expo/fingerprint` export. An
   update only reaches a binary with the **same** fingerprint, so a JS-only change keeps the same
   fingerprint (the OTA lands) while **any native change yields a new fingerprint** — the OTA is
   intrinsically incompatible with old binaries and isn't delivered (they keep their embedded
   bundle until a store build with the new fingerprint ships). This removes the `appVersion`
   footgun where a native change without a manual `version` bump could push JS to a binary lacking
   the native capability it needs. The `version` field (`2.6.0`) is the store/marketing version,
   and it is not hashed: `fingerprint.config.js` skips `version`, `ios.buildNumber` and
   `android.versionCode`, so two marketing versions can share one fingerprint (see
   [Version-only releases](#version-only-releases)). Resolve the current value with
   `vp exec expo-updates runtimeversion:resolve --platform ios|android` (from `packages/mobile/`).

## What a launch runs

An install holds two kinds of JS: the bundle embedded in the binary at build time, and the newest
signed update it has downloaded. Native `app.config.ts` sets `launchWaitMs` to 0 and checks for an
update on every launch. So expo-updates starts the app on the stored update (or the embedded bundle
when none is stored) without waiting, and downloads the next one in the background. A store binary's
first launch therefore ran the JS embedded at build time, however old that was, and every later
cold start ran the previous launch's download.

Before #6006 the only thing that moved a new install forward was a side effect. The retired-channel
migration ended in an ungated `Updates.reloadAsync()`, which expo-updates queued behind the
launch-time download, so the reload landed whenever the download finished. On 2.5.0 newcomers
(measured once, 2026-10-04) 48% of `Login Succeeded` events ran embedded JS, and for 26% the reload
landed between `Login Attempted` and `Login Succeeded`.

The **launch update gate** replaces that side effect. It gates every eligible cold start, not only
first launches: a returning climber's cold start waits for the update check too. The gate runs once
per JS runtime in a module-level store (`packages/mobile/src/lib/launch-update-gate-store.ts`, rules
in `launch-update-gate.ts`). The root layout starts it and reads its flags through
`useLaunchUpdateGate()`, so a remounted root layout reads the first verdict and never starts a
second gate. While it waits, launch readiness stays false, so the gates that wait on launch
readiness (onboarding, the QA prompt) do not paint.

| Profile | Which launch | Download cap |
| --- | --- | --- |
| `first_launch` | An embedded launch whose runtime version is not yet recorded in the `ota_first_launch_update_runtime_v1` preference. A fresh install, or the first launch after a store update to a new fingerprint | 15 s (`FIRST_LAUNCH_UPDATE_CAP_MS`) |
| `cold_start` | Every other eligible cold start | 10 s (`COLD_START_UPDATE_CAP_MS`) |
| `none` | Dev builds, updates disabled, an emergency launch, an iOS background launch (Live Activity intent), and a runtime that is itself the product of a reload (`restartCount > 0`) | No gate |

**Two phases, two caps.** The check phase is the wait for the update server to answer. It is capped
at 4 s (`LAUNCH_UPDATE_CHECK_CAP_MS`) for both profiles. If the check has not answered by then the
gate releases `timed_out`. The profile caps above, counted from gate start, apply only once a
download is under way (or the downloaded update is waiting). The 4 s cap exists for a network that
NetInfo calls online but whose upstream is dead: the manifest request can hang (the iOS request
timeout is 60 s), and without it every cold start on that network would sit behind the placeholder
for the full cap.

The native splash covers the first 2 s (`LAUNCH_UPDATE_PLACEHOLDER_DELAY_MS`). After that
`LaunchUpdatePlaceholder` shows "Checking for the latest version" with a progress bar for the
download. The placeholder stays up until the gate has resolved and auth is ready.

The gate ends in one of six outcomes:

- `updated`: a newer update is pending, so the app reloads onto it.
- `nothing_newer`: the launch check finished and found nothing to load.
- `timed_out`: a cap passed first (or auth had not settled by the cap, see below). A download in
  progress keeps going in the background and applies on the next launch. The gate never reloads
  after it has released, so a reload cannot land mid-sign-in.
- `failed`: the check or download errored, or the first-launch marker could not be read.
- `offline`: the Offline mode toggle is on, the device reports no connection, or the network is
  marked unreachable. Connectivity is read once, when the gate starts: an offline start releases at
  once, and going offline after that just runs into the cap.
- `skipped_failed_update`: the pending update is the one the gate already reloaded onto on an
  earlier launch (stored under `ota_launch_update_last_reload_target_v1`) and it is still pending,
  which means that update failed to launch. The gate does not reload onto it again.

Offline never waits because there is nothing to download, and a first launch with no signal must
open the app, not sit behind a bar. The first-launch marker is not written on `offline`, so the
next launch gets its full wait. Every other first-launch outcome writes it.

**No reload before auth settles.** Refresh tokens are single-use, so a reload in the middle of a
launch-time refresh would sign the climber out. The gate holds a reload until the root layout
reports auth ready (`notifyLaunchUpdateAuthReady`). If auth has not settled by the cap, it releases
`timed_out` instead.

When the launch-time manifest request went out under a retired channel override (the cleanup
cleared a live one on this launch), the gate makes one explicit check with the clean headers inside
the same caps, because the launch-time result describes the wrong channel.

Each gated launch sends one `OTA Launch Update` event (see
[OTA observability](#ota-observability-adoption--funnel)). It is sent before a reload, and the
analytics flush is awaited for up to 700 ms before the reload starts, so an `updated` event can
still be lost if the send is slower than that. A background launch that skips the gate leaves a
Sentry breadcrumb (category `ota`).

Routes that iOS presents as native modals sit above the React root, so the placeholder cannot
cover them. All eleven root `modal` / `transparentModal` routes in `app/_layout.tsx` (join,
share-beta, boards, moderation and its spray-walls screen, onboarding, the two QA screens,
send-recovery, the user drawer and play) are wrapped in `holdUntilLaunchReady` and show a spinner
until launch is ready. A cold start from a climb link also waits on launch-ready before it opens
the play drawer (`use-board-route-target.ts`). Add the wrapper to any new root modal route.

The cap timers decide when a cap has passed; the gate does not re-derive it from the wall clock,
which can step backwards on Android. Once a reload has been requested the gate gives the native
relaunch 5 s (`LAUNCH_UPDATE_RELOAD_GRACE_MS`) and then lets the app open. A relaunch that is
slower than that cannot be cancelled and can still land afterwards.

The browser target (`BOARDSESH_WEB=1`) is never gated: expo-updates' web module reports itself
enabled, so the gate excludes `Platform.OS === 'web'` explicitly.

**The gate has to be in the embedded bundle to help a first launch.** A first launch runs the
embedded JS, so only a binary built with the gate waits for the update. The caps are JS constants,
so a later OTA can change them for installs that already carry the gate. Do not remove the gate
without a replacement that reloads before sign-in: without it a first launch runs stale embedded JS
again, and the migration's old reload is gone.

The gate has not yet been checked on a device or against production numbers.

### Invariant: OTA JS must not call native methods newer than the min shipped binary

The fingerprint gate only protects you when the JS change is matched by a native change. It does
**not** catch a JS-only change that starts calling a native method the shipped binary doesn't have —
e.g. bumping a native module's JS (or the module itself, if its native side ships separately) so the
JS invokes a newer imperative native method. The fingerprint is unchanged (JS-only), so the OTA lands
on old binaries whose native layer predates the method, and the call fails at runtime.

This is exactly how #3478 happened: `@expo/ui`'s Android bottom sheet calls `partialExpand()` /
`expand()` on the native `ModalBottomSheetView`. A production OTA pushed JS that calls them onto a
store binary built against an older `@expo/ui`, and the unregistered AsyncFunction rejected — a
crash-reported unhandled rejection.

Rule: any imperative native call that could be OTA-ahead of the native binary must be guarded (a
`.catch` / capability probe / `requireOptionalNativeModule` null-check) so it degrades to a no-op
instead of throwing. For `@expo/ui` sheets the guard lives in `patches/@expo%2Fui@57.0.11.patch`.

## Publishing a production update

**Automatic.** A mobile-affecting push to `main` is detected by
`.github/workflows/production-deploy.yml`. It calls the OTA workflow to publish
both platform exports to the tester-only `pr-staging` branch while web and backend
build. Once the backend deploy succeeds (or is unchanged), a one-shot live
GraphQL-schema check must pass before those same archived export bytes are uploaded
to the existing `production` branch. No runner polls while the backend builds;
an OTA staging failure does not stop service deploys, but fails the overall run
and leaves production OTA unchanged. Production deploys are serialized, so a
newer main push waits while the current staged OTA finishes; the next run then
stages changes since the last successful production deploy. If main advanced,
the in-flight run leaves its generated changelog for the newer run to publish.
The stage records each platform's production manifest ID before publishing;
promotion refuses to overwrite a manual or native republish that changed either ID.
The promoter uses each archived export's `metadata.json` for asset media types,
matching the pinned `eoas` uploader even though Metro names the files by content
hash without extensions.

Pushes to `release/next` still run `.github/workflows/mobile-ota-production.yml`
directly. `main` serves the store fleet; `release/next` (the release train,
see `docs/mobile-store-release.md`) serves the testers running the train's
TestFlight / Play-internal binary, so they get JS as fast as everyone else —
including after a `main` → `release/next` sync.

**The train's publish is fingerprint-guarded.** xprem serves whichever update has
the newest `commitTime` *for a given runtimeVersion*. While the train's
fingerprint still equals main's — that is, before any native change has landed on
it — a publish from the train would be handed to the entire store fleet, silently
replacing main's JS with the train's. So the train workflow resolves `origin/main`
in a sibling worktree and skips any platform whose fingerprint still matches
main's, with a `::warning::` saying so. It fails closed: an unresolvable or flaky
comparison publishes nothing. The train therefore starts publishing only once it
carries a native change, which is also exactly when it has its own fingerprint and
its own binaries to serve. Everything else in that workflow stays main-only: the
changelog regeneration and push-back, the Sentry release, the health probe and the
Discord notification. Because
runtimeVersion is a fingerprint, this is safe to run on every push: a native change publishes an
OTA whose fingerprint no current binary has yet, so it only lands once the matching store build
ships. If the server is not wired (no `EXPO_UPDATES_URL` variable or committed cert), main
staging fails; direct release-train/manual publishes retain the old green no-op.
The matching native builds (`ios-testflight-rn` / `android-apk-rn`) run
on the same push but are **fingerprint-gated** — they only build when the fingerprint is new (see
[Native-build gating](#native-build-gating-ota-only-when-the-fingerprint-is-unchanged) below).
Matching fingerprints are necessary but not sufficient: an OTA published while a native build is
still running loses to that build's embedded bundle, so each native build republishes when it
finishes — see [Publish ordering](#publish-ordering-a-binary-can-outrank-a-newer-ota) below. A
successful publish (and any failure) posts to the Discord deploy channel via the
`DISCORD_DEPLOY_WEBHOOK` secret, the same channel the native build workflows use. The success
message lists what the OTA newly added: the workflow snapshots `changelog.generated.json` before
regenerating it, then `changelog-discord-summary.ts` diffs the two snapshots and renders the new
entries grouped as New / Improved / Fixed. When nothing new shipped (changelog unchanged) it falls
back to the triggering commit's subject.

**Manual** (one branch, ad hoc) — publish exactly one platform, then upload that export's source
maps before running `eoas` again:

```sh
EXPO_UPDATES_URL=https://updates.boardsesh.com/manifest \
EOO_TOKEN=eoo_… \
  vp run mobile:publish -- --channel production --platform ios --message "fix: <what>"

SENTRY_AUTH_TOKEN=sntrys_… \
  vp run mobile:upload-sourcemaps -- --platform ios
```

The wrapper translates its `--channel production` selector to `eoas publish --branch production`.
It deliberately does not pass eoas's deprecated `--channel` option; channel creation and mapping are
control-plane operations described below. The production publish runs
`eoas publish --branch production --dumpSourcemap --outputDir dist`, which exports the bundle plus
its external map and uploads the OTA bundle to our storage via the server. `eoas` reads the server
URL from `updates.url` in `app.config.ts`, so `EXPO_UPDATES_URL` must be present.
**Auth is `EOO_TOKEN`, not an Expo token:** the V3 control-plane server rejects Expo tokens, so
publish/rollback need an app-scoped `eoo_` key minted in the dashboard. The CLI is pinned to
**`eoas@3.2.5`** via `EOAS_PACKAGE_SPEC` in `scripts/lib/eoas.ts` (V3 routes are app-scoped; a `v2`
CLI 404s) — see [Versions](#versions-the-cli-pin-and-the-server-image) for the pin↔image rule. Every
self-hosted publish also passes `--upload-rate 5` to pace its asset uploads; the reasoning is below.

For Android, use `--platform android` on both commands and provide the same
`GOOGLE_MAPS_API_KEY` used by the Android native build while publishing. Do not use `--platform all`:
each `eoas publish` removes and recreates `packages/mobile/dist`, so the second platform would erase
the first platform's source maps before they reached Sentry.

### The throttle, and what actually fixes it

The original Tigris-backed setup answered a too-fast run of asset PUTs with
`503 <Code>SlowDown</Code>` on the `boardsesh-ota-v3` bucket. Three things multiply into that, and it
is worth keeping them apart — an earlier version of this doc said waiting was the only lever we had,
which stopped being true on 2026-08-19. The upload-rate cap remains a portable guard; verify the live
provider through the storage migration gate below.

**How much we upload.** One export is 380 assets, and 356 of them are the board-background images
`require()`d by `packages/mobile/src/lib/board-backgrounds-manifest.ts` — 94% of the asset count.
Storage keys are `{appId}/{branch}/{runtimeVersion}/{updateId}/assets/{hash}`; `updateId` is in the
path, so before server-side reuse every publish wrote a fresh full copy: ~760 PUTs for a two-platform
run, none of them deduplicated against the previous update.

**How the CLI uploaded it.** Up to and including 3.1.1, `eoas publish` fired every asset through one
unbounded `Promise.all`, and `fetchWithRetries` used a `retryOn` that inspected only transport errors
— never an HTTP status. One throttled asset therefore fell through `!response.ok` to
`process.exit(1)` and killed the whole publish.

**How many of them run at once.** `mobile-ota-preview.yml` scopes its publish job per PR
(`mobile-ota-preview-publish-<number>`), unlike `mobile-ota-production.yml`, which is a single
repo-wide group. On 2026-08-19 up to **11 preview publish jobs ran concurrently** (peak 13:15–13:23
UTC), each firing its own burst at the one bucket. A single repo-wide group would be the wrong fix:
GitHub keeps at most one pending run per group, so intermediate PRs' previews would be silently
superseded.

`eoas`/xprem **3.1.2** (2026-08-19) fixes the first two, and we take both:

- **`--upload-rate`** caps how many uploads start per second, enforced by a token-bucket limiter
  awaited before each upload. Every self-hosted publish passes `--upload-rate 5`
  (`SELF_HOSTED_UPLOAD_RATE_PER_SECOND` in `scripts/lib/eoas.ts`) — production and per-PR previews
  alike, since the previews are the concurrent ones. The CLI default is 10; the limiter is per
  process, so at 11 concurrent jobs the default would still aim ~110 starts/sec at one bucket. At 5
  that peak is ~55/sec and a lone publish still starts all 380 assets inside ~76 seconds.
- **Status-aware retries.** `fetchWithRetries` now retries 429 and 5xx, honours `Retry-After`, backs
  off exponentially up to 60s over four attempts, and rebuilds the multipart body so a retried upload
  does not replay a consumed stream. A single throttled asset no longer kills the publish.
- **Server-side asset reuse** (xprem #165) is the third fix and the largest, but it is server-side
  only: `requestUploadUrl` loads the previous update's `metadata.json` for the same
  app/branch/runtimeVersion/platform, server-side-copies everything already there, and hands back
  upload URLs for the remainder — roughly 380 uploads down to a handful on a repeat publish to a
  branch. **It needs the Railway image on `xprem:v3.2.5`**; until then the CLI-side halves above are
  what we have. It degrades safely (an unavailable copy just falls back to a normal upload).

The whole-command retry ladder below is therefore now a **backstop**, not the first line of defence.

**Transient upload failures** are retried only when eoas output contains the exact S3 SlowDown XML
response or an explicit HTTP 5xx status. Each platform gets at most six attempts, with 1, 3, 5, 10,
and 15 minute waits — 34 minutes of backoff per platform. HTTP 4xx, authentication, configuration,
export/build errors, unknown failures, and mixed permanent/retryable evidence fail immediately.
Child output stays live and is not echoed again from a captured tail. The EAS-hosted preview path
(`eas update`) is unchanged and does not use these retries.

The ladder is sized against the object store's observed cooldown rather than a guess. Two production
incidents (2026-07-15 run 29387706795, 2026-08-03 run 30855435091) throttled every attempt across a
~17 minute window and only published after a cool-down; the earlier 30/60/120 second ladder gave up
about 8 minutes in, so both needed a manual re-run. It has been holding since: preview run
32249835065 (PR #4546, 2026-08-19) **succeeded** after five throttled iOS attempts, publishing on the
sixth — but it took 45m39s to do it. That is the shape of the problem the rate cap addresses: the
ladder converts a hard failure into a slow success, because each retry re-runs a ~90s Metro export
and re-fires the identical burst. Do not shorten the ladder on the strength of 3.1.2 until a week of
publishes says so — and note that three workflows' `timeout-minutes` floors are derived from it.

Because both budgets are spent sequentially, a fully throttled production run can take ~98 minutes
before it reports failure. The publish jobs' `timeout-minutes` must stay above that: a job killed
mid-backoff dies by timeout, losing both the `s3-slowdown` diagnosis and the failure notification.
`scripts/mobile-ota-publish-workflow.test.ts` derives each floor from the ladder via
`minimumPublishJobTimeoutMinutes()`, so widening the budget again fails CI until the timeouts follow.
None of this costs anything on a healthy publish, which never sleeps and finishes in under 10 minutes.

When both platforms are requested, iOS then Android publish sequentially and Android still runs if
iOS fails. The run fails unless every requested platform succeeds, but it does not automatically
roll back a platform that already published. A single eoas invocation can still upload some objects
before its server-row write fails; making that internal PUT/database operation atomic requires an
upstream expo-open-ota change.

### OTA source maps and Sentry

Production and approved-release backport workflows publish and upload in this order: iOS OTA → iOS
maps → Android OTA → Android maps. Before either platform publishes, a shared compatibility
preflight checks the installed uploader and its dependencies; it needs neither a Sentry token nor
an Expo export. The audited SDK versions are exactly `7.11.0` and `8.24.0`; other versions stop the
workflow before publishing. The wrapper derives executable bundles from the requested
platform in `dist/metadata.json` (the primary bundle plus declared DOM component JavaScript), then
validates each bundle/map pair and map Debug ID. Public-folder JavaScript is not update executable
metadata and is ignored. Only validated pairs are copied into an isolated working directory for
the installed official Expo uploader, whose recursive scan cannot see other files in `dist`.
SDK 8.24.0 delegates to `@sentry/expo-upload-sourcemaps`; both audited versions use the same exact
bundle/map pairing and Debug ID contract. SDK 8.24's native build phases also resolve their own
CLI dependency. The native dependency check follows that resolution instead of requiring it to
match the direct CLI used by the standalone dSYM uploader; both existing dependency pins stay
unchanged. Sentry matches the running
OTA bundle to its map by Debug ID. It deliberately receives no synthetic release or dist, so the
SDK's native release/dist continue to describe the installed store binary.

Expo 57 declares DOM component JavaScript under `www.bundle`, but independently content-hashes its
map filename. Both audited uploaders require an exact adjacent `<bundle>.map`, so the wrapper rejects
such an export with an actionable error instead of silently omitting executable code. Boardsesh does
not currently use Expo DOM components; add an audited pairing/upload path before introducing one.

Publishing and source-map acceptance are **not atomic**. The OTA can already be live when Sentry
rejects its map. CI therefore lets changelog, deployment notice, and health reporting finish, warns
that crash frames may remain minified, and then fails the workflow. For a manual retry, return to the
exact same commit/tree, platform, and build environment that produced the live OTA, rerun that one
platform's publish to regenerate `dist`, and immediately run `mobile:upload-sourcemaps` before any
other `eoas publish`. A newer tree or different environment can produce a different Debug ID and
cannot repair the already-published artifact. When the failed run retained no exact export
artifacts, recover the current train by publishing a fresh OTA from the latest train tree with
the fixed uploader and require successful uploads for both platforms. That gives the fresh
update readable crash frames; repairing a historical update still requires its exact bundle/map
artifacts and matching Debug IDs.

**Progressive rollouts** are a control-plane feature: `eoas publish --branch production
--rollout-percentage N` ships to only `N%` of the channel's installs. Finish or revert
the rollout from the dashboard once it's healthy — an unfinished per-update rollout **locks**
further publishing on that branch, so a forgotten one turns the next auto-publish red.

### Production channel mapping and branch surfing

In V3 the channel→branch mapping lives in Postgres, not in Expo's API. `eoas publish --branch X`
creates the **branch** that holds the update; channel creation and mapping happen separately. A
client requesting an unmapped channel gets `No branch mapping found`. Mapping is a
**dashboard-admin operation**: the app-scoped `eoo_` publish key can list branches/channels but
**cannot map** (it 403s with "This action requires a dashboard session").

- **Production** maps to the `production` branch. The mapping is declared in `infra/ota/config.ts`
  and checked by `vp run ota:apply` (see [Managing xprem as code](#managing-xprem-as-code)).
- **PR previews and staging are branches, not channels.** The production channel enables xprem Branch
  Surfing with the narrow pattern `pr-*`; the picker sends `xprem-branch: pr-N` for a PR or
  `xprem-branch: pr-staging` for the staged main update. No extra channel mapping is created.
  Production in the picker clears the branch override. `pr-beta` is a third long-lived branch
  under the same pattern: the early-updates track ("Early updates" below). Staging is intentionally selectable
  before the backend schema is promoted, so it is for testers; the staging export itself
  is promoted byte-for-byte after the schema gate. The `pr-` S3 lifecycle rule also
  covers staging assets, so a stale staging update expires after 14 days.
- **Branch Surfing is ON** for `production` with the pattern `pr-*` (enabled 2026-09-01, once native
  builds carrying the picker and the baked `xprem-branch` header had reached testers — that ordering
  is the prerequisite, because a binary without the header cannot surf). While it was off, every
  tester saw "Previews are switched off" on the Test a PR screen: `/branch_lists` answered `404` with
  `xprem-branch-surfing: off`, which the client maps to `null`.
  The toggle is easy to miss — it lives on the dashboard's **Channels** page *inside the selected
  channel's detail pane* (`BranchSurfingCard`), not on the channel list, and an empty pattern makes
  it un-toggleable. There is also an API, despite xprem's docs calling it dashboard-only:
  `PUT /api/apps/{APP_ID}/channels/{CHANNEL}/branch-surfing` with `{"enabled":true,"pattern":"pr-*"}`
  and an admin session token (permission `channel:branch-surfing`, admin-only).
  Check the live state from a laptop, no credentials needed: `vp run mobile:ota-surf-doctor`.
- **Cleanup** logs in with `OTA_ADMIN_EMAIL` + `OTA_ADMIN_PASSWORD` and deletes the `pr-N` branch.
  During migration it first deletes a same-named legacy channel when one exists.
- **Green-field consequence:** a legacy v1 client that sends **no** `expo-app-id` header gets an
  HTTP 400 from V3. That's correct — only new header-carrying V3 builds ever hit V3; old binaries
  pointed at V2, which no longer exists.

### Managing xprem as code

The channel mapping, Branch Surfing and branch protection used to exist only as dashboard state. They
are now declared in `infra/ota/config.ts`, and `vp run ota:apply` compares that declaration with the
server. It follows the Railway tool (`infra/railway/`, `vp run railway:apply`): typed desired state,
a pure plan function (`infra/ota/plan.ts`), and all I/O in the script.

```bash
OTA_ADMIN_EMAIL=... OTA_ADMIN_PASSWORD=... vp run ota:apply             # plan: print the diff, exit 1 on drift
OTA_ADMIN_EMAIL=... OTA_ADMIN_PASSWORD=... vp run ota:apply -- --apply  # make the server match
```

What the tool converges:

| What | Declared value |
| --- | --- |
| Channel `production` | serves branch `production` |
| Branch Surfing on `production` | on, pattern `pr-*` |
| Branch `production` | exists, protected |
| Branch `pr-beta` | exists, protected |
| Branch `pr-staging` | exists, protected |
| Branch `pr-stable-candidate` | exists, protected; frozen bytes for blocking QA |

On 2026-10-05 the server differed from this in four ways: `pr-beta` did not exist, and none of the
three branches was protected. The first apply creates one empty branch and sets three flags.

A protected branch cannot be deleted by anyone until the flag is lifted in the dashboard.
`pr-staging` and `pr-beta` carry the `pr-` prefix so the single surfing glob covers them, which
leaves the PR-number check in `scripts/ota-preview-cleanup.ts` as the only thing between a cleanup
run and those branches. Protection is the second lock.

The same file declares the daily controller's release policy: canary steps 5, 10, 25, 50,
four hours per step, at least 20 hours overall and eight hours at 50%, then a healthy finish in the
22:00 UTC daily window. The controller stays read-only for production until
`OTA_STABLE_RELEASE_ENABLED=true`. Health thresholds remain provisional until the fleet's normal
faulty-device rate has been measured; see the daily stable runbook below.

What the tool will not do, whatever the declaration says:

1. Delete a channel, a branch or an update.
2. Touch a per-PR preview branch (`pr-<number>`). Declaring one is rejected before the server is read.
3. Lift protection from a branch.
4. Remap a channel while a rollout is live on it or on either branch involved.
5. Change anything it finds on the server that is not declared. It prints those and leaves them.

Live rollouts are state, not configuration: every plan lists them and none of them counts as drift.

**Exit codes.** `0` in sync. `1` the server was read and differs, and nothing else. `2` the server
could not be read after three tries (a failed login, a 5xx, a timeout). `3` the tool itself failed:
bad arguments, a refused write, an answer it could not parse. The difference matters to whoever is
paged: `1` is somebody's change, `2` is an outage or a rotated password, `3` is a bug or an API that
moved.

**Licence.** Branch protection and update health are Enterprise features in the 3.2.5 dashboard.
Every plan prints the server's licence state. If the server refuses a protection call for that
reason, the run says so in those words, still creates any missing branch (every create is planned
before any protect), and exits `1`.

#### What runs unattended, and what waits for a person

| Trigger | What it may change |
| --- | --- |
| Push to `main` touching `infra/ota/**` | Additive only: create a declared branch, protect a declared branch. It prints the whole plan and lists everything else as `pending manual apply`. |
| `ota-apply.yml` dispatched with `mode: plan` (the default) | Nothing. |
| `ota-apply.yml` dispatched with `mode: apply` | Everything declared: also remapping the channel, changing Branch Surfing, creating a channel. |
| `ota-drift.yml`, daily at 05:17 UTC | Nothing. It reports. |

Remapping the channel moves the whole fleet to another branch, and widening Branch Surfing changes
what any device may switch to. Neither happens because a PR merged. The allowlist is the script's
`--only create-branch,protect-branch` flag, which is unit-tested; the workflow only chooses the mode.
A pending change does not fail the push run, and the daily drift check keeps reporting it until
someone dispatches an apply.

`ota-drift.yml` asks two questions and gives each finding its own Discord message (API moved,
server differs, server unreadable, the check itself failed):

1. **Is the admin API still where our client expects it?** `vp run ota:api-probe` downloads the
   public dashboard bundle and checks that every path the client calls is still in it. No login.
2. **Does the server match the declaration?** A plan, never an apply.

#### One-time setup: the `ota-stable-release` environment

The four workflows (`ota-apply.yml`, `ota-drift.yml`, `mobile-ota-unlock.yml`,
`ota-rollout-proof.yml`) take the admin login from a GitHub environment named `ota-stable-release`. **It does not exist until the owner creates
it.** A job that names a missing environment makes GitHub create it with no protection at all, so
do this in order:

1. Create the environment `ota-stable-release`.
2. Set its deployment branches to **Selected branches**, with `main` as the only one.
3. Only then add:

| Environment secret | Used for |
| --- | --- |
| `OTA_ADMIN_EMAIL` | the dashboard admin login |
| `OTA_ADMIN_PASSWORD` | the dashboard admin login |
| `DISCORD_DEPLOY_WEBHOOK` | the drift alert |

All three are **secrets**, the email included. The preview environments keep the email in a
variable, and a variable is printed in logs unmasked; these jobs read it from `secrets` only and
mask it again before their first command. None of the tools prints the email, and a refused login's
error has it removed from whatever the server answered.

`ota-rollout-proof.yml` also needs the publish token, `EOO_TOKEN`, and the `EXPO_UPDATES_URL`
variable. Both are repository-level, so a job in this environment already sees them and nothing has
to be added. If `EOO_TOKEN` is ever moved into another environment, that workflow fails and names it.

`DISCORD_DEPLOY_WEBHOOK` exists today only in the `Production` environment, and a job reads one
environment. Without a copy in `ota-stable-release` the drift job goes red and says so in its
summary, and nothing reaches Discord.

Each workflow also refuses, in its first step, to run from any ref but `main`. It checks out `main`
and installs nothing: every script it runs uses node built-ins only, so no package's install script
executes in a job that holds the admin login. Until the environment holds the login, each job
writes one "Skipped" line to its summary and ends green.

#### The admin API these tools use

xprem documents the publish protocol and not the API its dashboard calls. `scripts/lib/xprem-admin.mts`
is a client for that API, and its header lists every path, method and payload with the dashboard
bundle and server version they were read from. Two checks stand behind it, and they cover different
things:

- `scripts/lib/xprem-admin.test.ts` pins the requests **our client** makes, against a fake server.
  It catches an accidental edit to the client. It cannot notice the real server changing.
- `vp run ota:api-probe` reads the **live** dashboard bundle and fails when a path the client calls
  is no longer in it. The daily drift workflow runs it, so an upgrade that moves an endpoint goes
  red within a day. Run it by hand after any `OTA_SERVER_VERSION` bump.

Neither proves a response shape. The client parses responses strictly, so a changed shape fails
loudly the first time it is read. None of this has been exercised against the live server with an
admin login yet.

Two things in that API are easy to get wrong:

- **Two id spaces.** The rollout endpoints and `expectedUpdateId` use the numeric update id
  (`17911745123242`). Health is keyed on the UUID-shaped id a device reports
  (`43d5c1d5-ade8-62d9-1d01-9ffa9a169620`). `mobile-ota-rollout.ts` resolves one to the other.
- **Remapping a channel is addressed by branch id**, not name:
  `POST /api/apps/{app}/branch/{branchId}/updateChannelBranchMapping`. A "Legacy" branch has no
  id, and the tool refuses to map a channel to one.

#### Rollouts: `scripts/mobile-ota-rollout.ts`

```bash
node --experimental-strip-types scripts/mobile-ota-rollout.ts status
node --experimental-strip-types scripts/mobile-ota-rollout.ts set    --runtime-version <rtv> --percentage 25
node --experimental-strip-types scripts/mobile-ota-rollout.ts finish --runtime-version <rtv>
node --experimental-strip-types scripts/mobile-ota-rollout.ts revert --runtime-version <rtv>
node --experimental-strip-types scripts/mobile-ota-rollout.ts health --runtime-version <rtv>
```

All of them take `--branch` (default `production`), `--platform ios|android|all` and the admin login
in the environment.

- `status` without `--runtime-version` walks **every** runtime version of the branch. A rollout
  belongs to one branch, one runtime version and one platform, and a release-train merge-back can
  leave one behind on a runtime version nothing publishes to any more.
- `set`, `finish` and `revert` read the rollout first and send the update id they found as
  `expectedUpdateId`, so the server refuses the write if the rollout was replaced in between.
  `--expected-update-id` also refuses to act on any rollout but the one named. A rollout that
  disappears before the command's own first write is an error, not a success.
- `finish` delivers the update to everyone. `revert` republishes the previous update as a new one;
  devices that took the canary return to it on their next check. `revert --if-live` treats "nothing
  is rolling out" as success.
- `health` prints a verdict per platform: `healthy`, `unhealthy` or `insufficient-evidence`.

How a canary is judged (`judgeCanary`, thresholds in `infra/ota/config.ts`):

1. Counts that are not finite, non-negative numbers are not evidence.
2. More faulty devices than devices on the update is treated as a crash loop: an update that
   crashes at launch falls back to the embedded bundle, so its devices stop counting as on the
   update. On 3 or more faulty devices that is unhealthy; on fewer there is not enough evidence.
3. The allowed faulty-device rate is the control's rate plus 2 points, capped at 5%. A control with
   fewer than 15 reporting devices counts as 0%, so a tiny or broken control cannot raise the bar.
4. Below 15 reporting devices the canary is never healthy. It is unhealthy only on 3 or more faulty
   devices at 30% or more; otherwise there is not enough evidence.
5. From 15 devices up: over the allowed rate on 3 or more faulty devices is unhealthy, over it on
   fewer is not enough evidence, and anything else is healthy.

Every verdict comes with a reason that names the rule behind it.

Launch and JS issue counts are printed and not judged: whether the server reports them as running
totals or per-minute counts is not known yet.

**What the throwaway-branch proof must establish** before any of this decides a release:

1. The full sequence on a scratch branch: start a rollout, publish refused, rollback refused,
   revert, publish accepted.
2. What an anonymous manifest request is served while a rollout is live.
3. Whether `expectedUpdateId` must be sent as a number or a string.
4. Whether one rollout write moves every platform that shares a runtime version.
5. Whether a device that fell back to the embedded bundle still counts in `devicesOnUpdate`. Rule 2
   above assumes it does not.
6. Whether `updateIssues` and `runtimeIssues` are running totals or per-minute counts.
7. How the server words a refusal of a licensed feature.
8. That a rollout names the update it replaced (`controlUpdateId`) whenever one existed. The
   promote re-run check refuses when it is missing.

##### Running the throwaway-branch proof

`scripts/ota-rollout-proof.ts` runs that sequence against the live server, on a scratch branch, and
prints what the server did. It is dispatch-only and asks for the branch name to be typed:

```bash
gh workflow run ota-rollout-proof.yml --ref main -f confirm=pr-rollout-proof
```

It takes three to five minutes. The transcript is the run's summary page, and the same transcript
plus a `result.json` are in the `ota-rollout-proof` artifact (kept 30 days).

What keeps it away from the fleet:

- **The branch is `pr-rollout-proof` and nothing else.** The script refuses any other name, a
  declared long-lived branch, and a branch the server maps to any channel. `infra/ota/config.ts`
  names it (`ROLLOUT_PROOF_BRANCH`) and deliberately does not declare it.
- **The runtime version is minted per run** (`rollout-proof-<UTC timestamp>-<random>`). No binary
  has it, so no device can be served anything the proof publishes. A fingerprint is refused.
- **Every request passes an allowlist before it is sent.** Reads, the login, writes addressed
  to that branch and that runtime version, and file uploads to the exact URLs a lease named. A request for `production`, for another runtime version,
  to a channel or to Branch Surfing is refused in the script and never reaches the server.
- **The updates are a comment.** Each one is `metadata.json`, `expoConfig.json` and a three-line
  `.js` file that says it is a rollout proof.

The steps, each ending `PASS` (an expectation held), `FAIL` (it did not) or `OBSERVED` (a question
with no right answer, written down):

| Step | What it does |
| --- | --- |
| guards | Signs in, reads the channels, refuses if any serves the branch. |
| a | Publishes update A at 100% for iOS and Android. Checks it is the head and that a manifest probe is answered from the branch. |
| b | Publishes update B at 10%. Records the lease echo and the shape of `GET …/rollout`. |
| c | Asks the manifest as a device with no client id, then as 40 simulated devices, twice. |
| d | Tries a publish, a republish and a rollback while the rollout is live. Each should be a 409. |
| e | Raises to 25%, then 50%. Checks that devices are only ever added. |
| f | Reads health for B and A. |
| g | Reverts. Records what the new head is, then publishes update C to show the lock is gone. |
| h-start | Publishes update D at 10%. |
| i | Sends `PUT …/rollout` and `revert` with a wrong `expectedUpdateId`, as a string and as a number. |
| h-finish | Finishes D, checks everyone is served it, publishes update E. |
| cleanup | Reverts a rollout that a broken step left live. Normally there is none. |
| j | Says whether one write moved both platforms, from how many writes the lib needed. |

A step that needs a broken step is `SKIPPED`. The summary table always lists every step. The run
ends red if any step failed.

**The manifest probes.** They send the headers a store binary sends (`expo-channel-name:
production`) plus `xprem-branch: pr-rollout-proof`, so they depend on Branch Surfing offering the
branch. Step a checks that first, by looking for `extra.branch` in the answer. If the probe is not
answered from the branch, steps c, e, g and h-finish skip their device checks and say so. They do
not count "no update" as "control".

**The simulated devices are not UUIDs by default.** The server buckets a rollout on a hash of the
raw `EAS-Client-ID`, and its Observe check-in only registers a device whose id parses as a UUID. So
ids like `rollout-proof-…-device-07` sample the rollout without adding 40 phantom devices to the
device registry. If the 50% step reports that no simulated device got the canary, dispatch again
with `-f uuid_client_ids=true`, which sends random UUIDs and does register them.

**What it leaves behind.** The branch `pr-rollout-proof`, one runtime version per run, and six
small updates per platform under it (A to E, and the copy of A that the revert publishes). Nothing
is deleted: removing the branch afterwards is the owner's call (dashboard, Branches). Its update
folders sit under the `pr-` storage prefix, which the bucket lifecycle rule expires after 14 days.
The bundles themselves are a few bytes each in the app's content-addressed store (`{appId}/cas/`),
and any bundle patches the server computes between them land under `{appId}/bsdiff/`. That rule
covers neither. `vp run ota:apply` and the daily drift check report the branch as a note and never
as drift.

**What it cannot establish.** Items 5 and 6 of the list above need a real device that runs an
update, fails and falls back. Nothing runs these updates, so the proof records the shape of the
health answers for an update with no devices and stops there.

**What the server source says to expect.** xprem is public, and
`mercuretechnologies/xprem` at the `v3.2.5` tag reads as follows. This is a reading, not a result:

- The publish lock is per branch and runtime version, across platforms
  (`HasActiveRolloutUpdate`). `requestUploadUrl`, `republish` and `rollback` all check it first and
  answer 409.
- A rollout row is per platform, and `PUT …/rollout` and `revert` act on every active row of the
  branch and runtime version. One call moves both platforms when they share a runtime version.
- `expectedUpdateId` is decoded as a JSON **string**. A number is a 400 ("invalid request body")
  before any comparison, and a wrong string is a 409. `GET …/rollout` serialises `updateId` as a
  string, so echoing it back unchanged is correct.
- A request with no `EAS-Client-ID` is never in a rollout and is served the control.
- `revert` republishes each control as a new update with an empty commit hash, or publishes a
  roll-back-to-embedded directive when the rollout had no control.

##### Results

[Run 37291343711](https://github.com/boardsesh/boardsesh/actions/runs/37291343711) passed on
2026-10-05. The script took 59 seconds on `pr-rollout-proof`: twelve steps passed, the shared-runtime
step recorded an observation, and none failed or skipped. Its `ota-rollout-proof` artifact contains
the transcript and raw replies. This proves the control plane; it does not qualify a current native candidate.

| Question | Measured result |
| --- | --- |
| Publish locks | Publish, republish and rollback returned 409 during a live rollout; publishing succeeded after revert and finish. |
| Device assignment | Anonymous requests received control. Each of forty IDs per platform kept its assignment; increasing 10% → 25% → 50% only added canary devices. |
| IDs and scope | `GET …/rollout` returned string IDs and one row per platform. Wrong string `expectedUpdateId` returned 409; a number returned 400. One write moved both platforms sharing the synthetic runtime. Production fingerprints differ, so production requires two writes. |
| Revert and finish | Revert restored control bytes under new UUIDs and null commit hashes. Finish served the candidate to anonymous and sampled devices; both operations removed the publish lock. Control IDs were present. |
| Remaining gaps | No device executed these bundles. Fallback-device accounting, issue-counter time semantics and a licensed-feature refusal remain unmeasured. Zero-device health correctly returned insufficient evidence. |

`mobile-ota-unlock.yml` wraps `revert --if-live` for publishers that must not be refused by a live
canary. It takes the iOS and the Android runtime version in one run. It is dispatch-only: a
reusable workflow is loaded from the caller's ref, so a release branch could change the steps that
run with the admin login. Callers will start it with
`gh workflow run mobile-ota-unlock.yml --ref main`. Native-build republishes and manual hotfix/backport
publishers dispatch and await that trusted workflow before writing production. A failed or missing
unlock blocks the publish. Staging exports do not unlock or replace production.

#### Daily stable runbook

`mobile-ota-stable-release.yml` runs dependency-free controller code from `main`. Its admin environment,
`ota-stable-release`, must use **Selected branches: main only**. The channel still serves `production`;
`pr-stable-candidate`, `pr-staging` and `pr-beta` are protected branches reached through the existing
`pr-*` surfing pattern. Creating the new protected branch requires the usual `ota:apply` convergence.

GitHub setup was verified on 2026-10-08: this environment selects only the `main` branch, and the
repository activation variable was explicitly set to `false`. This is the initial cutover state;
the proof and store-device checks below are still required before changing that variable.

Relevant `main` pushes always publish to staging, wait for deployment and backend-schema readiness,
then promote those exact exported bytes to `pr-beta`. This supplies early-update store QA before cutover.
Before `OTA_STABLE_RELEASE_ENABLED=true`, successful deployments additionally keep the existing
per-merge production promotion. Once enabled, production receives the daily qualified canary instead.
The activation switch controls production cadence, not staging or beta publication. Native builds,
release trains, manual hotfixes and backports retain
their existing publish routes, with the trusted unlock before a production write.

| Time, UTC | Controller work |
| --- | --- |
| 19:17 daily | Prepare the newest successful `main` push deployment with a complete stage artifact. Copy its exports to `pr-stable-candidate`; pin SHA, runtimes, hashes and source run; run all navigation smokes and both native boot checks against that frozen receipt. |
| 22:00 daily | Start one qualified candidate at 5%, or finish an eligible healthy canary. This is 9am Sydney during daylight saving, 8am during standard time. |
| Minute 37 hourly | Recheck health and apply at most one timed step. Delays do not skip soak periods. |

Each of 5%, 10%, 25% and 50% must soak for at least four hours. Completion additionally needs at
least 20 hours overall, eight hours at 50%, the 22:00 UTC hour and healthy evidence on every changed platform.
Insufficient samples with valid counts may progress through 50%, then hold. Missing or malformed
health data holds progression. An unhealthy platform reverts the owned canaries, except the partial-finish
case below. There is only one active production canary; staging and beta continue independently.
Start and step clocks begin after every changed platform write is confirmed, so a partial write never shortens a soak.

An unchanged platform must match one coherent production manifest: its captured native update UUID,
launch bundle hash, asset hashes and Expo client configuration must match the frozen candidate.
The controller records that UUID separately from the rollout IDs it owns. If both platforms are
unchanged, it records the candidate as completed without rollout writes. If only one changes, only
that platform needs rollout health and soak evidence; both platforms still require frozen native QA.
The unchanged manifest is rechecked before each transition. An external change holds completion and
reverts any owned sibling canary while preserving the external update.

Upload leases and unchanged-platform attestations are checkpointed before bundle uploads or
finalization. A retained receipt can recover a cancelled start, after validation against the frozen
candidate and captured baselines. Normal active phases restore the candidate bytes for those checks;
abort and revert can release owned canaries without that archive.

Preparation and tick artifacts retain candidate bytes, receipts, owned update IDs and checkpoints for
30 days. The source `mobile-ota-stage` artifact has its separate seven-day retention. Discovery accepts
only trusted workflow runs on repository `main`; the stage receipt must match the source run SHA.
Blocking QA must name the same frozen SHA, branch and receipt. Failed, cancelled, skipped or missing
jobs cannot qualify a candidate. Historical proof runs below do not substitute for fresh qualification.

**Activation remains off until proof and store QA pass.** Run fresh green and deliberately broken
candidates on iOS and Android, including the required navigation smokes and real downloaded bytes.
On physical store builds, verify early-update opt-in and opt-out, offline restart, preview precedence,
native upgrade and flag disablement. Then enable `OTA_STABLE_RELEASE_ENABLED`; activate the separate
`early-updates` product flag only after that device QA and the download/pin serialization work in
the Early updates section. The five-night advisory warm-up is not a prerequisite.
The [2026-10-08 reconstruction proof](ota-differential-proof-2026-10-08.md) verifies one real production
patch on each current native runtime: 18.34% of the measured gzip transfer on iOS and 20.43% on Android.
Issue [#6098](https://github.com/boardsesh/boardsesh/issues/6098) remains open for fleet download timing,
patch coverage, publish memory and emergency-launch evidence. The launch cap stays at ten seconds.

**Read a hold before retrying.** The workflow summary records the decision; the latest earlier write run's
state artifact is the authority. The current run is ignored, along with future queued, pending, waiting or
requested writes that have not started. A future completed or in-progress write run blocks this run;
dispatch a new controller run so it can read that newer checkpoint. Read-only plans never replace state.
Missing or unknown future-writer status also blocks recovery. An older unfinished write
run still blocks recovery. A missing, expired, corrupt or stale latest earlier checkpoint blocks automation, including
after a failed or cancelled run. Do not substitute an older artifact, reset ownership or guess a baseline.
Recovery requires the valid latest checkpoint: repair missing state from retained authoritative evidence
and compare its producer and owned IDs with the live server before retrying. `abort` cannot reconstruct
a lost or expired checkpoint. A candidate older
than 30 days must be prepared again. An independent production publication invalidates its recorded baseline;
only the controller's own completed canary may refresh a waiting candidate's baseline.

**Recover partial writes explicitly.** Intent and leased IDs are saved before writes; successful platform
results are retained. A retry may acquire a fresh lease if its recorded lease never became live; adoption of
an existing live canary requires the recorded ID. A changed completed-platform head blocks the remaining
write. To abandon a partial start or interrupted release with a valid checkpoint, dispatch:

```bash
gh workflow run mobile-ota-stable-release.yml --ref main -f command=abort
```

This main-only recovery takes the production lock even when `OTA_STABLE_RELEASE_ENABLED` is false.
It clears the waiting candidate, probes production heads, preserves independently published hotfix/native
updates and reverts any remaining live canary using its saved expected ID. An enabled tick that sees an
interrupted ramping canary follows the same abort path; trusted unlock and hotfix publication do not
permanently strand the controller. The standalone unlock itself does not erase controller state.

If a platform is unhealthy after the other platform finished at 100%, automation holds for manual recovery.
Reverting the remaining canary cannot restore the completed platform. While that platform still serves
the controller's finished UUID, `abort` refuses too: publish the approved known-good bytes for that platform
through the trusted publisher/unlock route, then dispatch `command=abort` to preserve the restored head
and revert the remaining owned canary. The controller never guesses a rollback bundle or overwrites
an independent recovery publication.

For a read-only inspection, dispatch `mobile-ota-stable-release.yml` with `command=plan`. Dispatch
`command=prepare` to freeze and test a candidate without enabling production writes. `command=tick` writes
only when the repository activation variable is true. Planning does not publish a replacement checkpoint.
Retry with a **new dispatch**, rather than GitHub's Re-run button: mutating run attempts other than one are
refused so a previous attempt's artifact IDs and ownership evidence are never replaced. Dispatch a new
`command=tick` to resume recorded work, or a new `command=abort` for explicit recovery.

#### Promoting to another branch, or as a rollout

`scripts/mobile-ota-promote.ts` takes optional flags. With none of them, it behaves as before.

- `--branch <name>` promotes to that branch (and `--capture-baseline --branch <name>` captures its
  baseline). The probe still sends `expo-channel-name: production` and reaches the branch with the
  `xprem-branch` header, the way a pinned device does.
- `--rollout-percentage <1-99> --rollout-receipt <path>` starts the update as a rollout. The
  anonymous manifest shows one device's view and cannot confirm a rollout, so this mode reads the
  rollout through the admin API and needs `OTA_ADMIN_EMAIL` and `OTA_ADMIN_PASSWORD` next to
  `EOO_TOKEN`. Admin and publish calls go to the same server, the one `EXPO_UPDATES_URL` names.
- **Rollout mode does not run the served-bytes check** that the default mode ends with. It confirms
  that the update it was leased is rolling out at the requested percentage. The bytes are covered
  only by the content hashes the server validated at upload.
- It is safe to re-run. Before any upload it writes the rollout receipt: the update id it was
  leased per platform, and the update each rollout is about to replace (the staged baseline). On a
  re-run, a platform whose live rollout carries its recorded id, built from its commit, counts as
  done. A live rollout it cannot tie to its own receipt is refused, even when it was built from the
  same commit, so keep the receipt file with the stage receipt between attempts.
- A platform whose own rollout is already live is **not** checked against the anonymous manifest:
  this promotion changed what the branch serves, and the manifest shows one device's side of a
  rollout. It is checked against the server's record of what the rollout replaced instead. That
  update must be the baseline in the receipt. If something else was published in between, the
  re-run refuses.

### Fingerprint parity — the one rule that matters

**Browser-data updates can change the native fingerprint.** On 19 September 2026,
the Next.js update in #4982 also refreshed `baseline-browser-mapping` from 2.11.17
to 2.11.24 and `caniuse-lite` from 1.0.30001809 to 1.0.30001810. Expo loads these
through its config plugins and includes their files as `expoConfigPlugins`
fingerprint sources. Those were the only source differences between the approved
iOS 2.5.0 runtime (`b71bdb600c5a`) and main (`b1058ef575fa`). No mobile native
feature caused that drift.

Main pins both datasets to the approved versions in `pnpm-workspace.yaml`, while
keeping Next.js 16.3.5. Advance these dependencies on `release/next` alongside a
new native build. Do not exclude their files from fingerprinting or override the
runtime hash to force an OTA through. Compare actual fingerprint sources when a
web dependency update unexpectedly changes mobile compatibility; a matching PR
and main hash alone does not prove that either matches the App Store binary.

The published runtimeVersion must equal the one the native build baked into the binary, or the OTA
silently never lands — and the publish must run the **`fingerprint` policy** (resolve the _current_
commit's hash), never a fixed value, so a native change moves the runtimeVersion and old binaries are
correctly excluded. Two things make that hold:

- **The binary embeds the _Linux_ fingerprint.** `@expo/fingerprint` is not deterministic across
  Linux and macOS, but the iOS binary is baked on macOS while the gate and the publish run on Linux.
  So the iOS build exports `EXPO_UPDATES_FINGERPRINT_OVERRIDE` set to the gate's Linux fingerprint;
  `app.config.ts` emits it as a literal runtimeVersion, and prebuild bakes _that_ into the binary
  instead of the macOS-resolved hash. (Android sets it too, for a uniform invariant.) This is what
  previously stranded iOS OTAs: the binary embedded a macOS hash the Linux publish never published
  under.
- **The publish resolves fresh.** The OTA publish sets **no** override — it resolves the current
  commit's fingerprint (`{ policy: 'fingerprint' }`) on Linux and serves the JS under it. For a
  JS-only commit that equals the shipped binary's embedded Linux value (OTA lands); on a native
  change it resolves the **new** hash, so old binaries (still on the old one) never receive JS that
  needs the new native code. **Pinning the publish to a fixed value (e.g. the last shipped tag) would
  do exactly that — a crash** — so `scripts/mobile-ci-env-parity.test.ts` asserts the publish never
  sets the override.

The fingerprint hashes the **resolved Expo config**, native files, the fingerprint config, and root
patch bodies — **not** the JS bundle — so the publish must resolve `app.config.ts` to the same
config the native `expo prebuild` did. The
config-affecting env that must match is `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` (drives the google-signin
plugin's native `iosUrlScheme`), `GOOGLE_MAPS_API_KEY` (drives `android.config`), and
`EXPO_UPDATES_URL`. The production and xprem headers are literals in app config. The other
`EXPO_PUBLIC_*` are inlined into the JS bundle;
they must still match so the OTA points at the right backend/analytics, but drift there is a runtime
bug, not a delivery failure. Mechanisms, all enforced/handled in CI:

- **Binary pin + fresh publish.** The native builds set `EXPO_UPDATES_FINGERPRINT_OVERRIDE` to the
  gate fingerprint; the publish leaves it unset. `scripts/mobile-ci-env-parity.test.ts` asserts both
  (and that no build-side re-resolve creeps back in).
- **Env parity.** `mobile-ota-production.yml` declares the same `EXPO_PUBLIC_*` + `EXPO_UPDATES_URL`
  env as `ios-testflight-rn.yml` / `android-apk-rn.yml`. The same parity test fails the build if they
  drift.
- **Per-platform publish.** `GOOGLE_MAPS_API_KEY` is set only on the Android prebuild (iOS uses
  Apple Maps) and it changes the resolved config — hence the fingerprint — for the Android side. So
  the workflow publishes iOS **without** the key and Android **with** it, in separate steps. A single
  `--platform all` publish with one env could only ever match one side.

### pnpm isolated-linker normalization and complete native inputs

pnpm's isolated linker stores a package below
`node_modules/.pnpm/<entry>/node_modules/<name>`. The entry encodes the lockfile dependency path:
scoped package slashes become `+`, and pnpm flattens patch and peer-resolution suffixes into an
underscore-separated tail. For example, a patched `@expo/ui` with a React peer is shaped like
`.pnpm/@expo+ui@57.0.14_patch_hash=<hash>_react@19.2.3/node_modules/@expo/ui`.

The peer portion describes the JavaScript install graph rather than native compatibility. An
unrelated dependency change can move that suffix without changing the package name, version, patch,
or native code. Raw Expo autolinking config contains these store paths, so hashing them verbatim
would move `runtimeVersion` and force a native build for install-graph noise.

`packages/mobile/fingerprint.config.js` normalizes this without hiding real native changes:

- Its content hook runs for exactly four serialized sources:
  `expoAutolinkingConfig:{ios,android}` and `rncoreAutolinkingConfig:{ios,android}`. It parses the
  JSON, walks nested objects and arrays, and removes only the peer tail from a SemVer-shaped
  `.pnpm/<encoded-package>@<version>/node_modules/<matching-package>` boundary. Package names,
  versions, prereleases, build metadata, and the content-addressed patch marker remain in the hash.
  `_` is not legal in a SemVer version, so the peer tail has an unambiguous start. Malformed store
  entries, mismatched package paths, file sources, `expoConfig`, and every other contents source are
  untouched; the normalization fails closed.
- Its `extraSources` hash `fingerprint.config.js` itself and the monorepo-root `../../patches`
  directory under stable keys. Expo's built-in patch discovery only checks
  `packages/mobile/patches`, while this repo's `patchedDependencies` live in the root
  `pnpm-workspace.yaml`; without the explicit source, editing native iOS/Android patch code at an
  unchanged package version would look OTA-compatible.

Long pnpm store entries are truncated and end in a 32-hex digest. The digest is part of the peer tail
and is removed with it. `virtualStoreDirMaxLength` is pinned to 120 in `pnpm-workspace.yaml`; pnpm's
platform-specific defaults would otherwise truncate at different points and make a contributor's
fingerprint disagree with CI. If truncation ever consumes the name or version prefix, the parser
leaves the path untouched, over-triggering a build rather than hiding a native change.

Expo's default `**/node_modules/**/node_modules/**` ignore also mistakes the isolated-store wrapper
for a genuine nested dependency. The exact-pinned patch
`patches/@expo__fingerprint@0.20.11.patch` collapses
`node_modules/.<store>/<entry>/node_modules/` wrappers when matching ignores and building
file/directory hash ids. Its dot-prefixed store match cannot collide with a real npm package name,
and pnpm's hoisted-compat directory does not have the required `<entry>/node_modules/` shape.
Autolinked native directories therefore contribute non-null hashes with stable logical ids, while a
real `node_modules/package/node_modules/transitive` subtree stays ignored. The mobile patch check
asserts both patch sentinels are installed, and the fingerprint tests assert that direct package
resolution and Expo's `expo/fingerprint` export reach the same real package path.

**Native release boundary.** Moving from one isolated-store layout to another changes the serialized
autolinking paths and intentionally moves both platform fingerprints once. The landing PR must stay
marked `native-fingerprint`, and matching iOS and Android store builds must ship before OTAs under
the new hashes can reach users. Do not force or backport the new JS under an old `runtimeVersion`;
old binaries keep their embedded bundle until they install the new store build.

**`EXPO_PUBLIC_USE_RN_FETCH=1` — pin RN's fetch, not expo/fetch.** Expo 57's WinterCG runtime installs
`expo/fetch` as the global `fetch` unless this flag is `'1'`. `expo/fetch`'s native `NativeResponse`
clears its state-change listeners on a background dispatch queue, which releases the captured
`JavaScriptPromise` JSI objects **off the JS thread** — destroying Hermes-owned pointers on the wrong
thread and crashing with `EXC_BAD_ACCESS` (Sentry `7595562195`). Since every GraphQL HTTP POST goes
through the global `fetch`, this hit production hard. The flag is **bundle-only** — it's referenced
only in Expo's JS runtime, never in `app.config.ts`, so it never enters the resolved config and does
**not** move the fingerprint (verified by resolving with/without it). That's why the fix shipped as a
plain OTA to already-installed binaries. It's part of the `mobile-ci-env-parity.test.ts` shared set so
it can't silently drop out of one channel (which would revert that channel to the crashing
`expo/fetch`), and `scripts/mobile-ota-compat-check.ts` writes it into the preview/`.env` too.

## Native releases and build gating

Two branches, two jobs. `main` owns production OTA delivery to the **store
fleet**; `release/next` — the release train — owns the automatic native TestFlight
and Play-internal builds, and publishes OTAs to the binaries it produces. Regular
changes target `main`; every change that moves the native fingerprint targets
`release/next`. The PR-time OTA compatibility check enforces that: a
fingerprint-moving PR into `main` fails its check-run unless it carries the
`allow-native-on-main` label, because main no longer builds a replacement binary
for it. The train's fingerprint tags (`fingerprint-<platform>-<hash>`) therefore
come from `release/next` builds. Full lifecycle, including the sync and merge-back
commands: `docs/mobile-store-release.md`.

A native change moves the fingerprint requested by production OTA, so installed
binaries on the previous fingerprint stop receiving new bundles until users
install the replacement store release. That gap closes at merge-back: once
`release/next` merges into `main`, main's fingerprint equals the shipped binaries'
again and main's publisher serves the new fleet. Prepare the version and localized
release notes before the final native change (the version no longer moves the fingerprint, so
bumping it alone starts no build; see [Version-only releases](#version-only-releases)),
keep the release focused, and move
both store builds through QA and review promptly. Keep backend changes compatible with the
currently shipped app until the replacement has been adopted.

### GraphQL schema changes: installed builds keep querying old fields

Every installed bundle, including old store builds and `pr-*` preview branches pointed at
production, keeps sending the queries it shipped with. Two rules follow (#5370):

- **Backend first.** Deploy a new field before the OTA that queries it. An OTA that lands first
  fails those requests until the backend catches up.
- **Never remove what installed builds still query.** Mark the field `@deprecated` and remove it
  only after those builds are gone: the store release that stopped querying it has been out for a
  full adoption cycle, and PostHog's `OTA Update Status` event, grouped by `runtimeVersion` (see
  [OTA observability](#ota-observability-adoption--funnel)), shows no meaningful traffic on older
  fingerprints. After the removal, watch Sentry for `schema_mismatch:true` events naming the field. CI's `codegen-drift` guard (a step of ci.yml's `guards` job) runs
  `packages/shared-schema/scripts/check-breaking-changes.ts`, which fails a PR whose generated SDL
  removes a field, argument, type or enum value (or adds a required argument / input field)
  against the base branch. A deliberate removal opts out with the `schema-breaking-ok` label;
  adding a label does not re-trigger CI, so re-run the job afterwards.

When a mismatch does reach a phone, the mobile client does not retry the request
(`GRAPHQL_VALIDATION_FAILED` fails the same way every time) and reports it to Sentry at `warning`
level, tagged `schema_mismatch: true` and fingerprinted by the validation message. Each mismatch is
its own Sentry issue; the `ota_channel` tag shows which bundle sent it. Before that change, all of
them landed in catch-all issues on the GraphQL client frame (BOARDSESH-CJ / BOARDSESH-7H), which
still collect unrelated request failures and must not be resolved as "the schema issue".

The native builds (`ios-testflight-rn`, ~60 min on macOS;
`android-apk-rn`, on Linux) only run when the fingerprint changes. A JS/TS-only
change keeps the same fingerprint, so a fresh store build is wasted. Each native
workflow gates itself on the fingerprint:

1. A cheap Linux **`gate` job** resolves the platform fingerprint with `vp exec expo-updates
runtimeversion:resolve` using the same **workflow-level** env the build uses (iOS without
   `GOOGLE_MAPS_API_KEY`, Android with it). The shared env sits at the workflow level so the gate
   and build can't drift, and the gate writes the same `.env` the build does — the `.env` is itself
   hashed into the fingerprint, so an absent or different one would resolve a different hash.
2. If a git tag `fingerprint-<platform>-<hash>` already exists, a binary with that fingerprint has
   already uploaded → the native build **skips**. Otherwise it **runs**.
3. On a successful build + store upload, the build job pushes `fingerprint-<platform>-<hash>` — the
   gate value the binary embeds (see the pin below), not a re-resolved one.

**Why a wrong skip is impossible.** The native build embeds the gate's exact value in the binary via
`EXPO_UPDATES_FINGERPRINT_OVERRIDE` (the macOS runner no longer re-resolves its own, divergent hash)
and tags it. So the tag, the binary's runtimeVersion, and the gate's skip-key are one value by
construction — the gate can never skip a fingerprint the binary lacks. This replaces the older "tag
the build-OS value and always-build on cross-OS divergence" scheme, which wasted iOS builds and —
worse — let the Linux OTA publish strand JS under a runtimeVersion the macOS binary never had.
Android builds on Linux like its gate, so it was never divergent; it pins the same way for a uniform
invariant. That claim is about fingerprint **identity** only — it says nothing about publish order,
which is a separate failure mode covered next.

### Fingerprint register

Record an entry when you land a native change, so a JS slice that needs the new binary knows which
hash to gate on and the next reader can tell an intended move from a surprise.

**Never record a bare local `runtimeversion:resolve`.** The absolute hash is a function of the whole
resolved config, and the native workflows feed it a `.env` of `EXPO_PUBLIC_*` values plus
`EXPO_UPDATES_URL` — the `.env` file is itself hashed, which is what
`scripts/mobile-ci-env-parity.test.ts` exists to keep in lockstep. A resolve without that env
produces a hash no binary will ever carry, and none of the 112 `fingerprint-*` tags match one. Even
WITH the CI env reproduced byte-for-byte, a developer box does not reliably land on the runner's
value; treat the absolute number as a CI output, not something to compute at your desk.

Two places produce a trustworthy hash:

- **`ota-check`** (`.github/workflows/mobile-ota-check.yml`) resolves both platforms on every PR push
  and prints a 12-hex prefix per side. Its **iOS** value is the real one — the iOS gate and
  `ota-check` both resolve without `GOOGLE_MAPS_API_KEY`, so the prefix matches the shipped
  `fingerprint-ios-*` tag. Its **Android** value is NOT: `GOOGLE_MAPS_API_KEY` is a
  Production-environment secret that feature-branch pushes cannot read, and the key perturbs the
  Android config. `ota-check` is still correct about Android *change vs no change*, because the
  missing key shifts both sides of its comparison equally — but the number it prints is not the
  number a binary embeds.
- **The `fingerprint-<platform>-<hash>` tag** the native build job pushes on a successful store
  upload. That is the full 40-hex value the binary actually embeds, and it is the only thing a JS
  feature gate may be written against. It exists only after the build runs on `main`.

So: record the iOS pair at merge time from `ota-check`, record the Android pair as "minted on merge",
and fill both in from `git tag -l 'fingerprint-*' --sort=-creatordate` once the store builds land.

| Merged | What moved it | iOS | Android |
| --- | --- | --- | --- |
| 2026-09-15, #5435 (SW-02) | `onnxruntime-react-native` 1.24.3 autolinked on Android via `packages/mobile/react-native.config.js`, `cameraPermission` on the `expo-image-picker` plugin, Android `CAMERA`, version 2.5.0 → 2.6.0 | main `b71bdb600c5a3e954d75c9ca673f056c62247ea9` (shipped tag) → PR `f0a4650d0746…` (`ota-check`; full hash lands as `fingerprint-ios-*` when `ios-testflight-rn` uploads) | main shipped tag `154bc941c504727afc914057aed2edff2c096576`; `ota-check` sees `fbc79fa47dc8…` → `4f14a7ee6bac…` WITHOUT the maps key, so neither is the binary's value — the real one lands as `fingerprint-android-*` when `android-apk-rn` uploads |
| 2026-10-04, #6006 | `fingerprint.config.js` gained `sourceSkips: ['ExpoConfigVersions', 'PackageJsonAndroidAndIosScriptsIfNotContainRun']` (bitmask 513), so `version`, `ios.buildNumber` and `android.versionCode` are no longer hashed. The config file is itself a hashed source, so this edit moved both fingerprints once. Landed on `release/next` | see the `fingerprint-ios-*` tags for #6006 | see the `fingerprint-android-*` tags for #6006 |

### Version-only releases

`fingerprint.config.js` sets `sourceSkips: ['ExpoConfigVersions',
'PackageJsonAndroidAndIosScriptsIfNotContainRun']`, which resolves to the bitmask 513.
`ExpoConfigVersions` drops `version`, `ios.buildNumber` and `android.versionCode` from the hashed
Expo config. The second name is `@expo/fingerprint`'s own default, restated because setting
`sourceSkips` replaces the default list. An unknown name is ignored without an error, so
`scripts/mobile-fingerprint-config.test.ts` pins both names against the installed enum, and
`check:mobile-fingerprint-inputs` fails if the hashed config carries those fields again.

Two marketing versions can now share one fingerprint. What follows from that:

1. A push to `release/next` that only bumps `version` resolves an existing
   `fingerprint-<platform>-<hash>` tag, so both native workflows skip the build. To ship a store
   binary that differs only by version number:
   1. Bump `version` and the release notes on `release/next`.
   2. Dispatch `ios-testflight-rn.yml` on `release/next`.
   3. Dispatch `android-apk-rn.yml` on `release/next` with `force_native` on.

   `mobile-store-draft.yml` then runs from the two completions.
2. After a version-only build the post-build OTA republish is skipped. The train guard in
   `mobile-ota-production.yml` does not publish while the train's fingerprint equals main's, so that
   binary runs its embedded bundle until main's next production publish.
3. A version-only release gets no "App update" marker in the in-app changelog (markers come from
   `fingerprint-*` tags) and no automatic screenshot run (that needs a fingerprint tag at the
   triggering commit). Dispatch the screenshot workflows by hand.
4. A backport (`mobile-ota-backport.yml`) to one version reaches every installed version that shares
   that fingerprint, because they request the same runtimeVersion. Backport only once `main` has
   moved off that fingerprint.
5. A version-only PR into `main` passes the OTA compatibility check, since the fingerprint does not
   move.

A version bump that rides along with a real native change works as before: the native change moves
the fingerprint and starts the build that carries the version. Every in-app reader of the app
version uses `expo-application` (the installed binary), so an OTA built from a newer `version` does
not change what an older binary shows or reports. Sentry release and dist come from the native
build.

These steps come from reading the workflows. No version-only release has been run end to end yet.

### Publish ordering: a binary can outrank a newer OTA

Matching fingerprints get an update *offered* to a binary. Whether it is *applied* is decided
separately, by time. `expo-updates` launches whichever update has the newest `commitTime`
(`LauncherSelectionPolicyFilterAware` sorts descending; `LoaderSelectionPolicyFilterAware` won't
even download one that isn't strictly newer than the running update). Upstream stamps a binary's embedded
`commitTime` when the **build** runs — `createManifestForBuildAsync.js` uses
`new Date().getTime()` — not when its commit was made. We patch that out; the history below is
what the patch is for.

A ~50-minute macOS build therefore finished with an embedded bundle *newer* than any OTA published
while it was running, even though that OTA came from a later commit. Both share a fingerprint, so
the OTA was eligible; it just always lost. It happened on 2026-09-01:

| time (UTC) | event |
| --- | --- |
| 02:06 | `aa5b4d3` pushed → iOS build starts |
| 02:31 | `c51fedb` (#4992) pushed → same fingerprint, so the native build skips |
| 02:37 | OTA published, `createdAt` 02:37:16Z |
| 02:46 | the *earlier* commit's binary writes `app.manifest`, `commitTime` ≈ 02:46 |
| 02:49 | uploaded as 2.4.0 build 10 |

Build 10 shipped without #4992's JS and could never receive it. Nothing catches this on its own:
an install running its own embedded bundle is not an emergency launch, so `mobile:ota-health-check`
reads the fleet as healthy (the same blind spot noted for the V2 cutover above).

**The fix is an ordering invariant:** for a given fingerprint, at least one publish must happen
strictly *after* the last binary carrying it finished bundling. Each native workflow therefore
dispatches `mobile-ota-production.yml` once its store upload lands, passing `expect_fingerprint`
(the value it just tagged and embedded). The dispatched run re-resolves the fingerprint and
**skips** if `main` has since moved to a new native change — publishing under the new fingerprint
would ship JS assuming native code that binary lacks. That leaves the just-shipped binary
permanently on its embedded bundle, which is correct: its replacement is already building, and
`mobile-ota-backport.yml` is the escape hatch if that cohort needs a JS fix meanwhile.

Two details that make it hold:

- The dispatch uses the default `GITHUB_TOKEN` with job-level `actions: write`. `workflow_dispatch`
  is the documented exception to "events triggered by `GITHUB_TOKEN` don't create a workflow run"
  (same pattern as `db-migration-renumber-dispatch.yml`); no App permission is involved.
- The shared `mobile-ota-production` lane uses `queue: max`. `cancel-in-progress: false` protects
  only the *running* run — GitHub still cancels a *pending* one when a new run queues, and the
  republishes are per-platform, so a superseded pending run would strand that platform. The cost is
  that pushes during a long publish queue instead of coalescing.

After a successful republish the workflow probes the manifest endpoint the way the app does and
fails unless the served update is for that fingerprint and was created after the run started. "The
publish step exited 0" is a proxy; the 2026-09-01 stranding had a green publish too.

#### The root fix: `commitTime` is the commit's date

The rail above routes around the defect; `patches/expo-updates@57.0.19.patch` removes it (#5021).
The patched `resolveEmbeddedCommitTime` in `utils/build/createManifestForBuildAsync.js` embeds
**HEAD's committer date** instead of the moment the build bundled, so ordering follows commit order
— the semantics everyone already assumed. It cost one native build train, because `patches/**` is a
fingerprint input.

Three details:

- **`%ct`, not `%at`.** The committer date, not the author date: a rebase or cherry-pick keeps the
  author date of the original write, which would order a backport ahead of work it contains.
- **Clamped to build time.** A future-dated commit would otherwise outrank every OTA published after
  it — the same failure, upside down.
- **Falls back to build time with no git to read** (an EAS build worker, a `.git`-less export). That
  fallback *is* the old racy behaviour, so it warns loudly and both native workflows run
  `vp run check:mobile-embedded-commit-time` on the artifact between bundling and the store upload.
  It reads every `app.manifest` the build produced and fails unless each carries HEAD's committer
  date exactly — and fails, rather than passing, when it finds no manifest at all.

The ordering is now mixed-clock, and that is the point: **binaries carry commit time, OTAs carry
publish time.** A publish can only happen after its commit exists, so publish time is always ≥ that
commit's time and every OTA published after commit A outranks a binary built from A by construction.

One consequence worth knowing: a `mobile-ota-backport.yml` publish of an older release anchor still
outranks a newer binary on the same fingerprint, because its `createdAt` is *now*. That is what a
backport is for, and it is unchanged by this patch.

The republish rail stays as defence in depth. It is what covers the fallback path, and it is the
only half that protects binaries built before this patch shipped.

The production OTA publish stays `main`-only and on the `fingerprint` policy.
After a native change lands, it immediately resolves the new fingerprint; this
is why the previous store fleet is temporarily OTA-ineligible. Once users install
the matching store binary, it receives that bundle and later JS-only updates.

The store-draft verifier resolves each checkout with its own frozen historical
lockfile and disabled lifecycle scripts. It runs in the `Production` environment
but exposes only `GOOGLE_MAPS_API_KEY` to checked-out code, because that key is a
native Android fingerprint input; iOS explicitly removes it. Both the pinned
`main` and build-checkout fingerprints must match each other and the immutable
12-character fingerprint in the selected `build-<platform>-...` tag. Immediately
before drafting, it rechecks that `main` and the selected tags have not moved.

**Fail-safe.** If the gate can't resolve the fingerprint, it builds. A manual
`workflow_dispatch` from `release/next` — or from `main`, which is the hotfix
rebuild after a merge-back — can force a build. Automatic store uploads run only
from `release/next`, and never from an arbitrary feature branch.

**Manual overrides.**

- **Ship an urgent JS-only fix to OTA-orphaned binaries.** Dispatch
  `mobile-ota-backport.yml` with the accepted release anchor and the JS-only fix
  commits. The workflow rejects a cherry-pick that moves the anchor fingerprint.
- **Force a rebuild of a fingerprint that already has a tag.** Dispatch the
  platform workflow from `release/next` (or from `main` after a merge-back).
  Manual dispatch bypasses the fingerprint gate. The protected fingerprint tag
  stays at the first build that established it, while the successful rebuild gets
  a fresh build-number tag. Do not delete or move the fingerprint tag.
- Android candidate APK/AAB files stay in Actions artifacts. After Play accepts
  the internal upload, the exact signed arm64 APK is also published as a public
  **Boardsesh Android Beta** prerelease on its immutable `build-android-*` tag.
- The Android **gate** job runs in the `Production` environment so it can read
  `GOOGLE_MAPS_API_KEY` (a secret that changes the Android fingerprint) and
  resolve the same hash the build bakes. Without it the gate computes a map-less fingerprint that
  never matches the binary, and Android never skips.

Resolve the current fingerprint locally to predict what the gate will see: `cd packages/mobile &&
vp exec expo-updates runtimeversion:resolve --platform ios` (add the Production env to match CI
exactly — see the parity check above).

## Publish ordering: an OTA must not outrun the backend schema

A fingerprint says nothing about the **backend**. An OTA whose JS sends a new GraphQL argument or
field only works once the live backend serves that schema. The old mobile workflow
and production deploy both ran off the same push to `main`, and the OTA was usually faster. It
happened on 2026-09-08 (#5370):

| time (UTC) | event |
| --- | --- |
| 21:36 | #5283 (schema + client in one commit) OTA published |
| 21:55 | backend with the new argument finishes deploying |

For those 19 minutes updated phones got `GRAPHQL_VALIDATION_FAILED`.

The main OTA now uploads to `pr-staging` while web and backend build. Promotion
starts only after the backend deploy and all attempted builds succeed. It reads
`release` from the live, healthy backend and requires an exact Git diff match
for both `packages/shared-schema/src/schema.ts` and its `schema/` directory
against the staged commit. A 503, missing release SHA, unavailable Git history,
or different schema fails closed. It does not poll or wait on a runner.
The same one-shot check guards direct main dispatches, including native-build
republishes; `release/next` retains its separate fingerprint guard.

The staged bundle is visible only to someone who chooses Staging in the picker.
That person may encounter a feature waiting for the backend change; the production
fleet cannot receive it until promotion. Because xprem only loads a *newer* update,
choosing Production clears the staging pin but may leave the currently running
staging JS until a newer production update ships. The picker says so. Schema
changes still have to stay backward-compatible for older store binaries.

## Backporting a JS fix to an approved release (release anchors)

The gating above delivers a JS fix to binaries whose fingerprint still matches `main`. Once native
churn has moved `main`'s fingerprint, an **already-released** (approved) store binary is
OTA-orphaned: a fix published from `main` goes out under the new fingerprint that old install never
requests (issue #3098). The remedy is to publish an OTA under the _old_ release's fingerprint. We
make that reproducible by anchoring each approved release with a tag.

**Anchoring is tied to each store's approval, not to merge.** We only care
about binaries that each platform actually accepted. The marketing `version`
is not part of the fingerprint, so the anchor's `<shortfp>` can be shared by
several versions (see [Version-only releases](#version-only-releases)).

Two tag families do this:

- `build-<platform>-v<version>-<buildNumber>-<shortfp>` — pushed by the native build workflows
  (`ios-testflight-rn.yml` / `android-apk-rn.yml`) on a successful store upload. Maps a store build
  number (iOS `CFBundleVersion` / Android `versionCode`) to the commit and the canonical gate
  fingerprint the binary embeds. `<shortfp>` is the first 12 hex chars of the fingerprint.
- `release/<platform>-v<version>-<shortfp>` — cut by
  `mobile-auto-version-bump.yml` when that platform's store reports the exact
  build accepted (`scripts/mobile-cut-release-tags.ts`). It points at the commit
  the approved binary was built from; its `<shortfp>` records the fingerprint an
  OTA must resolve to reach that release. This is the frozen **backport anchor**.

`mobile-auto-version-bump.yml` runs on a schedule and looks up each store's
exact approved build number before cutting that platform's idempotent anchor.

**It does not bump the marketing version.** An earlier revision auto-bumped the patch on `main` the
moment App Store Connect reported a version accepted, on the theory that anchoring only approved
fingerprints made the churn safe. That was wrong at the time and broke production OTAs: `version`
was part of the fingerprint, so bumping it on `main` moved off the fingerprint of the binary
**already in the field**, and "accepted" is not "adopted" — almost every install is still on the
previous store binary until it updates, so those installs stopped receiving OTAs. The version is no
longer hashed, so a bump alone would not strand anyone. It stays a manual decision because a new
version number only reaches the stores through a native build, and a version-only push does not
start one (dispatch both native workflows, see [Version-only releases](#version-only-releases)). The workflow name (`Mobile
Release Anchor`) and file name are kept; only the bump was removed.

**iOS anchoring is strict:** it uses App Store Connect's exact approved build number, and if no
`build-ios-v<version>-<buildNumber>-*` tag matches it, it skips (rather than anchoring a different
build's commit + fingerprint) and retries on the next run once the tag exists.

**Android anchoring is strict:** Google Play's production release lifecycle API
must report the exact `versionCode` as approved-but-held or published. The
monitor never infers Android approval from Apple's state and never falls back to
the latest Android build.

### Backport runbook

1. Land the JS-only fix on `main` as normal (get its commit SHA). It also ships to current-`main`
   installs via the usual production OTA.
2. Run the **Mobile OTA Backport** workflow (`mobile-ota-backport.yml`, `workflow_dispatch`) with the
   approved `version` (e.g. `2.1.0`), the `platform` (`all`/`ios`/`android`), and the fix commit
   SHA(s). Leave `dry_run` on for the first pass.
3. It checks out `release/<platform>-v<version>-<shortfp>`, cherry-picks the fix, overlays the exact
   workflow commit's dependency-light publish/source-map tooling, and commits that overlay so `eoas`
   sees a clean tree. It then verifies the resolved fingerprint's 12-char prefix equals the anchor's
   `<shortfp>`. A mismatch means the cherry-pick or tooling changed native inputs — it aborts,
   because an OTA would resolve a fingerprint no shipped binary has and silently never land. Anchors
   without an audited `@sentry/react-native` uploader (`7.11.0` or `8.24.0`) or its required
   dependencies also abort in the shared compatibility preflight, before publishing. Do not change that
   dependency on the frozen anchor: ship a native update with a supported uploader, wait for its
   approved release anchor, and backport against that new anchor instead.
4. Re-run with `dry_run` off to publish under the approved fingerprint and immediately upload that
   platform's Debug ID source map. It shares the `mobile-ota-production` concurrency lane, limits
   the platform matrix to one publish at a time, and never races a `main` OTA or bursts iOS and
   Android uploads concurrently. A dry run neither publishes nor uploads.

To find the anchor for a release: `git tag -l 'release/ios-v2.1.0-*'`.

## OTA observability (adoption + funnel)

A JS-only fix lands OTA-only, so "did it actually reach users?" needs telemetry — without it an
inert or broken OTA is silent (the gap that motivated issue #3098). The app reports two PostHog
events from `OtaUpdateTracker` (`packages/mobile/src/components/analytics/OtaUpdateTracker.tsx`),
mounted once near the root beside `AnalyticsScreenTracker`:

- **`OTA Update Status`** — fired once per launch with the running bundle:
  `{ isEnabled, isEmbeddedLaunch, updateId, channel, branch, runtimeVersion, createdAtIso, isEmergencyLaunch, emergencyLaunchReason }`.
  `isEmbeddedLaunch === false` means the install is running an **OTA'd**
  bundle (not the one baked into the binary); group by `updateId` to size the rollout of a specific
  JS-only fix; `runtimeVersion` is the fingerprint cohort that can receive OTAs at all. `channel`
  remains the fixed production channel, while `branch` identifies a selected xprem preview. The
  same cohort is also registered as PostHog **super properties** (`ota_update_id`,
  `ota_is_embedded`, `ota_runtime_version`, `ota_channel`, `ota_branch`) so any existing funnel can
  be sliced by OTA-vs-embedded and production-vs-preview branch.
- **`OTA Update Downloaded`** — fired when a newer bundle finishes downloading in-session
  (`{ updateId, createdAtIso }`). It applies on the **next** launch, which the following
  `OTA Update Status` records — together they form the published → downloaded → applied funnel.
  An update the launch update gate reloads onto (see [What a launch runs](#what-a-launch-runs))
  applies on the same launch instead, so it has no downloaded-then-next-launch gap.
- **`OTA Launch Update`** — fired once per gated cold start by the launch update gate, before the
  reload when it reloads and on release otherwise. Properties: `outcome` (`updated` / `timed_out` /
  `failed` / `offline` / `nothing_newer` / `skipped_failed_update`), `phase_at_release` (`check`,
  `download` or `none`: what expo-updates was doing when the gate ended, which tells a hung
  manifest request from a slow download among the `timed_out` launches), `duration_ms`, `trigger`
  (`fresh_install` / `binary_update` / `cold_start`), `cap_ms` (always the profile's full cap,
  15000 or 10000, never the 4000 check cap), `ota_runtime_version`, `ota_is_embedded`. Launches the
  gate skips send nothing. `duration_ms` against `cap_ms` is how the caps get tuned. The flush
  before a reload waits up to 700 ms, so `updated` can still be undercounted.

The same launch reads also become **Sentry global tags** (`ota_channel`, `ota_branch`,
`ota_update_id`, `ota_runtime_version`, `ota_is_embedded`) via `setOtaSentryTags`, so every crash /
error event is attributable to a channel, surfed branch, and bundle and lines up with the PostHog
cohort above.

Both no-op in dev / Expo Go (analytics disabled, `Updates.isEnabled` false); the `__DEV__` debug hook
still logs `[analytics] OTA Update Status …` to Metro so you can confirm the tracker fires locally.
In PostHog (project 412845), count distinct installs with `isEmbeddedLaunch = false` per `updateId` to
measure how many pulled a given OTA.

The launch update gate (#6006) is judged on two numbers, both from newcomers on a binary that
carries it, measured against the 2.5.0 baseline taken on 2026-10-04:

- Share of `Login Succeeded` with `ota_is_embedded = true`: 48% on 2.5.0, aim under 15%.
- Share of logins where a reload landed between `Login Attempted` and `Login Succeeded`: 26% on
  2.5.0, aim near 0.

Neither has been measured on a build with the gate yet.

### expo-observe (per-update timings, logs and errors)

Alongside the PostHog events above, the app reports to xprem's own **Observe** through
`expo-observe`. Different question: PostHog answers "did the update reach users", Observe answers
"did it make the app worse", because every row is attributed server-side to the `updateId` that
produced it — the per-update comparison neither PostHog nor Sentry can express.

- **Wiring**: `packages/mobile/src/lib/observe-bootstrap.ts` calls `Observe.configure()` at module
  scope, imported third in `app/_layout.tsx`. It must run before any screen mounts — the router
  integration throws if its initialized value changes during a screen's lifecycle — so it can never
  become a hook or an effect. It is also the ONLY module that imports `expo-observe`; everything
  else goes through the dependency-free slot in `observe-runtime.ts`, which keeps Expo's runtime out
  of the node-env test graph that `error-reporting.ts` sits in.
- **What it sends**: per-screen `cold_ttr` / `warm_ttr` / `tti` (expo-router integration), log
  events, and every error that reaches `reportError` — so Sentry and Observe always agree on what
  counted as an error. After feature flags resolve, the app flushes once for the launch and again
  whenever it returns from inactive/background to active; the SDK's native background flush stays
  in place. `tti` needs `markInteractive` per screen and is not wired up yet.
- **Endpoint**: derived from `EXPO_UPDATES_URL`'s origin plus the OTA app id
  (`resolveObserveEndpoint` in `app.config.ts`), so telemetry and manifests can never point at
  different servers. A build with no self-hosted URL, or an EAS-hosted one, reports nothing.
- **Control without a build**: `observe-dispatch-enabled` (kill switch) and `observe-sample-rate`
  (multivariate, ships at `1`) in PostHog. Unresolved flags read as the shipped defaults, so a
  device that never reaches PostHog keeps reporting.
- **Country**: Cloudflare overwrites `X-Geo-Country` from `ip.src.country` on the proxied updates
  hostname, and xprem trusts only that configured header. This is aggregate telemetry only: the
  public Railway origin means it must never be used for authorization or compliance decisions.
- **Native.** `expo-observe` pulls in `expo-app-metrics` and `expo-eas-client`, so it moved the
  fingerprint. Only binaries built after it shipped report at all — an older store build stays
  silent however long it runs.

The `expo-observe` and `expo-app-metrics` entries in `expo.autolinking.buildFromSource`
bypass their bundled Maven dependencies on the missing `expo-updates-interface` 57.0.2
artifact, using the autolinked 57.0.1 project instead. Remove each source-build entry only
when every Maven artifact referenced by that module is available and both native builds
pass. Observe also references `expo-eas-client` 57.0.4, whose Android Gradle config sets
`canBePublished false`; publishing the interface artifact alone does not resolve that
dependency. Recheck the upstream POMs and publication settings before removing either
entry. The interface pin's separate removal condition remains in `pnpm-workspace.yaml`
(#5867).

Where the rows land, and what they cost to keep: `docs/railway.md`.

## Health monitoring & rollback

A default production OTA reaches **every** matching install, on the launch that downloads it when that finishes inside the gate's cap and on the next launch otherwise, but V3 also supports
**progressive rollouts** to cap the blast radius: `eoas publish … --rollout-percentage N` serves the
update to only `N%` of the channel, and you finish or revert it from the dashboard once it looks
healthy (a per-update rollout locks further publishing on that branch until it's finished). Either
way the OTA publishes to our **self-hosted** server, so `eas update:insights` (which only sees
EAS-hosted updates) is blind to it. The health signal therefore comes from the app's own launch
telemetry above: an `OTA Update Status` event with `isEmergencyLaunch === true` is expo-updates'
automatic safety net firing — the downloaded JS failed to boot, so the binary fell back to its
**embedded** bundle. A spike in that rate across the production fleet right after a publish is the
tell-tale of a broken bundle.

### The surf doctor (`scripts/mobile-ota-surf-doctor.ts`)

The health check asks whether shipped updates **boot**. The surf doctor asks the other question:
whether previews are even **offered**. Use it whenever the mobile Test a PR screen shows nothing.

`/branch_lists` is an unauthenticated *device* endpoint, so this needs no credentials — it replays
the exact call a binary makes and maps the answer onto the three states the app renders:

```bash
vp run mobile:ota-surf-doctor                                        # is the switch on?
vp run mobile:ota-surf-doctor -- --platform ios --runtime-version <hash>
vp run mobile:ota-surf-doctor -- --platform ios --json
```

| What it prints | What the tester sees | Fix |
| --- | --- | --- |
| `HTTP 404, xprem-branch-surfing: off` | "Previews are switched off" | Turn Branch Surfing on for `production` (pattern `pr-*`) |
| `HTTP 200, 0 branches` (with `--runtime-version`) | "Nothing to test right now" | No preview published, or every `pr-*` branch predates the last native change — rebase the PRs |
| `HTTP 200, N branches` | the PR list | — |

The two questions need different inputs, and the script keeps them apart. Whether the **channel**
will surf is a property of the channel — the server answers the same regardless of who asks — so a
bare run answers it. Which **branches** are offered is filtered by exact runtimeVersion and platform,
so a bare run explicitly declines to read the list rather than reporting an empty one.

Pass `--runtime-version` to see the list, taking the hash from a native build's
`EXPO_UPDATES_FINGERPRINT_OVERRIDE`, and pair it with `--platform` — iOS and Android resolve to
different fingerprints (`GOOGLE_MAPS_API_KEY` is an Android-only input). The script deliberately does
**not** resolve a fingerprint locally: that value is wrong twice over — `@expo/fingerprint` is not
deterministic across macOS and Linux while binaries bake the Linux hash, and `app.config.ts` falls
back to the EAS updates config unless `EXPO_UPDATES_URL` and the native-build env are set, which
perturbs the hash again. A locally resolved probe would answer the branch question wrong while
looking authoritative.

It exits non-zero only when surfing is off or the server is unreachable; an empty list exits 0,
because "nothing published yet" is a diagnosis rather than a fault.

### The health check (`scripts/mobile-ota-health-check.ts`)

`vp run mobile:ota-health-check` queries PostHog (HogQL) for `OTA Update Status` events on the
`production` channel over a window and reports launch count, distinct installs, and the
emergency-launch rate:

```bash
vp run mobile:ota-health-check                                  # latest production update, last 24h
vp run mobile:ota-health-check -- --hours 6                     # narrower window
vp run mobile:ota-health-check -- --update-id <id>             # adoption context for a specific update
vp run mobile:ota-health-check -- --min-samples 50 --threshold 0.1
```

It **exits non-zero only when the emergency-launch rate exceeds `--threshold` (default 10%) AND the
window has at least `--min-samples` launches (default 30)** — so the low-volume minutes right after a
publish, or a one-off device failure, never trip it. Every other outcome (healthy, inconclusive,
missing key, API/network error) exits 0, so it's safe as a non-blocking gate.

Two notes on what it measures:

- An emergency launch runs the **embedded** bundle, so its `updateId` is the embedded one — you
  can't attribute the failure to the bad update's id. The gate therefore measures the **fleet-wide**
  production emergency rate over the window, not a per-`updateId` rate. The target update's adoption
  (installs successfully running it) is reported separately, for context only.
- The fleet relaunches over **hours**, so the value is a re-run later (manually, or wire it to a
  schedule), not the seconds after a publish.

**Required secret to activate the gate:** add `POSTHOG_PERSONAL_API_KEY` (a PostHog personal API key
with read access) to the **Production** environment — the same secret
`scripts/refresh-recommendations.ts` already uses. `POSTHOG_PROJECT_ID` (default `412845`) and
`POSTHOG_HOST` (default `https://us.posthog.com`) are optional overrides. Without the key the check
**skips and exits 0** — it never blocks a publish.

### Post-publish CI step (non-blocking)

`mobile-ota-production.yml` runs the health check after any platform publishes successfully, even
when another requested platform failed (a short `sleep` lets early relaunches report), with
`continue-on-error: true`, and posts the verdict to the same Discord
deploy channel as the publish announcement. It's wired so it can **never** block or fail the
publish: `continue-on-error` swallows a tripped gate, and the script no-ops (exit 0) until the
`POSTHOG_PERSONAL_API_KEY` secret exists. The step's `outcome` going to `failure` is what flips the
Discord header to the 🚨 emergency-spike variant.

### Rollback (`scripts/mobile-ota-rollback.ts`)

For an already-shipped (non-rollout) update, "rollback" means re-pointing the production branch on
the V3 server (a live progressive rollout is instead reverted from the dashboard). The canonical,
durable fix is to **revert the offending JS commit on `main`** — this workflow then republishes a
good bundle automatically. When you need installs reverted in **minutes**, before a revert PR can
merge, use the helper (wraps the `eoas` CLI):

```bash
vp run mobile:ota-rollback -- --platform ios       # rollback iOS to the embedded bundle
vp run mobile:ota-rollback -- --platform android   # rollback Android (needs GOOGLE_MAPS_API_KEY)
vp run mobile:ota-rollback -- --platform ios --mode republish   # re-point to a previous update (interactive, run LOCALLY)
```

- **`--mode embedded` (default)** runs `eoas rollback --nonInteractive`: publishes a rollback
  **directive** so every install currently on the bad OTA reverts to the binary's embedded (shipped,
  known-good) bundle on its next launch. `eoas rollback` prompts for confirmation and throws in a
  non-TTY, so the helper passes `--nonInteractive` — that's what makes it CI-safe.
- **`--mode republish`** runs `eoas republish`: re-points the branch to a previous published update
  you pick from a list. It's **interactive**, so run it locally, not in CI.

**Run it one platform at a time.** `eoas` resolves the target runtimeVersion (fingerprint) from the
local config, and that resolution mirrors the [per-platform production publish](#fingerprint-parity--the-one-rule-that-matters):
Android needs `GOOGLE_MAPS_API_KEY` set (it changes `android.config`) while iOS must resolve
**without** it (Apple Maps). A single `--platform all` can't satisfy both, so the helper rejects it.
Get the platform split wrong and `eoas` reports success while the directive is filed
under a fingerprint no shipped binary embeds, so the fleet reverts nothing.

Env: `EXPO_UPDATES_URL` + `EOO_TOKEN` (same as the publish), plus
`GOOGLE_MAPS_API_KEY` for `--platform android`. After rolling back, land the real fix (a revert or a
corrected commit) on `main` so the next publish moves the fleet forward again.

### Crash-screen recovery button ("Check for a fix")

When a bad OTA crashes the app hard enough to reach the root `ErrorBoundary`
(`packages/mobile/app/_layout.tsx`), the built-in "Try again" only re-renders the same broken
in-memory bundle. The **"Check for a fix"** button next to it runs `checkForUpdateAsync →
fetchUpdateAsync → reloadAsync` in one tap, so it applies **both** a newer fixed bundle **and** a
published rollback-to-embedded directive (and any update already downloaded in the background). That
means either recovery lever above unbricks a stuck user without the old two-blind-cold-start dance:
run `vp run mobile:ota-rollback` (or land the fixed bundle on `main`) and every crashed install gets
back to a working app the next time someone taps the button. It only appears on a real
store/TestFlight binary (`Updates.isEnabled && !__DEV__` — the calls throw `ERR_UPDATES_DISABLED` in
dev), and when there's nothing to apply it says so rather than reloading the broken bundle again. The
screen also fires an `Error Screen Shown` event (tagged with the OTA update id / channel) and an
`OTA Recovery Attempted` event carrying the outcome, so the crash-and-recovery path is visible in
PostHog. The reloaded-\* success outcomes are tracked (and the client flushed) **just before** the
reload — `reloadAsync()` restarts the app immediately, so a post-reload capture would be lost;
delivery is still best-effort since the restart can pre-empt the flush.

The same check and fetch, without the reload, runs once and with no button when the app finds its
offline database was migrated by a newer bundle than the one running (a reverted canary, or a climber
who left the early-updates track). The fetched bundle launches on the next cold start. It reports
through the same `OTA Recovery Attempted` event with `source: schema-downgrade` and a `result` of
`update-fetched`, `no-fix-available` or `failed`, so filter on a missing `source` to count
crash-screen recoveries alone. See `docs/offline-sync-plan.md` → "Older JS
on a newer database".

## Boot check: the published bytes on a release build

Everything above watches an update after it has reached phones. The boot check runs before: it takes
the update a branch is serving for one commit and proves it starts on a release build of the app, on
an iOS simulator and an Android emulator. A bundle that will not boot is the one failure a canary
cannot contain cheaply, because every phone that takes it falls back or crashes before it can report.

- Script: `scripts/mobile-ota-boot-check.ts` (`vp run mobile:ota-boot-check`), node built-ins only.
- Decisions, with no I/O: `scripts/lib/ota-boot-check.ts`, tested against captures of real runs.
- Workflow: `.github/workflows/mobile-ota-boot-check.yml`. It can be called (`workflow_call`, output
  `passed`), dispatched, and it runs itself on any PR that edits it or the script.

The daily stable controller calls it with the exact SHA, receipt and `pr-stable-candidate` branch.
Staging or beta moving during QA cannot change the candidate under test.

```bash
gh workflow run mobile-ota-boot-check.yml -f ref=<40-character commit> -f branch=pr-staging
```

### What a run does

1. **Pins a receipt for the exact bytes.** The daily controller passes its frozen candidate receipt.
   A PR self-check instead waits for the successful `pr-N` preview at that PR's exact head SHA, then
   reads `mobile-ota-preview-receipt` and validates its producing run and successful deployment.
   That receipt records the actual exported hashes, platform publish runtimes and served update UUIDs.
   Neither path follows the moving staging head. For a manual dispatch without an explicit receipt,
   `resolve` reads the matching `mobile-ota-stage` receipt (kept seven days); an empty `ref` selects
   the newest staged commit. Such a manual staging run fails if staging moves before its manifest check.
2. **Asks the server what the branch serves**, with the headers a phone pinned to that branch sends
   and no device id. The request, retries, and response-body read share a 30-second deadline. The
   manifest carries no commit hash, so the tie to the commit is the bundle: the
   head's `launchAsset.hash` must be the staged bundle's SHA-256. If it is not, the run fails here.
   It also fails when the server answers from another branch, which is what it does when the branch
   has nothing for that runtime version.
3. **Gets a release binary of the commit's native tree**, from the cache or by building it. It is
   built from the commit under test, with `EXPO_UPDATES_FINGERPRINT_OVERRIDE` set to the update's
   runtime version, the same way a store build takes its own. The embedded fixture timestamp is
   set to 2000-01-01 before installation or APK packaging, preserving the actual JS, assets and
   runtime. This fixture represents an already-installed binary; it is not an unmodified store build.
4. **Installs it fresh, pinned to the branch, and launches it twice.** Launch 1 runs the embedded
   bundle and downloads the update. Launch 2 is a cold start, which is when a downloaded update runs.
5. **Reads what expo-updates wrote down**: its `updates` table and its log file, copied off the
   device. Nothing reads the screen and no test id is involved.

It passes only when all of these hold for the second launch:

| Check | Read from |
| --- | --- |
| The update was on disk, complete, after launch 1 | the update's row, status ready |
| Launch 2 ran that update, not the embedded bundle and not nothing | `last_accessed`, which expo-updates stamps on the update it launches |
| React drew content under it | `successful_launch_count` went up; expo-updates counts one on React Native's content-did-appear signal, for the launched update only |
| No failed launch was recorded for it | `failed_launch_count` is 0 |
| The process was alive 30 seconds in | `launchctl list` on the simulator, `pidof` on the emulator |
| No crash line in the device log | a crash report or signal on iOS; `FATAL EXCEPTION`, a fatal signal or an uncaught JS error on Android |

A check that cannot run is a failed check. There is no skip.

### Pinning a binary to a branch

The branch has to be baked into the binary. expo-updates can also take the header from a stored
override, which is how a phone is pinned, but the app clears that override on a fresh install's first
launch (`OtaBranchSurfingInitializer`), so an override written from outside does not survive.

- **iOS:** the cached `.app` is the product build with `xprem-branch: ''`. At test time the script
  copies it and sets `EXUpdatesRequestHeaders.xprem-branch` in the copy's `Expo.plist`. It changes
  only the copied embedded `app.manifest` ordering timestamp, verifies the JS bytes are unchanged,
  and signs the copy ad hoc while preserving its existing entitlements. The cached app remains
  unchanged. One cached binary serves any branch.
- **Android:** an APK's manifest is compiled, so the edit happens between `expo prebuild` and Gradle,
  in the generated `android/` folder (`pin-android-project`). The branch is part of the cache key, and
  a run against another branch builds again. A boot-only Gradle init hook stamps the generated
  `app.manifest` after Expo resource generation and before normal packaging/signing. The workflow
  verifies the final APK timestamp before caching or installing it; the APK signing process stays
  unchanged. Production builds do not load this hook.

The binary also has to be one a phone could hold when the update reaches it. expo-updates only
downloads an update newer than the bundle it is running, by `commitTime`: a binary's embedded bundle
uses `app.manifest.commitTime` and an update uses its published `createdAt`. Stock Expo stamps the
build clock; Boardsesh's existing production SDK patch uses HEAD's committer date. Either can
outrank a previously published update reused by content deduplication. Boot fixtures therefore use
the fixed historical date 2000-01-01, independently of the candidate. The script still reads the
prepared `app.manifest` and refuses a remote update that is not strictly newer. It never force-loads
remote JS or changes the candidate manifest. Evidence records the prepared binary identity and
timestamp; iOS also records the original timestamp, and Android build logs record the rewrite.
Successful first-screen timings describe this prepared fixture and its exact remote update, not
the original store binary or physical-device performance.

### What it sends, and to whom

- **Analytics: nothing, and the run checks.** The bundle built into the gate's binary has no PostHog
  key and no Sentry DSN. The update under test has the production ones, because it is the real
  update. The workflow adds `us.i.posthog.com`, `us-assets.i.posthog.com` and the Sentry ingest host
  to the runner's `/etc/hosts` as `0.0.0.0`, and the script resolves each from the device before
  installing anything. If one still resolves it fails. `--allow-telemetry` turns that off for a local
  run, which then counts as one new anonymous climber in production PostHog.
- **xprem's device registry: two devices in total.** The server registers a device when
  `EAS-Client-ID` is a UUID, and a fresh install mints one. The script seeds one fixed id per platform
  (`BOOT_CHECK_CLIENT_IDS`), so every run is the same two devices. Their rows in Observe are the
  gate's: `b007c4ec-0000-4000-8000-000000000105` (iOS) and `b007c4ec-0000-4000-8000-0000000a11d0`
  (Android).
- **Observe timings and the backend.** Observe posts to the update server itself, so those few rows
  per run are sent, attributed to the two devices above. The app also reads from the production
  backend, signed out. It creates no account.

### What it proves

- The published bundle loads as Hermes bytecode and runs far enough to draw a first screen.
- The native updater accepts the update: signature, runtime version, every asset downloaded.
- The update is served to a binary pinned to that branch, at that runtime version.
- The verdict turns red on a bundle that throws at startup (see "Proof, and what a run costs" below).

### What it does not prove

- **Anything past the first drawn content.** A blank or broken home screen that still renders passes.
  A crash more than 30 seconds in passes.
- **Signed-in behaviour**, navigation, writes, Bluetooth. The app is a signed-out fresh install.
- **The patch path.** The gate's embedded bundle is not an update the server knows, so it is sent the
  full bundle. A phone usually gets a bsdiff patch.
- **The store binary itself.** The binary is a simulator or x86_64 build of the same native tree, told
  the update's runtime version. It is not the signed arm64 binary a phone runs, and Android's is
  debug-signed and built without the maps key.
- **A phone that already ran other updates.** Every run is a fresh install.
- **Real-device limits**: memory, a slow network, a full disk.

### Proof, and what a run costs

Historical proof measured on 2026-10-05, from PR #6131, on `macos-26` and `ubuntu-latest`.
These runs prove the original green/red behavior; refreshed controller activation still requires new
proof on both platforms with the current frozen candidate and blocking gate:

| Run | What it tested | iOS | Android |
| --- | --- | --- | --- |
| [37319204398](https://github.com/boardsesh/boardsesh/actions/runs/37319204398) | `pr-staging` head for main `042b342`, no cached binary | pass, 34 min (22 min build) | 20 min build, then a workflow bug stopped it |
| [37325498650](https://github.com/boardsesh/boardsesh/actions/runs/37325498650) | the same, binaries cached | pass, 7 min | pass, 3 min |
| [37326533621](https://github.com/boardsesh/boardsesh/actions/runs/37326533621) | `pr-6129`, a preview whose root layout throws while its module loads | fail, 8 min | fail, 19 min (the branch is in Android's cache key, so it built) |

In the red run both platforms downloaded the broken update, launched it, and recorded one failed
launch and no first screen. expo-updates then recovered: Android fell back to the embedded bundle,
and iOS fetched the update the server falls back to. The app was on screen and alive either way,
which is why the verdict is read from the update's own counters and not from "is the app running".

The four captures in `scripts/__tests__/fixtures/ota-boot-check/` are from local runs of the same
two updates, and the unit tests replay them through the verdict.

Only that one failure class was produced on purpose. A bundle that is not valid Hermes bytecode, a
missing asset and a bad signature all end in the same two readings (not on disk, or a failed launch),
but none of them has been made to happen.

A daily run is one macOS job and one Linux job: about 7 minutes of macOS and 3 of Linux while the
native inputs stand still, and about 35 and 25 on the day they change.

### Running it by hand

```bash
vp run mobile:ota-boot-check -- --platform ios --app-path <Boardsesh.app> \
  --branch pr-staging --expect-commit <sha> --receipt <receipt.json> --device <udid> --allow-telemetry
```

A branch with no stage receipt (a PR preview) takes a receipt written by hand, naming the update by
id: `{"commitHash":"<sha>","platforms":{"ios":{"runtimeVersion":"…","updateId":"…"}}}`. The workflow
takes the same JSON as `receipt_json`. Android needs a `google_apis` emulator image, not
`google_play`: reading the app's private database needs `adb root`.

## PR-time OTA-compatibility signal

The native gate above answers "should `main` rebuild?". `mobile-ota-check.yml` answers the same
question one step earlier, on the PR: **does this change ride over-the-air, or does it force a new
TestFlight/Play build?** It runs on every non-`main` push touching mobile code and posts a sticky
comment plus a neutral **"OTA compatibility"** check-run. It is informational only — a native change
is legitimate, so it never blocks merge.

The verdict is a **fingerprint diff of the branch versus `origin/main`**, resolved in one job under
identical env (`scripts/mobile-ota-compat-check.ts`, run via `vp run check:mobile-ota-compat`): the
job checks out the PR, materializes `origin/main` as a sibling `git worktree` with its own
`vp install`, then resolves both per platform and compares — equal fingerprint → ships OTA,
different → needs a native build.

It diffs against `main` rather than looking up a shipped `fingerprint-<platform>-<hash>` tag on
purpose: the equality verdict is invariant to env imperfections. `GOOGLE_MAPS_API_KEY` is a
Production-environment secret unavailable on feature-branch pushes, but a missing key shifts _both_
sides of the comparison by the same constant, so the delta is still detected — the check needs no
Production secret. The shipped-tag lookup survives only as a secondary "already on a released build"
line, shown when confidently true (it matches the iOS tag in CI, and is suppressed for Android,
whose tag was built with the maps key the branch push lacks).

The workflow's fingerprint-affecting env is held byte-identical to the native builds + OTA publish by
`scripts/mobile-ci-env-parity.test.ts` (which now guards four workflows, and asserts this one
intentionally omits `GOOGLE_MAPS_API_KEY`). Reproduce a verdict locally:

```bash
git worktree add /tmp/main-baseline origin/main
(cd /tmp/main-baseline && vp install --frozen-lockfile)
vp run check:mobile-ota-compat -- --write-env --base-dir /tmp/main-baseline
```

## One-time setup (V3 green-field infra — done outside this repo)

This is the runbook that stood up the live V3 server; it's here for the record and for standing up a
replacement. `vp run mobile:ota-setup` scripts the in-repo phases; the cloud actions (bucket,
Postgres, server, DNS) stay manual. Run it with no argument for the ordered runbook.

> **Storage migration gate:** `infra/cloudflare/config.ts` declares `boardsesh-ota-v3` as an R2 bucket with the
> custom domain `ota-assets.boardsesh.com` and with `r2.dev` disabled. That desired state does not prove which provider Railway currently
> uses, because `AWS_BASE_ENDPOINT` and its credentials remain live secrets. Inspect the production service before
> calling the OTA bucket migrated. If it still points at Tigris, complete the verified copy below before rotating any
> Railway credential. Then require `/hc` and `/ready` to return 200, publish a test update, and download/install it
> from a production-configured client. See `docs/cloudflare.md` → **R2 buckets**; no live provider is inferred from
> the declaration alone.

### Asset delivery from the edge

Every asset request costs two hops. `updates.boardsesh.com/assets` reaches the Railway server uncached, which
answers with a 302. That first hop stays whatever the storage setup; what changes is where it points. Without
`CDN_BASE_URL` the target is a presigned `r2.cloudflarestorage.com` URL. Measured from
Sydney on 2026-10-05, the first hop took 350 to 650 ms per asset and the second served the 20.9 MB iOS bundle
uncompressed over HTTP/1.1. Fleet `expo.updates.download_time` since the R2 rotation was p50 5.3 s and p90 19.6 s
(268 samples over 19 hours).

`ota-assets.boardsesh.com` is the public custom domain on the bucket, with a cache rule and a Brotli compression
rule (`docs/cloudflare.md` → **OTA assets host**). xprem redirects asset requests to it because
`CDN_BASE_URL` is set on the Railway service (`infra/railway/config.ts`). `railway:apply` refuses to set that
variable while the host does not answer (`preflightUrl`), so the Railway change cannot land ahead of the
Cloudflare one. It does not check caching or compression; the gate below does.

**Rolling back to presigned URLs takes two steps, in this order.** `railway:apply` never unsets a variable, so
reverting the declaration alone leaves the fleet on the CDN, and unsetting it alone lasts only until the next
apply sets it again.

1. Unset `CDN_BASE_URL` on the `boardsesh-ota-v3` service in Railway and let it redeploy. Delivery is back on
   presigned URLs as soon as the new deployment serves.
2. Merge a PR that removes the `CDN_BASE_URL` entry from `OTA_REQUIRED_VARS` and from the runbook block in
   `scripts/mobile-ota-setup.ts`.

Nothing in the bucket changes either way.

**Gate before pointing xprem at the host.** Take two real `cas/` keys from launch assets, one published after
the R2 rotation and one copied over from Tigris, and require all three for both:

1. `curl -sI https://ota-assets.boardsesh.com/{appId}/cas/{hash}` returns 200.
2. A second request returns `cf-cache-status: HIT`. A miss that never turns into a hit means the object carries no
   `Cache-Control`; the migration only copied that header where the Tigris object had one.
3. With `-H 'accept-encoding: br'` the response carries `content-encoding: br` and the transfer is 7 to 8 MB.

If the third fails, first read the `cf:apply` log of the deploy that shipped the rule. A line saying the token
cannot read the `http_response_compression` phase, or that Cloudflare refused the write, means the rule does not
exist: grant `Zone.Response Compression Edit` and re-run. Only when the rule is live and the body is still
uncompressed is the edge declining to compress `application/octet-stream`. The host is then still faster than the
presigned path, but settle compression before treating the download-time target as reachable.

### Tigris → R2 object-copy gate

`.github/workflows/migrate-ota-storage.yml` is the one-shot, manual copy gate. It reads the live source endpoint,
bucket and S3 credentials directly from the `boardsesh-ota-v3` Railway variables with the Production
`RAILWAY_TOKEN`; it classifies the endpoint as Tigris or R2 without logging it and immediately masks the retrieved
access keys. The workflow sends no Railway mutation and never changes the live reader. Its S3 client imports no
delete operation, so neither provider loses an object.

Before running it, add these bucket-scoped Production secrets for the `boardsesh-ota-v3` R2 bucket:

- `OTA_R2_AWS_ENDPOINT_URL`
- `OTA_R2_AWS_ACCESS_KEY_ID`
- `OTA_R2_AWS_SECRET_ACCESS_KEY`

The CLI keeps its default of four concurrent objects. Use `--concurrency 32` to
increase copy and every full SHA-256 verification pass together; accepted values
are integers from 1 to 64. The migration workflow defaults its `concurrency`
input to 32 and validates the same bounds before accessing providers. Each copy
worker stages one source object on disk, so reserve scratch space for up to the
selected number of simultaneous objects. Verification streams directly from providers
and does not stage objects on disk. Reduce the limit if provider throttling
or disk pressure appears; full integrity and source-stability checks remain required.
Transient upload failures receive at most four whole-object attempts, reopening the staged
file and requiring its original Content-MD5 on every attempt. Authentication, checksum,
local-file and unknown errors stop immediately. A rerun hashes existing destination objects
before skipping them; it never deletes the completed prefix or skips final full verification.

Run the gate in this order:

1. Dispatch **Migrate OTA Storage to R2** on `main` with `mode=inventory`. It must classify the live endpoint as
   Tigris and list both complete buckets through every pagination token. An unknown endpoint or an R2 live endpoint
   stops the Tigris-copy workflow without writing.
2. Freeze every OTA writer: disable `production-deploy.yml` first, then disable
   `mobile-ota-production.yml`, `mobile-ota-backport.yml`, `mobile-ota-preview.yml`,
   `mobile-ota-preview-prompt.yml` and `mobile-ota-preview-sweep.yml`. The production deploy workflow can call the
   production OTA publisher through `workflow_call` and promote its staged update; GitHub records that run under
   the caller, so the callee's run list alone misses it. Disabling it also pauses web and backend production deploys
   until it is re-enabled. Confirm all six are idle with
   `gh run list --workflow <file> --status <status>` for `requested`, `waiting`, `pending`, `queued` and `in_progress`.
   The migration workflow first verifies all six are `disabled_manually`, then refuses copy/verify while any has a
   nonterminal run. Keep all six disabled through copy, final verification and Railway credential rotation; their
   normal concurrency groups do not exclude one another.
3. Dispatch the same workflow with `mode=copy` and `ota_publishes_frozen=true`. It refuses destination-only keys
   before its first PUT. Existing same-key objects must match the source by full size, SHA-256 and portable metadata,
   or the run stops without replacing them. Missing objects use create-only conditional PUTs; if another writer creates
   one first, the workflow accepts it only after a full fingerprint match. Portable HTTP and user metadata are
   preserved, and no objects are deleted. S3 tags, omitted metadata or object-lock/website metadata stop the run
   because R2 cannot preserve them faithfully.
4. Require the copy's built-in verification to pass, then dispatch `mode=verify` with the freeze confirmation for a
   separate final read. Both runs require an exact key set and sizes, full-stream SHA-256 equality for every object,
   metadata equality, a stable source listing, and a second full Tigris hash pass after destination verification. A
   same-size source overwrite during the gate therefore fails even though its listing size did not change.
5. Only after that final green verification, replace Railway's `AWS_BASE_ENDPOINT`, `AWS_ACCESS_KEY_ID` and
   `AWS_SECRET_ACCESS_KEY` together with the scoped R2 values. Do not change `S3_BUCKET_NAME`. This repository does
   not perform that credential rotation.
6. Verify `/hc` and `/ready`, publish one test update, and install/download it from a production-configured client
   before unfreezing OTA writers. Re-enable the five direct publisher files first, then re-enable
   `production-deploy.yml` with `gh workflow enable <file>` so its caller resumes only after its OTA callee is
   enabled. Keep the Tigris bucket and its credentials intact as the rollback source. If the migration is abandoned
   before rotation, re-enable the same five direct publishers, then `production-deploy.yml`; no reader or source
   object changed.

**Rollback after new R2 publishes:** restoring the endpoint alone strands updates added to the shared database
after cutover. Freeze and drain the same six workflows, manual publishers, server cleanup and lifecycle mutations.
Retain the previous Tigris credentials securely and supply `OTA_LEGACY_AWS_ENDPOINT_URL`,
`OTA_LEGACY_AWS_ACCESS_KEY_ID`, `OTA_LEGACY_AWS_SECRET_ACCESS_KEY`, and optionally `OTA_LEGACY_AWS_REGION`
and `OTA_LEGACY_S3_FORCE_PATH_STYLE`. Run `vp run storage:migrate-ota -- --reverse --apply`, then
`vp run storage:migrate-ota -- --reverse --verify-only`. Reverse mode requires Railway to still point at R2,
reads its current credentials, and creates only missing Tigris keys using conditional PUTs. Existing same-key objects
must match by full size, SHA-256 and metadata; a mismatch stops the copy without replacement, and a concurrent create
is accepted only after the same full match. Extra archived Tigris objects are retained; forward migration still
requires exact key sets. The final verification checks source stability. Only after verification passes, restore the
old Railway endpoint and credentials together. Before that, take `CDN_BASE_URL` off the service (both steps
under [Asset delivery from the edge](#asset-delivery-from-the-edge)): it points at the R2 custom domain, so an
update published to Tigris afterwards would redirect to a bucket that does not hold it and 404. Verify old and
new update delivery before restoring writers. Neither
direction changes Railway or deletes storage objects.

Keep all mutable maintenance frozen through final verification and credential rotation, including any active bucket
lifecycle rules. Record the prior policies and restore them unchanged after acceptance; do not introduce new expiry
rules during the migration. Prove manifests actually deliver R2 assets after rotation, including representative old
runtimes and a newly published update, rather than passing on cached Tigris URLs. Preserve the shared Redis cache
configuration and signing identity.

1. **Storage bucket** — an empty S3-compatible bucket `boardsesh-ota-v3` plus a scoped key. The original setup used
   Tigris (`t3.storage.dev`, region `auto`); the migration target is the R2 bucket above. Keep it portable
   (see the object-storage rules in `CLAUDE.md`). For a brand-new replacement only, preflight
   put/get/CopyObject with a disposable key, then delete that test key only (retry with
   `AWS_S3_FORCE_PATH_STYLE=true` if CopyObject fails). The migration workflow above uses real inventory and never
   creates a test key or deletes any object.
2. **Postgres** — a dedicated Railway Postgres. **Create the database before first boot** (the
   server runs migrations but never creates the DB itself, else SQLSTATE `3D000`), and use an
   internal URL with explicit `sslmode` in `DB_URL`. **Enable backups + uptime monitoring and keep a
   `pg_dump` / `pg_restore` runbook** — see the durability note below; Postgres is the sole store of
   the app's private signing key.
3. **Master key** — `printf %s "$(openssl rand -base64 32)"` (no trailing newline). Store
   `DB_KEYS_MASTER_KEY_B64` in a password manager **plus** one out-of-band copy, and read it back
   before boot. It seals the signing key in Postgres; **never regenerate it** (doing so makes every
   sealed key unreadable).
4. **Deploy the server** — Railway service running
   `ghcr.io/mercuretechnologies/xprem:v3.2.5`, which `infra/railway/config.ts` declares and
   `vp run railway:apply` keeps deployed (see the
   [deployment](https://mercuretechnologies.github.io/expo-open-ota/docs/deployment/railway) /
   [env reference](https://mercuretechnologies.github.io/expo-open-ota/docs/reference/environment)
   docs). Required env:
   - `BASE_URL` = `https://updates.boardsesh.com`
   - `JWT_SECRET` = random string
   - `STORAGE_MODE` = `s3`, plus `S3_BUCKET_NAME` (`boardsesh-ota-v3`), `AWS_REGION` (`auto`),
     `AWS_BASE_ENDPOINT` (the selected S3-compatible account endpoint), and
     `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
   - `CACHE_MODE` = `redis`, with `REDIS_HOST` = `${{Redis.REDISHOST}}`, `REDIS_PORT` =
     `${{Redis.REDISPORT}}`, `REDIS_PASSWORD` = `${{Redis.REDISPASSWORD}}` (the project's
     Railway Redis, over the private network) and `CACHE_KEY_PREFIX` = `boardsesh-ota`. Local
     mode caches in the Go heap with no size bound or eviction: in production it reached a
     1.7 GB live heap (2.3M objects) after 21 days. The backend keeps its own keys in the same
     Redis; the prefix keeps OTA keys easy to tell apart (unset, xprem uses `expoopenota`). xprem
     has no default for `REDIS_PORT` and panics if it cannot reach Redis. `vp run railway:apply` asserts all of this (see
     [railway.md](./railway.md)). `CACHE_MODE` = `local` still works as a fallback at one
     replica, if Redis is down or being replaced; expect the heap to grow again while it runs.
     **Redis is now a hard dependency of OTA delivery.** xprem opens the cache once, in a
     `sync.Once`, and pings `REDIS_HOST:REDIS_PORT`; if that ping fails it panics. The first cache
     use is the bucket-migration lock at boot, so an unreachable Redis crashes the server before it
     serves any update. The mitigation is the service's restart policy set to `ALWAYS`, so it keeps
     retrying until Redis answers. The likely time for this race is Railway's Redis auto-update
     window (weekends), when Redis restarts and the OTA server may boot while it is down.
   - `TRUST_GEOIP_HEADERS=true` and `GEOIP_HEADER_COUNTRY=X-Geo-Country`. Apply the Cloudflare
     request-header rule before enabling these; it overwrites the header from `ip.src.country` on
     `updates.boardsesh.com`.
   - `DB_URL` + `DB_KEYS_MASTER_KEY_B64` (from steps 2–3)
   - `USE_DASHBOARD=true`, `ADMIN_EMAIL` (a bare address), and a policy-compliant `ADMIN_PASSWORD`
     (≥8 chars, upper/lower/digit/special — first boot crash-loops otherwise). These are the
     dashboard email+password login.
   - `PROMETHEUS_ENABLED` — gates the `/metrics` endpoint (public/unauthenticated when on).
   - **Not needed** in control-plane: `EXPO_APP_ID`, `EXPO_ACCESS_TOKEN`,
     `PUBLIC_EXPO_KEY_B64` / `PRIVATE_EXPO_KEY_B64` — the app and its keypair are created in the
     dashboard and the keypair is DB-generated + sealed under the master key.
5. **DNS** — point `updates.boardsesh.com` at the service (Railway custom domain + CNAME). Confirm
   liveness `/hc` = 200 and readiness `/ready` = 200 (`/ready` is new in V3).
6. **Create the app + keys/cert** — in `/dashboard` (admin login), create the app; its internal id
   is `007e6fd7-f200-448c-9449-8d48ba5d51fc` (what the client sends as `expo-app-id`). Key store =
   database (generates the keypair, sealed under the master key). **Export the app's public cert**
   → commit it as `packages/mobile/certs/certificate.pem`. The committed cert is what flips
   production builds onto the self-hosted path (`resolveUpdatesConfig` stays on EAS until the cert
   exists). **Don't create/map the `production` channel yet** — the branch it maps to doesn't exist
   until the first `eoas publish --branch production`. Come back and map `production` → `production` **after the first production
   publish** (the first `main` OTA, or a manual `vp run mobile:publish -- --channel production`), via
   the dashboard. `vp run mobile:ota-setup map` prints the steps. Enable Branch Surfing on
   `production` with pattern `pr-*` only once native builds carrying `@xprem/control-center` and the
   baked `xprem-branch` header have reached testers — a binary without that header cannot surf. The
   toggle is on the Channels page inside the selected channel's detail pane.
7. **Publish credential** — mint an app-scoped `eoo_` API key in the dashboard (the control-plane
   rejects Expo-token auth). Add it as the GitHub repo secret **`EOO_TOKEN`** and also to the
   `ota-preview` environment.
8. **GitHub config** — set the repo **variable** `EXPO_UPDATES_URL` =
   `https://updates.boardsesh.com/manifest` (consumed by the two native build workflows + the OTA
   publish workflow). `GOOGLE_MAPS_API_KEY` must also exist as a secret (already used by the Android
   build).
9. **Verify** — a header-carrying `GET https://updates.boardsesh.com/manifest` (with `expo-app-id`,
   `expo-channel-name: production`, platform/runtime headers) returns 200 with signature `keyid
main` after the first publish, and its assets load. `vp dlx eoas@3.2.5 doctor --channel=production`
   should be clean.

### Durability: Postgres holds the only private key

With DB-generated keys, the app's **private signing key lives only in Postgres**, sealed under
`DB_KEYS_MASTER_KEY_B64`. Losing both the master key and the Postgres backups makes the entire V3
fleet unsignable — no OTA could ever be published again for those binaries. So both are load-bearing:
keep Railway Postgres backups on, keep the master key in two places, and verify a `pg_restore`
dry-run periodically.

Because the shipped binary sends a fixed `expo-app-id`, **standing up a replacement server means
RESTORING that Postgres** (the app row + its sealed signing key) from a `pg_dump` backup — recreating
the app from scratch mints a **new** app id that no shipped binary ever sends, so its OTAs would never
be requested.

## Changelog ownership (the in-app "What's New")

`packages/mobile/src/data/changelog.generated.json` is owned **solely** by the
`mobile-ota-production.yml` workflow. On every production OTA it regenerates the file from merged-PR
`## Release Notes` sections and publishes it **uncommitted** — `expo export` reads the working tree,
so the fresh entries ship in the bundle either way. It **commits and pushes to `main`** only after
every requested platform succeeds (the commit is tagged `[skip ci]` so the push can't re-trigger the
OTA). A partial or total publish failure leaves the regenerated files unpushed; the next run
regenerates the same source-of-truth files.

**Why it is not committed before the publish.** It used to be, because `eoas publish` aborts on a
dirty tree. But eoas reads an update's `message` **and** its `commitHash` from `HEAD`
(`git log -1` / `git rev-parse HEAD`), so committing first stamped every row on the update server
with a throwaway `chore(changelog): refresh…` commit — and a sha that never even reached `main`,
since the push-back resets to `origin/main` and commits afresh. The V3 dashboard's only identifying
columns are `Message` and a 7-char `Commit`, and it has no search box, so both were useless.
`scripts/mobile-publish.ts` now passes eoas' `--disableRepositoryCheck` for production publishes
**running under GitHub Actions only** (`shouldAllowDirtyTree`) — locally the clean-tree guard stays
on, so `vp run mobile:publish -- --channel production` can't ship a developer's scratch edits. The
workflow's "Assert only the changelog is uncommitted" step replaces the integrity check eoas' guard
was incidentally providing: it fails the publish if anything other than the two changelog files is
dirty. The flag is `hidden: true` upstream, so it is only safe because `EOAS_PACKAGE_SPEC`
(`scripts/lib/eoas.ts`) pins the exact eoas version — re-check it on any eoas bump.
Nothing else writes the file: the native build workflows and `refresh-acknowledgements.yml` only
_read_ it, and a CI guard (`changelog-owned` in `ci.yml`) fails any PR that edits it. A fully
successful OTA still publishes when the push-back identity is not wired — the push-back just keeps
`main`'s copy (which the native binaries embed) current.

### Native-release markers + on-demand update check

The generator also reads the `fingerprint-<platform>-<hash>` tags the native build workflows push
(after a successful store upload) and emits a `nativeReleases` array alongside `entries` — each marker
records the shipping commit's date, platforms, and per-platform fingerprint. Both `CHANGELOG.md` and
the in-app "What's New" interleave these as a dated **App update** divider, so the boundary between
OTA-delivered and store-delivered changes is visible (the app filters markers to the running
platform). The tag lands only after the store upload finishes, so a marker shows up on the _next_
changelog regeneration, not the same push that triggered the native build. The OTA publish workflow
checks out with `fetch-tags: true` so the tags are present when the generator runs.

The changelog screen also has a **Check for updates** button (shown only when `Updates.isEnabled`,
i.e. production OTA builds) that pulls an OTA on demand: `checkForUpdateAsync` → `fetchUpdateAsync` →
"restart now?" → `reloadAsync`.

**Push-back needs a bypass identity**, because `main` requires a pull request (enforce-admins on),
which blocks the default `GITHUB_TOKEN` from pushing directly. One-time setup:

1. **Create a GitHub App** (org or personal) with repository permission **Contents: Read & write**.
   No webhook needed. Note its **App ID**.
2. **Install** the App on `boardsesh/boardsesh` (only this repo).
3. **Generate a private key** for the App (downloads a `.pem`).
4. **Add the App to the bypass list**: repo → Settings → Branches → `main` rule → _Allow specified
   actors to bypass required pull requests_ → add the App.
5. **Wire the secrets**: set repo **variable** `OTA_PUSH_APP_ID` = the App ID, and repo **secret**
   `OTA_PUSH_APP_PRIVATE_KEY` = the `.pem` contents.

Until those exist, the OTA's "Push changelog to main" step no-ops with a `::warning::` (the OTA
itself still ships). A fine-grained PAT from a user who's in the bypass list works too — store it as
`OTA_PUSH_APP_PRIVATE_KEY`'s equivalent and swap the `Mint push token` step for a direct
`secrets.<PAT>` (ask if you prefer that route).

## Verify end to end

1. Local config check — the V3 cert is already committed at `packages/mobile/certs/certificate.pem`,
   so the cert gate is satisfied and a local prebuild injects the headers (a missing cert would fall
   back to EAS and inject no channel header). Run `cd packages/mobile &&
EXPO_UPDATES_URL=https://example.test/manifest vp exec expo prebuild
--platform ios --clean --no-install`, then confirm `ios/Boardsesh/Supporting/Expo.plist` has
   `EXUpdatesRequestHeaders` → `expo-channel-name=production`, `xprem-branch=''`, **and**
   `expo-app-id=007e6fd7-…`, plus
   an `EXUpdatesCodeSigning*` entry. Repeat `--platform android` and grep `AndroidManifest.xml`.
2. **Fingerprint parity (the critical check)** — the OTA server must serve an update under the exact
   runtimeVersion the shipped binary embeds. The binary embeds the gate fingerprint (the
   `fingerprint-<platform>-<hash>` tag), baked as a literal `EXUpdatesRuntimeVersion` in `Expo.plist`
   because the build sets `EXPO_UPDATES_FINGERPRINT_OVERRIDE` (a local prebuild without that env var
   instead writes the `file:fingerprint` sentinel and computes the hash at archive time — expected).
   The publish reaches it by resolving the same fingerprint fresh on Linux (no override). Probe the
   manifest the way the app does, with the tag's hash as the runtime-version header:

   ```sh
   curl -sS -H 'expo-app-id: 007e6fd7-f200-448c-9449-8d48ba5d51fc' \
        -H 'expo-channel-name: production' -H 'expo-platform: ios' \
        -H 'expo-runtime-version: <hash-from-fingerprint-ios-tag>' \
        -H 'accept: application/expo+json,application/json' \
        "$EXPO_UPDATES_URL"
   ```

   A `200` whose `manifest` part (not a `directive`/`noUpdateAvailable`) reports `runtimeVersion`
   equal to the tag hash confirms binary-rv == published-rv. Repeat with `expo-platform: android` and
   the `fingerprint-android-` tag. The publish pins to the same tag the binary embeds, so these match
   by construction — a mismatch means the pin wiring broke (recheck
   `scripts/mobile-ci-env-parity.test.ts`).

   **Publish ordering (the other half of the same check).** A matching fingerprint only makes the
   update *eligible*; `expo-updates` still launches whichever has the newest `commitTime`. Read the
   `createdAt` out of that same response and compare it against when the binary was built — the
   `Bundle React Native code and images` phase in the native run's log, or `Updates.createdAt` on a
   device already running the embedded bundle:

   ```sh
   # …same curl as above, then:
   #   "createdAt":"2026-09-01T04:39:48.000Z"   ← must be LATER than the build
   ```

   Earlier than the build means that binary will keep launching its embedded bundle no matter how
   many times the fingerprint matches. Dispatch `mobile-ota-production.yml` to fix it. See
   [Publish ordering](#publish-ordering-a-binary-can-outrank-a-newer-ota).

3. Ship one native TestFlight build from `main` (bakes in the fingerprint runtimeVersion + server
   URL + cert). Existing `appVersion`-era installs won't receive fingerprint OTAs — they update
   from the store once.
4. Make a trivial JS change, push to `main` (or publish and upload one platform with the manual
   commands above), relaunch the TestFlight/internal-track app, and confirm the OTA downloads and
   applies.
5. On one TestFlight iOS install and one internal/store Android install running the new OTA, use the
   tester crash tool to send a JavaScript error. Confirm both events resolve to
   `packages/mobile/src/...` source lines, their Debug IDs match the uploaded OTA maps, and the
   events' native release/dist still identify the installed store binaries rather than the OTA.

## PR preview picker

Production/TestFlight builds use xprem's
[Branch Surfing API](https://mercure-technologies.gitbook.io/xprem/concepts/branch-surfing)
through the `qa-surf.ts` adapter, which retains the config and surf modules from
`@xprem/control-center@3.1.2`. The app does not mount the package's `ControlCenter` UI.
Its floating edge target and light-only sheet were removed for #5287 after reports of
the sheet opening while closing climb search.

Every user on a surfing-capable binary gets Boardsesh's **Test a PR preview** row in the
user drawer and under **Previews** on the More tab. Both open the themed preview screen,
which lists compatible PR branches, Staging when available, and Production to return
to the live feed. It explains "Previews are switched off" or "Nothing
to test right now" when appropriate. The row is hidden only on a binary that cannot surf.

A user whose profile has `isTester` is also *prompted* without asking: on every cold
start the app either offers a PR preview list (title, risk, how fresh) or, if they are already on a
`pr-<n>` bundle, shows that PR's `## Test plan`. Finishing sends an approve/decline verdict back to
the PR and clears the branch pin. Anyone signed in can file such a verdict from the screens above;
only a tester's moves the `qa-approved` / `qa-declined` label. See
`docs/crowdsourced-qa-mobile.md` (mobile) and `docs/crowdsourced-qa.md` (backend + GitHub side).

The native request headers are fixed in `app.config.ts`:

```text
expo-channel-name: production
expo-app-id: 007e6fd7-f200-448c-9449-8d48ba5d51fc
xprem-branch:
```

When a tester picks a branch, the official package overrides `xprem-branch`, downloads the matching
update, and reloads. Returning to the build's branch clears that header. Runtime compatibility and
manifest signing remain enforced by expo-updates.

Old builds may have a native `expo-channel-name` override and a best-effort AsyncStorage mirror under
`dev_ota_channel_override`. On the first launch in the fingerprint cohort carrying the required
Branch Surfing headers, `clearRetiredChannelOverride` (`ota-channel-override-cleanup.ts`, run once
per launch through `ota-channel-override-cleanup-run.ts`) clears the native override unconditionally,
removes the mirror and persists a dedicated `ota_branch_surfing_migration_v1` marker. It no longer
reloads. The root's `OtaBranchSurfingInitializer` renders nothing and keeps the cleanup independent
of preview UI.
The marker matters:
the mirror can be absent even when the native override exists, while later launches must preserve
xprem's own selected branch. A failed read/clear/write leaves QA readiness false and retries on a later launch.

The cleanup is also what tells the launch update gate whether this launch's manifest request used a
retired override. When it cleared an override that really was in effect, `Updates.channel` keeps
naming the retired channel for the rest of this JS runtime, so QA readiness stays false for the
whole session and becomes true on the runtime after a reload or on the next launch. It stays false
only when all four hold: a Branch Surfing build, the `ota_branch_surfing_migration_v1` marker
absent, `Updates.channel` different from the baked `expo-channel-name`, and the gate did not
reload. A fresh install reports the cleanup as run but never had an override, so it is ready at
once. The reload onto a
fresh bundle belongs to the gate, not the cleanup.
EAS preview builds skip this migration; their separate tester-only `BranchSwitcherScreen` remains
available under More → Preview Build.

The retired custom channel switcher, GraphQL GitHub proxy, preview route, and web QR page were
removed. The Android `/preview` intent filter remains only as a compatibility ingress, so existing
`/preview/pr-N` links still land safely on What's New, including after login; branch selection happens
through **Test a PR preview** in More or the user drawer. Sentry crash tools now live at More → Development → Sentry
Diagnostics for tester accounts.

Telemetry keeps `ota_channel=production` and reads the selected branch from
`Updates.manifest.extra.branch`, recording it as `branch` on the OTA status event and `ota_branch`
in PostHog/Sentry. Diagnostic eligibility uses the same manifest field, classified by
`otaBranchKind` in `qa-surf.ts` (`pr-<n>` and `pr-staging` are previews; `pr-beta` is not).

## Early updates ("Get updates early")

A switch in More → **App updates** that any climber on a surfing-capable binary can turn on. A phone
with it on sends `xprem-branch: pr-beta` (`EARLY_UPDATES_OTA_BRANCH`) and so follows the branch that
receives every merge to `main`; a phone with it off follows `production`. It is called "early
updates" everywhere a climber can read it, never "beta": in this app beta means climb beta.

**Status: shipped dark.** The row is behind the `early-updates` PostHog flag (see
`docs/feature-flags.md` → "Mobile flags"). The deployment pipeline now promotes exact staged bytes
to `pr-beta` after deployment/schema readiness, independently of the stable activation switch.
Before enabling the product flag, finish the download/pin serialization work described below and
complete the device checks from #6101 on iOS and Android store builds. The serialization follow-up is
tracked in [#6269](https://github.com/boardsesh/boardsesh/issues/6269): everything below rests on
native expo-updates behaviour that unit tests model but cannot prove.

After that serialization fix, pilot QA does not require enabling the flag for everyone.
On a tester's phone, leave any PR or staging
preview, then set **More → Feature Flags → Early updates → On** and **Get updates early → On**.
The tester-only per-phone override persists across restart and wins over PostHog. After testing,
turn Get updates early off and wait for the leave to complete before resetting the override to Default.

### Known cost: the first launch after every store update (Android)

Read this before turning the flag on. It cannot be fixed from JS.

On Android the embedded bundle's database row always carries the headers baked into the build, so
it is never launchable under a pin. A member who updates the app from the store therefore opens the
new binary with **nothing launchable**: online, the splash screen blocks on a full OTA download with
no time cap; offline, the app emergency-launches the embedded bundle. Today that happens only to
testers pinned to a preview. With this feature it happens to every Android member at every native
release. After an emergency launch the sync drops the pin without needing a network, so the launch
after is an ordinary one on the regular track, and the member rejoins once online.

iOS does not pay this cost, for a reason that has its own edge (next section): it inserts the new
embedded row under the pin and launches it normally.

### The rules the design rests on

All read from expo-updates 57; `ota-track-sequences.test.ts` models each and cites its source.

1. **Launch.** A cold start launches only an update whose stamped request headers **equal** the
   headers configured now (`LauncherSelectionPolicyFilterAware`, both platforms).
2. **Stamp.** A download stamps the update with the headers in force. An update id already on disk
   is not restamped, and `fetchUpdateAsync` still reports `isNew: true` for it (iOS `AppLoader`,
   Android `Loader.processUpdate`).
3. **Load.** A served update counts as available when the launched update's stamp no longer matches
   the configured headers, whatever its commit time; otherwise only when it is newer
   (`LoaderSelectionPolicyFilterAware`).
4. **Embedded.** Android inserts the embedded row with the baked headers (`EmbeddedUpdate.kt`) and
   never reaps it. iOS inserts it with the headers in force at insertion
   (`UpdatesDatabase.addUpdate`), only when nothing else is launchable or it is newer, and reaps it
   like any other row. So on iOS it may carry a pin's stamp, a baked stamp, or be gone.
5. **Reaper.** After launch, updates older than the launched one are deleted but for one. Android
   keeps the newest of them; iOS keeps the last one it iterated.

So writing the header override does not mean "follow that branch from the next launch". It means
"at the next launch, refuse everything on disk that was not downloaded under exactly these headers".
Consequences:

- **A pin is only kept once an update stamped for it is on disk.** A switch waits for expo-updates
  to be idle, writes the override, checks, downloads, and keeps the pin only if that left a stamped
  update. Anything else puts the previous override back.
- **The server falling back is the dangerous answer, not an error.** When xprem does not have the
  requested branch for this binary it serves the channel's own update. That is usually the update
  already running, under the old stamp; expo-updates reports it "downloaded" and it still cannot
  launch. So joining asks `/branch_lists` (the whole list) for the branch first, and after the check
  it refuses an update id it knows is on disk under another stamp.
- **Leaving works without waiting for a newer build** (rule 3): the regular track's current update
  launches at the next open even though it is older than the early update that was running.
- **Leaving is refused when it would leave nothing launchable.** On iOS a store update while pinned
  inserts the embedded row under the pin (rule 4). If the regular track has published nothing for
  that binary yet, dropping the pin would leave nothing launchable at every cold start, with nothing
  to repair it. So "no update on the server" only counts as leavable when the app was launched with
  no pin.

### The pieces

| Piece | File |
| --- | --- |
| Header writes, the pin record and journal, the queue, `/branch_lists` | `src/lib/qa/qa-surf.ts` |
| The sync decision (pure), the sync, the switch, leaving a preview | `src/lib/qa/early-updates.ts` |
| Launch sync (renders nothing) | `src/components/qa/EarlyUpdatesLaunchSync.tsx` |
| Row state for More, membership, the flag-off confirmation | `src/lib/qa/use-early-updates.ts` |
| The picker's branch query and its surfing-off effect | `src/lib/qa/use-qa-branches.ts` |
| The More section | `src/components/early-updates-section.ts` |
| The model of the rules above, and every sequence run against it per platform | `src/lib/qa/__tests__/ota-track-sequences.test.ts` |

### State

Settings (MMKV, per device):

- `earlyUpdates`: the **choice**. The switch writes it at once, so it responds instantly offline.
- `otaPinnedBranch`: the **pin record**, the branch this app last pinned, null for none.
  expo-updates cannot read the override back. `pr-beta` also means an update stamped for that pin
  is on disk. `pr-<n>` / `pr-staging` means a tester's preview owns the header. Only `qa-surf.ts`
  writes it.
- `otaPinSwitchInFlight`: a journal. Set to `{ to }` just before a no-reload switch writes the
  override and cleared when the switch finishes either way. Found at launch, it means the app was
  killed in between with the override left on `to`.
- `otaLeaveOwed`: the server switched Branch Surfing off and the unpin could not be completed yet.
- `otaLeaveBlockedUpdateId`: a leave was refused on this update id (see "Leaving can be blocked").

At launch, before the first sync, `adoptRunningOtaPin` makes the record match what the launch
proved: a `pr-*` bundle names its own pin, and a journal names the pin an interrupted switch left
behind. After an emergency launch nothing is proven and nothing is adopted.

### The sync

`syncEarlyUpdates` moves the pin towards the choice. It runs behind the switch and once per launch
(`EarlyUpdatesLaunchSync`, after the first interactions, in the background), never reloads, never
throws, and makes no request when there is nothing to do. `decideEarlyUpdatesSync`, in order:

| Condition | Action |
| --- | --- |
| This launch was an emergency launch | **repair**: write "no override" and clear every record of a pin, at once and with no request. Only if there was any sign of a pin (a record, an interrupted switch, or the choice) is a regular update then fetched. Before flags resolve, whoever owns the pin, once per launch. For a climber who never had a pin this is a no-op: an emergency launch has many causes that have nothing to do with branches. |
| A leave is owed to the server | leave |
| Pin record `pr-beta`, choice off | leave |
| Pin record `pr-beta`, flag `off` and confirmed | leave, at most once per launch |
| Pin record `pr-beta`, otherwise | nothing |
| Pin record `pr-<n>` / `pr-staging`, that bundle running | nothing: the pin is the tester's |
| Pin record `pr-<n>` / `pr-staging`, another bundle running | ask `/branch_lists`. Still offered: nothing. Gone (the PR merged): join for a member, leave for everyone else |
| No pin, choice on, flag `on` | join: ask `/branch_lists`, then switch |
| Anything else | nothing |

A leave that was refused on the update still running is skipped in every row above.

**A flag `off` is only acted on when confirmed**: it came in a response received since the app
opened (PostHog's request id differs from the cached bag's), for the account that was signed in when
the launch started. A cached bag, a failed request re-emitting it, a sign-out, and a different
account signing in mid-session all leave a member where they are; hiding the row needs none of this.

A join that cannot finish leaves the phone exactly where it was: offline (`deferred`), or the server
not offering the branch for this binary (`waiting`, normal right after a native release until the
first merge publishes for the new fingerprint). A leave that cannot finish leaves the phone pinned
with its stamped update. Both are tried again at the next launch. A join that could not start
online therefore takes two more opens: one to switch, one to launch the early update.

### What a cold start launches

| Choice | Pin record | On disk | A cold start launches |
| --- | --- | --- | --- |
| off | none | regular updates, or none | the newest regular update, or the embedded bundle |
| on | none (join waiting for a network, the flag, or the branch) | the same | the same: the phone is on the regular track until the join lands |
| on | `pr-beta` | at least one update stamped `pr-beta` | the newest update stamped `pr-beta` |
| off | `pr-beta` (leave waiting) | the same | the newest update stamped `pr-beta`, until the leave lands |
| any | `pr-<n>` / `pr-staging` | whatever the tester's surf downloaded | not ours while the server still offers that branch |

No row has a pin without an update stamped for it. What can still put a phone there:

| Situation | Android | iOS |
| --- | --- | --- |
| Store update to a new binary while pinned | Every time. Online: splash blocks on a full download. Offline: emergency launch, then repaired. | Launches the new embedded bundle normally; it now carries the pin's stamp. |
| App killed mid-join | Online: one blocking download, then normal. Offline: emergency launch; the sync drops the pin with no network, so the next open is the regular update. | If the embedded row has been reaped (two or more OTAs launched): the embedded bundle, normally, which is the build's ORIGINAL JS, at every open until a network arrives. Otherwise as Android. |
| App killed mid-leave | Launches the regular update; the journal clears the stale record, so it does not flap back. | The same. |

None of the launch-time behaviour can be changed from JS: the decision is made before any JS runs.
The kill window is not "seconds": native runs checks and downloads one after another, so a switch
that started while the launch-time download was running would sit pinned for all of it. The switch
therefore waits for `isStartupProcedureRunning`, `isChecking` and `isDownloading` to be false before
writing anything, and every native call it awaits has a 3-minute JS timeout after which the
previous override is put back.

A pre-existing case this change does not touch: a PR surf that answers `nothing-to-load` keeps its
pin with nothing stamped for it.

### Leaving can be blocked

While the server does not have `pr-beta` for a binary, it answers a pinned phone with the regular
track's update, and the launch-time check downloads it **under the pin's stamp**. That update can
then never launch without the pin (rule 2), so a leave is refused on it (`blocked`), the pin stays,
and the attempt is not repeated until a different update is running.

What that state is, honestly: the phone runs the regular track's JS, launches normally, and keeps
getting regular updates, all under a `pr-beta` stamp. The leave completes on its own once the server
offers `pr-beta` again (so pinned launches stop pre-fetching regular updates) and the regular track
then publishes. No safe way to force it from JS was found: dropping the pin would launch the
embedded bundle on Android (the build's original JS) until the next regular release, and may leave
nothing launchable on iOS. The same applies to a non-member whose PR preview branch was deleted: the
dead pin cannot be dropped, the phone is on regular updates in effect, and the switch in More is
offered as usual (joining needs no leave).

### Coexisting with PR previews

Previews and early updates share the one `xprem-branch` header, so they take turns.

- Picking a PR or Staging replaces the pin. The three `surfTo*` helpers write the pin record first
  (a surf that reloads never returns to write it) and put the previous pin back, record and headers,
  when xprem's surf rejects or hangs. xprem restores from its own session memory on a failed surf,
  which knows nothing of a pin made by an earlier session or by a no-reload switch.
- The sync stands down while a tester's bundle is running, and that includes the flag going off.
- Leaving is where a member differs. `returnToOwnTrack` (the picker's own-track row, the brief's
  **Leave preview**, the verdict sheet) joins early updates for a member, with no reload. A member
  is the stored choice unless the flag says off. If the switch cannot be made (offline), the preview
  pin stays and the screen says so. When the server does not offer `pr-beta` for this binary the
  member's track is production for now: the picker row then reads **Production**, and the exit
  reloads onto it as it does for everyone else.
- A tester whose PR merged without a verdict used to be stranded on a pin to a deleted branch. The
  sync now asks the server about any recorded preview pin whose bundle is not the one running.
- The switch is not offered while a preview or staging bundle is running or pinned. The row becomes
  a line saying to leave the preview first, because a flip would silently drop it.

### Branch Surfing switched off

`/branch_lists` answers `404` with `xprem-branch-surfing: off`. `qa-surf.ts` makes that request
itself (`fetchQaBranches`), where it used to call xprem's `listBranches`, for two reasons: xprem
folds that answer and any other 404 into one `null`, and it clears the pin on the spot, which is
the bare unpin the rules above forbid. `fetchQaBranches` only reads. `noteBranchSurfingOff` is
called from the two places that ask: `QaTesterGate` (a tester's launch, as before) and the picker's
`useQaBranches` effect. It does a proper leave, attempted even with no pin on record, since a build
older than the record may have pinned. When the leave cannot be completed it is recorded as owed and
the launch sync retries it, for a member and a tester's preview pin alike. The `earlyUpdates` choice
is kept: joining asks for the branch first, so nothing re-pins while surfing stays off. A 404
without the header changes nothing.

### Other code that checks for updates (not queued yet)

The changelog's "check for updates" and the crash screen's recovery ("Check for a fix") call
`Updates.checkForUpdateAsync` / `fetchUpdateAsync` directly, exactly as before this feature. They
are **not** in the pin-change queue (`runPinChangeExclusively`), so one of them running in the
middle of a no-reload switch is made, and stamped, under an override the switch may be about to take
back, and a download of theirs after a same-session switch is attributed to the launch-time pin.

That is deliberate while the flag is off: with no switch in the fleet the queue would protect
nothing, and it would let a stuck pin change stall the last-resort recovery button. **Routing these
downloads, including automatic schema-downgrade recovery, through the queue is owed before the flag
is turned on.** Bound the branch-list request through response-body reading too: the early-update
sync currently calls it while holding the pin queue. Expired waiting work must not start later;
timing out a caller must not release a lock while an uncancelled native download still runs.
Keep restart confirmation and reload outside the network timeout and preserve crash-screen recovery.

### Telemetry

`Early Updates Toggled` `{ enabled }` fires on a deliberate flip only (`EARLY_UPDATES_TOGGLED_EVENT`
in `src/lib/ota-telemetry.ts`). Everything the sync does is silent. Which branch a phone actually
runs is `ota_branch`, already on every event, and `isEmergencyLaunch` on `OTA Update Status` is the
signal to watch for the Android cost above. A `pr-beta` bundle's `environment` tag comes from the
env the bundle was exported with, not from the branch name, so whatever publishes to `pr-beta` must
leave `EXPO_PUBLIC_SENTRY_ENVIRONMENT` unset or members drop out of the production population.

### Known gaps

- `isConnectStepProductionBuild` still treats every `pr-*` branch as a preview, so a new account on
  an early-updates phone is not enrolled in the connect-step test.
- The stamp bookkeeping knows about the running update, an update the launch-time check downloaded,
  and downloads made through `qa-surf.ts`. An older update left on disk under another stamp is
  invisible to JS. It can only matter if the server reuses an update id across branches.
- If the pin record and the native override ever disagree with no journal to explain it (a device
  restore that brings back one and not the other), the row can say "on" for a phone on the regular
  track. That state launches normally.
- Whether xprem manifests carry `expo-manifest-filters` is unverified. The "check turned down by the
  loader policy proves the running bundle needs no pin" inference assumes they do not.

## Per-PR preview branches (self-hosted)

Every PR with React Native changes can publish its JS bundle to its own self-hosted branch
`pr-<number>`, which any user can switch to on a compatible store/TestFlight build via the preview picker
above — no per-tester build. Workflow: `.github/workflows/mobile-ota-preview.yml` (sweep:
`mobile-ota-preview-sweep.yml`).

- **Reconcile, then publish.** Every same-repository PR synchronization runs, even after the last
  mobile file leaves the diff. A no-longer-mobile revision removes its preview. A mobile revision
  runs `eoas publish --branch pr-<number>` for each compatible platform. The production channel stays
  baked in app config and no same-named channel or map job is created. Xprem exposes the branch
  through `/branch_lists` when it matches the production channel's `pr-*` surfing pattern and the
  running binary's exact runtimeVersion/platform.
- **The branch is reset only for a native change.** The reset exists to stop an older compatible
  update staying surfable when a newer commit turns native-only on one or both platforms. Only a
  revision that can move the native fingerprint can do that, so the gate scans the PR diff for
  fingerprint paths (`packages/mobile/app.config.ts`, `fingerprint.config.js`, `plugins/`, `modules/`,
  `locales/`, `targets/`, `ios/`, `android/`, `packages/mobile/package.json`, `patches/`, the root
  manifest and lockfile — every extra source `packages/mobile/fingerprint.config.js` declares) and emits
  `needs_reset`. A JS-only revision — a test-only commit, a copy fix — skips the reset entirely and
  its new update supersedes the old one in place, so the preview never leaves the picker. A native
  revision still resets, and the `notify` job says so on the PR before the branch goes away: the
  publish takes roughly 12 minutes, and re-running the workflow by hand only starts that wait over.
  `needs_reset` defaults to true, so anything the gate cannot resolve keeps the old behaviour.
  Because a skipped job would otherwise skip its dependents, `publish` guards with `!cancelled()`
  and blocks only on `needs.reset.result == 'failure'`.
- **A revision that publishes nothing leaves the last good bundle up.** With no reset, a JS-only PR
  that falls behind a native change on `main` publishes neither platform and `pr-<number>` keeps
  serving the last revision that did publish — better for a tester than an empty branch, but the
  sticky comment says which, so an unchanged picker entry is not read as "this commit is live".
- **A preview is compared against the PR's base branch.** A PR into `release/next` is diffed against
  `release/next` — the fingerprint its TestFlight build runs — and every other PR against `main`.
  The base comes from the API in a trusted step before any PR-author code runs, allowlisted to
  those two branches. Before this, every train PR read as "behind a native change on `main`" and
  published nothing, though its bundle matched a shipped build (#5898).
- **An identical export is skipped, and the publish says so.** Xprem refuses to create an update whose
  bundle matches one already in storage (`There is no change in the update for android, ignored` /
  `No changes found in the update, nothing to deploy`) and `eoas` exits **0** either way. Ordinarily
  that is right — the identical update is still on the branch. It is only dangerous next to a reset,
  which is how #5417 lost its Android preview: a comment-only commit left the Android bundle
  unchanged, the reset had already deleted `pr-5417`, and the skipped publish never recreated it. The
  branch was iOS-only from then on and the row simply was not in the Android picker — not greyed out,
  absent, because `/branch_lists` is filtered per platform. `mobile:publish` now scans for that notice
  and reports `android=no-change` instead of `android=success`. Since `needs_reset` (above) this pairing
  can no longer arise from a JS-only push.
- **The publish verifies its own work.** After every platform reports success, `mobile:publish` asks
  `/branch_lists` — the same unauthenticated question the in-app picker asks — whether `pr-<number>` is
  actually offered to that platform's fingerprint. **Two independent signals are required to fail the
  job**: the platform reported `no-change` (nothing was created) AND the server answered and did not
  list the branch. That pairing is the #5417 signature. A platform that DID create an update but whose
  branch the probe cannot find only warns — the update exists, so the probe is far likelier to be
  measuring the wrong thing than to have found a hole.
  The runtimeVersion is resolved **inside the publish step, under that platform's own env**, and this
  is the subtle part: `GOOGLE_MAPS_API_KEY` is an Android-only fingerprint input, so the compatibility
  check — which has no key, and whose header says its absolute hashes are meaningless for exactly this
  reason — resolves a *different* Android hash. Passing that one in failed a healthy publish in run
  34796068541. Skipped entirely outside CI, where a locally resolved fingerprint is not the one any
  binary runs. Two independent, bounded resolves must agree before their result is cached for
  the platform. A mismatch or failed confirmation reports that the runtime cannot be checked;
  it cannot combine with `no-change` to fail the publish. The preview timeout budget includes
  both 60-second resolver caps once per platform, even when a later probe reuses the cached result.
  Shared with `vp run mobile:ota-surf-doctor` through `scripts/lib/ota-branch-probe.ts`, so the
  diagnostic and the publisher can never disagree about what "surfable" means. The probe re-asks on a
  miss (~31 s across five waits) before failing: the branch list lags a finished publish by up to the
  15 s the sticky comment already warns testers about, and a red X on a working preview would teach
  people to ignore the check. A branch that is listed is listed on the first probe, so a healthy
  publish never waits. It fails only on a server that ANSWERED about this exact
  runtimeVersion and platform and did not list the branch; an unreachable server or a
  channel with surfing switched off are facts about the server, not about this publish,
  and degrade to "cannot check" alongside the missing-fingerprint case.
- **Branch availability can avoid another export after a finalize 524.** `markUpdateAsUploaded` regularly outlives
  Cloudflare's 100 s origin cap on `updates.boardsesh.com`, and the proxy answers 524 after the assets
  are already uploaded — the update has usually landed. The retry wrapper recognises that one endpoint
  and probes the branch before spending another attempt: if the branch is offered for this runtime,
  the wrapper accepts the attempt and skips another export. This checks availability only: an older
  update on the same branch can satisfy it, so it does not prove this attempt's bundle is live.
  That probe runs a short schedule (~3s of waits), with the retry ladder behind it; a negative
  answer costs another attempt rather than immediately failing the job.
  #5422 burned **2h09m over six attempts** re-bundling ~5300 modules to
  reach the same timeout, which the in-app picker showed as "building" for the whole time (the chip
  reads the `pr-preview` deployment, which the publish job holds open). Any other 5xx, and a 524 seen
  next to permanent-error evidence, still walk the full backoff ladder.
- **Source maps stay local to the runner.** The shared publisher generates external maps for these
  exports, but the preview workflow intentionally has no `SENTRY_AUTH_TOKEN` and never uploads them.
  It runs PR-authored code, so granting a Sentry upload credential would cross the preview security
  boundary. The next platform publish replaces `dist`; the runner discards the final copy.
- **Fingerprint parity.** A native-change PR resolves a new fingerprint no shipped binary has, so
  that platform is **skipped** — `vp run check:mobile-ota-compat` (the same engine as
  `mobile-ota-check.yml`) gates each platform, and the PR comment says so. The env is held
  byte-identical to the native builds + production publish by `scripts/mobile-ci-env-parity.test.ts`.
- **Previews go stale when `main`'s fingerprint moves — and the picker just looks empty.** This is
  the failure mode to know about, because nothing about it is loud. `/branch_lists` offers a branch
  only to a binary whose runtimeVersion AND platform match it exactly, and the compat check compares
  each PR against **current** `origin/main`. So a native change landing on `main` does two things at
  once: every already-published `pr-<n>` branch keeps the old fingerprint and becomes invisible to
  the new binaries, and every open PR that has not rebased now resolves `native-change-required`, so
  its next push publishes nothing. The result is a tester on the newest build seeing "Nothing to test
  right now" while the branches still exist on the server.
  **The remedy is a rebase**: rebasing a PR onto `main` moves it to `main`'s fingerprint, the compat
  check returns `ota-compatible`, and the push republishes the preview where current builds can see
  it. Auto-republishing without the rebase would be wrong — the PR tree still lacks the new native
  code, so its JS would be served to a binary it was never built against.
  This bit us on 2026-09-01: a native change at 11:04 orphaned every live preview, and the two
  surviving branches only reappeared after their PRs were rebased. The PR comment now names both
  fingerprints and says "rebase" instead of "needs a TestFlight build" when a PR is merely behind.
  To confirm from a laptop, with the fingerprint a native build baked:
  `vp run mobile:ota-surf-doctor -- --platform ios --runtime-version <hash>` (take `<hash>` from that
  build's `EXPO_UPDATES_FINGERPRINT_OVERRIDE`; a locally resolved one is macOS-flavoured and will not
  match).
- **Who can publish (security).** The publish uses the app-scoped **`EOO_TOKEN`**, which is scoped to
  the **`ota-preview`** environment. Dashboard admin credentials (`OTA_ADMIN_EMAIL` +
  `OTA_ADMIN_PASSWORD`) live in a SEPARATE **`ota-preview-unattended`** environment and are used only
  by trusted-base cleanup jobs. The publish job runs
  PR-author code (`app.config.ts` calls `execSync`; workspace postinstall) with `EOO_TOKEN` in scope
  but never the admin creds. The boundary that protects `production`:
  - **Forks get NO secrets** in the publisher's `pull_request` job, so a fork cannot publish or
    exfiltrate the token regardless of what it edits. This is the hard boundary for external
    contributors. A separate `pull_request_target` workflow handles metadata and cleanup only: it
    uses the trusted default-branch definition, checks out trusted main explicitly, and never runs
    fork code or holds `EOO_TOKEN`.
  - **Fork / on-demand previews** run only from a **`/ota-preview` comment** whose author currently
    has `write`, `maintain`, or `admin` repository permission, or from `workflow_dispatch`. A broad
    `author_association: COLLABORATOR` label is not enough. Those events run the **default-branch
    (main)** copy of the workflow, so the permission gate is not PR-editable. An accepted comment
    dispatches a trusted default-branch run into the per-PR lifecycle lane; rejected comments never
    enter that lane or evict pending reconciliation. To make that path discoverable,
    `mobile-ota-preview-prompt.yml` reacts directly to trusted `pull_request_target`
    metadata, verifies the PR is a fork, and reads its current file list. It removes an older fork
    preview before posting a sticky "a maintainer can `/ota-preview`" comment; on close or removal of
    the last mobile diff it deletes the branch instead. An Actions-created deployment keyed by the
    full head SHA prevents a delayed follow-up from deleting a preview a maintainer just published;
    contributor-authored marker comments are never trusted as state. These trusted-base actions never
    run fork code; `/ota-preview` still performs the actual publish.
  - **Same-repo collaborators are trusted.** For `pull_request`, GitHub runs the PR's **own** copy of
    the workflow with repo secrets. Any same-repo PR touching the relevant paths auto-publishes.
    Environment reviewers can add defense-in-depth, but correctness does not assume they are
    configured. A malicious insider already holds the repo's secrets through other workflows.
    `^pr-[1-9][0-9]*$` guards every branch mutation (defense-in-depth).
  - **Hardening (optional).** The admin-cred split is already done: `OTA_ADMIN_EMAIL` +
    `OTA_ADMIN_PASSWORD` live only in **`ota-preview-unattended`**, whose jobs check out the trusted
    base and carry no required reviewers, so PR-author code never runs with the admin creds. The only
    residual hardening concerns **`EOO_TOKEN`**: it's currently also a plain repo secret (the
    production publish on `main` needs it), which any same-repo PR workflow can read. For hard
    same-repo enforcement, keep `EOO_TOKEN` only on `ota-preview` and the `main` production
    environment, drop the repo-level copy, and configure required reviewers on `ota-preview`.
    Production channel mapping is declared in `infra/ota/config.ts`. The jobs that apply and check
    it take the admin login from a third environment, `ota-stable-release`, which the owner must
    create with a deployment-branch policy of `main` before adding secrets. They run `main`'s code
    with no dependency install.
- **Readiness signal.** Each publish posts a sticky PR comment (branch name + picker steps) and a
  GitHub **Deployment** to the `pr-preview` environment so the PR shows a green "ready" marker; the
  cleanup marks it inactive on close.
- **Cleanup + storage.** The per-PR concurrency lane serializes reset/publish/close so a late upload
  cannot recreate a branch after cleanup. `publish` keeps the `needs: [gate, reset]` edge even when
  the reset is skipped, so it still queues behind an in-flight reset. On PR close, or whenever the current diff no longer affects
  mobile, `pr-<number>` is deleted via `scripts/ota-preview-cleanup.ts delete --branch pr-<number>`.
  The trusted fork follow-up performs the same reconciliation for fork pushes and closes. A daily
  sweep reaps preview branches whose PR is no longer open and fails red on an unavailable or
  malformed inventory. During migration the helper first deletes a same-named legacy channel when
  present. Server-side branch deletion is the **primary** garbage collector. The S3 bytes are the
  orphan backstop: V3 keys updates as `{appId}/{branch}/{runtimeVersion}/{timestamp}/…`, so the
  bucket lifecycle rule is scoped to the appId-scoped prefix
  **`007e6fd7-f200-448c-9449-8d48ba5d51fc/pr-`** — it ends with the workflow's branch prefix `pr-`,
  and `production/` under the same app id never starts with `pr-`, so production is never touched. If
  the branch prefix and this lifecycle prefix ever diverge, previews either never expire (storage
  leak) or the rule could match production, so `scripts/mobile-ci-env-parity.test.ts` couples them.

One-time infra: `vp run mobile:ota-setup preview` prints the lifecycle rule + the GitHub setup
(the `ota-preview`, `ota-preview-unattended`, and `pr-preview` environments; `ota-preview` holds
secret `EOO_TOKEN` for the publish job, `ota-preview-unattended` holds var `OTA_ADMIN_EMAIL` +
secret `OTA_ADMIN_PASSWORD` for cleanup/sweep jobs, and `GOOGLE_MAPS_API_KEY` is a
repo-level secret for the Android fingerprint).

## Deferred

- **`beta` channel**: TestFlight on `beta`, App Store on `production`, promote at GA. Not to be
  confused with the `pr-beta` *branch* on the `production` channel, which is the early-updates track
  ("Early updates" above) and needs no second channel.
- **In-app `BranchSwitcher`** (`src/components/BranchSwitcherScreen.tsx`, gated on
  `isPreviewBuild()` in `src/lib/preview-build.ts`) switches branches **device-locally** on a preview
  build — it overrides the `expo-channel-name` request header via the same `channel-switch.ts` state
  machine as before, with no EAS API token and no project-wide channel remap.
  The store-binary preview flow rides self-hosted `pr-<number>` branches through xprem (above).

### R2 reader publication for the frozen 2.6 cohort

The manual `R2 Frozen Reader Publication` workflow targets only deployed production source
`6cab8437bb7875e3a84ea228365c344428a6ca3c`. The current release train has newer native
inputs, so its normal publisher cannot update this older cohort. No approved 2.6
backport anchor exists; this workflow validates the actual deployed production source instead
of creating a release tag or overriding its fingerprint.

Dispatch from `main` with one platform and **dry run enabled first**. The protected
Production job resolves both original full fingerprints twice on Linux, cold exports
with the public R2 snapshot base, and checks the compiled Hermes bundle before any
publishing credential is provided. A production dispatch uses the same immutable
source and shared production FIFO lane, requires source-map upload, and verifies the
new signed production manifest and every delivered R2 asset, whether xprem redirects to the
presigned bucket URL or to `ota-assets.boardsesh.com`. The workflow
cannot accept another source commit or runtime.

Download the public acceptance receipts immediately after each run and retain them
with the migration evidence until acceptance is complete. GitHub artifacts expire
after seven days; receipts created before a failed step are also uploaded.

A successful run is a publication check. For the October 2026 migration, native
launch and a fresh offline-board R2 bootstrap passed on the iOS Release simulator.
The owner explicitly waived incomplete Android native acceptance after emulator
failures; this does not claim an Android native pass. The actual production and
restoration results belong in [the acceptance record](r2-migration-2026-10.md).
Keep all legacy objects and credentials during the retention period;
see [the R2 reader acceptance PR](https://github.com/boardsesh/boardsesh/pull/5989) and issue #5912. An already
published R2 update requires reverse copy and complete verification before an OTA
storage rollback; changing only the endpoint is insufficient.

## Public store update reminders

Accepted release anchors and publicly available update targets are separate signals.
The Mobile Release Anchor workflow also collects public store metadata every six
hours in an independent job. The 2.6.0 app uses that metadata for progressive,
dismissible native-update reminders; it never treats an accepted-but-unpublished
binary as an available update. See [mobile-store-release.md](mobile-store-release.md)
for collector credentials, snapshot history, suppression rules, and activation
through the release train's merge back into `main`.
