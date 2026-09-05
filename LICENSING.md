# Licensing

Boardsesh is free and open source software, and self-hosting will always be an
option. Since the transition described below it is licensed under two
licences, chosen by what a directory does:

| Tier | Licence | SPDX | Text |
| --- | --- | --- | --- |
| **Product core**: the mobile and web apps, the backend and sync services, the Aura board renderer, search, sessions, analytics, recommendations, collaboration and all other user-facing product logic. Everything not listed in the second row. | GNU Affero General Public License v3.0 or later | `AGPL-3.0-or-later` | `LICENSE`, `LICENSES/AGPL-3.0-or-later.txt` |
| **Interoperability infrastructure**: the public API schema and clients, protocol definitions, board catalogue and adapters, Bluetooth libraries, third-party board API clients, and controller firmware. | Apache License 2.0 | `Apache-2.0` | `LICENSES/Apache-2.0.txt`, plus a `LICENSE` copy inside each covered directory |

**Copyright holder.** Copyright in Boardsesh's own contributions is held by
Boardsesh, the trading name under which Marco de Jongh operates as a sole
trader in Australia. A sole trader is not a separate legal person, so notices
that say "Boardsesh" name that trading name, and any licence grant or
commercial arrangement is made by the individual trading as Boardsesh.
Contributions from other people belong to their authors (see "Contributions
received under Apache-2.0" below).

The machine-readable form of this page is `REUSE.toml` (per-path SPDX
annotations, REUSE 3.3 format), the `license` field of every `package.json`,
`Cargo.toml` and PlatformIO `library.json`, and the
`org.opencontainers.image.licenses` label on the service images.
`scripts/__tests__/licence-boundary.test.ts` fails CI when any of those
disagree with this page. This page describes what the repository declares; it
is not legal advice.

## Why two licences

The core is copyleft so that whoever distributes a modified Boardsesh, or runs
a modified Boardsesh for other people over a network, has to make their
modified source available to those users. That is what keeps a fork or a hosted
copy as open as the original. Section 13 of the AGPL is the network clause;
if you self-host a modified Boardsesh for your gym or your friends, you must
offer them the source of what you run. An unmodified self-hosted copy is
already covered by this repository.

The interoperability tier is permissive so that anyone can build on it without
copyleft obligations: a new client for the Boardsesh API, an app for a board
Boardsesh does not support yet, independent LED hardware that speaks the same
Bluetooth protocols, or a tool that reads the board catalogue. Permissive reuse
of those parts is good for climbers whether or not the result touches
Boardsesh.

## The boundary, directory by directory

### Apache-2.0 (interoperability infrastructure)

| Directory | Package | What it is |
| --- | --- | --- |
| `packages/shared-schema/` | `@boardsesh/shared-schema` | The Boardsesh GraphQL schema and shared TypeScript types |
| `packages/shared/graphql/` | `@boardsesh/graphql` | Shared GraphQL operations and their codegen output: the client side of the public API |
| `packages/shared/graphql-client/` | `@boardsesh/graphql-client` | graphql-ws client helpers |
| `packages/board-constants/` | `@boardsesh/board-constants` | The board catalogue (sizes, layouts, sets, holds), grade colours, difficulty bands |
| `packages/shared/board-config/` | `@boardsesh/board-config` | Board metadata, hold maps, angle tables, board name and path helpers |
| `packages/shared/ble-protocol/` | `@boardsesh/ble-protocol` | The Bluetooth LED protocols (Aurora boards, MoonBoard, Woods, Rogue timer) |
| `packages/moonboard-ocr/` | `@boardsesh/moonboard-ocr` | MoonBoard screenshot OCR |
| `packages/crypto/` | `@boardsesh/crypto` | Encryption helpers used by the board API clients |
| `packages/shared/logbook/` | `@boardsesh/logbook` | Logbook grouping, search and display helpers. Left under Apache-2.0 because of its authorship (see below) |
| `packages/mobile/modules/health-workouts/` | `@boardsesh/health-workouts-module` | The Apple Health bridge. Left under Apache-2.0 because of its authorship (see below) |
| `packages/aurora-sync/src/api/`, `packages/kilter-sync/src/api/`, `packages/moonboard-sync/src/api/` | `@boardsesh/aurora-sync/api`, `@boardsesh/kilter-sync/api`, `@boardsesh/moonboard-sync/api` | The third-party board API clients (HTTP, Keycloak, PowerSync, scraping). Each directory carries its own `LICENSE`; the sync engines around them are AGPL (see the staged extraction plan below) |
| `packages/board-controller/`, `embedded/` | firmware projects and the PlatformIO libraries under `embedded/libs/` | The ESP32 board controller, MoonBoard dev server, protocol decoders, LED drivers and displays |
| `packages/web/board-controller/` | Python service | The board-controller WebSocket server |

The public REST API specification served at `/openapi.json` is Apache-2.0 too
(`packages/web/app/lib/api-docs/generate-openapi.ts`). The servers behind it
are AGPL.

Every package in this tier depends only on other packages in this tier (the
boundary test enforces the direction), so each can be copied out and reused
under Apache-2.0 alone.

### AGPL-3.0-or-later (product core)

Everything else, in particular `packages/web`, `packages/backend`,
`packages/mobile` and its Expo modules, `packages/db`, `packages/scheduler`,
the sync engines (`packages/aurora-sync`, `packages/kilter-sync`,
`packages/moonboard-sync`, `packages/location-sync`, `packages/sync-runtime`),
every other `packages/shared/*` package, `ml/`, `scripts/`, `deploy/`, and the
repository's tooling, documentation and configuration.

**The Aura board renderer** is part of the core and is the part the copyleft
protects most deliberately. Its scope is board geometry and hold masks,
inactive-hold dimming (the veil), role-coloured rendering, the glow and
compositing passes, resolution-independent rendering, and thumbnail
generation and caching. It lives in:

- `packages/board-renderer/` (Rust workspace: `core`, `ffi`, `wasm`, and the committed `wasm/pkg/` output)
- `packages/mobile/modules/board-renderer/` (the Expo module: Swift and Kotlin/JNI bindings, the Expo-web binding, and the committed prebuilt `xcframework` and `jniLibs`)
- `packages/shared/board-render/`, `packages/shared/board-look/`, `packages/shared/board-art-geometry/`
- the verbatim wasm copies in `packages/web/public/wasm/` and `packages/mobile/public/wasm/`

Its public boundary is one JSON `RenderConfig` in, one premultiplied RGBA
buffer out, through two C symbols (`board_renderer_render`,
`board_renderer_free`) or one wasm export (`render_overlay`). That surface is
kept small on purpose so native, React Native and web consumers can integrate
it; nothing about it is obfuscated. The protection comes from the licence.

Two source files in that scope carry no SPDX header by design:
`packages/shared/board-render/src/pipeline.ts` and
`packages/shared/board-render/src/background.ts`. Their content hash feeds
`BOARD_RENDER_VERSION`, so a comment-only edit would flush a year of immutable
CDN cache for no pixel change. Package metadata and `REUSE.toml` cover them.

### Generated and prebuilt artifacts

Compiled or copied output carries the licence of the source it was built
from: the wasm-pack output and its two `public/wasm/` copies, the iOS
`libboard_renderer_ffi.a` slices and Android `libboard_renderer_ffi.so`
files (AGPL), the firmware `.bin` files (Apache-2.0), the traced silhouette
shards under `packages/shared/board-art-geometry/src/generated/` (AGPL, with
the reservation about their inputs below), and the generated GraphQL and board
catalogue files under the Apache-tier packages (Apache-2.0).

## The transition point

Until the licensing change was merged, every file in this repository was
offered under the Apache License 2.0 (`LICENSE` at the root), and the Expo
native modules under `packages/mobile/modules/` additionally declared `MIT` in
their `package.json`, an unedited template default.

- **Last commit on `main` under Apache-2.0 alone:** `fac0aa52` (2026-09-05, "chore(changelog): refresh from merged PRs"). Every commit up to and including it, and every build, image, OTA bundle, firmware binary and dataset export produced from those commits, remains available under Apache-2.0. The mixed model applies from the merge commit of the licensing change onward.
- **Last store release under Apache-2.0:** version 2.4.0 for iOS and Android, built from `1037e0462` (2026-09-01; tags `release/ios-v2.4.0-15f9b78d219b`, `release/android-v2.4.0-8a93b3d14de7`).
- **Registries:** nothing was ever published to npm, crates.io or PyPI, so no registry copy exists under any licence.

Nothing about this change is retroactive. A copy you obtained before the
transition keeps the rights it came with, and Apache-2.0 is irrevocable for
those revisions. Earlier versions were never AGPL, and this page does not say
otherwise.

## Contributions received under Apache-2.0

Before the transition, code was contributed to this repository by people other
than the maintainer under the Apache License 2.0 (there was, and is, no
contributor licence agreement). Those contributions were not, and cannot be,
relicensed by the project. They remain under Apache-2.0, with their copyright
held by their authors. Apache-2.0 permits sublicensing and combining into
derivative works, so they are carried inside the AGPL-licensed combined work
with their licence and notices intact, and `LICENSES/Apache-2.0.txt` ships
with every copy for that reason. `git log` and `git blame` are the per-line
record of who wrote what; this table summarises where such contributions
survive today, by the names recorded in git history:

| Contributor (as recorded in git) | Components with surviving contributions |
| --- | --- |
| Jay Harris | web, backend, mobile, db, board-constants, shared-schema, ble-protocol, board-config, board-react, create-climb-react, graphql, i18n, logbook, docs |
| Alex Zuttre (also as Helter Skilter, WinnebagoMaaan) | web, backend, mobile, db, shared-schema, analytics, board-react, graphql, i18n, logbook, profile-stats, scripts, CI, docs, marketing |
| Miguel Palau Zarza | web, backend, db, shared-schema, graphql, repo tooling |
| Axel Perschmann | web, mobile, i18n, scripts, docs |
| Alex Sánchez | web, mobile, i18n, profile-stats, scripts, marketing |
| Alex Pooley | backend, mobile, db, climb-filters, i18n |
| giannilariosa | backend |
| Peter Popescu | mobile, i18n |
| Lily Gertsacov | backend, shared-schema, graphql, scripts |
| lukalelovic | crypto, root files |
| gardaholm, SamRoehrich, alex-claude, ES-Alexander | small changes in web or backend |
| Mayank Basena | `SECURITY.md` and the Code of Conduct (itself adapted from the Contributor Covenant v2.0, CC-BY-4.0, and annotated as such in `REUSE.toml`) |

The share of surviving outside-contributed lines per AGPL package, from
`git blame` at the transition (rounded; generated files excluded where noted):

| AGPL package | Outside share | What it is |
| --- | --- | --- |
| `packages/shared/create-climb-react` | 37% | the create-climb hook and its tests (Jay Harris) |
| `packages/shared/profile-stats` | 19% | chart builders, angle lifetime (Alex Sánchez, Alex Zuttre) |
| `packages/shared/climb-filters` | 8% | the progress filter (Alex Pooley) |
| `packages/shared/board-react` | 7% | the tick-mutation hook (Alex Zuttre) |
| `packages/mobile` | 3% | logbook UI, filter chips, create-climb screen, Bluetooth auto-disconnect, sheets (several contributors) |
| `packages/backend` | 2% | user data export (giannilariosa), Instagram beta import (Alex Zuttre), MoonBoard de-duplication (Jay Harris), tick queries |
| `packages/db` | 1% of hand-written lines | the Boardsesh-grade model and a MoonBoard de-duplication migration (Jay Harris), beta-link scripts (Alex Zuttre); plus two machine-generated migration snapshots |
| `packages/shared/i18n` | 23% | translations, above all the German catalogue (Axel Perschmann) |
| `packages/web` | under 1% | logbook preferences, Instagram posting, username generation, grade format |
| `packages/mobile/modules/live-activity` | under 1% | Bluetooth encoding details (Jay Harris) |

Two packages were left under Apache-2.0 instead of being carried into the
AGPL, because they are predominantly other people's work and there is no
instrument that would let the project change that: `packages/shared/logbook`
(92% Alex Zuttre) and `packages/mobile/modules/health-workouts` (a disclosed,
partly verbatim port of Miguel Palau Zarza's HealthKit plugin from the
retired Capacitor app; its earlier `MIT` metadata was a template default and
never the inbound licence).

Because the remaining files are of mixed authorship, the AGPL core does not
carry per-file SPDX headers claiming a single copyright holder; the licence is
declared at package level and in `REUSE.toml`. The Aura renderer packages (solely
Boardsesh-authored, `SPDX-FileCopyrightText: 2026 Boardsesh`) and the Apache
tier (unchanged in licence, `SPDX-FileCopyrightText: Boardsesh contributors`)
do carry headers.

Provenance notes recorded during the audit:

- `packages/shared/ble-protocol/src/aurora.ts` carries a type alias and a colour-override parameter written by Lily Gertsacov in the retired web Bluetooth code; blame attributes the file move elsewhere. The package is Apache-2.0, so nothing changes, but the credit stands.
- One line by gardaholm in `packages/web/app/lib/data/get-logbook.ts` predates the repository's first `LICENSE` file (added 2025-01-06); it is de minimis and is treated like every other pre-transition contribution.
- `packages/web/board-controller/static/` contains a prebuilt JavaScript bundle with embedded notices for React (MIT), classnames (MIT), regenerator-runtime (MIT), the Nayuki QR code generator (MIT) and qrcode.react (ISC). Those notices are retained as-is.
- `packages/board-renderer/core/src/edt.rs` implements Felzenszwalb and Huttenlocher's distance-transform algorithm, whose authors' reference C++ code is GPL-2.0-or-later. Its provenance was checked two ways before the transition: a structural comparison against that reference found no code-specific fingerprint beyond the conventional `1e20` sentinel (every shared element is the paper's own Algorithm 1 notation, and the pop-loop shape, the hoisted `f[q] + q²`, the underflow guard and the argmin extension are absent from the reference), and the session that produced the file records no external code, fetch or paste, only the paper's algorithm and a prose specification. The file is an independent implementation of a published algorithm and stays as written.

## What the licences cover, and what they do not

The licences govern this implementation: the source, the bindings, the tuning
data, the traced geometry, the compiled artifacts. They do not claim the ideas.
Dimming unlit holds, colouring holds by role, glowing a silhouette, rendering at
any size, queueing climbs, or talking to a board over Bluetooth are ideas anyone
may implement independently. A renderer or an app written from scratch that
happens to look or behave similarly is not a derivative work of this one.

The traced hold silhouettes under `packages/shared/board-art-geometry/src/generated/`
are machine-traced from the board manufacturers' artwork. Boardsesh's licence
covers Boardsesh's tracer, its rules and its selection. It does not assert any
rights over the manufacturers' artwork, and the traced data is kept separate
from Boardsesh's own code so that distinction stays visible.

## Third-party components

Boardsesh ships third-party software under its own licences, all of which are
compatible with distribution under the AGPL or Apache-2.0 as applicable:

- Rust crates in the renderer (`packages/board-renderer/Cargo.lock`): permissive throughout; `tiny-skia` and `tiny-skia-path` are BSD-3-Clause and `arrayref` is BSD-2-Clause, whose notices travel with the prebuilt binaries.
- `sharp` (Apache-2.0) loads libvips (LGPL-3.0-or-later) as a native addon in the web and backend images.
- The firmware links the Arduino-ESP32 core and `links2004/WebSockets` (both LGPL-2.1-or-later) statically; the complete source and build recipe in `embedded/` satisfy the relinking requirement.
- npm dependencies are MIT, ISC, BSD, Apache-2.0, MPL-2.0 or similar. The in-app "Open source licenses" screen lists the mobile app's dependencies (`scripts/generate-oss-licenses.ts`).

Boardsesh started as a fork of Climbdex (MIT, Luke Emery-Fertitta); the
current codebase is a from-scratch Next.js application, but the acknowledgement
in `CONTRIBUTING.md` stays.

## Commercial licensing

The licences above are the only terms the code is offered under in this
repository. Separate commercial licensing of AGPL components could be
available from the copyright holder for the parts the copyright holder owns;
no terms are published here. Any such arrangement, like the questions in the
next section, needs final legal review before it can be relied on.

## Contributions from now on

A contribution is accepted under the licence of the directory it changes:
AGPL-3.0-or-later for the core, Apache-2.0 for the interoperability tier.
There is no CLA or DCO today. `docs/contributor-policy-proposal.md` sets out
the options and is a proposal for review, not a policy in force; until a
decision is made, outside pull requests to the AGPL core may be held so the
questions below do not get harder to answer.

## Open questions requiring legal review

1. **App Store and Play Store distribution.** The Free Software Foundation's position is that Apple's App Store terms are incompatible with the GPL family. The maintainer can distribute their own AGPL code through the stores, but contributions received under the AGPL alone would not come with that permission, and forks cannot rely on it. The preferred direction is a public, lawyer-reviewed additional permission under AGPL section 7 that allows app-store distribution for everyone while keeping the source obligation, rather than a private exception for the official build. No such permission has been added; adding one needs explicit approval and legal review.
2. **Dual licensing and contributor permissions.** Whether to ask core contributors for a licence grant that allows relicensing or commercial terms, and in what form. See `docs/contributor-policy-proposal.md`.
3. **OTA updates.** Over-the-air JavaScript bundles are a distribution of the AGPL core to the installed app. Boardsesh satisfies the source obligation through this repository; a fork operating its own update server would have to do the same.
4. **The combined-work model itself.** The project relies on Apache-2.0's permission to sublicense and to combine into derivative works in order to carry outside contributions inside the AGPL core without consent. Counsel should confirm that reading and the wording above; the fallback for any package where it is not accepted is to leave that package under Apache-2.0, as was done for `logbook` and `health-workouts`.
5. **Traced geometry data** derived from manufacturers' artwork (above).
6. **AI-assisted authorship.** Much of the codebase was written with AI assistance, recorded in commit trailers. How that affects copyrightability, and therefore enforceability, varies by jurisdiction. Records of the human decisions behind the code (issues, reviews, session links in commit messages) should be preserved.
7. **The board snapshots dataset** (`docs/board-snapshots-dataset.md`) is published without a stated licence. A code licence does not cover a data export; it needs its own terms.

## Staged extraction plan for the board API clients

The three board API clients are Apache-2.0 today by directory
(`packages/<board>-sync/src/api/`, each with its own `LICENSE`, SPDX headers on
every file, and a `./api` export from the package). That boundary is
enforceable but sits inside AGPL packages, which is more awkward for a reuser
than a package of its own. Moving them out is straightforward and can happen
in a later change without touching behaviour:

1. Create `packages/aurora-api`, `packages/kilter-grips-api` and `packages/moonboard-api` (Apache-2.0, `license` field, `LICENSE`, README) and move each `src/api/` there unchanged. They already import nothing from their parent packages; Kilter's client depends only on `@boardsesh/crypto` and Aurora's on `@boardsesh/shared-schema/types`, both in the Apache tier.
2. Point the sync packages' `./api` exports at the new packages and re-export, so `@boardsesh/aurora-sync/api` and `@boardsesh/kilter-sync/api` keep working for the backend and web imports.
3. Move the `src/api/**` entries in `REUSE.toml` and the boundary test's Apache directory list to the new package paths, and drop the per-directory `LICENSE` files.
4. Run the sync and backend test suites; nothing else changes.

The same pattern applies if the Swift Bluetooth manager inside the Live
Activity module (`packages/mobile/modules/live-activity/ios/BoardBle*.swift`)
should one day become a reusable native library: extract it into its own
module, license it Apache-2.0 there, and leave the Live Activity product code
in the core.
