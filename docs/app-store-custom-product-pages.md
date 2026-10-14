# Board-specific App Store custom product pages

The four custom product pages (CPPs) are `kilter`, `tension`, `moonboard`, and
`spray`. Their source of truth is
[`app-stores/apple/custom-product-pages.json`](../app-stores/apple/custom-product-pages.json).
The manifest defines exact board configurations, the nine-image story, language
mapping, promotional text, desired search keywords, and screenshot display slots.
Caption copy lives in `app-stores/presentation/{en-US,es,fr,de}.json`.

## The nine-image story

Every CPP opens with two real board trios, in this order:

1. **Supports Kilter**, **Supports Tension**, **Supports MoonBoard**, or
   **Supports spray walls**, showing three configurations of that target.
   Kilter and Tension say **We can also import your existing logbook for you**.
   MoonBoard adds **from a CSV export**. Spray walls make no import claim.
2. **One app for all your boards**, with **All your logbooks in one place**,
   showing three other popular board families. The target family is excluded.

| Target | First trio, in source order | Second trio, in source order |
| --- | --- | --- |
| Kilter | Homewall 7×10, Original 12×12 (centre), Homewall 10×10 | Tension Board 2 Mirror, MoonBoard 2024, Woods 12×12 |
| Tension | Original, Tension Board 2 Mirror, Tension Board 2 Spray | Kilter Original 12×12, MoonBoard 2024, Woods 12×12 |
| MoonBoard | 2016, Masters 2019, 2024 | Kilter Original 12×12, Tension Board 2 Mirror, Woods 12×12 |
| Spray wall | Liz's Wall, Cherry's Wall, The Bowlo | Kilter Original 12×12, Tension Board 2 Mirror, MoonBoard 2024 |

The remaining seven feature screenshots retain their existing relative order,
native source captures, and style. They cover discovery/filtering, logbook,
queue, workout, wall status and Dynamic Island (iPad kiosk), or spray setting,
projects and hold review. The standalone **See your next move** image is absent.
All nine outputs and promotional text are localized. The complete raw capture
contract remains 13 scenes even when a presentation omits a source.

The owner confirmed that Kilter account linking is permanently enabled. Legacy
Aurora export import also remains available. Tension import is available without
that flag; MoonBoard copy specifically qualifies its CSV export. Spray walls
never promise logbook imports. The regular Apple page retains **One app for all
your boards** and **One logbook for every board**.

Pricing appears only in promotional text: free, no ads, no paid upgrades. Hold
suggestions require review; workout copy promises a plan. Benchmark-specific
MoonBoard headlines, a mirrored Tension climb, Lock Screen, and shortcut claims
need their own genuine native captures before use. Public metadata describes
compatibility without manufacturer affiliation or endorsement.

## Genuine capture data comes first

The catalogue count can change after bootstrap. Recording derives the grade-filter
count from the actual recorded response to the exact native query and variables,
then waits for that literal localized count and the selected grade controls. Its
response key, hashes, timestamp and count proof stay with the recording, raw
capture and prepared candidate. Replay verifies that immutable proof and waits
for its fixed count. A changed count for the same query within one recording
fails capture; other queries retain the existing first-response rule. When
shards disagree, `--on-conflict newest` derives only the count and its proof from
the genuine winning response. Every other capture and provenance field must
still agree.

The current default-listing campaign fixture contains seven board families; it
does not prove the three variants required by each CPP. No CPP fixture reference
is pinned until its actual recorded data has been verified. Missing coverage
must stop capture, rather than reuse the existing campaign or substitute boards.

Use the existing [record/replay workflow](mobile-screenshot-fixtures.md) to prepare
a recording account with the named configurations, useful target-specific climb
results, logged sessions, a shared queue, and workout content. A CPP fixture
manifest includes `capture.cpp.target`, board readiness text indexed by variant
ID, `boardNames` with the six genuine UUID/config-matched roster names, and scene
identity/readiness for search, logbook, LED/setting, queue, workout,
status/playlist, and Island/kiosk/hold editor. Scene board IDs identify the target
board; the queue also supplies its actual recorded session ID. The logbook scene
also requires `ascentId`: the genuine displayed row UUID selected from the first
native family page using the shared grouped-logbook representative rules. A
newer attempt can group under an older send or flash, so copying the first raw
ascent UUID is insufficient. Capture verifies the exact entry and localized
row label, using at most five scrolls within the recorded first page if needed.
Readiness text must identify real captured content. Do not invent records or
readiness labels.

