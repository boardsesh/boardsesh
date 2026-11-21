# Google Play Store Metadata - Boardsesh

> **Listing text is source-controlled in `fastlane/metadata/android/en-US/`** and
> pushed to Google Play by the `android metadata` lane (see `fastlane/Fastfile`
> and the `Mobile Store Metadata` workflow). Edit the `.txt` files there, not the
> prose below — the App Name, Short Description, Full Description, and What's New
> copy live in `title.txt`, `short_description.txt`, `full_description.txt`, and
> `changelogs/default.txt` respectively. The listing is localized: `en-US`
> (default), `es-ES`, `fr-FR`, `de-DE`, `it-IT`, and `zh-CN` each have their own folder under
> `fastlane/metadata/android/`, and `supply` uploads every locale folder it finds.
> The changelogs ride the AAB instead (`android-apk-rn.yml` stages every locale
> into `whatsnew-<locale>`), because the `android metadata` lane runs with
> `skip_upload_changelogs`. Italian listing text and release notes use `it-IT`;
> Simplified Chinese uses `zh-CN`, including the 2.8.0 release notes;
> the Android screenshot capture remains the existing English phone set.
> This doc keeps the operational material that `supply` can't upload: the
> feature-graphic brief, testing instructions, data-safety form, and the
> screenshot map.

## Basic Info

| Field              | Value                         |
| ------------------ | ----------------------------- |
| App Name           | Boardsesh                     |
| Package Name       | com.boardsesh.app             |
| Category           | Health & Fitness              |
| Tags               | Sports, Fitness               |
| Content Rating     | Everyone (IARC)               |
| Pricing            | Free                          |
| Contains Ads       | No                            |
| In-app Purchases   | No                            |
| Contact Email      | sales@boardsesh.com           |
| Support URL        | https://boardsesh.com         |
| Privacy Policy URL | https://boardsesh.com/privacy |

## Short Description

Canonical: [`fastlane/metadata/android/en-US/short_description.txt`](../../fastlane/metadata/android/en-US/short_description.txt) (Play limit: 80 characters). App Name lives in [`title.txt`](../../fastlane/metadata/android/en-US/title.txt) (Play limit: 30 characters).

## Full Description

Canonical: [`fastlane/metadata/android/en-US/full_description.txt`](../../fastlane/metadata/android/en-US/full_description.txt) (Play limit: 4000 characters).

## Listing images

Source-controlled under `fastlane/metadata/android/en-US/images/` and pushed by
the `android images` lane (see `fastlane/Fastfile` and the `Mobile Store Metadata`
workflow), so the Play store listing icon is updated from code, not the Play
Console UI.

- `icon.png` (512x512, 32-bit PNG, under 1MB): committed, resized from `packages/mobile/assets/icon.png`.
- `featureGraphic.png` (1024x500, no transparency): committed, the app logo (`packages/mobile/assets/adaptive-icon.png`) centered on a #0A0A0A background. A clean stopgap; swap in a designed banner (brief below) when one is ready.

The lane only uploads images that exist locally and never deletes a remote one,
so swapping either file and re-running is all it takes to update the listing.

