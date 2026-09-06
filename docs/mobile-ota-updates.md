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
- V3 is the Railway service `boardsesh-ota-v3` (image `ghcr.io/mercuretechnologies/xprem:v3.1.2` —
  see [Versions](#versions-the-cli-pin-and-the-server-image)), backed by a dedicated Railway Postgres
  and a Tigris bucket `boardsesh-ota-v3`. Railway currently pulls that exact release through the
  **pre-rename** repository path (`ghcr.io/mercuretechnologies/expo-open-ota`, same tag) — upstream
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

One version governs both halves of the self-hosted path, and it lives in exactly one place:
`EOAS_PACKAGE_SPEC` in `scripts/lib/eoas.ts`, currently **`eoas@3.1.2`**. The matching server image is
`ghcr.io/mercuretechnologies/xprem:v3.1.2`, which is deployed on Railway. `scripts/__tests__/eoas-version-parity.test.ts` fails CI
if this doc, the setup runbook or the rollback helper drifts off the pin — root `scripts/` has no
typecheck task, so nothing else would catch it.

**The CLI may lead the server; it must never trail it.** Neither side exchanges a version and there
is no version endpoint, so confirm the deployed image in Railway after a bump. Two features require
the server on v3.1.2:

- server-side reuse of the previous update's assets (xprem #165) — see
  [The throttle](#the-throttle-and-what-actually-fixes-it) for what that is worth;
- `vp run mobile:ota-rollback -- --mode republish`: 3.1.2 lists republish candidates through a new
  `.../runtimeVersion/<rv>/publish-groups` route that 3.0.5 does not serve, and can pass
  `?publishGroup=` on the republish call itself; back-compat for older clients is server-side
  (xprem #168). The helper prints a warning before running it. `--mode embedded` — the mode the
  incident runbook uses — is unaffected.

After any bump: re-verify `/hc` = 200, `/ready` = 200, a header-carrying manifest + asset probe, and
run `eoas doctor`.

### Standing rules

- **Never drop `expo-app-id`, `expo-channel-name`, or `xprem-branch`.** Self-hosted clients bake all
  three in `updates.requestHeaders`; xprem's official picker overrides only `xprem-branch`.
- **Move the `eoas` pin first, the V3 server image second — never the other way round.** A CLI that
  trails the server can 404 on app-scoped routes. Re-verify after every bump (above).
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
validate a specific PR on a compatible store/TestFlight build via xprem's official branch picker —
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
   signature against the embedded cert and applies it on next launch.
3. **runtimeVersion** uses the **`fingerprint`** policy — a hash of the native project (deps,
   config plugins, entitlements, native dirs), resolved by the exact-pinned, patched
   `@expo/fingerprint@0.20.7` installation behind Expo's `expo/fingerprint` export. An
   update only reaches a binary with the **same** fingerprint, so a JS-only change keeps the same
   fingerprint (the OTA lands) while **any native change yields a new fingerprint** — the OTA is
   intrinsically incompatible with old binaries and isn't delivered (they keep their embedded
   bundle until a store build with the new fingerprint ships). This removes the `appVersion`
   footgun where a native change without a manual `version` bump could push JS to a binary lacking
   the native capability it needs. The `version` field (`2.0.0`) is now just the store/marketing
   version, decoupled from OTA compatibility. Resolve the current value with
   `vp exec expo-updates runtimeversion:resolve --platform ios|android` (from `packages/mobile/`).

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

**Automatic.** Every push to `main` that touches the mobile app runs
`.github/workflows/mobile-ota-production.yml`, which publishes a production OTA. Because
runtimeVersion is a fingerprint, this is safe to run on every push: a native change publishes an
OTA whose fingerprint no current binary has yet, so it only lands once the matching store build
ships. Until the server is wired (no `EXPO_UPDATES_URL` variable or committed cert), the workflow
skips with a green no-op. The matching native builds (`ios-testflight-rn` / `android-apk-rn`) run
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
**`eoas@3.1.2`** via `EOAS_PACKAGE_SPEC` in `scripts/lib/eoas.ts` (V3 routes are app-scoped; a `v2`
CLI 404s) — see [Versions](#versions-the-cli-pin-and-the-server-image) for the pin↔image rule. Every
self-hosted publish also passes `--upload-rate 5` to pace its asset uploads; the reasoning is below.

For Android, use `--platform android` on both commands and provide the same
`GOOGLE_MAPS_API_KEY` used by the Android native build while publishing. Do not use `--platform all`:
each `eoas publish` removes and recreates `packages/mobile/dist`, so the second platform would erase
the first platform's source maps before they reached Sentry.

### The throttle, and what actually fixes it

Tigris answers a too-fast run of asset PUTs with `503 <Code>SlowDown</Code>` on the
`boardsesh-ota-v3` bucket. Three things multiply into that, and it is worth keeping them apart —
an earlier version of this doc said waiting was the only lever we had, which stopped being true on
2026-08-19.

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
  branch. **It needs the Railway image on `xprem:v3.1.2`**; until then the CLI-side halves above are
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
maps → Android OTA → Android maps. The wrapper derives executable bundles from the requested
platform in `dist/metadata.json` (the primary bundle plus declared DOM component JavaScript), then
validates each bundle/map pair and map Debug ID. Public-folder JavaScript is not update executable
metadata and is ignored. Only validated pairs are staged for the official `@sentry/react-native`
7.11 Expo uploader, whose recursive scan cannot see other files in `dist`. Sentry matches the running
OTA bundle to its map by Debug ID. It deliberately receives no synthetic release or dist, so the
SDK's native release/dist continue to describe the installed store binary.

Expo 57 declares DOM component JavaScript under `www.bundle`, but independently content-hashes its
map filename. Sentry 7.11 can only group an exact adjacent `<bundle>.map`, so the wrapper rejects
such an export with an actionable error instead of silently omitting executable code. Boardsesh does
not currently use Expo DOM components; add an audited pairing/upload path before introducing one.

Publishing and source-map acceptance are **not atomic**. The OTA can already be live when Sentry
rejects its map. CI therefore lets changelog, deployment notice, and health reporting finish, warns
that crash frames may remain minified, and then fails the workflow. For a manual retry, return to the
exact same commit/tree, platform, and build environment that produced the live OTA, rerun that one
platform's publish to regenerate `dist`, and immediately run `mobile:upload-sourcemaps` before any
other `eoas publish`. A newer tree or different environment can produce a different Debug ID and
cannot repair the already-published artifact.

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

- **Production** is mapped once, by hand, in the dashboard — nothing on `main` remaps it.
- **Per-PR previews are branches, not channels.** The production channel enables xprem Branch
  Surfing with the narrow pattern `pr-*`; the official `@xprem/control-center` sends
  `xprem-branch: pr-N`. No per-PR channel or mapping is created.
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

### Fingerprint parity — the one rule that matters

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

`main` owns both production OTA delivery and automatic native TestFlight and
Play-internal builds. All mobile changes target `main`. A native change moves the
fingerprint requested by production OTA, so installed binaries on the previous
fingerprint stop receiving new bundles from `main` until users install the
replacement store release. Prepare the version and localized release notes
before the final native change, keep the release focused, and move both store
builds through QA and review promptly. Keep backend changes compatible with the
currently shipped app until the replacement has been adopted.

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
`workflow_dispatch` from `main` can force a build. Automatic store uploads never
run from an arbitrary feature branch.

**Manual overrides.**

- **Ship an urgent JS-only fix to OTA-orphaned binaries.** Dispatch
  `mobile-ota-backport.yml` with the accepted release anchor and the JS-only fix
  commits. The workflow rejects a cherry-pick that moves the anchor fingerprint.
- **Force a rebuild of a fingerprint that already has a tag.** Dispatch the
  platform workflow from `main`.
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

## Backporting a JS fix to an approved release (release anchors)

The gating above delivers a JS fix to binaries whose fingerprint still matches `main`. Once native
churn has moved `main`'s fingerprint, an **already-released** (approved) store binary is
OTA-orphaned: a fix published from `main` goes out under the new fingerprint that old install never
requests (issue #3098). The remedy is to publish an OTA under the _old_ release's fingerprint. We
make that reproducible by anchoring each approved release with a tag.

**Anchoring is tied to each store's approval, not to merge.** We only care
about binaries that each platform actually accepted. The marketing `version`
is part of the fingerprint, so bumping it moves the fingerprint.

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
fingerprints made the churn safe. That was wrong and broke production OTAs: bumping the version on
`main` busts the fingerprint of the binary **already in the field**, and "accepted" is not "adopted" —
almost every install is still on the previous store binary until it updates, so those installs stop
receiving OTAs (the publish resolves a fingerprint no shipped binary embeds). Marketing-version bumps
are a manual decision, made alongside the native build that ships them. The workflow name (`Mobile
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
   without the audited `@sentry/react-native` 7.11 uploader also abort. Do not change that
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

The same launch reads also become **Sentry global tags** (`ota_channel`, `ota_branch`,
`ota_update_id`, `ota_runtime_version`, `ota_is_embedded`) via `setOtaSentryTags`, so every crash /
error event is attributable to a channel, surfed branch, and bundle and lines up with the PostHog
cohort above.

Both no-op in dev / Expo Go (analytics disabled, `Updates.isEnabled` false); the `__DEV__` debug hook
still logs `[analytics] OTA Update Status …` to Metro so you can confirm the tracker fires locally.
In PostHog (project 412845), count distinct installs with `isEmbeddedLaunch = false` per `updateId` to
measure how many pulled a given OTA.

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
  counted as an error. `tti` needs `markInteractive` per screen and is not wired up yet.
- **Endpoint**: derived from `EXPO_UPDATES_URL`'s origin plus the OTA app id
  (`resolveObserveEndpoint` in `app.config.ts`), so telemetry and manifests can never point at
  different servers. A build with no self-hosted URL, or an EAS-hosted one, reports nothing.
- **Control without a build**: `observe-dispatch-enabled` (kill switch) and `observe-sample-rate`
  (multivariate, ships at `1`) in PostHog. Unresolved flags read as the shipped defaults, so a
  device that never reaches PostHog keeps reporting.
- **Native.** `expo-observe` pulls in `expo-app-metrics` and `expo-eas-client`, so it moved the
  fingerprint. Only binaries built after it shipped report at all — an older store build stays
  silent however long it runs.

Where the rows land, and what they cost to keep: `docs/railway.md`.

## Health monitoring & rollback

A default production OTA reaches **every** matching install on the next launch, but V3 also supports
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

1. **Storage bucket** — an empty S3-compatible bucket `boardsesh-ota-v3` (Boardsesh uses Tigris,
   `t3.storage.dev`, region `auto`) + a scoped key. Keep it portable (see the object-storage rules
   in `CLAUDE.md`). Preflight put/get/CopyObject/delete (retry with `AWS_S3_FORCE_PATH_STYLE=true`
   if CopyObject fails).
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
   `ghcr.io/mercuretechnologies/xprem:v3.1.2` (see the
   [deployment](https://mercuretechnologies.github.io/expo-open-ota/docs/deployment/railway) /
   [env reference](https://mercuretechnologies.github.io/expo-open-ota/docs/reference/environment)
   docs). Required env:
   - `BASE_URL` = `https://updates.boardsesh.com`
   - `JWT_SECRET` = random string
   - `STORAGE_MODE` = `s3`, plus `S3_BUCKET_NAME` (`boardsesh-ota-v3`), `AWS_REGION` (`auto`),
     `AWS_BASE_ENDPOINT` (the Tigris endpoint), and `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
   - `CACHE_MODE` = `local` (fine at one replica)
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
main` after the first publish, and its assets load. `vp dlx eoas@3.1.2 doctor --channel=production`
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

## Official branch picker

Production/TestFlight builds follow xprem's
[official Branch Surfing integration](https://mercure-technologies.gitbook.io/xprem/concepts/branch-surfing)
and mount `ControlCenter` from `@xprem/control-center@3.1.2`. Xprem probes
`/branch_lists` once per JS session and renders its built-in blue edge marker only when Branch
Surfing is enabled for the production channel and a compatible branch exists. It is available to
every app user and shows xprem's raw branch names such as `pr-4613`.

The marker is not the only entry point, and treating it as one was a mistake worth recording: it
renders **nothing at all** when surfing is off or no branch matches this binary, so "the marker is
missing" and "there is nothing to test" look identical from a tester's side of the screen. Every
user now also gets Boardsesh's own **Test a PR preview** row — in the user drawer and under
**Previews** on the More tab — which opens a screen that *says* which of the two it is
("Previews are switched off", "Nothing to test right now"). The row is hidden only on a binary that
cannot surf at all, where it would offer something the app genuinely cannot do.

On top of both, a user whose profile has `isTester` is *prompted* without asking: on every cold
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
Branch Surfing headers, Boardsesh clears the native override unconditionally, removes the mirror, persists a
dedicated migration-complete marker, and reloads before mounting `ControlCenter`. The marker matters:
the mirror can be absent even when the native override exists, while later launches must preserve
xprem's own selected branch. A failed read/clear/write leaves the picker disabled and retries later.
EAS preview builds skip this migration; their separate tester-only `BranchSwitcherScreen` remains
available under More → Preview Build.

The retired custom channel switcher, GraphQL GitHub proxy, preview route, and web QR page were
removed. The Android `/preview` intent filter remains only as a compatibility ingress, so existing
`/preview/pr-N` links still land safely on What's New, including after login; branch selection happens
only through xprem's marker. Sentry crash tools now live at More → Development → Sentry
Diagnostics for tester accounts.

Telemetry keeps `ota_channel=production` and reads the selected branch from
`Updates.manifest.extra.branch`, recording it as `branch` on the OTA status event and `ota_branch`
in PostHog/Sentry. Diagnostic eligibility uses the same manifest field.

## Per-PR preview branches (self-hosted)

Every PR with React Native changes can publish its JS bundle to its own self-hosted branch
`pr-<number>`, which any user can switch to on a compatible store/TestFlight build via the official picker
above — no per-tester build. Workflow: `.github/workflows/mobile-ota-preview.yml` (sweep:
`mobile-ota-preview-sweep.yml`).

- **Reconcile, then publish.** Every same-repository PR synchronization runs, even after the last
  mobile file leaves the diff. A no-longer-mobile revision removes its preview. A mobile revision
  resolves the per-platform OTA verdict in a secret-free `compat` job, then runs
  `eoas publish --branch pr-<number>` for each compatible platform. The production channel stays
  baked in app config and no same-named channel or map job is created. Xprem exposes the branch
  through `/branch_lists` when it matches the production channel's `pr-*` surfing pattern and the
  running binary's exact runtimeVersion/platform.
- **The branch is deleted first only when a platform is about to publish nothing.** The `reset` job
  still deletes the mutable `pr-<number>` branch before `publish`, which is what stops an older
  compatible update from staying surfable when a newer commit is native-only on one or both
  platforms — but it now runs only when `compat` says a platform is `native-change-required`, or
  when `compat` gave no usable answer at all (it errored, timed out or was skipped; an inconclusive
  verdict resets, because that hazard is the one the workflow cannot see).
  **Why it is conditional:** the reset is unconditional in its effect and the publish is not. eoas
  compares each export against the update already on the branch and uploads nothing when they match
  — `⚠️ No changes found in the update, nothing to deploy`, on stdout, exit code 0. A push that
  changes only tests, docs or CI is exactly that: none of it reaches the Metro bundle, so the export
  is byte-identical. Pairing the two meant any such push deleted the preview and put nothing back,
  while the run still went green and the sticky comment still said the branch was ready. PR #5166
  lost `pr-5166` to two consecutive test-only pushes that way. On an all-compatible revision there
  is nothing to reconcile anyway: a changed bundle supersedes the old update by publishing over it,
  and an unchanged one is already what the branch serves.
  `scripts/mobile-publish.ts` reports the difference either way — a platform that uploaded nothing
  now reads `ios=unchanged` rather than `ios=success` in the platform-results line.
  **If a preview branch is missing** and the log shows "nothing to deploy": push a commit that
  actually moves the bundle, or re-point the branch locally with
  `vp run mobile:ota-rollback -- --platform <ios|android> --mode republish`.
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
    Production channel mapping stays a one-time dashboard action, so no admin creds ever touch
    `main`.
- **Readiness signal.** Each publish posts a sticky PR comment (branch name + picker steps) and a
  GitHub **Deployment** to the `pr-preview` environment so the PR shows a green "ready" marker; the
  cleanup marks it inactive on close.
- **Cleanup + storage.** The per-PR concurrency lane serializes reset/publish/close so a late upload
  cannot recreate a branch after cleanup. On PR close, or whenever the current diff no longer affects
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

- **`beta` channel**: TestFlight on `beta`, App Store on `production`, promote at GA.
- **In-app `BranchSwitcher`** (`src/components/BranchSwitcherScreen.tsx`, gated on
  `isPreviewBuild()` in `src/lib/preview-build.ts`) switches branches **device-locally** on a preview
  build — it overrides the `expo-channel-name` request header via the same `channel-switch.ts` state
  machine as before, with no EAS API token and no project-wide channel remap.
  The store-binary preview flow rides self-hosted `pr-<number>` branches through xprem (above).
