# App Store Metadata - Boardsesh

> **Listing text is source-controlled in `fastlane/metadata/en-US/`** and pushed to
> App Store Connect by the `ios metadata` lane (see `fastlane/Fastfile` and the
> `Mobile Store Metadata` workflow). Edit the `.txt` files there, not the prose
> below — the App Name, Subtitle, Description, Keywords, Promotional Text, and
> What's New copy live in `name.txt`, `subtitle.txt`, `description.txt`,
> `keywords.txt`, `promotional_text.txt`, and `release_notes.txt` respectively.
> The listing is localized: `en-US` (default), `es-ES`, `es-MX`, `fr-FR`,
> `de-DE`, `it`, and `zh-Hans` each have their own folder under `fastlane/metadata/`.
> `deliver` uploads every locale folder it finds. There's one Spanish app translation but no
> universal App Store Spanish (unlike `en-US`, which covers every English
> storefront), so the same `es` copy serves both `es-ES` (Spain) and `es-MX`
> (Mexico/Latin America) — matching the two Spanish screenshot locales. German and
> French each map to a single storefront locale. Italian uses `it` on Apple
> and `it-IT` on Google Play. Simplified Chinese uses `zh-Hans` on Apple and
> `zh-CN` on Google Play. Its listing text and 2.8.0 release notes are included;
> Chinese screenshots use the separate capture-only workflow below.
>
> The "Languages" list Apple shows on the product page comes from the binary, not
> from these folders: `ios.infoPlist.CFBundleLocalizations` plus the `locales` map
> in `packages/mobile/app.config.ts`. Adding a listing locale without adding it
> there leaves the page claiming English only.
>
> **A brand-new locale needs no App Store Connect setup.** `deliver` activates the
> language on the editable version itself — adding `de-DE/` and merging was enough
> (`Activating version language de-DE...` in the 2026-08-03 run). What it does need
> is an _editable_ version to write onto: between releases there often isn't one, and
> the `ios metadata` lane skips cleanly and says so. Create the version in App Store
> Connect first, then dispatch.
>
> This doc keeps the operational material that `deliver` can't upload: review
> notes, privacy labels, and the screenshot map.

## Basic Info

| Field              | Value                                          |
| ------------------ | ---------------------------------------------- |
| App Name           | Boardsesh (name.txt)                           |
| Subtitle           | see subtitle.txt                               |
| Bundle ID          | com.boardsesh.app                              |
| Category           | Health & Fitness (primary), Sports (secondary) |
| Age Rating         | 4+                                             |
| Copyright          | 2024-2026 Boardsesh contributors               |
| Support URL        | https://boardsesh.com                          |
| Marketing URL      | https://boardsesh.com                          |
| Privacy Policy URL | https://boardsesh.com/privacy                  |

## Keywords

Canonical: [`fastlane/metadata/en-US/keywords.txt`](../../fastlane/metadata/en-US/keywords.txt) (App Store limit: 100 characters, comma-separated, no spaces after commas).

## Description

Canonical: [`fastlane/metadata/en-US/description.txt`](../../fastlane/metadata/en-US/description.txt). App Name and Subtitle live in [`name.txt`](../../fastlane/metadata/en-US/name.txt) and [`subtitle.txt`](../../fastlane/metadata/en-US/subtitle.txt).

## What's New

Canonical: [`fastlane/metadata/en-US/release_notes.txt`](../../fastlane/metadata/en-US/release_notes.txt) — the "What's New in This Version" text. Update it on every release before running the `ios metadata` lane.

## Screenshots

The native capture and framing pipeline produces iPhone portrait and iPad
landscape screenshots. `--devices common --locales all` covers iPhone 16 Pro Max,
iPhone 16 Pro, and the 13-inch and 11-inch iPads in five app languages
(`en-US`, `es`, `fr`, `de`, `it`). Spanish is copied to both Apple Spanish locales;
Italian writes the `it` folder. The default listing has 20 capture shards,
24 storefront sets and 180 images. iPhone and iPad carry different stories.

### iPhone — nine-image campaign

The default iOS replay capture uses 18 native sources and composes
these nine outputs. Filename prefixes set the store display order:

| Output                  | Headline / benefit               | Native content                                                       |
| ----------------------- | -------------------------------- | -------------------------------------------------------------------- |
| `00-your-boards.png`    | Your boards. One app.            | Kilter, spray wall in the center foreground, and MoonBoard.          |
| `01-spray-wall.png`     | Your spray wall, too.            | The real wall photo on a light marketing background.                |
| `02-more-boards.png`    | More boards. Same app.           | Woods, Decoy and Grasshopper; copy also names Touchstone and So iLL. |
| `03-your-crew.png`      | Your crew. One queue.            | The shared queue and contributor avatars.                            |
| `04-on-the-wall.png`    | See what's on the wall.          | Current wall status while browsing another climb.                    |
| `05-one-logbook.png`    | All your boards. One logbook.    | Native logbook entries from several boards.                          |
| `06-session-plan.png`   | Give your session a plan.        | The native workout generator.                                        |
| `07-dynamic-island.png` | Next climb. From Dynamic Island. | Real expanded Live Activity controls.                                |
| `08-next-project.png`   | Find your next project.          | Native climb search and filters.                                     |

Italian uses `07-session-detail.png` in slot 07, framed from the native
`04-session-detail.png` capture with the `session` caption. Its session recap
replaces the physical Live Activity image until a reviewed Italian fixture exists.
The other locales retain the Live Activity slot.

The opening puts spray walls alongside supported boards; the second image gives
the new spray feature its own scene. The third broadens board compatibility,
then the fourth shows the shared queue. Compositions reuse the showcase video's typography and palette around
real captures. They do not manufacture app controls or use AI-generated images.

The campaign uses the dedicated `app-stores/apple/campaign-fixtures.json` pin
with a shared crew session and seven board selectors: Kilter, Tension, MoonBoard,
Woods, Decoy, Grasshopper, spray. Preflight rejects missing or wrongly typed
boards. Android and navigation smoke retain the separate legacy fixture.
See the [creative asset runbook](../../docs/marketing/app-store-creative-assets.md)
for capture, review, and separate Header/Search Results exports.