New recordings also store `heroClimbs`, selecting actual climb IDs from at most
ten results for each exact board configuration. Trio titles differ and grades
vary where the real results permit; Kilter excludes the misleading “Moon Landing”
title. Native navigation opens the requested loaded row through the normal climb
action, with no first-row fallback. Capture uses the device’s real V-grade
preference, with personal and Boardsesh grades disabled, and waits for those
preferences to settle. Existing candidates without this optional contract keep
their original navigation.

Explicit hero capture waits for the current board's saved search to restore,
then clears actual filters, committed search text and any pending name debounce.
It waits for genuine default-query results before resolving the requested ID.
Returning to that hero starts a new reset; ordinary rerenders do not.

The selected-pane marker identifies the owned board and rendered climb only after
both current board-art layers have displayed. Hidden tabs, stale image events and
opening-art bridges cannot satisfy it. Tension’s new mirror capture additionally
requires a genuine local or preview view before using the normal Mirror action,
then verifies the mirrored artwork and restores the original orientation.

New search captures reset through the real header action, then use the
`search-grade` navigation command to apply a range through the existing live
filter action. Native setup validates both IDs against loaded GetGrades and the
current exact board configuration, and clears restored search text through the
existing clear action before applying the range. Capture requires the actual selected
GradeRail endpoints and genuine API count. It then clears through header Reset
and closes through leading Close before navigation. Trailing Reset must never
be treated as Apply; Maestro hierarchy existence does not prove an offscreen
chip can be tapped.

UIKit exposes the filter header, column and grade chips as accessibility peers.
Capture matches the real Reset ID, localized label and enabled state, selected
grade labels, and exact count without imposing a nonexistent parent relation.
After Reset, its disabled state proves that grade bounds, board filters and name
are cleared; the offscreen Any chip is not a usable native readiness gate.

The dedicated recording account uses the display name Liz. Bootstrap changes only
that authenticated owner’s display name and generated private QA board names,
then rereads ownership, configuration, privacy and avatar state. UUIDs, photos,
climbs, ascents and third-party setter names remain intact.

Existing public catalogue boards retain their visibility and metadata. Bootstrap
selects an editable private configuration or creates a separate private QA board
with the exact same catalogue configuration. Duplicate-config creation is allowed
only when the authenticated owner already has a verified public source; its UUID
is retained in checkpoint provenance. A previously checkpointed public source can
migrate to that private QA copy. An explicit public, foreign, mismatched or
permission-unknown UUID binding stops before setup writes.
A pending new QA row must pass fresh name, private-visibility and editability
checks on retry; it cannot be reclassified as an older public source.

Manufacturer status scenes also require `climbId`, copied unchanged from the
actual first primary-board climb. Both canonical UUIDs and Aurora's compact
32-character hexadecimal identifiers are accepted, preserving their casing.
The iPad's visible wall hero is checked against that climb and the actual owned
board configuration. Its loaded-list gate also waits for the requested board's
search results, rather than accepting a repeated title from a previous board.

Capture order differs from the exported story. Workouts and wall status are
captured before joining the genuine crew queue: joining changes the Session tab,
and the wall-status capsule appears only when the lit climb differs from the
selected climb. The manufacturer status gate checks the phone capsule's complete
localized accessibility label, or the iPad's dedicated wall-status panel, on the
Climbs screen; an ordinary climb-list row cannot satisfy it. Queue capture then
precedes logbook and LED capture so their selected climb belongs to the target
board. The exported recipe order is independent of this navigation order.

