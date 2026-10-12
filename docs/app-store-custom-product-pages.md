# Board-specific App Store custom product pages

The four custom product pages (CPPs) are `kilter`, `tension`, `moonboard`, and
`spray`. Their source of truth is
[`app-stores/apple/custom-product-pages.json`](../app-stores/apple/custom-product-pages.json).
The manifest defines exact board configurations, the nine-image story, language
mapping, promotional text, desired search keywords, and screenshot display slots.
Caption copy lives in `app-stores/presentation/{en-US,es,fr,de}.json`.

## The nine-image story

The first image names compatibility: **Supports Kilter**, **Supports Tension**,
**Supports MoonBoard**, or **Supports spray walls**, showing three distinct boards
from that target family. Kilter Original is the centre phone in its opening trio.
The manufacturer pages add **Import your existing logbook.** Spray walls instead
say **Set climbs on your wall photos.**

The second image says **One app for all your boards** and **All your logbooks in
one place.**, showing three boards from other families. The regular Apple product
page also opens with **One app for all your boards**, using its existing mixed-board
phone trio and iPad first-screen layout. All captions are localized.

| Target | First-image trio | Second-image trio |
| --- | --- | --- |
| Kilter | Homewall 7×10, Original 12×12 (centre), Homewall 10×10 | Tension 2 Mirror, MoonBoard 2024, Woods 12×12 |
| Tension | Original, Tension 2 Mirror, Tension 2 Spray | Kilter Original 12×12, MoonBoard 2024, Woods 12×12 |
| MoonBoard | 2016, Masters 2019, 2024 | Kilter Original 12×12, Tension 2 Mirror, Woods 12×12 |
| Spray wall | Liz's Wall, Cherry's Wall, The Bowlo | Kilter Original 12×12, Tension 2 Mirror, MoonBoard 2024 |

Images three through nine show search/filtering, logbook, LED control, shared
queue, workouts, wall status, and Dynamic Island. For iPad, the ninth image uses
the wall kiosk. Spray walls instead show setting on the photo, saved playlists,
and hold editing in the LED, wall-status, and ninth slots; they have no LED claim.
The standalone **See your next move** image is absent from CPP recipes.

These pages make the alternative clear: keep projects, a crew queue, sessions,
and a logbook together when you climb on several boards. Copy describes
compatibility with manufacturers, without implying affiliation or endorsement.

## Genuine capture data comes first

The current default-listing campaign fixture contains seven board families; it
does not prove the three variants required by each CPP. No CPP fixture reference
is pinned until its actual recorded data has been verified. Missing coverage
must stop capture, rather than reuse the existing campaign or substitute boards.

Use the existing [record/replay workflow](mobile-screenshot-fixtures.md) to prepare
a recording account with the named configurations, useful target-specific climb
results, logged sessions, a shared queue, and workout content. A CPP fixture
manifest includes `capture.cpp.target`, board readiness text indexed by variant
ID, and scene identity/readiness for search, logbook, LED/setting, queue, workout,
status/playlist, and Island/kiosk/hold editor. Scene board IDs identify the target
board; the queue also supplies its actual recorded session ID. Readiness text
must identify real captured content. Do not invent records or readiness labels.

CPP recording verifies the authenticated owner, private session, and primary board
configuration before maintaining real upstream session membership. This makes a
dormant permanent session available to its native join preview. The recorder
relays only the known native join, queue, and roster documents for that verified
session. Tokens stay in memory. Full React Native replies supply the recorded
initial snapshots; smaller ActivityKit replies are relayed and later replayed
through strict projections of fields actually recorded in the full replies.
The existing default-listing recorder retains its inert WebSocket behavior.

Generated flows retain a separate Maestro command document. All 64 combinations
of target, app language, and device were validated with the pinned Maestro 2.6.1
parser before the native capture rerun.

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
discovery. Bootstrap verifies the persisted owner, board configuration, private
visibility, permanence, and durable lifecycle before joining; live presence alone
does not determine whether a saved session is reusable. An account/backend-bound checkpoint whose durable lifecycle is ended may receive
a fresh permanent replacement even when the old row is absent from recent
sessions; this does not claim ownership of that inaccessible row. An owned,
private, matching nonpermanent checkpoint session may also receive a permanent
replacement. Both IDs are tracked and the old record remains unchanged. Missing
active, foreign, public, or mismatched bindings stop before creating a replacement. Existing logbook entries are reused; a missing entry can be
seeded as one explicitly private example attempt. No send is invented. Cherry
and Bowlo can appear in the real new-climb editor before either wall has climbs.
The checkpoint is bound to the authenticated account and backend and cached for
resuming interrupted recognition or queue setup.

Liz's Wall reuses the existing owned Home Spray Wall with its UUID unchanged.
After ownership, private visibility, published photo provenance, and real holds
are verified, bootstrap applies the user-approved name-only rename to Liz's Wall.
It rereads the wall and catalogue labels and verifies unchanged published photo,
version, hold count, homography, and board configuration. Checkpoint-bound Cherry
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
