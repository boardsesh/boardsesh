# Google Play Store Metadata - Boardsesh

> **Listing text is source-controlled in `fastlane/metadata/android/en-US/`** and
> pushed to Google Play by the `android metadata` lane (see `fastlane/Fastfile`
> and the `Mobile Store Metadata` workflow). Edit the `.txt` files there, not the
> prose below — the App Name, Short Description, Full Description, and What's New
> copy live in `title.txt`, `short_description.txt`, `full_description.txt`, and
> `changelogs/default.txt` respectively. The listing is localized: `en-US`
> (default), `es-ES`, and `fr-FR` each have their own folder under
> `fastlane/metadata/android/`, and `supply` uploads every locale folder it finds.
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
`commit_to_main = true`. It builds the screenshot APK, captures fresh shots on an
emulator, and commits them back to main via the OTA push app token — which
re-triggers `Mobile Store Metadata`, which uploads them. The nightly cron only
captures (uploads the artifact + posts a Discord preview); it never commits,
because the capture isn't byte-deterministic (relative timestamps, live feed
data) and auto-committing would churn the live listing daily.

**Specs:**

- Minimum 2, maximum 8 per device type (phone, 7-inch tablet, 10-inch tablet)
- JPEG or PNG, 16:9 or 9:16 aspect ratio
- Minimum 320px, maximum 3840px per side

**Screens to capture** (8 = the Play Store phone max; captured by `vp run mobile:screenshots --platform android`, in store display order):

1. `00-home` — activity feed, your crew's sessions
2. `01-climbs` — browse the board's climbs
3. `02-board-view` — a climb with the holds lit (the signature view)
4. `03-discover` — the playlist library
5. `04-workout-generator` — the Record tab's workout generator
6. `05-profile` — your stats and progression
7. `06-board-sheet` — the board switcher
8. `07-session-detail` — a session recap: stats, leaderboard, sends

(Party Mode, playlist detail, and the logbook are on the iOS 10-shot set but don't fit Android's 8-shot cap.)

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

1. Sign in with the demo account. You will see the board selection screen.
2. Browse climbs: Select "Kilter Board" and pick any layout/size/angle combination. You will see a searchable list of thousands of community climbs with grade ratings and quality stars.
3. Search and filter: Use the filter controls to narrow by grade range, minimum quality rating, and hold count.
4. View a climb: Tap any climb to see the hold layout rendered on the board image. Colored circles show hand and foot positions.
5. Queue management: Tap the "+" button on a climb to add it to your queue. Open the queue panel to see your list. Reorder by dragging, remove by swiping.
6. Bluetooth pairing: Go to the Bluetooth connection screen. The app will request Bluetooth permission and scan for nearby BLE devices. Without a physical board, the scan will complete with no devices found. This is expected.
7. Board history (board-linked): connect to a board and open its board feed. It shows the climb lit right now and recent sends on that wall — who lit each, grade, angle and setter. This is always on and tied to the board; you don't start a session for it.
8. Sessions (collaborative): start a session from the queue panel. This creates a WebSocket-backed shared session. Open a second browser or device, sign in with a different account, and join the same session to test real-time sync. Sessions are always live: any participant can set the next climb and it broadcasts to everyone instantly. There is no single "driver" and no voting step (the older driver/vote model is deprecated). Whoever is connected to the board over Bluetooth relays the lit climb to the wall. Ending a session produces a recap and updates the logbook/Progress tracking.
9. Logbook: Check the logbook/profile section to see logged climbs and stats.

## Data Safety Form

**Does your app collect or share any of the required user data types?** Yes

**Is all of the user data collected by your app encrypted in transit?** Yes

**Do you provide a way for users to request that their data is deleted?** Yes

### Data Collected

| Data type                      | Collected | Shared | Purpose                            | Optional                     |
| ------------------------------ | --------- | ------ | ---------------------------------- | ---------------------------- |
| Email address                  | Yes       | No     | Account management                 | No (required for account)    |
| Name                           | Yes       | No     | App functionality, personalization | No (required for profile)    |
| Approximate location           | Yes       | No     | App functionality                  | Yes                          |
| Precise location               | Yes       | No     | App functionality                  | Yes                          |
| Health info - Fitness activity | Yes       | No     | App functionality                  | Yes                          |
| App interactions               | Yes       | No     | Analytics                          | No (collected automatically) |
| Crash logs                     | Yes       | No     | Analytics                          | No (collected automatically) |

### Data NOT Collected

- Financial info (no payments in app)
- Messages or chat content (Party Mode is queue-based, not chat)
- Photos, videos, or audio
- Files or documents
- Calendar or contacts
- Device identifiers for advertising
- Browsing history