Before each tablet capture, the flow closes UIKit's floating sidebar only when
its exact `ToggleSidebar` control says `Hide Sidebar`. It waits for that open
state to disappear and for animations to settle; a hidden sidebar is never
toggled open. Fresh replay images must verify the final pane layout.

For manufacturer hero scenes in tablet recording, the flow can tap the native
list's localized “Try again” after its genuine error placard appears. It requires
the scene acknowledgment and exact owned-board header, scopes both controls to
the real `climb-list` ancestor, and makes at most three retry attempts while
waiting for the selected climb's physical paint marker. The strict title, grade,
owned-results list, header, row, overlay and final paint gates still follow.
Replay, phones and spray editors retain their existing hero gates. A successful
recorded response alone does not prove that the native client loaded that query.

The retry's 30-second paint wait runs only after tapping a genuine list error's
Retry control. A normal load with no error placard proceeds to the existing
90-second title and physical-paint gates.

Capture-only route acknowledgment diagnostics retain the exact pathname and
requested-parameter checks. Logs include sequence, fixed/redacted path names,
known mismatched capture-key names, HTTP status, and fixed request-error
categories. They never include parameter values, dynamic identifiers, URLs,
tokens, or arbitrary exception details. A visible destination alone cannot
replace a successful route acknowledgment.

CPP recording verifies the authenticated owner, private session, and primary board
configuration before maintaining real upstream session membership. This makes a
dormant permanent session available to its native join preview. The recorder
relays only the known native join, queue, and roster documents for that verified
session. Tokens stay in memory. Full React Native replies supply the recorded
initial snapshots; smaller ActivityKit replies are relayed and later replayed
through strict projections of fields actually recorded in the full replies.
The existing default-listing recorder retains its inert WebSocket behavior.

The owner check and session transport log fixed stage and predicate labels, so
an ownership mismatch can be distinguished from a fetch or presence failure.
Owner HTTP diagnostics retain only phase, elapsed time, status and allowlisted
network codes. They omit account/session IDs, variables, response bodies, tokens,
URLs and exception messages. Diagnostics do not change validation, timeouts,
retries or which genuine responses may enter the recording.

Generated flows retain a separate Maestro command document. All 64 combinations
of target, app language, and device were validated with the pinned Maestro 2.6.1
parser before the native capture rerun.

Spray's Status scene opens Projects, whose native climb rows group the name,
author, status and grade into one accessibility label. Its required gate matches
the exact `climb-row` ID and the selected climb's escaped name within that row,
using the same localized composite-row selector as other native climb lists.
The acknowledged route, actual board identity, accessory-climb checks and
90-second content deadline remain required. A visible row does not replace the
recorded Projects response or subsequent full replay and image review.

For the verified empty Cherry and Bowlo spray walls, iPad capture first enters
that wall's actual Climbs list through a distinct acknowledged scene. It checks
the real list and exact owned-board header, then taps the localized enabled
Create a climb control. The app's existing push opens the native editor modal;
replacing the stack root directly with the editor can leave the previous wall's
player beside it. The editor content remains required, and capture waits for
both the player overlay and board statistics pane to disappear. After the image,
the flow closes the editor through its real control and verifies dismissal before
the next scene. Phone and populated-wall navigation keep their existing routes.
The extra list queries need genuine recorded responses; native replay and image
review must still confirm all three correct wall photos and the final layout.

CPP shard retries retain their failure evidence in separate
`capture-debug/attempt-1/` and `capture-debug/attempt-2/` directories. Metro,
backend, native-process diagnostics and partial captures belong to that attempt;
the next invocation cannot overwrite them. CI uploads the existing diagnostic
artifact for 14 days even when a later attempt succeeds. The capture result,
two-attempt budget and content checks keep their existing behavior.