Apple permits up to ten screenshots; this campaign deliberately uses nine.
The Android eight-image campaign is separate. [Apple screenshot guidance](https://developer.apple.com/app-store/product-page/)

### iPad — six framed slots

The iPad slot does not auto-scale from iPhone, and an iPad is used differently: it
gets mounted by the wall. So it leads with the kiosk, then shows the complete
browse screen. The current landscape UI has no trailing wall column; the browse
frame preserves the full native list instead of enlarging an obsolete crop.

| Output                     | What the image shows                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `00-wall-kiosk.png`        | The wall kiosk: the lit climb, readable from the mat.                                          |
| `01-wall-status.png`       | The complete native Climbs list, with the climb-search caption. The filename is retained for upload parity. |
| `02-home.png`              | The crew's activity feed.                                                                      |
| `03-discover.png`          | The playlist library.                                                                          |
| `04-workout-generator.png` | The Record tab's workout generator.                                                            |
| `05-profile.png`           | Sends and progress across every board.                                                         |

It runs on the same six captures the sidebar flow already takes, each feeding one
frame, so it needs no board switching and no extra fixtures.

The six-image iPad campaign has no board-family frame. Board-family stories use
their matching fixtures independently; adding a campaign frame requires an
explicit recipe and updated store artwork.

Every board in the set is drawn with **Aura**, the default story renderer.
`packages/mobile/src/dev/stories/StoryRoot.tsx` receives the workflow's
`render_mode` through the story URL. Story IDs select the board fixtures;
`boards` selectors apply to live integration setup. Capture readiness fails
closed if a scene or its assets cannot render.


## Header and Search Results

These are separate organic App Store creative placements on iOS/iPadOS 27 and
later, not extra screenshot slots. Generate opaque PNGs with `vp run store:creatives`:
Header at 3840 × 1646 and Search Results at 3840 × 2560. Keep them outside the
screenshot upload tree. The [creative asset runbook](../../docs/marketing/app-store-creative-assets.md)
covers source requirements, `creative-assets.json` provenance, localization and
manual Asset Library review/publication. Existing fastlane screenshot and
metadata lanes do not upload or publish them.

## Review Notes

**Demo Account**

- Email: test@boardsesh.com
- Password: test

**Native features**

Boardsesh uses native Bluetooth to light compatible climbing boards, supports
Lock Screen controls through Live Activities, and can save climbing sessions to
Apple Health with permission. The website at boardsesh.com provides marketing,
account and public sharing pages; test climbing and shared sessions in the app.

**Testing without a physical board**

1. Sign in with the demo account and choose a board in the board picker. Open
   Climbs to browse and filter climbs; Kilter has a Verified quick filter.
2. Open a climb to see its holds, then add it to the queue. Open the queue to
   browse the selected climbs. No physical board is required for this.
3. Open Session and build a workout. Choose 4x4, Limit Bouldering or On the Minute
   to preview climbs and rests; Pyramid also offers Same climbs down.
4. Open Home to see the sections available for the account. Weekly totals,
   recommendations and projects depend on its climbing history. Customize Home
   controls which sections appear. Discover includes My climbs.
5. Open Settings > Timers to inspect countdown buzz and Lock Screen countdown
   preferences.

**Optional shared-session test:** on the first device, open Session and tap
Start. Open Invite and share its link. On a second device, sign in with a
different account and open that link in Boardsesh. Both participants can use
the queue. End the session to see its recap. Skip this exercise if a second
device and account are unavailable; the single-device checks above still work.

**Hardware and permissions for 2.8.0**

Bluetooth scanning needs permission and a nearby compatible controller. An empty
scan without hardware is expected. Nearby-board discovery uses location only
when permission is granted; boards can also be selected manually.

Spraywalls can be used without LEDs: a photo highlights the climb's holds.
Optional WLED lighting needs a configured controller on the same Wi-Fi network.
The LED settings map holds to LEDs, find controllers on Wi-Fi, set brightness
and choose a Wi-Fi automatic switch-off time. Saved setup is shared with climbers
who can access the Spraywall. Compatible controllers with Boardsesh Bluetooth
support can also light climbs over Bluetooth. Installing that support is a
separate opt-in beta for matching hardware and requires explicit consent.
Automatic switch-off is currently Wi-Fi-only.

Board history belongs to the physical board and shows climbs lit through
Boardsesh and recent activity. Crew sessions share a queue; any participant can
control it. Ending a session produces a recap and updates climbing history.
These are separate features.

The app uses CoreBluetooth via react-native-ble-plx and the bluetooth-central
background mode to maintain a board connection while the screen sleeps.
Session traffic uses `wss://ws.boardsesh.com/graphql` (the production
`EXPO_PUBLIC_WS_URL` in `.github/workflows/mobile-native-release.yml`).

## App Privacy - Data Collection Labels

This is a source-backed submission inventory for 2.8.0, not a readback of the
live App Store Connect labels. Reconcile the selected binary, enabled SDKs and
current console answers before submission. Fastlane listing uploads do not
update these answers.

### Account-linked collection

| Data Type | Category | Purpose and collection path |
| --- | --- | --- |
| Email Address, Name | Contact Info | Account management and profile display |
| User ID | Identifiers | Authentication, ownership of saved content and account-linked analytics |
| Precise Location | Location | Nearby board/session discovery when location permission is granted |
| Fitness | Health & Fitness | Logged sends, attempts, grades, sessions and workout results |
| Photos | User Content: Photos or Videos | Uploaded avatars, gym images, Spraywall photos and attached feedback screenshots; optional submissions |
| Other User Content | User Content | Saved climb/session comments, notes and user-created climbing content |
| Product Interaction | Usage Data | PostHog product events linked to the signed-in account when analytics is enabled |
| Product Interaction | Usage Data | First-party daily activity records keyed by account and platform, independent of the Analytics setting; only aggregate counts leave this database |

Photo visibility depends on the surface: Spraywall originals are stored
privately and served through authorized reads, while avatars and feedback
screenshots have public delivery paths. Private storage and optional submission
do not mean a photo is not collected.

### Diagnostics and collection controls

| Collection path | Purpose | Identity handling and control |
| --- | --- | --- |
| PostHog product analytics | Analytics | Identifies the signed-in account. Analytics can be switched off in Settings; prompt regions require Allow, while other supported regions can default on. Session replay is a separate opt-in, off by default. |
| Sentry crash and performance reports | App functionality: reliability | Runs independently of the Analytics setting. Native/JS privacy handling removes user identity and device IDs; verify the shipped SDK's remaining fields when selecting linked/not-linked answers. |
| Observe and OTA health | App functionality: performance and update reliability | Runs independently of the Analytics setting. No account identity is assigned, but installation/session identifiers are retained; do not describe the whole diagnostics path as identifier-free. |
| Apple Ads install attribution | Advertising or marketing measurement | Requires explicit Allow everywhere, including regions where product analytics defaults on; include its actual fields and use in the console review. |

Use [Apple's collection, linkage and tracking definitions](https://developer.apple.com/app-store/app-privacy-details/)
for the final answers. A lack of an account ID alone does not establish that
install-linked diagnostics are unlinked, and optional collection is not an
automatic disclosure exemption. Confirm any additional video, audio or document
collection from the complete feature/SDK inventory rather than restoring the
old blanket “not collected” list.

Evidence: [media storage](../../docs/operations/user-media-storage.md),
[analytics choices and telemetry paths](../../docs/analytics/analytics-consent.md),
[native PostHog identity](../../packages/mobile/src/lib/posthog-client.ts),
[Sentry privacy handling](../../packages/mobile/src/lib/sentry.ts), and
[stored comments](../../packages/backend/src/graphql/resolvers/social/comments.ts).
