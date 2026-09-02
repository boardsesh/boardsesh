# App Store Metadata - Boardsesh

> **Listing text is source-controlled in `fastlane/metadata/en-US/`** and pushed to
> App Store Connect by the `ios metadata` lane (see `fastlane/Fastfile` and the
> `Mobile Store Metadata` workflow). Edit the `.txt` files there, not the prose
> below — the App Name, Subtitle, Description, Keywords, Promotional Text, and
> What's New copy live in `name.txt`, `subtitle.txt`, `description.txt`,
> `keywords.txt`, `promotional_text.txt`, and `release_notes.txt` respectively.
> The listing is localized: `en-US` (default), `es-ES`, `es-MX`, `fr-FR`, and
> `de-DE` each have their own folder under `fastlane/metadata/`, and `deliver`
> uploads every locale folder it finds. There's one Spanish app translation but no
> universal App Store Spanish (unlike `en-US`, which covers every English
> storefront), so the same `es` copy serves both `es-ES` (Spain) and `es-MX`
> (Mexico/Latin America) — matching the two Spanish screenshot locales. German and
> French each map to a single storefront locale.
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

Generated iPhone portrait and iPad landscape screenshots, captured + uploaded by
`vp run mobile:screenshots` (Maestro -> fastlane; see
`packages/mobile/.maestro/README.md`). Ten slots, in store display order (the
filename prefix sets the order):

1. `00-board-view` — a climb with the holds lit on Marco's Kilter board (the signature view)
2. `01-board-view-2` — a climb lit on a gym Tension board, showing multi-board support
3. `02-home` — the global "Everyone" activity feed
4. `03-climbs` — browse the board's climbs, on Marco's Kilter board
5. `04-session-detail` — a session recap: stats, leaderboard, sends
6. `05-workout-generator` — the Record tab's workout generator
7. `06-discover` — the playlist library
8. `07-playlist-detail` — a smart playlist (crowd favourites)
9. `08-logbook` — your logged sends and progression
10. `09-profile` — your stats and progression

The lit board leads. It is the thing nothing else does, and the first shot is the
only one most people see — the feed and the climb list read like any app's until
you already know what the board is for.

Apple allows up to 10; the current generated set uploads 10 screenshots. Google Play caps phones at 8, so its set drops playlist detail and logbook (see the Play metadata).

Every board in the set is drawn with **Aura**, the app's default look. Both the
drawing and which wall each shot sits on are pinned by the screenshots build
(`EXPO_PUBLIC_SCREENSHOT_RENDER_MODE`, `EXPO_PUBLIC_SCREENSHOT_BOARDS` — defaults in
`packages/mobile/src/lib/screenshot-mode.ts`), and the capture fails rather than
upload a set that came back in the classic look or on a fallback wall. Retarget one
run from the workflow's `render_mode` / `boards` dispatch inputs.

## Review Notes

**Demo Account**

- Email: test@boardsesh.com
- Password: test

**Why this app needs to be native**

The core feature of Boardsesh is connecting to climbing board LED controllers via Bluetooth Low Energy (BLE). iOS Safari does not support the Web Bluetooth API (https://caniuse.com/web-bluetooth), which makes it impossible to control the board from a web browser on iPhone. This is the primary reason the app exists as a native iOS app. The web version at boardsesh.com works on Android and desktop browsers that support Web Bluetooth.

**Testing without a physical board**

You do not need a climbing board to test the app. Here is what you can verify:

1. **Sign in**: Use the demo account above. You will see the board selection screen.
2. **Browse climbs**: Select "Kilter Board" > pick any layout/size/angle combination. You will see a searchable list of thousands of community climbs with grade ratings and quality stars.
3. **Search and filter**: Use the filter controls to narrow by grade range, minimum quality rating, and hold count.
4. **View a climb**: Tap any climb to see the hold layout rendered on the board image. The colored circles show hand and foot positions.
5. **Queue management**: Tap the "+" button on a climb to add it to your queue. Open the queue panel to see your list. You can reorder by dragging and remove by swiping.
6. **Bluetooth pairing**: Go to the Bluetooth connection screen (gear icon or connection prompt). The app will request Bluetooth permission and scan for nearby BLE devices. Without a physical board, the scan will complete with no devices found. This is expected behavior.
7. **Party Mode**: Start a party session from the queue panel. This creates a WebSocket-backed collaborative session. You can open a second browser tab at boardsesh.com, sign in with a different account, and join the same session to test real-time sync. Sessions are always live: any participant can set the next climb and it broadcasts to everyone instantly. There is no single "driver" and no voting step (the older driver/vote model is deprecated). Whoever is connected to the board over Bluetooth relays the lit climb to the wall.
8. **Logbook**: After signing in, check the logbook/profile section to see logged climbs and stats.

**What the app does**

Boardsesh lights up climbs on LED boards (Kilter, Tension, MoonBoard and others) over Bluetooth. Two things set it apart from a single-board app, and they are distinct features:

- **Board history (board-linked, always on):** when you connect to a board, a live feed shows what is lit on that wall right now plus recent sends — who lit each climb, the grade, angle and setter. It is tied to the physical board, not to a session, and you do not start anything.
- **Crew sessions (collaborative):** you start a session and everyone in it shares one queue that any participant can drive (no single driver). A session ends with a recap and feeds your logbook and progress tracking.

**Bluetooth**

The app connects to climbing boards over Bluetooth Low Energy to light the holds. Data flows one way, phone to board; no personal data is sent over Bluetooth. It uses native CoreBluetooth (via react-native-ble-plx) and declares bluetooth-le / bluetooth-central so the connection survives the screen sleeping. Endpoints: API at boardsesh.com, Party Mode WebSocket at wss://backend.boardsesh.com.

## App Privacy - Data Collection Labels

### Data Linked to You

| Data Type        | Category         | Purpose                                                                             |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------- |
| Email Address    | Contact Info     | Account creation and authentication                                                 |
| Name / Username  | Contact Info     | Profile display, shown to other users in Party Mode and social features             |
| Precise Location | Location         | Party session discovery (finding nearby sessions), only when user grants permission |
| Fitness Activity | Health & Fitness | Climb ticks and logbook entries (sends, attempts, grades)                           |

### Data Not Linked to You

| Data Type  | Category    | Purpose                                                                        |
| ---------- | ----------- | ------------------------------------------------------------------------------ |
| Usage Data | Diagnostics | Vercel Analytics for page views and performance metrics, collected anonymously |

### Data Not Collected

- Financial information
- Contacts or address book
- Browsing history
- Purchases
- Photos or videos
- Health data (beyond fitness activity above)
- Sensitive information
- Advertising data