CPP Maestro runs use a separate process supervisor so an uncaught JVM main-thread
exception cannot strand the synchronous capture script. The supervisor fails the
attempt, terminates only its owned process group with a one-second SIGTERM grace
and SIGKILL fallback, and lets the existing diagnostics and fresh-boot retry run.
An independent 30-minute Maestro limit also fails the attempt. That limit does
not guarantee that two attempts, simulator startup, and diagnostics fit within
the shard's 65-minute job limit. Failed native diagnostic commands and the failure
screenshot each have a 15-second hard limit. Native content checks remain required.
CI also collects existing CPP failure files after cancellation, with a 15-second
limit on the additional simulator log query, so a later job timeout retains the
evidence already saved by an earlier failed attempt.

The original real spray-wall photographs are committed at
`app-stores/apple/cpp-source-photos/`: `lizfinal.JPG`, `cherry4.JPG`, and
`bowlo.jpg`. The CPP manifest records each original filename, byte count, and
SHA-256. The user supplied these photos for this campaign. Set up Liz, Cherry,
and Bowlo through the existing spray-wall photo and hold workflow, and record
the resulting native screens. Source photos alone do not constitute configured
walls or recorded fixtures. Bundle authorized photos using the existing
fixture-photo transport so replay does not rely on expiring private URLs.

Each target declares a pending reference at `app-stores/apple/cpp-fixtures/<target>.json`.
The files are created only after recording and verification; declaring their paths
does not attest that a dataset exists. Export a sanitized immutable snapshot,
publish its hash-named archive/reference, and verify full replay before saving
that target's checked JSON reference. It uses the existing `version`, `url`,
`sha256`, `bytes`, and `files` format. Follow the target-specific commands below;
the default publisher's upload mode always rewrites the shared Android pin.

The workflow can prepare the dedicated screenshot account automatically: choose
one `cpp_target`, `cpp_action=capture`, and `fixtures=record`, leaving `cpp_scenario`
empty. A single bootstrap runs before the native matrix. It uses real API calls
for private boards, original-photo uploads, hold recognition/publishing, and a
private permanent crew queue. Session creation uses `invite_only`,
`isPublic: false`, `discoverable: true`, and `isPermanent: true`: the current backend
stores permanence only through its discoverable-session path. The invite-only
resource policy and board-access checks keep this queue out of other users'
discovery. CPP queues use the actual private QA board's `/b/<slug>/<angle>` path:
a manufacturer configuration tuple cannot distinguish that row from an older
owned public board with the same layout. Bootstrap reads the real slug back and
verifies its exact UUID, owner, private visibility, and configuration. An implicit
legacy tuple checkpoint receives a fresh named private permanent session after
its original owner, privacy, and configuration are verified. Both session IDs
are tracked; the old session and public source board stay unchanged. A resumed
named-session checkpoint is reused, including after interrupted queue setup.
New scenarios also select a different drawable climb from the actual primary
board's first ten results for the solo accessory preview. Its raw climb UUID,
title, and displayed grade are recorded as `accessoryClimb`; the wall-status climb
stays unchanged. Bootstrap stops if those results have no suitable different
climb. Older scenarios without this field keep their existing capture behavior.
On phones, the strict solo-head marker is attached to the existing visible
accessory row: UIKit can omit its central Apple Zoom link from the accessibility
tree. Only CPP captures group that row under its actual climb name; normal use
keeps the controls' individual accessibility. The marker still rejects retained
or shared-session content and requires the actual selected climb UUID.
On tablets, joining returns to the Session tab. Capture waits for that native
tab's selected state, then waits for and taps the existing localized unselected
Climbs tab, which UIKit also exposes with its sidebar collapsed. It verifies
Climbs is selected before issuing the queue command;
the exact route, sequence, private-session and content gates still apply.
Manufacturer tablet captures allow at most three taps of that enabled,
unselected native tab, checking its selection before each tap and settling for
up to ten seconds afterward. The final 90-second selected-state assertion stays
mandatory. Retained French Tension traces showed the unique correct target
remaining unselected after a completed tap, then succeeding unchanged on a fresh
attempt; the retry does not change the app or repair missing fixture assets.
Before each tablet frame, capture closes only the exact open-state Hide Sidebar
control. Up to three state-checked taps handle a native tap that finishes without
closing; each tap settles, and the final closed-state assertion still must pass.
Paint readiness requires genuine native display events for the current overlay
and every mounted background layer. Unchanged image instances retain their display
proof when capture metadata or additional background layers arrive; new layers,
removed and re-added instances, and visibility epochs require fresh display proof.
Screenshot wall readers also use the actual published owned-board UUID as their
scope. Switching capture boards starts a new local history from that board's
recorded climbs, so previous families do not remain in the status or kiosk list.
Bootstrap verifies the persisted owner, named board identity, configuration, private
visibility, permanence, and durable lifecycle before joining; live presence alone
does not determine whether a saved session is reusable. An account/backend-bound checkpoint whose durable lifecycle is ended may receive
a fresh permanent replacement even when the old row is absent from recent
sessions; this does not claim ownership of that inaccessible row. An owned,
private, matching nonpermanent checkpoint session may also receive a permanent
replacement. Both IDs are tracked and the old record remains unchanged. Missing
active, foreign, public, or mismatched bindings stop before creating a replacement. Existing logbook entries are reused; a missing entry can be
seeded as one explicitly private example attempt. Existing primary-board entries
without a guaranteed displayed representative stop bootstrap before example
attempt creation. A resumed demo attempt keeps its checkpointed UUID and uses
the backend’s idempotent tick operation. No send is invented. Cherry and Bowlo
can appear in the real new-climb editor before either wall has climbs.
The checkpoint is bound to the authenticated account and backend and cached for
resuming interrupted recognition or queue setup.
An interrupted photo publication resumes only the checkpointed draft after
rechecking ownership, original-photo bytes and actual detected holds. The publish
request sends the existing version ID, as required by the GraphQL input contract.

