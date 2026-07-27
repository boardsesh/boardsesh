# Mobile OTA updates (production: self-hosted expo-open-ota V3)

How JS/TS-only fixes reach the `packages/mobile` app without a new native build.

`expo-updates` speaks an open protocol, so we self-host the manifest + asset server with
[expo-open-ota](https://github.com/mercuretechnologies/expo-open-ota) (the mercuretechnologies fork)
instead of paying for EAS Update hosting. We run it in **V3 control-plane mode** (`v3.0.5`): a
Postgres-backed server that owns channel↔branch mapping, code-signing keys, and progressive
rollouts itself, so there's no dependency on Expo's API and no MAU/bandwidth billing. The only thing
we still keep from Expo is a free account/token for the EAS free-tier _preview_ path (below).

## Two servers: V2 frozen, V3 live (green-field migration)

We migrated to V3 green-field rather than upgrading V2 in place, because a V2→V3 upgrade needs a
destructive storage re-path and an in-place stateless→control-plane key-sealing migration. We were
cutting a new native build anyway, so instead we stood up a fresh V3 server on an empty bucket + new
Postgres and left V2 untouched. Two servers now run in parallel:

| Server          | Host                    | Version                                     | Who hits it                                                                                                                                                                     |
| --------------- | ----------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **V2 (frozen)** | `ota.boardsesh.com`     | axelmarciano V2, stateless                  | Old store/TestFlight binaries built before the V3 cutover. They have `ota.boardsesh.com` + the old cert baked in, so V2 keeps serving them unchanged. **Do not publish to it.** |
| **V3 (live)**   | `updates.boardsesh.com` | mercuretechnologies `v3.0.5`, control-plane | New/updated binaries (V3 URL + V3 cert + `expo-app-id` header baked in). CI publishes only here.                                                                                |

- Old installs migrate to V3 by store-updating to a V3 build; there's no cross-server backport.
- **Rollback before the store rollout is free:** the V3 build bakes the V3 URL, so V3 must be proven
  good on TestFlight/internal track before wide release. If V3 misbehaves pre-rollout, fix it — the
  old fleet is untouched on V2. Post-rollout recovery is forward-only (publish a fixed OTA / roll
  back on V3).
- V3 is the Railway service `boardsesh-ota-v3` (image `ghcr.io/mercuretechnologies/expo-open-ota:v3.0.5`),
  backed by a dedicated Railway Postgres and a Tigris bucket `boardsesh-ota-v3`.
- **Retire V2 later**, telemetry-gated: watch the old-build share in PostHog (below); when it's
  negligible, decommission the `boardsesh-ota` service + its bucket. Until then it's one small idle
  service.
- **The URL cutover happens at merge, not before.** The repo variable `EXPO_UPDATES_URL` (consumed by
  the native build workflows + the OTA publish workflow) flips from the V2 `https://ota.boardsesh.com/manifest`
  to the V3 `https://updates.boardsesh.com/manifest` **when the V3 client PR merges** — no earlier, no
  later. Flip it early and V2-era publishes from `main` break; flip it late and the first V3 native
  build bakes the stale V2 URL into the binary. Already-open PR branches keep pinning `eoas@2` and
  targeting the old URL until they're rebased onto the merged change.

### Standing rules

- **Never drop `expo-app-id`.** V3 clients must always send it (baked in `updates.requestHeaders` via
  `OTA_APP_ID`). Dropping it breaks both publishing and the in-app channel switcher — keep it forever.
- **Bump the V3 server image and `eoas` in lockstep** (exact version match). After any bump,
  re-verify `/ready` = 200 and a header-carrying manifest + asset probe, and run `eoas doctor`.
- **Dashboard creds are production-release creds.** `/dashboard` mints API keys, exports the cert,
  remaps channels, and runs rollouts — treat the admin login as production-release access (one admin,
  read-only members).

## Two hosting paths (don't mix them up)

|                | Preview / dev                            | Production                                                                                                                       |
| -------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Built by       | `eas build` (`mobile:preview-build`)     | bare `expo prebuild` + xcodebuild/gradle (the `ios-testflight-rn` / `android-apk-rn` workflows)                                  |
| Hosting        | EAS free tier (`u.expo.dev`)             | self-hosted expo-open-ota V3 (`updates.boardsesh.com`)                                                                           |
| Channel source | `channel` in `eas.json`                  | `expo-channel-name` request header baked in by `expo prebuild`                                                                   |
| Publish        | `vp run mobile:publish` (→ `eas update`) | auto on push to `main` (`mobile-ota-production.yml`); manual: `vp run mobile:publish -- --channel production` (→ `eoas publish`) |

A third path rides the **same self-hosted server**: per-PR `pr-<number>` channels that let any user
validate a specific PR on a store/TestFlight build via the in-app switcher — see
[Per-PR preview channels](#per-pr-preview-channels-self-hosted) below.

The split is decided in `packages/mobile/app.config.ts` (`resolveUpdatesConfig`): when
`EAS_BUILD` is set it returns the EAS URL; otherwise it uses the self-hosted server — but **only
when both `EXPO_UPDATES_URL` and the signing cert `certs/certificate.pem` are present** (fail
closed). Until both exist it falls back to the EAS URL so builds still succeed and OTA is simply
inert. The cert gate matters: baking the self-hosted update URL into a binary _without_ code
signing would let a compromised manifest host (or a network MITM) push arbitrary JS to every
install, since the device couldn't verify the manifest came from us.

## How the production path works

1. **Build time** (`expo prebuild`): `EXPO_UPDATES_CHANNEL=production` →
   `updates.requestHeaders['expo-channel-name'] = 'production'` is injected into `Expo.plist`
   (`EXUpdatesRequestHeaders`) and `AndroidManifest.xml`. `updates.url` points at V3
   (`https://updates.boardsesh.com/manifest`). The build also bakes an **`expo-app-id`** request
   header — `007e6fd7-f200-448c-9449-8d48ba5d51fc`, the V3 server's internal app id (set in
   `app.config.ts` as `OTA_APP_ID`, env-overridable via `EXPO_PUBLIC_OTA_APP_ID`). This is **not**
   the EAS project id `87499648-…`; that value survives only as the cert's CN. V3 routes every
   request on `expo-app-id`, so a build that drops the header can't be served. The public
   code-signing cert (`certs/certificate.pem`, exported from the V3 dashboard) is embedded, and the
   app signs manifests with `keyid: 'main'` / `rsa-v1_5-sha256` (V3 hardcodes `keyid='main'`).
2. **Runtime**: on launch the app asks `<server>/manifest` with its `expo-app-id`, channel, and
   runtimeVersion headers. V3 returns the latest signed update on the branch mapped to that channel
   (see [Channel↔branch mapping](#channelbranch-mapping-control-plane) below); the app verifies the
   signature against the embedded cert and applies it on next launch.
3. **runtimeVersion** uses the **`fingerprint`** policy — a hash of the native project (deps,
   config plugins, entitlements, native dirs), resolved by Expo's bundled `@expo/fingerprint`. An
   update only reaches a binary with the **same** fingerprint, so a JS-only change keeps the same
   fingerprint (the OTA lands) while **any native change yields a new fingerprint** — the OTA is
   intrinsically incompatible with old binaries and isn't delivered (they keep their embedded
   bundle until a store build with the new fingerprint ships). This removes the `appVersion`
   footgun where a native change without a manual `version` bump could push JS to a binary lacking
   the native capability it needs. The `version` field (`2.0.0`) is now just the store/marketing
   version, decoupled from OTA compatibility. Resolve the current value with
   `bunx expo-updates runtimeversion:resolve --platform ios|android` (from `packages/mobile/`).

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
instead of throwing. For `@expo/ui` sheets the guard lives in `patches/@expo%2Fui@57.0.3.patch`.

## Publishing a production update

**Automatic.** Every push to `main` that touches the mobile app runs
`.github/workflows/mobile-ota-production.yml`, which publishes a production OTA. Because
runtimeVersion is a fingerprint, this is safe to run on every push: a native change publishes an
OTA whose fingerprint no current binary has yet, so it only lands once the matching store build
ships. Until the server is wired (no `EXPO_UPDATES_URL` variable or committed cert), the workflow
skips with a green no-op. The matching native builds (`ios-testflight-rn` / `android-apk-rn`) run
on the same push but are **fingerprint-gated** — they only build when the fingerprint is new (see
[Native-build gating](#native-build-gating-ota-only-when-the-fingerprint-is-unchanged) below). A
successful publish (and any failure) posts to the Discord deploy channel via the
`DISCORD_DEPLOY_WEBHOOK` secret, the same channel the native build workflows use. The success
message lists what the OTA newly added: the workflow snapshots `changelog.generated.json` before
regenerating it, then `changelog-discord-summary.ts` diffs the two snapshots and renders the new
entries grouped as New / Improved / Fixed. When nothing new shipped (changelog unchanged) it falls
back to the triggering commit's subject.

**Manual** (one branch, ad hoc) — set the V3 server URL and an app-scoped `EOO_TOKEN`:

```sh
EXPO_UPDATES_URL=https://updates.boardsesh.com/manifest \
EOO_TOKEN=eoo_… \
  vp run mobile:publish -- --channel production --message "fix: <what>"
```

This runs `eoas publish --branch production --channel production`, which does an `expo export` and
uploads the bundle to our storage via the server. `eoas` reads the server URL from `updates.url` in
`app.config.ts`, so `EXPO_UPDATES_URL` must be present. **Auth is `EOO_TOKEN`, not an Expo token:**
the V3 control-plane server rejects Expo tokens, so publish/rollback need an app-scoped `eoo_` key
minted in the dashboard. The CLI is pinned to **`eoas@3.0.5`** via `EOAS_PACKAGE_SPEC` in
`scripts/lib/eoas.ts` — it must match the deployed server version exactly (V3 routes are
app-scoped; a `v2` CLI 404s). Bump the server image and the pin in lockstep.

**Progressive rollouts** are a control-plane feature: `eoas publish --branch production --channel
production --rollout-percentage N` ships to only `N%` of the channel's installs. Finish or revert
the rollout from the dashboard once it's healthy — an unfinished per-update rollout **locks**
further publishing on that branch, so a forgotten one turns the next auto-publish red.

### Channel↔branch mapping (control-plane)

In V3 the channel→branch mapping lives in Postgres, not in Expo's API. `eoas publish --branch X
--channel Y` creates the **branch** (which holds the update) and the **channel**, but leaves them
**unmapped**. A client requesting an unmapped channel gets `No branch mapping found`. Mapping is a
**dashboard-admin operation**: the app-scoped `eoo_` publish key can list branches/channels but
**cannot map** (it 403s with "This action requires a dashboard session").

- **Production** was mapped once, by hand, in the dashboard — nothing on `main` remaps it.
- **Automation** (the per-PR previews) maps headlessly via `scripts/ota-channel-map.ts`
  (`map` / `delete`), which logs in with the dashboard admin credentials (`OTA_ADMIN_EMAIL` +
  `OTA_ADMIN_PASSWORD`) to mint a short-lived admin JWT, then create/remap or delete the channel
  through the management API (`POST /auth/login` → `GET/POST /api/apps/{appId}/branches|channels`,
  `POST …/branch/{branchId}/updateChannelBranchMapping`, `DELETE …/{channels|branches}/{name}`).
  Delete the channel/mapping before the branch, or the branch delete is refused.
- **Green-field consequence:** a legacy v1 client that sends **no** `expo-app-id` header gets an
  HTTP 400 from V3. That's correct — only new header-carrying V3 builds ever hit V3; old binaries
  stay on V2.

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

The fingerprint hashes the **resolved Expo config** and native files — **not** the JS bundle — so the
publish must resolve `app.config.ts` to the same config the native `expo prebuild` did. The
config-affecting env that must match is `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` (drives the google-signin
plugin's native `iosUrlScheme`), `GOOGLE_MAPS_API_KEY` (drives `android.config`), and
`EXPO_UPDATES_URL`/`EXPO_UPDATES_CHANNEL`. The other `EXPO_PUBLIC_*` are inlined into the JS bundle;
they must still match so the OTA points at the right backend/analytics, but drift there is a runtime
bug, not a delivery failure. Mechanisms, all enforced/handled in CI:

- **Binary pin + fresh publish.** The native builds set `EXPO_UPDATES_FINGERPRINT_OVERRIDE` to the
  gate fingerprint; the publish leaves it unset. `scripts/mobile-ci-env-parity.test.ts` asserts both
  (and that no build-side re-resolve creeps back in).
- **Env parity.** `mobile-ota-production.yml` declares the same `EXPO_PUBLIC_*` + `EXPO_UPDATES_*`
  env as `ios-testflight-rn.yml` / `android-apk-rn.yml`. The same parity test fails the build if they
  drift.
- **Per-platform publish.** `GOOGLE_MAPS_API_KEY` is set only on the Android prebuild (iOS uses
  Apple Maps) and it changes the resolved config — hence the fingerprint — for the Android side. So
  the workflow publishes iOS **without** the key and Android **with** it, in separate steps. A single
  `--platform all` publish with one env could only ever match one side.

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

## Native-build gating (OTA-only when the fingerprint is unchanged)

The OTA publish is cheap and runs on every push, but the native builds (`ios-testflight-rn`,
~60 min on macOS; `android-apk-rn`, on Linux) only need to run when the fingerprint actually
changes. A JS/TS-only change keeps the same fingerprint, so installed binaries pull the new JS over
the air and a fresh native build is wasted. Each native workflow gates itself on the fingerprint —
the self-hosted equivalent of Expo's `continuous-deploy-fingerprint`:

1. A cheap Linux **`gate` job** resolves the platform fingerprint with `bunx expo-updates
runtimeversion:resolve` using the same **workflow-level** env the build uses (iOS without
   `GOOGLE_MAPS_API_KEY`, Android with it). The shared env sits at the workflow level so the gate
   and build can't drift, and the gate writes the same `.env` the build does — the `.env` is itself
   hashed into the fingerprint, so an absent or different one would resolve a different hash.
2. If a git tag `fingerprint-<platform>-<hash>` already exists, a binary with that fingerprint has
   already shipped → the native build **skips** (the OTA delivers the JS). Otherwise it **runs**.
3. On a successful build + store upload, the build job pushes `fingerprint-<platform>-<hash>` — the
   gate value the binary embeds (see the pin below), not a re-resolved one.

**Why a wrong skip is impossible.** The native build embeds the gate's exact value in the binary via
`EXPO_UPDATES_FINGERPRINT_OVERRIDE` (the macOS runner no longer re-resolves its own, divergent hash)
and tags it. So the tag, the binary's runtimeVersion, and the gate's skip-key are one value by
construction — the gate can never skip a fingerprint the binary lacks. This replaces the older "tag
the build-OS value and always-build on cross-OS divergence" scheme, which wasted iOS builds and —
worse — let the Linux OTA publish strand JS under a runtimeVersion the macOS binary never had.
Android builds on Linux like its gate, so it was never divergent; it pins the same way for a uniform
invariant.

The OTA publish stays on the `fingerprint` policy (it does **not** read a tag or an override): it
resolves the current commit's fingerprint and serves the JS under it. On a native-change commit it
resolves the **new** fingerprint, so the new JS only reaches a binary built from that same commit —
old binaries (still on the previous fingerprint) keep their embedded bundle until they store-update.
That's the fingerprint policy working as intended; pinning the publish to the last shipped tag would
instead serve native-dependent JS to old binaries and crash them.

**Fail-safe.** If the gate can't resolve the fingerprint, it builds. A manual `workflow_dispatch`
bypasses the tag check and builds — for iOS that means dispatching on `main` (the iOS build is
`main`-only by design, since it uploads to TestFlight). The Android workflow drives this with a
`force_native` input (default **on**): on, it builds regardless of the fingerprint (the urgent-fix
escape hatch below); off, it falls through to the same tag check as a push, so a dispatch can also be
a no-op rebuild. A dispatch on any branch still produces an artifact-only APK, matching its
pre-existing behavior.

**Manual overrides.**

- **Ship an urgent JS-only fix to OTA-orphaned binaries.** A JS fix merged to `main` is delivered
  OTA-only and skips the native build when its fingerprint already shipped — but a binary whose
  fingerprint has since drifted (heavy native churn orphans older binaries, the root cause behind
  issue #3098) can't pull that OTA. Dispatch `android-apk-rn.yml` with `force_native` on to rebuild
  the native app so those installs get the fix via a store update.
- Force a rebuild of a fingerprint that already has a tag:
  `git push --delete origin fingerprint-<platform>-<hash>`, then re-push to `main` (or run the
  workflow via dispatch).
- The Android tag is recorded once the **sideload APK (GitHub Release) and the AAB build** succeed
  — the reliable signal that a binary with this fingerprint exists. It is **not** gated on the Play
  upload: that step is best-effort and can fail for Console-policy reasons (e.g. the
  Foreground-services declaration) unrelated to the binary, and coupling the tag to it would let a
  persistent Play issue rebuild Android forever. A failed Play upload is recovered by re-uploading
  the retained AAB artifact (or rerunning the workflow), not by withholding the fingerprint tag.
- The Android **gate** job runs in the `Production` environment so it can read
  `GOOGLE_MAPS_API_KEY` (a Production-scoped secret that changes the Android fingerprint) and
  resolve the same hash the build bakes. Without it the gate computes a map-less fingerprint that
  never matches the binary, and Android never skips.

Resolve the current fingerprint locally to predict what the gate will see: `cd packages/mobile &&
bunx expo-updates runtimeversion:resolve --platform ios` (add the production env to match CI
exactly — see the parity check above).

## Backporting a JS fix to an approved release (release anchors)

The gating above delivers a JS fix to binaries whose fingerprint still matches `main`. Once native
churn has moved `main`'s fingerprint, an **already-released** (approved) store binary is
OTA-orphaned: a fix published from `main` goes out under the new fingerprint that old install never
requests (issue #3098). The remedy is to publish an OTA under the _old_ release's fingerprint. We
make that reproducible by anchoring each approved release with a tag.

**Anchoring is tied to App Store approval, not to merge.** `main` iterates through many fingerprints
between releases; we only care about the ones that actually shipped and were approved (an approved
binary is frozen forever). The marketing `version` _is_ part of the fingerprint, so bumping it moves
the fingerprint — which is fine, because we never rely on an intermediate fingerprint staying
OTA-compatible; we only anchor approved ones.

Two tag families do this:

- `build-<platform>-v<version>-<buildNumber>-<shortfp>` — pushed by the native build workflows
  (`ios-testflight-rn.yml` / `android-apk-rn.yml`) on a successful store upload. Maps a store build
  number (iOS `CFBundleVersion` / Android `versionCode`) to the commit and the canonical gate
  fingerprint the binary embeds. `<shortfp>` is the first 12 hex chars of the fingerprint.
- `release/<platform>-v<version>-<shortfp>` — cut by `mobile-auto-version-bump.yml` when App Store
  Connect reports a version accepted (`scripts/mobile-cut-release-tags.ts`). It points at the commit
  the approved binary was built from; its `<shortfp>` records the fingerprint an OTA must resolve to
  reach that release. This is the frozen **backport anchor**.

`mobile-auto-version-bump.yml` runs on a schedule (every 6h) and, per accepted version, looks up the
approved build's `build-*` tag (iOS by the approved build number, Android by the latest build of the
same marketing version) and cuts the `release/*` anchor at that commit. It is idempotent, so the
second platform's approval and any re-run are safe.

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

**Android caveat:** approval is detected from App Store Connect only — there is no Google Play query.
The Android anchor is cut alongside the iOS approval, pointing at the _latest_ Android build of the
same marketing version. If Android hasn't actually shipped that version to the store, the anchor is
premature; a backport under it would just reach whatever installs hold that fingerprint (and the
backport re-verifies the fingerprint before publishing), so it is ineffective rather than incorrect.
Confirm the Android release actually shipped before relying on an Android backport.

### Backport runbook

1. Land the JS-only fix on `main` as normal (get its commit SHA). It also ships to current-`main`
   installs via the usual production OTA.
2. Run the **Mobile OTA Backport** workflow (`mobile-ota-backport.yml`, `workflow_dispatch`) with the
   approved `version` (e.g. `2.1.0`), the `platform` (`all`/`ios`/`android`), and the fix commit
   SHA(s). Leave `dry_run` on for the first pass.
3. It checks out `release/<platform>-v<version>-<shortfp>`, cherry-picks the fix, and **verifies the
   resolved fingerprint's 12-char prefix equals the anchor's `<shortfp>`**. A mismatch means the
   cherry-pick touched native inputs — it aborts, because an OTA would resolve a fingerprint no
   shipped binary has and silently never land. Ship such a fix as a new native build instead.
4. Re-run with `dry_run` off to `eoas publish --channel production` under the approved fingerprint,
   reaching that release's installs. It shares the `mobile-ota-production` concurrency lane, so it
   never races a `main` OTA.

To find the anchor for a release: `git tag -l 'release/ios-v2.1.0-*'`.

## OTA observability (adoption + funnel)

A JS-only fix lands OTA-only, so "did it actually reach users?" needs telemetry — without it an
inert or broken OTA is silent (the gap that motivated issue #3098). The app reports two PostHog
events from `OtaUpdateTracker` (`packages/mobile/src/components/analytics/OtaUpdateTracker.tsx`),
mounted once near the root beside `AnalyticsScreenTracker`:

- **`OTA Update Status`** — fired once per launch with the running bundle:
  `{ isEnabled, isEmbeddedLaunch, updateId, channel, runtimeVersion, createdAtIso, isEmergencyLaunch, emergencyLaunchReason }`.
  `isEmbeddedLaunch === false` means the install is running an **OTA'd**
  bundle (not the one baked into the binary); group by `updateId` to size the rollout of a specific
  JS-only fix; `runtimeVersion` is the fingerprint cohort that can receive OTAs at all. The same
  cohort is also registered as PostHog **super properties** (`ota_update_id`, `ota_is_embedded`,
  `ota_runtime_version`) so any existing funnel can be sliced by OTA-vs-embedded.
- **`OTA Update Downloaded`** — fired when a newer bundle finishes downloading in-session
  (`{ updateId, createdAtIso }`). It applies on the **next** launch, which the following
  `OTA Update Status` records — together they form the published → downloaded → applied funnel.

The same launch reads also become **Sentry global tags** (`ota_channel`, `ota_update_id`,
`ota_runtime_version`, `ota_is_embedded`) via `setOtaSentryTags`, so every crash / error event is
attributable to a channel and bundle and lines up with the PostHog cohort above. A tester who switched
channels in-app overrides `ota_channel` with their active channel (read from the AsyncStorage override
mirror), matching the build-vs-override channel the switcher shows.

Both no-op in dev / Expo Go (analytics disabled, `Updates.isEnabled` false); the `__DEV__` debug hook
still logs `[analytics] OTA Update Status …` to Metro so you can confirm the tracker fires locally.
In PostHog (project 412845), count distinct installs with `isEmbeddedLaunch = false` per `updateId` to
measure how many pulled a given OTA.

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

`mobile-ota-production.yml` runs the health check after a successful publish (a short `sleep` lets
early relaunches report), with `continue-on-error: true`, and posts the verdict to the same Discord
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
You must also set `EXPO_UPDATES_CHANNEL` (e.g. `production`) — it feeds `updates.requestHeaders` and
thus the fingerprint. Get any of these wrong and `eoas` reports success while the directive is filed
under a fingerprint no shipped binary embeds, so the fleet reverts nothing.

Env: `EXPO_UPDATES_URL` + `EOO_TOKEN` + `EXPO_UPDATES_CHANNEL` (same as the publish), plus
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
`bun install`, then resolves both per platform and compares — equal fingerprint → ships OTA,
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
(cd /tmp/main-baseline && bun install --frozen-lockfile)
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
   `ghcr.io/mercuretechnologies/expo-open-ota:v3.0.5` (see the
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
   until the first `eoas publish --branch production`, and the headless map hard-fails on a
   nonexistent branch. Come back and map `production` → `production` **after the first production
   publish** (the first `main` OTA, or a manual `vp run mobile:publish -- --channel production`), via
   the dashboard or `vp run mobile:ota-setup map` — see
   [Channel↔branch mapping](#channelbranch-mapping-control-plane).
7. **Publish credential** — mint an app-scoped `eoo_` API key in the dashboard (the control-plane
   rejects Expo-token auth). Add it as the GitHub repo secret **`EOO_TOKEN`** and also to the
   `ota-preview` environment.
8. **GitHub config** — set the repo **variable** `EXPO_UPDATES_URL` =
   `https://updates.boardsesh.com/manifest` (consumed by the two native build workflows + the OTA
   publish workflow). `GOOGLE_MAPS_API_KEY` must also exist as a secret (already used by the Android
   build).
9. **Verify** — a header-carrying `GET https://updates.boardsesh.com/manifest` (with `expo-app-id`,
   `expo-channel-name: production`, platform/runtime headers) returns 200 with signature `keyid
main` after the first publish, and its assets load. `bunx eoas@3.0.5 doctor --channel=production`
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
`## Release Notes` sections, commits it, **pushes it back to `main`** (commit tagged `[skip ci]` so
the push can't re-trigger the OTA), and only then runs `eoas publish` (which needs a clean tree).
Nothing else writes the file: the native build workflows and `refresh-acknowledgements.yml` only
_read_ it, and a CI guard (`changelog-owned` in `ci.yml`) fails any PR that edits it. The OTA still
publishes whether or not the push-back is wired — the push-back just keeps `main`'s copy (which the
native binaries embed) current.

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
EXPO_UPDATES_URL=https://example.test/manifest EXPO_UPDATES_CHANNEL=production bunx expo prebuild
--platform ios --clean --no-install`, then confirm `ios/Boardsesh/Supporting/Expo.plist` has
   `EXUpdatesRequestHeaders` → `expo-channel-name=production` **and** `expo-app-id=007e6fd7-…`, plus
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

3. Ship one native TestFlight build from `main` (bakes in the fingerprint runtimeVersion + server
   URL + cert). Existing `appVersion`-era installs won't receive fingerprint OTAs — they update
   from the store once.
4. Make a trivial JS change, push to `main` (or `vp run mobile:publish -- --channel production`),
   relaunch the TestFlight app, and confirm the OTA downloads and applies.

## In-app channel switcher ("Try a preview", production builds)

**Any** user on a production/TestFlight build can repoint it at a different channel at runtime to try a
specific PR's OTA, without a per-tester build. The entry is a visible **"Try a preview"** button on the
**What's New** screen (`app/changelog.tsx`), next to _Check for updates_ — shown only when
`!__DEV__ && Updates.isEnabled`. It opens the switcher screen (`src/components/ChannelSwitcherScreen.tsx`),
which lists a fixed **Production** row (return to the stable release — shown to everyone), the
**live per-PR previews by pull-request title** (not raw `pr-<n>` strings), and a reset-to-production
action. _(It used to be a tester-only "OTA Channel Switcher" row under More → Development; that row
was removed.)_

- **Live preview list:** the screen calls the **public** `otaPreviewChannels` GraphQL query
  (`packages/backend/src/lib/ota-preview-channels.ts`), which derives the live channels from the GitHub
  `pr-preview` Deployments this workflow writes, intersected with still-open PRs — two cached GitHub
  calls, fail-soft to `[]`. Optional backend `GITHUB_TOKEN` raises the rate-limit ceiling (works
  unauthenticated on the public repo).
- **Mechanism:** `Updates.setUpdateRequestHeadersOverride({ 'expo-channel-name': <channel> })` —
  overrides only the channel header, keeping the build's `updates.url`, so the embedded code-signing
  cert still verifies every manifest. Then `checkForUpdateAsync` → `fetchUpdateAsync` → `reloadAsync`.
- **Why no `disableAntiBrickingMeasures`:** the header-only override (unlike
  `setUpdateURLAndRequestHeadersOverride`) needs no anti-brick opt-out. expo-updates only requires
  that the overridden header was **baked in at build time** (`updates.requestHeaders` — production
  builds bake `expo-channel-name` via `EXPO_UPDATES_CHANNEL`). So anti-bricking rollback + code
  signing stay intact for every user, and the feature is pure JS (rides an OTA; no native rebuild).
  ⚠️ If you ever drop the `expo-channel-name` header from `app.config.ts`'s `resolveUpdatesConfig`,
  the switcher breaks (the override throws). Keep it baked in.
- **Constraint:** the target channel must have an OTA published at the **same fingerprint
  runtimeVersion** as the running binary, or `checkForUpdateAsync` reports nothing available.
- **Channel switching is universal.** Every user on a production/TestFlight build can switch to any
  channel: the fixed **Production** row, the live per-PR previews, the preset list (`preview-1…4`,
  excluding the build channel so it doesn't duplicate the Production row), and free-text manual entry
  are all shown to everyone. Switch logic lives in `src/lib/channel-switch.ts` (unit-tested:
  `resolveBuildChannel`, `deriveChannelRowState`, and the switch/reset state machine).
- **Tester-only extras:** only the Sentry crash-test tools on the same screen still require the
  **`tester`** role (`UserProfile.isTester`; admin panel → Roles, admins implicitly count).

### One-tap link from the PR (`/preview/<channel>`)

Walking What's New → Try a preview → find the row is a lot to ask of a reviewer, so the sticky PR
comment also carries **`https://www.boardsesh.com/preview/pr-<number>`**. It resolves three ways:

| Where it's tapped  | What happens                                                                                                                                                                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS, app installed | Opens the app straight onto `app/preview/[channel].tsx`. The AASA (`packages/web/app/.well-known/apple-app-site-association/route.ts`) is wildcard (`'/*'`), so `/preview/*` needed no native change.                                                                                                                 |
| Android, or no app | Lands on the web page (`packages/web/app/preview/[channel]`), which offers `com.boardsesh.app:///preview/pr-<n>` as a button. Android `intentFilters` are path-scoped, so a direct Android universal link needs a `/preview` prefix added in `app.config.ts` — a fingerprint change, hence a separate native release. |
| Desktop            | Same web page; scan the QR to continue on a phone.                                                                                                                                                                                                                                                                    |

- **Why https and not the scheme directly:** GitHub's markdown sanitiser only renders `http`/`https`
  anchors, so a `com.boardsesh.app://` href in a comment would render as inert text.
- **The route just pre-selects.** `app/preview/[channel].tsx` renders the same
  `ChannelSwitcherScreen`, passing `requestedChannel`. The screen offers it through the **same
  confirm dialog** a tapped row raises — a link never switches the app on its own — and waits for the
  stored-override read plus the preview list first, so the dialog can name the PR and the revert
  target is correct. On a Metro/dev build (`updatesUsable === false`) it prefills the manual field
  instead.
- **It survives signing in.** The auth gate (`auth-provider.tsx`) redirects any unauthenticated route
  to `/auth/login`, so a signed-out tap would otherwise drop the channel on the floor and land the
  tester on home. `deep-link-provider.tsx` stashes it under `boardsesh_pending_preview_channel` and
  replays it once auth flips — the same stash-and-replay the join flow uses, re-validating the stored
  value on the way out as well as in.
- **The link only appears once the channel is mapped.** The announce step gates on `switchable`
  (published **and** the `map` job succeeded), so a bundle that published but failed mapping doesn't
  advertise a link that would report "No branch mapping found".
- **Channel names from a URL are whitelisted** in `src/lib/preview-link.ts` (`^pr-[1-9]\d*$` plus the
  presets — no `pr-0`, no leading zeros, so one PR has exactly one URL) before they reach
  `performChannelSwitch`. The web half is
  `packages/web/app/lib/ota-preview-link.ts` — the two are deliberately separate small files because
  the third consumer of this grammar, the `github-script` step in the workflow, can't import TS.
- **Scheme spelling:** emit the three-slash form (`com.boardsesh.app:///preview/…`). With two
  slashes `preview` is the URL _host_, which Expo Router's prefix stripping drops; `+native-intent.ts`
  normalises both, but don't rely on the rescue.

## Per-PR preview channels (self-hosted)

Every PR with React Native changes can publish its JS bundle to its own self-hosted channel
`pr-<number>`, which any user can switch to on a store/TestFlight build via the "Try a preview" switcher
above — no per-tester build. Workflow: `.github/workflows/mobile-ota-preview.yml` (sweep:
`mobile-ota-preview-sweep.yml`).

- **Publish + map.** For each platform the workflow runs `eoas publish --branch pr-<number> --channel
pr-<number>` (keeping `EXPO_UPDATES_CHANNEL=production` so the runtimeVersion equals the shipped
  binary's), then maps the channel to the branch with `scripts/ota-channel-map.ts map` — because in
  V3 `eoas publish` leaves the channel **unmapped** and the `eoo_` key can't map it (see
  [Channel↔branch mapping](#channelbranch-mapping-control-plane)). The channel name and the baked
  header are independent: the baked `expo-channel-name=production` drives the fingerprint, `pr-<number>`
  drives where the bundle lands and what the switcher selects.
- **Fingerprint parity.** A native-change PR resolves a new fingerprint no shipped binary has, so
  that platform is **skipped** — `vp run check:mobile-ota-compat` (the same engine as
  `mobile-ota-check.yml`) gates each platform, and the PR comment says so. The env is held
  byte-identical to the native builds + production publish by `scripts/mobile-ci-env-parity.test.ts`.
- **Who can publish (security).** The publish uses the app-scoped **`EOO_TOKEN`**, which lives in the
  gated **`ota-preview`** environment; the channel-mapping step uses the dashboard admin credentials
  (`OTA_ADMIN_EMAIL` + `OTA_ADMIN_PASSWORD`), which live in a SEPARATE **`ota-preview-unattended`**
  environment (no required reviewers, trusted-base code only — see below). The publish job runs
  PR-author code (`app.config.ts` calls `execSync`; workspace postinstall) with `EOO_TOKEN` in scope
  but never the admin creds. The boundary that protects `production`:
  - **Forks get NO secrets** on `pull_request` (we never use `pull_request_target`), so a fork can't
    publish or exfiltrate the token regardless of what it edits. This is the hard boundary for
    external contributors.
  - **Fork / on-demand previews** run only from a maintainer **`/ota-preview` comment**
    (`author_association` OWNER/MEMBER/COLLABORATOR) or `workflow_dispatch`. Those events run the
    **default-branch (main)** copy of the workflow, so their maintainer gate is not PR-editable; the
    publish then waits on the `ota-preview` environment. To make that path discoverable, a fork PR now
    gets an **auto-posted nudge**: the skipped fork run uploads a `mobile-ota-fork-prompt` artifact
    with the PR number, and the companion `mobile-ota-preview-prompt.yml` (`workflow_run`, base-repo
    context so it can comment on forks) posts a sticky "a maintainer can `/ota-preview`" comment. That
    file only comments — it holds no OTA secret and never checks out fork code — so the boundary above
    is unchanged; `/ota-preview` still does the actual publish. The nudge is removed once a real
    preview is published.
  - **Same-repo collaborators are trusted.** For `pull_request`, GitHub runs the PR's **own** copy of
    the workflow with repo secrets. Any same-repo PR touching the relevant paths auto-publishes; the
    **`ota-preview` environment** reviewer gate (if required reviewers are configured) is the human
    checkpoint — not a hard wall against a malicious insider, who already holds the repo's secrets via
    other workflows. `^pr-[0-9]+$` guards every channel mutation (defense-in-depth).
  - **Hardening (optional).** The admin-cred split is already done: `OTA_ADMIN_EMAIL` +
    `OTA_ADMIN_PASSWORD` live only in **`ota-preview-unattended`**, whose jobs check out the trusted
    base and carry no required reviewers, so PR-author code never runs with the admin creds. The only
    residual hardening concerns **`EOO_TOKEN`**: it's currently also a plain repo secret (the
    production publish on `main` needs it), which any same-repo PR workflow can read. For hard
    same-repo enforcement, make `EOO_TOKEN` environment-scoped instead — hold it on `ota-preview` (and
    on the `main` production environment) and drop the repo-level copy, so a PR can't reach it without
    the `ota-preview` gate. Production channel mapping stays a one-time dashboard action, so no admin
    creds ever touch `main`.
- **Readiness signal.** Each publish posts a sticky PR comment (channel name + switcher steps) and a
  GitHub **Deployment** to the `pr-preview` environment so the PR shows a green "ready" marker; the
  cleanup marks it inactive on close.
- **Cleanup + storage.** On PR close the `pr-<number>` channel + branch are deleted via
  `scripts/ota-channel-map.ts delete` (mapping gone → the server stops resolving it), and a daily
  sweep reaps `pr-<number>` channels whose PR is no longer open (the backstop for fork closes, which
  get no secrets). Server-side deletion is the **primary** garbage collector. The S3 bytes are the
  orphan backstop: V3 keys updates as `{appId}/{branch}/{runtimeVersion}/{timestamp}/…`, so the
  bucket lifecycle rule is scoped to the appId-scoped prefix
  **`007e6fd7-f200-448c-9449-8d48ba5d51fc/pr-`** — it ends with the workflow's channel prefix `pr-`,
  and `production/` under the same app id never starts with `pr-`, so production is never touched. If
  the channel prefix and this lifecycle prefix ever diverge, previews either never expire (storage
  leak) or the rule could match production, so `scripts/mobile-ci-env-parity.test.ts` couples them.

One-time infra: `vp run mobile:ota-setup preview` prints the lifecycle rule + the GitHub setup
(the `ota-preview`, `ota-preview-unattended`, and `pr-preview` environments; `ota-preview` holds
secret `EOO_TOKEN` for the publish job, `ota-preview-unattended` holds var `OTA_ADMIN_EMAIL` +
secret `OTA_ADMIN_PASSWORD` for the mapping/cleanup/sweep jobs, and `GOOGLE_MAPS_API_KEY` is a
repo-level secret for the Android fingerprint).

## Deferred

- **`beta` channel**: TestFlight on `beta`, App Store on `production`, promote at GA.
- **In-app `BranchSwitcher`** (`src/components/BranchSwitcherScreen.tsx`, gated on
  `isPreviewBuild()` in `src/lib/preview-build.ts`) switches branches **device-locally** on a preview
  build — it overrides the `expo-channel-name` request header via the same `channel-switch.ts` state
  machine as the tester Channel Switcher, with no EAS API token and no project-wide channel remap.
  The store-binary preview flow rides self-hosted `pr-<number>` channels (above).
