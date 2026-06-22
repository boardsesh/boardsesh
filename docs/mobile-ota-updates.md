# Mobile OTA updates (production: self-hosted expo-open-ota)

How JS/TS-only fixes reach the `packages/mobile` app without a new native build.

`expo-updates` speaks an open protocol, so we self-host the manifest + asset server with
[expo-open-ota](https://github.com/axelmarciano/expo-open-ota) instead of paying for EAS Update
hosting. The only thing we keep from Expo is a **free** account/token — the server uses Expo's
API for channel↔branch metadata, but serves manifests and bundles from our own storage, so
there's no MAU/bandwidth billing.

## Two hosting paths (don't mix them up)

|                | Preview / dev                            | Production                                                                                                                       |
| -------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Built by       | `eas build` (`mobile:preview-build`)     | bare `expo prebuild` + xcodebuild/gradle (the `ios-testflight-rn` / `android-apk-rn` workflows)                                  |
| Hosting        | EAS free tier (`u.expo.dev`)             | self-hosted expo-open-ota                                                                                                        |
| Channel source | `channel` in `eas.json`                  | `expo-channel-name` request header baked in by `expo prebuild`                                                                   |
| Publish        | `vp run mobile:publish` (→ `eas update`) | auto on push to `main` (`mobile-ota-production.yml`); manual: `vp run mobile:publish -- --channel production` (→ `eoas publish`) |

A third path rides the **same self-hosted server**: per-PR `pr-<number>` channels that let a tester
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
   (`EXUpdatesRequestHeaders`) and `AndroidManifest.xml`. `updates.url` points at our server. The
   public code-signing cert (`certs/certificate.pem`) is embedded.
2. **Runtime**: on launch the app asks `<server>/manifest` with its channel + runtimeVersion
   headers. The server returns the latest signed update on the branch mapped to that channel; the
   app verifies the signature against the embedded cert and applies it on next launch.
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
`DISCORD_DEPLOY_WEBHOOK` secret, the same channel the native build workflows use.

**Manual** (one branch, ad hoc) — once the server is deployed and you're logged in (`bunx eas
login`, or `EXPO_TOKEN` set):

```sh
EXPO_UPDATES_URL=https://ota.boardsesh.com/manifest \
  vp run mobile:publish -- --channel production --message "fix: <what>"
```

This runs `eoas publish --branch production`, which does an `expo export` and uploads the bundle
to our storage via the server. `eoas` reads the server URL from `updates.url` in `app.config.ts`,
so `EXPO_UPDATES_URL` must be present.

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
bypasses the tag check and always builds — for iOS that means dispatching on `main` (the iOS build
is `main`-only by design, since it uploads to TestFlight); the Android workflow additionally builds
from a `workflow_dispatch` on any branch (artifact-only, matching its pre-existing behavior).

**Manual overrides.**

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

## One-time setup (infra — done outside this repo)

`vp run mobile:ota-setup` scripts the in-repo phases (cert generation, the Railway env block, the
Expo channel/branch, the GitHub variable); the cloud actions (bucket, server, DNS) stay manual.
Run `vp run mobile:ota-setup` with no argument for the ordered runbook.

1. **Storage bucket** — reuse the existing S3-compatible provider (the one
   `packages/backend/src/storage/s3.ts` uses) with a dedicated `boardsesh-ota` bucket + a scoped
   token. Keep it portable (see the Railway/object-storage rules in `CLAUDE.md`).
2. **Code-signing keys** — `vp run mobile:ota-setup keys` (runs `bunx eoas@2 generate-certs` in
   `packages/mobile/` and prints the Railway env block with the base64 keys filled in). Produces
   `certs/certificate.pem` (commit — already whitelisted in `.gitignore`) plus the gitignored
   `certs/private-key.pem` and `certs/public-key.pem` (**never commit** — these go to the server).
   The committed cert is what flips production builds onto the self-hosted path:
   `resolveUpdatesConfig` stays on EAS until the cert exists, so generate and commit it before
   relying on the `EXPO_UPDATES_URL` variable.
3. **Deploy the server** — [Railway template](https://axelmarciano.github.io/expo-open-ota/docs/deployment/railway)
   or Docker/Helm. Required env (see the
   [env reference](https://axelmarciano.github.io/expo-open-ota/docs/reference/environment)):
   - `BASE_URL` = `https://ota.boardsesh.com`
   - `JWT_SECRET` = random string
   - `EXPO_APP_ID` = `87499648-655e-4fb8-9856-65da37e55fb1` (our Expo project id)
   - `EXPO_ACCESS_TOKEN` = an Expo token (same value as the `EXPO_TOKEN` CI secret)
   - `CACHE_MODE` = `local` (or `redis`)
   - `STORAGE_MODE` = `s3`, plus `S3_BUCKET_NAME`, `AWS_REGION`, `AWS_BASE_ENDPOINT` (the
     S3-compatible endpoint — Boardsesh uses Tigris on fly.io), and
     `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
   - `KEYS_STORAGE_TYPE` = `environment`, plus `PUBLIC_EXPO_KEY_B64` / `PRIVATE_EXPO_KEY_B64`
     (base64 of the keys from step 2)
   - optional: `USE_DASHBOARD=true` + `ADMIN_PASSWORD` for the monitoring web UI
4. **DNS** — point `ota.boardsesh.com` at the deployed server (CDN-front if desired).
5. **GitHub config** — `vp run mobile:ota-setup github --url https://ota.boardsesh.com/manifest`
   sets the repo **variable** `EXPO_UPDATES_URL` (consumed by the two native build workflows + the
   OTA publish workflow) and confirms the `EXPO_TOKEN` secret exists. `GOOGLE_MAPS_API_KEY` must
   also exist as a secret (already used by the Android build).
6. **Channel/branch** — `vp run mobile:ota-setup expo` creates the `production` channel + branch on
   the Expo project (the server reads the mapping from Expo's API) and maps channel `production` →
   branch `production`.

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

1. Local config check (the cert gate means you must generate certs first, else the config falls
   back to EAS and injects no channel header): `cd packages/mobile && bunx eoas@2 generate-certs`,
   then `EXPO_UPDATES_URL=https://example.test/manifest EXPO_UPDATES_CHANNEL=production bunx expo
prebuild --platform ios --clean --no-install`, then confirm `ios/Boardsesh/Supporting/Expo.plist`
   has `EXUpdatesRequestHeaders` → `expo-channel-name=production` and an `EXUpdatesCodeSigning*`
   entry. Repeat `--platform android` and grep `AndroidManifest.xml`.
2. **Fingerprint parity (the critical check)** — the OTA server must serve an update under the exact
   runtimeVersion the shipped binary embeds. The binary embeds the gate fingerprint (the
   `fingerprint-<platform>-<hash>` tag), baked as a literal `EXUpdatesRuntimeVersion` in `Expo.plist`
   because the build sets `EXPO_UPDATES_FINGERPRINT_OVERRIDE` (a local prebuild without that env var
   instead writes the `file:fingerprint` sentinel and computes the hash at archive time — expected).
   The publish reaches it by resolving the same fingerprint fresh on Linux (no override). Probe the
   manifest the way the app does, with the tag's hash as the runtime-version header:

   ```sh
   curl -sS -H 'expo-channel-name: production' -H 'expo-platform: ios' \
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

## Tester channel switcher (in-app, production builds)

Users granted the **`tester`** community role (admin panel → Roles; admins implicitly count as
testers) see an extra "OTA Channel Switcher" row under **More → Development** in the app. It lets a
tester repoint a production/TestFlight build at a different channel (e.g. `preview-2`) at runtime to
validate a specific PR's OTA, without a per-tester build.

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
- **Gating:** the row shows only when `isTester && !__DEV__ && Updates.isEnabled` (overrides are inert
  in dev/Expo Go). Logic lives in `src/lib/channel-switch.ts` (unit-tested); UI in
  `src/components/ChannelSwitcherScreen.tsx`. The `tester` role is global-only and grants nothing
  beyond this flag (`UserProfile.isTester`).

## Per-PR preview channels (self-hosted)

Every PR with React Native changes can publish its JS bundle to its own self-hosted channel
`pr-<number>`, so a `tester` switches to it on a store/TestFlight build via the switcher above — no
per-tester build. Workflow: `.github/workflows/mobile-ota-preview.yml` (sweep:
`mobile-ota-preview-sweep.yml`).

- **Fingerprint parity.** The publish keeps `EXPO_UPDATES_CHANNEL=production` (so the runtimeVersion
  equals the shipped binary's) and passes `--channel pr-<number>` as the `eoas` upload branch. The
  two are independent: the baked `expo-channel-name` header drives the fingerprint, `--channel`
  drives where the bundle lands and what the switcher selects. A native-change PR resolves a new
  fingerprint no shipped binary has, so that platform is **skipped** — `vp run check:mobile-ota-compat`
  (the same engine as `mobile-ota-check.yml`) gates each platform, and the PR comment says so. The
  env is held byte-identical to the native builds + production publish by `scripts/mobile-ci-env-parity.test.ts`.
- **Who can publish (security).** `EXPO_TOKEN` == the server's trusted `EXPO_ACCESS_TOKEN`, and the
  publish job runs PR-author code (`app.config.ts` calls `execSync`; workspace postinstall) with that
  token. The boundary that protects `production`:
  - **Forks get NO secrets** on `pull_request` (we never use `pull_request_target`), so a fork can't
    publish or exfiltrate the token regardless of what it edits. This is the hard boundary for
    external contributors.
  - **Fork / on-demand previews** run only from a maintainer **`/ota-preview` comment**
    (`author_association` OWNER/MEMBER/COLLABORATOR) or `workflow_dispatch`. Those events run the
    **default-branch (main)** copy of the workflow, so their maintainer gate is not PR-editable; the
    publish then waits on the `ota-preview` environment.
  - **Same-repo collaborators are trusted.** For `pull_request`, GitHub runs the PR's **own** copy of
    the workflow with repo secrets, so the **`ota-preview` label** + non-fork + the **`ota-preview`
    environment** reviewer gate are an intent + review checkpoint (no accidental publishes; a human
    approves each diff) — not a hard wall against a malicious insider, who already holds the repo's
    secrets via other workflows. `^pr-[0-9]+$` guards every channel mutation (defense-in-depth).
  - **Hardening (optional).** For hard same-repo enforcement, make `EXPO_TOKEN` an **`ota-preview`
    environment secret** (not a repo secret) so a same-repo PR can't drop the environment to reach it.
    Then the sweep needs a main-only environment (e.g. `ota-maintenance` with a `main` deployment
    branch policy, no reviewers) and the on-close cleanup defers channel deletion to the sweep (so
    cleanup needs no token). Not done by default because `EXPO_TOKEN` is currently a repo secret
    shared with the production publish.
- **Readiness signal.** Each publish posts a sticky PR comment (channel name + switcher steps) and a
  GitHub **Deployment** to the `pr-preview` environment so the PR shows a green "ready" marker; the
  cleanup marks it inactive on close.
- **Cleanup + storage.** On PR close the `pr-<number>` channel + branch are deleted (mapping gone →
  the server stops resolving it). The S3 bytes are reclaimed by a **bucket lifecycle rule** scoped to
  the **`pr-`** key prefix: expo-open-ota keys updates as `<branch>/<runtimeVersion>/<timestamp>/…`,
  and neither `production/` nor `preview-*/` starts with `pr-`, so production is never touched. A
  daily sweep reaps `pr-<number>` channels whose PR is no longer open (the backstop for fork closes,
  which get no secrets). The lifecycle rule is the **only** thing bounding S3 (there is no
  branch-delete primitive, only per-update `DeleteUpdateFolder`), so treat it as load-bearing infra.
  **Keep `S3_KEY_PREFIX` unset** — the bare `pr-` prefix depends on it; if you ever set it, re-scope
  the lifecycle rule to `<prefix>/pr-`.

One-time infra: `vp run mobile:ota-setup preview` prints the lifecycle rule + the GitHub setup
(the `ota-preview` / `pr-preview` environments, the `ota-preview` label, and exposing
`GOOGLE_MAPS_API_KEY` as a repo-level secret for the Android fingerprint).

## Deferred

- **`beta` channel**: TestFlight on `beta`, App Store on `production`, promote at GA.
- **In-app `BranchSwitcher`** (`src/lib/eas-api.ts`) still lists EAS-hosted branches for the
  dev-client preview build. The store-binary preview flow now rides self-hosted `pr-<number>`
  channels (above); migrating the dev-client switcher off EAS too would drop the Expo dependency
  entirely.