Liz's Wall reuses the existing owned Home Spray Wall with its UUID unchanged.
After ownership, private visibility, published photo provenance, and real holds
are verified, bootstrap applies the user-approved name-only rename to Liz's Wall.
It rereads the actual wall and social-board names and verifies unchanged published
photo, version, hold count, homography, and board configuration. Spray's optional
`UserBoard` layout/size labels are normally null; any returned non-null label must
match the requested name. Missing or malformed fields stop setup. This verifies
the API's native display names, not hidden catalogue-table labels. Ownership,
private visibility and editability are checked even when the names already match.
Checkpoint-bound Cherry
and Bowlo walls from earlier runs receive the same verified rename to Cherry's Wall
and The Bowlo; newly created walls use those names directly. The committed seed binding and
approved stored-photo SHA are checked against the live owner and downloaded bytes;
a changed photo stops the run. The original input hash remains separate from the
stored processed photo hash. Missing Cherry and Bowlo walls are added only after
bootstrap reads the current owner-only wall lifecycle list and verifies that all
required additions fit the ten-wall cap. Archived walls do not consume live-wall
slots; unfinished non-archived walls do. The account's wall count can change
between campaigns, so no fixed count is assumed. If the entire trio would exceed
the cap, bootstrap stops before creating any demo data and reports the current
count, missing walls, and required slots. It never deletes or repurposes an
existing wall automatically. Use another authorized screenshot account or obtain
explicit approval for changing an existing demo wall before retrying.

For local bootstrap, first set `SCREENSHOT_USER_EMAIL` and
`SCREENSHOT_USER_PASSWORD` to the dedicated test account, then run:

```bash
vp exec node --import tsx scripts/bootstrap-cpp-scenario.ts --target spray --apply --seed-demo-content --bindings app-stores/apple/cpp-seed-bindings.json --accepted-source-hashes app-stores/apple/cpp-seed-photo-hashes.json --accept-source-bindings --out .boardsesh/cpp/spray/scenario.json
```

Omit the binding/hash flags for manufacturer CPPs. Without `--apply`, bootstrap
reports prerequisites without changing backend state. Supply `cpp_scenario`
explicitly when using a previously verified real scenario instead.

Record one target with an account-specific scenario containing real board UUIDs,
selectors, session IDs, and native scene readiness. Supply complete
`readyTextByLocale` maps for translated screens without a climb or wall name.
The native scene navigation uses acknowledged commands, including on iPad.

