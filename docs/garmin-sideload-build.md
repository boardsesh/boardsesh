# Garmin watch app: build and release

`.github/workflows/garmin-release.yml` compiles the Connect IQ app in `garmin/`
for every watch listed in `garmin/release-devices.txt`, signs each one, and
republishes them under the rolling **`garmin-latest`** GitHub release.
`.github/workflows/garmin-ci.yml` is the PR gate. Both share
`.github/actions/connectiq-sdk`, which installs the SDK.

This is the Garmin counterpart to [`android-sideload-build.md`](./android-sideload-build.md),
with one important difference: the app is not on the Connect IQ Store yet, so a
GitHub release is the *only* way anyone gets it.

## The stable download URL

The whole point of the rolling tag. These never change:

```
https://github.com/boardsesh/boardsesh/releases/download/garmin-latest/boardsesh-fenix7.prg
https://github.com/boardsesh/boardsesh/releases/download/garmin-latest/SHA256SUMS.txt
```

Link those from docs, the app and Discord. Every build moves the tag to the new
commit and updates the release **in place** — assets are re-uploaded with
`--clobber` and any asset for a watch that left `release-devices.txt` is pruned.
It is deliberately not delete-then-recreate: this release is the only way to
install the app, so a publish that failed halfway after a delete would leave
every climber with no download at all.

`garmin-latest` sits outside the "Protect native release tags" ruleset
(`build-*`, `fingerprint-*`, `release/*`), so `GITHUB_TOKEN` can move it.
Per-commit archaeology comes from the 30-day `garmin-prg` Actions artifact on
each run, not from the tag.

## How it runs

- **PR gate** (`garmin-ci.yml`): `pull_request` touching `garmin/**`. Compiles
  `fenix7`, the staging jungle flavour, and the unit-test target. ~1 min after
  SDK setup.
- **Release** (`garmin-release.yml`): push to `main` touching `garmin/**`,
  excluding `garmin/README.md`. Also `workflow_dispatch`. All 12 watches compile
  in about 26 seconds; the run is dominated by the SDK download.
- Nothing else triggers either one. A push that does not touch `garmin/**` runs
  no Garmin job at all.

`ci.yml` deliberately has **no** `garmin` filter. Its `changes` job hardcodes
every output to `'true'` on push, so a Garmin job there would compile on every
push to `main`. `embedded/**` sets the precedent: a non-`vp` toolchain gets its
own workflows. `scripts/__tests__/garmin-workflows.test.ts` pins this.

## Why CI downloads the SDK instead of pulling an image

The Connect IQ SDK licence (§3, shipped inside the SDK at
`resources/readme/licenses/CIQ-LICENSE-AGREEMENT.html`) says you agree not to
"rent, lease, lend, upload to or host on any website or server, sell,
redistribute, or sublicense the SDK … or to enable others to do so". A public
GHCR image with the SDK baked in breaches that outright; a private one is not
clearly permitted. So CI fetches its own copy each run and redistributes
nothing.

Garmin also gates every device profile behind an account login and offers no
scoped API token — unlike App Store Connect, where CI gets a key that can only
touch builds. The closest available thing is a whole Garmin account, so CI uses
a **dedicated** one that exists only for this and holds no personal data.

## Configuration contract

All in the **`Garmin`** GitHub Environment. No required reviewers and no branch
restriction on it: the PR gate runs on feature branches, and gating the release
behind a human click would defeat "sideload the latest from `main`". The real
boundary is that GitHub never gives secrets to fork PRs, and the release
workflow only triggers on `main`.

| Secret | What |
|---|---|
| `GARMIN_USERNAME` | The dedicated CI Garmin account |
| `GARMIN_PASSWORD` | Its password |
| `GARMIN_DEVELOPER_KEY_BASE64` | `base64 -i garmin/developer_key \| tr -d '\n'` |