**Feature graphic design brief:** show the Boardsesh logo/wordmark centered on a dark background (#0A0A0A or similar). Optionally include a faded image of a climbing wall or lit-up board holds behind the logo. Keep text minimal: the app name and a short tagline at most (e.g. "Light up your board"). Avoid screenshots in the feature graphic. Use high contrast so the logo reads well at small sizes in the Play Store browse view.

## Screenshots

**Source of truth: `app-stores/google/screenshots/pixel-2/*.png`** (committed, like the
listing text and icon). The `android screenshots` lane uploads them, and the
`Mobile Store Metadata` workflow runs that lane whenever the committed set changes
on main (it's in the workflow's `paths`). `sync_image_upload: true` means an
unchanged set is a no-op, so a text-only listing edit doesn't re-submit them.

**Refreshing them:** dispatch `mobile-screenshots-android.yml` with
`commit_to_main = true`. It loads the screenshot bundle through Metro in the
Android dev-client, captures fresh shots on an emulator, and commits the framed
images back to main via the OTA push app token — which
re-triggers `Mobile Store Metadata`, which uploads them. The nightly cron only
captures (uploads the artifact + posts a Discord preview); it never commits or
changes the live listing. Replay uses the frozen fixture snapshot pinned in
`app-stores/screenshot-fixtures.json`.

**Specs:**

- Minimum 2, maximum 8 per device type (phone, 7-inch tablet, 10-inch tablet)
- JPEG or PNG, 16:9 or 9:16 aspect ratio
- Minimum 320px, maximum 3840px per side

**Campaign outputs** (eight framed PNGs, in store display order):

| Output | What the image shows |
| --- | --- |
| `00-board-family.png` | Compatibility with Tension, Kilter, and MoonBoard 2016. |
| `01-more-boards.png` | Compatibility with Woods Board, Grasshopper, and MoonBoard 2024. |
| `02-live-queue.png` | A shared queue with climbs added by the crew. |
| `03-wall-status.png` | The live wall-status capsule shows the lit climb while a different climb is selected locally. |
| `04-climbs.png` | Browsing the board's climbs. |
| `05-discover.png` | The playlist library. |
| `06-workout-generator.png` | The Record tab's workout generator. |
| `07-profile.png` | One climbing history across boards, with the activity calendar and board-share donut. |

Run `vp run mobile:screenshots -- --platform android --dev-client --fixtures replay`
with the six-board shared-session fixture bundle to produce this set. Maestro
captures fourteen raw PNGs: the original eight app surfaces, four additional board
views, wall status, and the shared queue. The wall-status capture happens before
joining the crew, while the local selection differs from the climb currently lit
on the wall. Presentation recipes combine real board captures into the first two
frames and select eight uploadable PNGs. The raw Home and board-activity captures
remain available without taking a slot in this listing set. The full raw set stays
separate from the framed listing images.

Legacy fixture bundles without shared-session metadata keep their original
eight-image presentation: separate Tension and Kilter frames followed by Home
and the other five surfaces. Two/three-board scenarios still produce ten/eleven
raw inputs with a single compatibility frame and `02-wall-status.png`. Earlier
eleven/twelve-source campaigns also remain readable, with their board-view and
participant composite named `02-live-climb.png`.
The [campaign fixture contract](../../docs/qa/mobile-screenshot-fixtures.md#routes)
describes the recorded state required by the extended flow.

The board is drawn with **Aura**, the default isolated-story renderer.
The workflow's `render_mode` reaches `StoryRoot.tsx` through each story URL;
story IDs select matching board fixtures. `boards` selectors apply to live
integration setup, whose defaults live in `src/dev/integration/config.ts`.
A missing story or failed asset readiness stops the capture.

## What's New

Canonical: [`fastlane/metadata/android/en-US/changelogs/default.txt`](../../fastlane/metadata/android/en-US/changelogs/default.txt). Ships with the AAB at release time — `android-apk-rn.yml` stages it as the release's `whatsNewDirectory` (Play limit: 500 characters). Update it on every release.

## Publishing pipeline & the review gate

The `Mobile Store Metadata` workflow pushes the full Android listing — text
(`android metadata`), icon + feature graphic (`android images`), and screenshots
(`android screenshots`) — to Google Play whenever the committed assets change on
main.

**Why a green run used to leave the listing stale.** `supply` commits a
listing-only edit (no AAB) with `changes_not_sent_for_review: false`, i.e. "send
these for review". Google rejects that on a listing-only edit with _"Please set
the query parameter changesNotSentForReview to true"_. fastlane's default
`rescue_changes_not_sent_for_review: true` silently catches that, re-commits with
`changesNotSentForReview=true`, and prints "Successfully finished the upload" — so
CI was green while the changes sat in the Play Console as **"changes ready to send
for review"** and never published. The lanes now set
`rescue_changes_not_sent_for_review: false`, so that case fails the workflow
loudly instead of faking success.

**Managed publishing must stay OFF.** With it off, changes that are sent for
review auto-publish once review passes. If someone turns managed publishing on,
every API-committed change queues under _Publishing overview → changes ready to
publish_ and waits for a manual "Publish" — the listing will look stale again
even though CI is green.

**Multiple production releases.** supply resolves a single release in the
production track before it uploads the (app-global) listing, and aborts with
_"More than one release found in this track. Please specify with the :version_code
option"_ when the track holds more than one — e.g. a new release in review next to
the live one, or a staged/halted rollout. The lanes handle this by pinning
`version_code` to the highest production version code
(`play_production_version_code` in the Fastfile); the listing applies app-wide
regardless of which release is selected, and changelogs stay skipped so the
release itself is untouched.

**If the listing stops updating:** check the Play Console _Publishing overview_
first. A backlog of "ready to send for review" / "ready to publish" means a
review/publishing gate, not a broken upload — the workflow logs will show
"Successfully finished the upload to Google Play". A red workflow with the
`changesNotSentForReview` error means Google won't auto-review a listing-only
edit and the changes must be sent for review from the Console (or bundled with a
release).

## Testing Instructions

Internal reference for QA and closed testing tracks. Not a Play Store field.

**Two distinct features (don't conflate them):**

- **Board history (board-linked, always on):** tied to a physical board. A live feed of what is lit on that wall right now plus recent sends — who lit each climb, the grade, angle and setter. Ambient; nothing to start.
- **Sessions (collaborative):** you and your crew start a session and share one queue any participant can drive (no single driver, no voting). It is your crew's workout/sesh and ends with a recap and tracking.

**Demo Account**

- Email: test@boardsesh.com
- Password: test

**Testing steps:**

1. Sign in with the demo account and choose a board. Browse Climbs, try the grade
   filters and Kilter's Verified filter, then open a climb to see its holds.
2. Add climbs to the queue. Open Session and preview a 4x4, Limit Bouldering or
   On the Minute workout. Pyramid also offers Same climbs down.
3. Open Home and Customize Home. Weekly climbing, recommendations and projects
   depend on the account's history. Discover includes My climbs.
4. With a compatible Bluetooth board connected, light a climb and lock the
   phone. The ongoing card shows the climb's colours, bulb and Next controls;
   timed driving adds a remaining-time ring. Without hardware, an empty
   Bluetooth scan is expected.
5. Open Settings > Timers to inspect countdown buzz and Lock Screen countdown
   preferences.

**Optional shared-session test:** on the first device, open Session and tap
Start. Open Invite and share its link. On a second device, sign in with a
different account and open that link in Boardsesh. Both participants can use
the queue. End the session to see its recap. Skip this exercise if a second
device and account are unavailable; the single-device checks above still work.

**Spraywall lighting in 2.8.0**

Spraywalls still work without LEDs using highlighted holds on a photo. Optional
WLED lighting needs a configured controller on the same Wi-Fi network. LED
settings map holds to LEDs, discover WLED on Wi-Fi and save brightness and a
Wi-Fi automatic switch-off time. The saved setup is shared with climbers who can
access the Spraywall. Compatible controllers with Boardsesh Bluetooth support
can also light climbs over Bluetooth. Installing that support is a separate
opt-in beta for matching hardware and requires explicit consent. Automatic
switch-off is currently Wi-Fi-only.

Nearby-board discovery needs location permission; manual board selection remains
available. Settings > Timers controls countdown buzz and Lock Screen rest
countdowns.

## Data Safety Form

This is a source-backed submission inventory for 2.8.0, not a readback of the
live Play Console answers. Reconcile it with the selected binary, SDKs and all
versions still covered by the form before submission. Fastlane listing uploads
do not update Data safety answers.

**Does the app collect user data?** Yes. Account deletion is available in the
app. Verify the console's deletion URL and encryption-in-transit answer against
the enabled collection paths, including SDKs.

### Collection inventory

The control column describes each path. Rows sharing a Play data type must be
considered together when choosing that type's required/optional answer.

| Data type | Purpose and collection path | User control |
| --- | --- | --- |
| Email address, Name, User IDs | Account management, profile display and ownership of saved content | Provided or created when using an account |
| Approximate/Precise location | Nearby board/session discovery | Location permission; include any SDK-derived coarse location in the final inventory |
| Health and fitness: Fitness info | Sends, attempts, grades, sessions and workout results | Optional logging and workout use |
| Photos | Avatars, gym images, Spraywall photos and feedback screenshots | Optional upload; photo visibility depends on the surface |
| Other user-generated content | Climb/session comments, notes and user-created climbing content | Optional submission |
| App interactions: product analytics | PostHog product events linked to the signed-in account | Analytics setting; Allow in prompt regions, with opt-out region defaults elsewhere. Replay has a separate opt-in. |
| App interactions: daily activity | First-party account/platform activity records for service usage counts | Independent of the Analytics setting; only aggregate counts are exported |
| Crash logs and Diagnostics | Sentry crash/performance reports, Observe and OTA reliability signals | Independent of the Analytics setting; Sentry redacts identity, while Observe/OTA retain installation/session identifiers |
| Device or other IDs | PostHog identifiers and functional installation/session identifiers | Product-analytics identifiers follow its setting; functional identifiers do not |
| Install attribution | Play install-referrer measurement and associated analytics | Explicit Allow required everywhere; a regional analytics default is insufficient |

Do not mark all App interactions optional just because PostHog product capture
has an opt-out: the first-party daily activity path continues. Likewise,
installation identifiers are distinct from advertising identifiers. Map the
actual SDK/attribution fields to the console's data types rather than declaring
all identifiers absent.

### Sharing and final console reconciliation

Public profiles, photos and comments have user-facing audiences. Connected
training apps receive only the data the climber authorizes; logbook access and
workout handoff are part of 2.8.0. Check each transfer against
[Google's sharing definitions and exceptions](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en),
including service-provider processing and user-initiated transfers. The old
blanket “Shared: No” column is not a verified assessment of these paths.

Use the same guidance for required/optional answers across the versions covered
by the form. Uploads are collection even when optional. Do not carry forward
the old photo/comment exclusions, or infer that video, audio or documents are
absent without completing that part of the feature/SDK inventory.

Evidence: [media storage](../../docs/operations/user-media-storage.md),
[analytics choices and telemetry paths](../../docs/analytics/analytics-consent.md),
[native PostHog identity](../../packages/mobile/src/lib/posthog-client.ts),
[Sentry privacy handling](../../packages/mobile/src/lib/sentry.ts),
[stored comments](../../packages/backend/src/graphql/resolvers/social/comments.ts),
and [integration data boundaries](../../docs/integrations/integration-platform.md).