```bash
vp run mobile:screenshots -- --platform ios --cpp spray --fixtures record --cpp-scenario .boardsesh/cpp/spray/scenario.json --theme dark --devices common --locales all
```

Record-mode exports are diagnostic and have no verified archive signature.
Before replay, bundle all authorized wall photos using
`prepare-ios-campaign-fixtures.ts <recording> <new-candidate> --walls <walls.json>`.
The wall list contains each `wallUuid`, `layoutId`, and its CPP `variantId`.
Preparation adds `boardPhotoAssets` with hashes of the actual downloaded backend
photo files; `boardPhotoSha256` separately records the approved original inputs.
These hashes may differ after normal photo processing. Private signatures expire
in fifteen minutes. Add `--refresh-photo-urls` to preparation when it runs later:
the helper authenticates the same screenshot account against the recorded backend,
reads fresh signatures for the same immutable R2 objects, and preserves every
recorded geometry/version field. It never replays mutations or substitutes photos.
The `--cpp` selector derives the three wall identities from genuine recorded
ownership and the capture scenario, or copies manufacturer recordings unchanged.

After a successful record matrix, CI merges the requested shards and prepares a
sanitized, hashed fixture-candidate archive artifact. This artifact is reviewable
and does not publish a pin. The `cpp-prepare-record` job requires every requested
shard and emits `cpp-fixture-candidate-<target>`, containing `<target>.json.gz` and
`<target>.digest.json`. A partial record matrix is diagnostic; successful archive
preparation alone does not prove full replay coverage.
For MoonBoard, preparation reads the existing native **Status → Attempts** page
through the authenticated recording proxy and requires its selected primary
ascent to remain unchanged. Original native records and their receipt stay
unfiltered and immutable. Only a prepared candidate with this exact genuine
response may drive the native menu interaction during replay; the final ascent
UUID/text visibility gate stays mandatory. See the
[bounded preparation contract](mobile-screenshot-fixtures.md) before reusing a
retained record. A full replay and image review still determine whether the
logbook frame is suitable for the CSV-import caption.


Spray CPP replay requires three distinct bundled wall images and validates every
asset before launching.

The iOS workflow dispatch accepts `cpp_target` and `cpp_action` (`plan`,
`capture`, `upload`, or `submit`). A plan produces a read-only discovery artifact;
capture produces review artifacts. Upload and submit require full replay coverage,
serialize with the other store writers, and use the existing Production environment.
That environment permits `main` and `release/next`; App Store operations on a feature
branch are blocked by its deployment policy.

## Prepare, publish, and verify one target

Keep the shared Android and default Apple campaign pins unchanged. Do not run
`mobile:screenshot-fixtures-publish` without `--archive` for a CPP: its upload
mode writes `app-stores/screenshot-fixtures.json`, and it has no target-reference
option. The steps below add immutable fixture assets to the existing
`screenshots-baseline` prerelease; they do not replace its baseline manifest or
screenshot ZIPs. Run the commands from the repository root.
Use one Bash shell for these blocks so their variables persist. Start with
`set -euo pipefail`, as shown in both preparation alternatives, so a failed
new-directory or filename guard stops subsequent commands.