| Variable | Value today |
|---|---|
| `CIQ_SDK_VERSION` | `9.2.0` |
| `CIQ_SDK_MANAGER_VERSION` | `0.8.4` ([lindell/connect-iq-sdk-manager-cli](https://github.com/lindell/connect-iq-sdk-manager-cli)) |
| `CIQ_AGREEMENT_HASH` | `CC737BBBA104D7740D5BBCF27D0F6382` |

The agreement hash is how the SDK licence gets accepted non-interactively. Get a
fresh one with `connect-iq-sdk-manager agreement view` and read the agreement
before you paste it. A stale hash fails the download rather than silently
accepting revised terms.

## The signing key

`garmin/developer_key` is a 4096-bit PKCS#8 DER RSA key, gitignored, generated
once per `garmin/README.md` §2.

**SHA-256: `8760ff9c143e400718afd66ae4a965a884009a2818dcc6ed5ea9af272506f8c2`**

The release workflow prints that digest on every run. If it ever differs, the
key was rotated — stop and work out why. The Connect IQ Store rejects an update
signed with a different key, so rotating it after the app is listed means a new
app id and orphaned installs.

Custody: 1Password **and** the GitHub secret. Not either.

**PR builds never touch it.** They mint a throwaway RSA-4096 key in
`$RUNNER_TEMP` instead, because nothing compiled on a PR is ever installed or
distributed, and the fewer jobs that can read the real key, the better. Both
workflows shred whatever key they used in an `if: always()` step.

## Adding a watch

Add the product id to `garmin/release-devices.txt`. That's the whole change —
about five seconds of build time. The workflow fails loudly if the id is not an
`<iq:product>` in `garmin/manifest.xml`, and the manifest is the place to add a
watch the app has never supported at all.

Published today: `fenix7`, `fenix7s`, `fenix7x`, `fenix843mm`, `fenix847mm`,
`fenix8solar47mm`, `epix2`, `fr255`, `fr265`, `fr965`, `venu3`, `vivoactive4`.

Declared in the manifest but not published yet: `fenixe`, `fenix8solar51mm`,
`fr255s`, `fr255m`, `fr255sm`, `fr265s`, `fr955`, `venu2`, `venu2s`, `venu3s`,
`vivoactive4s`.

## Installing a build (what to tell people)

1. Download the `.prg` for the watch, e.g. `boardsesh-fenix7.prg`.
2. Plug the watch in over USB — it mounts as a drive named **GARMIN**.
3. Copy the file into `GARMIN/APPS/`.
4. Eject and unplug. Boardsesh appears in the app list.
5. If it does not appear, rename to `BRDSESH.PRG` and copy again. Some devices
   ignore long filenames in `APPS/`; the short name is 8.3-safe either way.

Uninstall by deleting the file. Pairing is unchanged — generate an 8-character
watch code in the app during a live session and type it on the watch
(`garmin/README.md` §6).

## What this pipeline does not do

- **No unit-test execution.** `garmin-ci.yml` compiles the `-t` target so
  `garmin/tests/*.mc` cannot rot, but does not run it. `monkeydo` needs the
  Connect IQ simulator, a Qt GUI app that is documented upstream to segfault and
  hang under Xvfb. Running the suite stays a manual step (`garmin/README.md` §5)
  until that is proven stable.
- **No `.iq` store package.** `monkeyc -e` builds all 23 manifest products for
  Connect IQ Store upload. Store submission is still blocked on the placeholder
  launcher icon, so the pipeline does not build one yet. Add it to the release
  workflow when the icon lands.
- **No strict type checking.** `monkeyc -l 3` reports 254 errors against the
  current source and produces no binary, so the gate uses the default (gradual)
  level the app is written against. Tightening it is a source-cleanup project,
  not a CI setting. The gate does fail if the warning count grows past the
  baseline in `garmin-ci.yml`.
- **No fork-PR compile.** Fork PRs cannot read secrets, so they cannot download
  the SDK. The gate skips rather than failing. Push the branch to this repo to
  get it compiled.

## Troubleshooting

**`SDK on PATH is X but Y was requested`** — the cache restored a different SDK.
Bump `CIQ_SDK_VERSION` or clear the `ciq-*` caches.

**`monkeyc emitted N warnings, up from 24`** — a new compiler warning landed.
Fix it, or raise `CIQ_WARNING_BASELINE` in `garmin-ci.yml` and say why in the PR.
The baseline includes the known 60×60 launcher-icon placeholder and the empty
`FitUnitNone` string, so it drops when those are fixed.

**`<device> is not an <iq:product>`** — a typo in `garmin/release-devices.txt`,
or a watch that needs adding to `garmin/manifest.xml` first.

**Agreement rejected** — Garmin revised the SDK terms. Read them, then refresh
`CIQ_AGREEMENT_HASH`.
