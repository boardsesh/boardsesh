# Boardlordz APK provenance and feature comparison

Investigated 4 November 2026. Boardlordz Android **1.1.0, build 43**, package
`com.provatech.boardlordz`, compared with Boardsesh commit
`796746a5db3c4fae37a54d8d8fd2d0a7cb00fc1f`.

**The evidence supports selective reuse of Boardsesh's Bluetooth implementation
and Kilter image assets, rather than establishing a whole-app reskin.** The APK
credits Boardsesh and contains the Apache 2.0 terms, sections 1–9. Its client
targets a separate API on Fly.io. No Boardsesh backend destination was found in
the inspected APK, but production log access was unavailable, so server-side
proxying or undisclosed backend use remains unresolved.

## Findings and confidence

| Question | Finding | Evidence and limit |
| --- | --- | --- |
| Is this a Boardsesh fork or reskin? | Confirmed reuse of Aurora BLE code and image inputs; whole-app derivation is not established. | The APK runs a Svelte app in Capacitor. Boardsesh mobile uses React Native and Expo. Multiple specific BLE algorithms match, and Boardlordz acknowledges the port. A different framework does not exclude translated code elsewhere. |
| Is Boardsesh credited? | Yes, in the APK's About HTML and compiled About component, with a GitHub link and Apache 2.0 label. | APK bytes, not just a website claim. Apache 2.0 terms also ship under an AndroidX dependency. This does not settle every license condition. |
| Are they using our backend? | No direct client use found. Boardlordz's REST and session WebSocket code uses `boardlordz-api.fly.dev`. | All regular members of the acquired base APK and two splits were scanned. A public website capture also contacted that API. No authenticated Android runtime or production ingress audit was possible. |
| What is worth implementing? | Differential hold maps, authored hand beta, recurring leagues, natural-language workout input, and planner handoff. | Detailed scope and acceptance criteria below. Several apparent gaps already exist in Boardsesh. |

## Artifact identity and evidence