1. Download the prepared artifact from a successful record run. Set the target
   and actual run ID; `CPP_EXPORT` must be a new directory.

   ```bash
   set -euo pipefail
   CPP_TARGET=kilter
   CPP_RUN_ID='<successful-record-run-id>'
   CPP_EXPORT=".boardsesh/cpp/$CPP_TARGET/candidate-$CPP_RUN_ID"
   test ! -e "$CPP_EXPORT"
   gh run download "$CPP_RUN_ID" --repo boardsesh/boardsesh \
     --name "cpp-fixture-candidate-$CPP_TARGET" --dir "$CPP_EXPORT"
   ```

   For a local recording, use a new prepared directory and export instead:

   ```bash
   set -euo pipefail
   CPP_TARGET=kilter
   CPP_EXPORT=.boardsesh/cpp/kilter/candidate-new
   test ! -e "$CPP_EXPORT"
   vp exec node --import tsx scripts/prepare-ios-campaign-fixtures.ts \
     .boardsesh/cpp/kilter/recording .boardsesh/cpp/kilter/prepared-new \
     --cpp --refresh-photo-urls
   vp run mobile:screenshot-fixtures-pseudonymise -- \
     --dir .boardsesh/cpp/kilter/prepared-new --check
   mkdir -p "$CPP_EXPORT"
   (set -C; vp exec node --import tsx scripts/screenshot-fixtures-publish.ts \
     --archive "$CPP_EXPORT/$CPP_TARGET.json.gz" \
     .boardsesh/cpp/kilter/prepared-new > "$CPP_EXPORT/$CPP_TARGET.digest.json")
   ```

   Substitute the same target's directories for other pages. Spray signature
   refresh uses `SCREENSHOT_USER_EMAIL`/`SCREENSHOT_USER_PASSWORD` and a
   `SCREENSHOT_UPSTREAM` matching the recording. `--cpp` derives authorized walls
   from the real recorded roster/scenario; manufacturer candidates are copied
   unchanged. The archive exporter refuses to replace an existing archive.

2. Name the archive/reference by its digest. The reference points to the archive,
   not to another reference. Use fresh local filenames; preserve existing assets.

   ```bash
   CPP_SHA=$(jq -r .sha256 "$CPP_EXPORT/$CPP_TARGET.digest.json")
   CPP_ARCHIVE_NAME="cpp-fixtures-$CPP_TARGET-$CPP_SHA.json.gz"
   CPP_REFERENCE_NAME="cpp-fixtures-$CPP_TARGET-$CPP_SHA.json"
   CPP_REFERENCE_URL="https://github.com/boardsesh/boardsesh/releases/download/screenshots-baseline/$CPP_REFERENCE_NAME"
   test ! -e "$CPP_EXPORT/$CPP_ARCHIVE_NAME"
   test ! -e "$CPP_EXPORT/$CPP_REFERENCE_NAME"
   cp -n "$CPP_EXPORT/$CPP_TARGET.json.gz" "$CPP_EXPORT/$CPP_ARCHIVE_NAME"
   (set -C; jq --arg url "https://github.com/boardsesh/boardsesh/releases/download/screenshots-baseline/$CPP_ARCHIVE_NAME" \
     '{version: 1, url: $url, sha256, bytes, files}' \
     "$CPP_EXPORT/$CPP_TARGET.digest.json" > "$CPP_EXPORT/$CPP_REFERENCE_NAME")
   ```

3. Publish both new immutable assets. Omit `--clobber`; if either hash-named
   asset already exists, verify its bytes instead of replacing it.

   ```bash
   gh release upload screenshots-baseline --repo boardsesh/boardsesh \
     "$CPP_EXPORT/$CPP_ARCHIVE_NAME" "$CPP_EXPORT/$CPP_REFERENCE_NAME"
   vp run mobile:screenshot-fixtures-fetch -- \
     --reference "$CPP_EXPORT/verified-reference.json" \
     --reference-url "$CPP_REFERENCE_URL"
   ```

   Fetch verifies the public reference, archive checksum/size, file count,
   paths, and base64 decoding of the archived bytes. It installs only the
   explicit candidate reference here; neither default pin changes. Replay
   startup and the full native capture validate fixture semantics and coverage.

4. Replay the entire target with the candidate reference before committing a pin.
   Use the reviewed feature branch until merge, then `main`. The branch must
   contain the CPP workflow; the command below selects your current branch.

   ```bash
   CPP_CAPTURE_REF=$(git branch --show-current)
   test -n "$CPP_CAPTURE_REF"
   gh workflow run mobile-screenshots-ios.yml --repo boardsesh/boardsesh \
     --ref "$CPP_CAPTURE_REF" -f cpp_target="$CPP_TARGET" \
     -f cpp_action=capture -f fixtures=replay \
     -f fixture_snapshot="$CPP_REFERENCE_URL" -f locales='' \
     -f gate=full -f upload=false -f publish_baseline=false
   ```

   Empty workflow `locales` selects all four app languages and all four common
   devices (16 shards for this target). A candidate override is scoped to one
   target, so do not combine it with `cpp_target=all`. Keep `cpp_action=capture`:
   `upload=false` alone does not disable CPP upload/submit actions. Require every
   shard to pass and inspect the nine-image exports/contact sheets for all five
   storefront locales. Record-mode images cannot be uploaded.

