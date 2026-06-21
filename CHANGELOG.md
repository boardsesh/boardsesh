# Changelog

User-facing changes to Boardsesh, newest first. Auto-generated from the "Release
Notes" section of merged pull requests — do not edit by hand (a CI check rejects
manual changes). See docs/mobile-ota-updates.md.

## 2026-06-21

### App update

A new version shipped to the Play Store.

### New

- Stuck at sign-in? Report a bug or jump into Discord without logging in first. ([#3131](https://github.com/boardsesh/boardsesh/pull/3131))
- You can now see at a glance when you're driving the board: the bar lights up when you have control, shows who's driving when a crewmate has it, and lets you connect or open board controls right from the bar — no digging into the climb view. ([#3115](https://github.com/boardsesh/boardsesh/pull/3115))

### Fixed

- Tester-only dev tooling + backend security/integrity hardening; nothing climber-facing. ([#3116](https://github.com/boardsesh/boardsesh/pull/3116))

## 2026-06-20

### App update

A new version shipped to the App Store and Play Store.

### New

- Beta testers can now switch OTA update channels right in the app to preview a specific build. ([#3068](https://github.com/boardsesh/boardsesh/pull/3068))
- See when a new app version landed — What's New now flags store updates, so you can tell what arrived over the air from what needs an app update. ([#3101](https://github.com/boardsesh/boardsesh/pull/3101))
  Tap "Check for updates" in What's New to grab the latest fixes on the spot.
- See a climber's recent beta videos right on their profile — swipe through the shelf or tap See all for the full grid. ([#3076](https://github.com/boardsesh/boardsesh/pull/3076))
- Drive your board from the Android session notification ([#3073](https://github.com/boardsesh/boardsesh/pull/3073))
  The session notification now shows your current climb with its grade, angle, and your spot in the queue, and draws the board art right on your phone. Previous and Next move the board through your queue without opening the app, and the lightbulb shows when you're connected. When a crewmate takes the board, the card steps back to show what's on the wall.
- The lock-screen Live Activity got a cleaner look and now knows who's on the board. ([#3077](https://github.com/boardsesh/boardsesh/pull/3077))
  When you're connected, the bulb glows and Prev/Next move the wall through your
  queue; when a crewmate takes over, it shows what they're climbing instead. The
  grade shows in its real grade colour up in the corner, and the board thumbnail is
  easier to read at a glance.

### Improved

- Boards open without a hitch on Android — selecting a board no longer briefly freezes the app. ([#3099](https://github.com/boardsesh/boardsesh/pull/3099))

### Fixed

- Find a gym on a full-screen map you can drag to resize, pan to explore new areas, and search by city — board picking right from the map. ([#3118](https://github.com/boardsesh/boardsesh/pull/3118))
- The wall history keeps up with your crew now — sends from friends show up right away, even after your phone's been in your pocket or your signal dropped for a moment. Pull down on the history list any time to refresh it. ([#3111](https://github.com/boardsesh/boardsesh/pull/3111))
- Fixed an Android freeze where the app could stop responding after a couple of minutes — the climb list wouldn't scroll and both bars went dead until you reopened the app. It stays live now. ([#3108](https://github.com/boardsesh/boardsesh/pull/3108))
- Fixed an Android freeze where the top and bottom bars stopped responding right after you picked a climb. ([#3104](https://github.com/boardsesh/boardsesh/pull/3104))
- Sign in with Apple now falls back to a browser sign-in on iPhone when the native prompt can't complete, so you're not locked out. ([#3092](https://github.com/boardsesh/boardsesh/pull/3092))
- Pick a board and keep climbing — fixed an Android freeze that hit right after switching boards. ([#3097](https://github.com/boardsesh/boardsesh/pull/3097))
- Playlist grades now match the wall angle you've dialed in, instead of a climb's most-popular angle ([#3090](https://github.com/boardsesh/boardsesh/pull/3090))

## 2026-06-19

### App update

A new version shipped to the App Store and Play Store.

### New

- See what's new right in the app — a What's New page now lives under Settings, with a "New" dot when there's an update you haven't read yet. ([#3066](https://github.com/boardsesh/boardsesh/pull/3066))

### Fixed

- The board view now renders natively on the newest Android phones that use 16 KB memory pages (Android 15 and later, 64-bit devices). ([#3069](https://github.com/boardsesh/boardsesh/pull/3069))