The [official Play listing](https://play.google.com/store/apps/details?id=com.provatech.boardlordz)
identifies Boardlordz and publisher Prova Climb. These APKs were retrieved from
Google Play's delivery service using Aurora's public anonymous access, without
a personal Google account. Download completed at **2026-11-04 09:08:30 UTC**.
An earlier indexed listing said updated November 3; the freshly retrieved Play
page said November 4. The hashes below identify the inspected version precisely.

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| Base APK | 23,834,117 | `dc6fa93990c6fc0b1f4d50a032003a6bad16ab7a718a2250882ca15fcd6fe7ca` |
| `config.en` split | 74,137 | `95f11e2dcea944fcf0e57b09047129fd14e64d5f5c27b911948e9ea4f19dfb67` |
| `config.xxhdpi` split | 120,352 | `26a8f1a4ae3d2e7659c10c63db543bc29dcf922045d65d430dcf110787b94345` |

All ZIP CRC checks passed. Google's `apksig` 8.13.0 verified all three APKs with
v2 and v3 signatures and source stamps, with no reported errors or warnings.
All share certificate SHA256
`daea75c2747a626ad5ccf357724a0583a5eeabd55c057e2fe79017f48385c016`.
This establishes artifact integrity and matching split signers; it does not
identify any relationship with Boardsesh's signing identity.

The locally retained artifacts are in the ignored directories
`.boardsesh/boardlordz-research/acquired/` and
`.boardsesh/research/boardlordz/`. The first holds the signed APKs, download
provenance and signing verification. The second holds extracted assets, JADX
output, REA evidence and browser observations. Anonymous access tokens and signed
delivery URLs are private acquisition material and are excluded from the report
and shareable evidence bundle.

The [evidence ledger](./boardlordz-2026-11-04.evidence.json) records selected
member hashes, exact byte offsets, acquisition metadata, evidence identities and
bounded scan results. These identifiers refer to complete local REA records:

| Evidence | Operation | Scope |
| --- | --- | --- |
| `ev_bcc4b9323227775f535a8dd88a2e00ea0eeb4f9fad6bb27313a61979252d9acd` | REA `inspect_artifact` | Base APK central-directory inventory; complete within that substep. It does not inspect the APK signing block. |
| `ev_16535b03f76d8667cff8ef80c2e599a288456a2af5ccdd1271724c8e1de78f6a` | REA `analyze_javascript_application` | Six exact APK JavaScript files, 378,901 bytes, 122,808 AST nodes, zero parse failures. Another 95 inventoried relevant files remain outside this semantic analysis. |
| `ev_94969fbac3cf5a70e6b4bb31f13854c44a9c9541aaa23c05ef92f8289aeeef1c` | REA `capture_browser_scenario` | Public homepage load and 2.5-second wait. Recorded 73 requests, including four to the Fly.io API; none to Boardsesh. Zero event drops, but incomplete because some requests were still pending at capture end. |

REA 6.7.0 was run through its CLI because the session exposed no REA MCP tools.
No client configuration was changed. Ordinary ZIP scans, JADX output, signature
checks and supplemental Playwright observations are identified separately from
REA evidence. JADX 1.5.5 decoded the manifest and recovered Java from the DEX;
it reported 28 decompilation errors, so its output is not complete recovered source.

## Extent of Boardsesh reuse

### Aurora Bluetooth code

APK member `assets/public/_app/immutable/chunks/7JG8B3Vy.js` contains the Aurora
packet implementation. Comparison with
[aurora.ts](../../packages/shared/ble-protocol/src/aurora.ts) and
[transport.ts](../../packages/shared/ble-protocol/src/transport.ts) shows the
following matching behavior. These are manual static correspondences, not an
automatically measured whole-app similarity percentage.

| Boardlordz implementation | Boardsesh correspondence | Why it matters |
| --- | --- | --- |
| Checksum sums modulo 256, XORs 255; frame is `[1, length, checksum, 2, ...body, 3]`. | `checksum`, `wrapBytes` | Same packet construction. Protocol constants alone would be weak lineage evidence. |
| API v2 uses commands 77–80, v3 uses 81–84; splits bodies at 255 bytes and rewrites first/last/only commands. | Command tables and `getAuroraBluetoothPacket` | Matching packet assembly strategy. |
| v2 power budget is 18, scale ladder `[1,.8,.6,.4,.2,.1,.05]`, two LEDs per Kilter hold and one for other boards. | `computeV2Scale`, `getLedsPerHold` | A more specific algorithmic match than the shared BLE UUID. |
| API and serial parsers use `/@(\d+)/` and `/#([^@]+)/`; board parser removes whitespace and hyphens; bare manufacturer names trigger a special path. | `parseApiLevel`, `parseSerialNumber`, `parseBoardTypeFromDeviceName`, `isKilterBuiltBox` | Same parsing and controller compatibility decisions. |
| Results carry `ledsWritten`, `ledsWithColour`, `allLedsDark`; v2 detects a nonempty packet with no lit LEDs. | `BluetoothPacketResult` and packet diagnostics | Distinctive diagnostics also present in Boardsesh. |

Boardlordz changes the surrounding interface: its encoder accepts LED entry
objects instead of Boardsesh's frames/placement mapping; its wrapper maps board
coordinate roles to RGB, returns skipped coordinates and throws when a v2 packet
would darken the whole climb. The same bundle includes MoonBoard and Dungeon
Trainer handling. Matching hardware support by itself does not establish copying
of those other implementations.

The About component explicitly identifies Boardsesh as the source of the Aurora
port. Together with the code correspondences, that makes reuse **high confidence**.
The exact upstream revision and total translated code volume cannot be recovered
from these facts alone.

### Kilter image inputs

The APK also ships `assets/public/boards/SOURCES.md`. It records that its Kilter
layer PNGs came from Boardsesh's public web assets at commit `6fdc0d6e`, then
were composited by its own `backend/scripts/build_aurora_board_assets.py`.
That commit exists locally as
`6fdc0d6e41949ca758c0c5db42a570946543219f`, dated October 15, 2026.

This is a packaged admission of copied image inputs, **not** proof that the
resulting WebP files are byte-identical to Boardsesh assets. The file describes
the copy as one-time and identifies the manufacturer as the image copyright
holder. It does not establish ongoing requests to Boardsesh or Boardsesh's
ownership of the manufacturer imagery.

### Application architecture

The base APK has 579 ZIP entries and 91 JavaScript members, including 90 under
`assets/public`. It includes
`assets/capacitor.config.json`, bundled Svelte routes and six standard Capacitor
plugins for BLE, app lifecycle, haptics, notifications, social login and sharing.
Its application-specific Java entry point extends `BridgeActivity`, registers an
install-referrer plugin and calls the superclass. The manifest targets Android
SDK 36, minimum SDK 24. No `.so` entries were present in this acquired base APK;
that observation does not claim every architecture split was acquired.

This differs from Boardsesh's Expo/React Native application and GraphQL-based
client. Boardlordz has its own REST resource names, bearer-token handling,
WebSocket messages, local storage keys and Svelte UI. That is substantial evidence
against a simple package rename and skin swap. It cannot exclude translated or
rewritten Boardsesh logic in other areas; no defensible overall copied percentage
is available.

## Attribution and license findings

The claim that there is **no attribution** is contradicted by the inspected build.
Both `assets/public/about.html` and the compiled About route link to
`github.com/boardsesh/boardsesh` and identify the Aurora port and Apache 2.0.
The current [public About page](https://boardlordz.com/about), updated October 30,
also gives this credit. The APK image provenance file separately mentions
Boardsesh and the asset revision.

The base APK contains the Apache 2.0 terms, sections 1–9, at
`META-INF/androidx/concurrent/concurrent-futures/LICENSE.txt` (10,175 bytes,
SHA256 `809fa1ed21450f59827d1e9aec720bbc4b687434fa22283c6cb5dd82a47ab9c0`).
The text matches Boardsesh's license through the end of the terms after
whitespace normalization; it omits the optional license-application appendix.
Its dependency location does not establish how recipients are directed to the
license or how the redistributed port satisfies every applicable condition.

Boardsesh's [LICENSE](../../LICENSE) is Apache 2.0. Its redistribution conditions
cover a license copy, modified-file notices, retained source notices and, where
applicable, upstream NOTICE text. They do not impose a general public-source
release or a particular branded UI credit. No tracked upstream NOTICE file was
found at the comparison commit. See the
[authoritative Apache text](https://www.apache.org/licenses/LICENSE-2.0).

The port's preferred source, modification notices and complete distribution
history are unavailable. **This investigation does not establish license
noncompliance.** Preserve the signed artifact and these findings before deciding
whether a narrower compliance request is justified.

## Backend dependency assessment

### What the APK contains

The primary API client, `assets/public/_app/immutable/chunks/DzaoLw-V.js`, sets
the base URL to **`https://boardlordz-api.fly.dev`**, reads a
`boardlordz.token` preference, and adds `Authorization: Bearer …` for signed-in
requests. Its generic fetch concatenates that base with resource paths.

| Flow | Destination encoded in the client |
| --- | --- |
| Browse, grades, holds, similar climbs | `/api/v1/setups`, `/api/v1/problems`, `/api/v1/hold-hardness`, `/api/v1/problems/{id}/similar` at the Fly.io API |
| Account, logbook, lists, workouts | `/api/v1/auth/*`, `/api/v1/ticks`, `/api/v1/me/lists`, `/api/v1/plan` at that API |
| Shared board session | `wss://boardlordz-api.fly.dev/api/v1/sessions/{code}/ws?member=…`, derived by replacing the base URL's HTTP scheme |
| Leagues and training planner | `/api/v1/leagues/*`, `/api/v1/prova/*` at that API |
| Uploaded spray wall images and detection | `/api/v1/walls/*` at that API; image helpers resolve relative image paths against it |

`capacitor.config.json` has no remote `server.url` override. The decompiled custom
Java entry point does not add an alternate API origin. Literal origin scans also
find OAuth, documentation and schema URLs; those are not all application servers.
The small provenance file explains copied Kilter assets without requiring runtime
fetches from Boardsesh.

Case-insensitive UTF-8 and UTF-16LE searches covered every regular ZIP member of
the base, English and xxhdpi APKs. The only seven `boardsesh` occurrences in the
base are the About link/text copies and `boards/SOURCES.md`. None of the acquired
APKs contains literal `ws.boardsesh.com`, `updates.boardsesh.com`,
`ota-assets.boardsesh.com`, `x-boardsesh-client`, `boardsesh-mobile` or `graphql`.
Computed, encoded, encrypted or server-configured destinations can escape this
search; strings establish a bounded negative result, not a universal guarantee.

### What was observed on the network

Two ordinary public GET requests returned HTTP 200 from the Fly.io service:
`/api/v1/setups` and `/api/v1/walls/status` (the latter returned `enabled: true`).
A supplemental Playwright capture loaded the current website and clicked its
Open the web app button, reaching the sign-in dialog without signing in.
It recorded 76 requests: 66 to `boardlordz.com`, five to
`boardlordz-api.fly.dev`, and five to Cloudflare/Google font or login services.
The five API requests comprised setups, three benchmark lists and the site's
own analytics event. None contacted a Boardsesh origin. This is a **public web
observation**, not a capture from Android, authenticated account flows or BLE.

The current website and APK are different builds: 41 of the 90 JavaScript members
under the APK's `assets/public` tree are byte-identical to a fetched website
member. The central API and BLE
chunks are among the exact matches. Web-only observations are therefore labeled
separately; they are not silently substituted for APK behavior.

### What remains unresolved

Railway CLI 5.52.1 returned `Unauthorized` for the saved account and project
context. No production HTTP or WebSocket logs were obtained. The connected Loki
datasource listed Boardsesh worker services, but no identifiable public ingress
or realtime backend stream in its last-24-hour service inventory. No negative
traffic conclusion is drawn from that inventory, and no broad unrelated logs
were searched.

The remaining backend question is whether Boardlordz's **server**, rather than
its client, calls Boardsesh. Client analysis cannot answer that. Nor does the
absence of a Boardlordz user agent prove absence: client identity is caller
controlled. Boardsesh's accepted WebSocket connection log includes user agent,
client identity and connection identifiers in
[setup.ts](../../packages/backend/src/websocket/setup.ts); origin policy permits
some native/no-origin connections. CORS alone does not prevent native access.

With authenticated production log access, the bounded follow-up is:

1. Search a defined retention window for Boardlordz/Prova origins, user agents and client identities; report the exact interval and coverage.
2. Check GraphQL HTTP and accepted/rejected WebSocket requests, correlating connection IDs and repeated unusual client patterns without exporting personal logbooks.
3. Compare server egress identity only with independently attributable infrastructure; a Fly.io IP or a copied Boardsesh identity alone is insufficient attribution.
4. Investigate suspicious callers before changing access policy. Do not deny all native clients or shared hosting ranges.

[LEGAL.md](../../LEGAL.md) separates the Apache-licensed code from permission to
use Boardsesh's hosted account/sync/realtime service. It also welcomes use of
public nightly catalogue snapshots. Static assets, snapshots and the hosted
authenticated backend are different dependencies; none should be conflated.

## Feature comparison

APK presence below means shipped client UI/logic and endpoint contracts were
observed. It does not prove a server feature works end to end. Boardsesh status
describes the comparison commit; rollout flags are identified where known.

| Feature | Boardlordz APK evidence | Boardsesh comparison |
| --- | --- | --- |
| Board browsing, grade/hold/setter filters, queues, ticks | Main bundled app and REST client | Existing core features. Boardsesh also has Woods support; Boardlordz includes Dungeon Trainer-specific code. Hardware operation was not tested. |
| Shared sessions and current climb | Session REST/WS code, current-item and reconnect state | Existing collaborative queues, presence and shared control. |
| Lists, profiles, follows, feed, external beta videos | Main app/API modules | Existing playlists, social feed, profiles, comments and beta links. |
| Rest, pyramids, 4×4 and limit training | Workout UI, plan types and timers | Existing staged generator and runner. Timed types are dev/tester-flagged in [workout-stages.md](../workout-stages.md). Boardlordz describes four distinct problems per 4×4 round; Boardsesh's documented version repeats one problem per set. This is a variant/rollout distinction. |
| Personal hold map compared with population | Board/Mine/Me vs board scopes, comparison endpoint and ratio presentation | Heatmaps and personal-progress filters already exist. Normalized differential comparison is a useful extension. |
| Hand-by-hand drawn beta | L/R moves, matches, undo, crux index, sequence and submission endpoints | No equivalent structured move editor found. Existing beta is primarily linked video and comments. |
| Recurring leagues | Setter Rotation and Flash Comp, round windows, invite codes, standings, season restart | Missing multiweek league system; current session and kiosk leaderboards are not this feature. Handicap formula remains server-side and unknown. |
| Published ungraded projects | Project claim, hunter enrollment and claim/reopen/archive UI | First-ascent grading already exists. Hunter/dispute lifecycle is a narrower possible extension. |
| Similar climbs | Similar-problems endpoint | Existing indexed similarity online and offline; see [similar-climbs.md](../similar-climbs.md). Boardlordz's server algorithm is unknown. |
| Photo spray wall recognition and corner calibration | Wall photo/sweep upload, consent, detection and corner UI | Existing durable backend recognition and four-corner homography; see [spray-recognition-rollout.md](../spray-recognition-rollout.md) and [spray-walls.md](../spray-walls.md). |
| Describe a workout in prose | 1,000-character input and plan response `{spec, parser}` | New input method for the existing generator; parser internals are not recoverable from the APK. |
| Planner session handoff and results | Prøva connect/upcoming/start/finish endpoints | Generic OAuth/workout integration is [accepted design](../integration-platform.md), not built at this commit. Reuse that plan rather than create a bespoke partner API. |
| Offline catalogue/outbox and background board controls | Comparable durability was not established from this investigation | Boardsesh already has local catalogue downloads, mutation outbox and native background/lock-screen board control. Do not claim competitor parity without runtime tests. |

The Boardsesh absence check covered 3,797 TS/TSX/JSON/GraphQL source files under
mobile, backend, shared packages, shared schema and database schemas, excluding
tests, fixtures, generated output and catalogues. It found no corresponding
league, structured-beta-submission or natural-language-plan implementation.
This does not describe unpublished branches.

## Implementation backlog

These are independent implementation proposals, not copied source or exact
competitor behavior specifications. Estimates are subjective engineer-days for
one experienced developer, including meaningful testing. Their value ranking
has not been validated with climbers. No feature implementation is part of this
investigation.

| Priority | Valuable addition | Scope and acceptance criteria | Ownership | Estimate |
| --- | --- | --- | --- | --- |
| 1 | Find holds you underuse at your grades | Normalize personal versus board usage at fixed setup, angle and grade range. Highlight five underused holds; tapping one finds matching climbs. Show honest small-sample/empty states. First decide whether the population denominator is climbs or ascents. | Pure shared comparison logic; existing mobile heatmap; backend only if chosen baseline cannot be derived locally. | 4–6 days |
| 2 | Draw and replay your hand beta | Save L/R moves, matches and one crux at an angle. Support undo, edits, deletion, numbered playback and mirroring. Validate coordinates, ownership and visibility. Start with authored sequences; automatic solutions/consensus are additional work. | Backend submissions/moderation; focused pure shared move model; mobile editor/playback. | 8–12 days |
| 3 | Weekly gym or crew leagues | Invite by code, schedule rounds in an explicit timezone, rotate authorized setters, hide picks until opening, and derive auditable standings from eligible ticks. Retain past seasons. Design and test scoring rather than guessing Boardlordz's unknown formula. | Backend membership/scheduling/results; pure shared scoring; mobile joins/picks/standings. | 15–25 days |
| 4 | Describe and preview a workout | Parse grades, counts, warmup, rest and filters into the existing stage schema. Preview and correct before queue mutation. Bound parser output, surface ambiguity, and retain existing quality/fill safeguards. An LLM is optional, not established by competitor evidence. | Backend parser/provider; shared generator validation; mobile preview. | 5–8 days |
| 5 | Open planner sessions and return results | Deliver the existing generic OAuth/workout design. Require scoped consent, editable board selection, idempotent creation/results and working revocation. Third-party onboarding/cooperation is separate; do not depend on private Prøva endpoints. | Backend OAuth/public API; shared workout contract; mobile launch/run linkage. | 20–35 days plus onboarding |

Two optional experiments belong below that queue. Project hunting could add
enrollment and an auditable, single-winner first-ascent claim/dispute lifecycle
to existing ungraded projects (estimated 4–7 days). The current **website** also
has Daily Crux, a five-climb game where players place missing holds, with streaks
and gym/league scores out of 5,000. It is not a grade-guessing game and was absent
from the acquired APK's JavaScript and routes. A similar retention experiment
would need demand validation and an estimated 8–12 days.

Existing source references supporting the comparison include
[heatmap queries](../../packages/mobile/src/db/queries/get-hold-heatmap-local.ts),
[heatmap controls](../../packages/mobile/src/components/search/heatmap/HoldFilterHeatmapPanel.tsx),
[video beta](../../packages/mobile/src/components/AddBetaVideoSheet.tsx),
[session leaderboards](../../packages/mobile/src/components/session/SessionLeaderboard.tsx),
[project chips](../../packages/mobile/src/components/ProjectChip.tsx),
[spray climb rules](../../packages/mobile/src/components/create-climb/spray-climb-rules.ts),
[workout types](../../packages/shared/playlist-generator/src/types.ts),
[spray detection](../../packages/mobile/src/lib/spray/use-spray-detection.ts) and
[homography](../../packages/shared/spray-wall-geometry/src/homography.ts).
The earlier [Boardz quality-filter comparison](../workout-catalogue-depth.md)
concerns a separately named product and is not evidence that Boardz and Boardlordz
are the same application.

## Reproduce the static evidence

Preserve the three APKs as acquired; the density split is required by this Play
distribution, so the base is not a complete universal installation package.
The inspection does not require installing the APK or logging into Boardlordz.

```sh
vp exec python3 scripts/research/inspect-boardlordz-apk.py \
  .boardsesh/boardlordz-research/acquired/com.provatech.boardlordz-43.apk \
  --output .boardsesh/research/boardlordz/reproduced-base-scan.json
```

The scanner hashes the artifact and each regular member, checks ZIP CRCs,
inventories literal origins and searches the declared indicators in UTF-8 and
UTF-16LE. It never executes code or fetches embedded URLs. It also identifies
candidate Apache license members by four text markers; that heuristic alone
does not establish completeness. Repeat for each split;
signature verification is a separate operation and is not claimed by this script.

For semantic REA inspection, use pinned `rea-agents@6.7.0`, an existing supported
Node runtime, and select the API, BLE, main UI and About members listed in the
evidence ledger. Keep the complete returned JSON and its limitations. Do not
report static syntax as observed execution. No Android runtime, authenticated
feature flow, physical LED test, server-source review or production ingress audit
was completed in this investigation.