5. After successful full replay and image review, install only the selected
   target's verified reference, then commit that JSON file.

   ```bash
   vp run mobile:screenshot-fixtures-fetch -- \
     --reference "app-stores/apple/cpp-fixtures/$CPP_TARGET.json" \
     --reference-url "$CPP_REFERENCE_URL"
   git diff -- "app-stores/apple/cpp-fixtures/$CPP_TARGET.json"
   ```

   Fetch preserves the previous target pin if verification fails. Review an
   intentional target-pin update; never copy it onto
   `app-stores/screenshot-fixtures.json` or `app-stores/apple/campaign-fixtures.json`.

## Capture and review

Run on macOS with Xcode simulators and the existing cached native dev client:

```bash
vp run mobile:screenshots -- --platform ios --cpp all --fixtures replay --theme dark --devices common --locales all
```

Replace `all` with one target to recapture that page. The common device matrix
contains iPhone 16 Pro Max, iPhone 16 Pro, iPad Pro 13-inch (M5), and iPad Pro
11-inch (M5). The four app languages produce five storefront locales: `en-US`,
`es-ES`, `es-MX`, `fr-FR`, and `de-DE`. CPP raw sources and framed exports are
isolated under `app-stores/apple/cpp/<target>/`, with the upload tree at
`screenshots/<app-store-locale>/<device>/`.

1. Inspect both trios: three distinct target variants, then three other families.
2. Inspect all nine images for the correct board, useful content, and readable localized copy.
3. Check the shared queue, LED/setting scene, and actual Island/kiosk/hold editor surface.
4. Review every full-resolution image and contact sheet; retain source hashes and presentation manifests.
5. Run the existing screenshot gates before upload; never publish record-mode diagnostic output.

## Fastlane upload and Apple review

Use the existing App Store Connect API credentials from
[the Fastlane setup](../fastlane/README.md). From `fastlane/`:

```bash
bundle exec fastlane ios cpp target:all action:plan
bundle exec fastlane ios cpp target:all action:upload
bundle exec fastlane ios cpp target:all action:submit
```

`plan` reads the account without changing Apple state and reports local asset gaps.
Its discovery artifact lists approved terms, eligible opaque keyword IDs, current
assignments, and page owners. Configure `ASC_CPP_KEYWORD_IDS_JSON` (or workflow
`cpp_keyword_ids`) with verified locale/term-to-ID mappings; the lane never guesses
IDs from response order or opaque encodings.
`upload` reconciles stable reference names, localized promotional text, ordered
screenshots, and keyword assignments. It reuses editable drafts, creates a new
version for an approved page when content changes, skips identical content, and
refuses to edit a version under review. `submit` uses the validated uploads in a
CPP-only review submission; it does not submit a binary or the default listing.
Default-listing uploads continue through the existing `ios screenshots` lane.

Desired keywords are Kilter/kilterboard, Tension, MoonBoard (plus `moon` in
English/French), and spray/wall (Spraywall/Spraywand in German). Apple only permits
eligible keywords from the latest approved app-version localization; committed
keyword files alone do not establish eligibility. Missing terms or assignments
to another CPP must fail preflight before mutation. Resolve those account states
before retrying. See [Apple's keyword assignment rules](https://developer.apple.com/help/app-store-connect/create-custom-product-pages/configure-multiple-product-page-versions/).

Organic keyword assignment does not guarantee search placement or ranking;
Apple's search algorithm determines whether a page appears. Submission also
does not imply approval. Record each CPP URL and current review state, and leave
page links enabled after submission. See
[Apple's CPP review process](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-a-custom-product-page/).
