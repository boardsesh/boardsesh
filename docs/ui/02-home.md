## Home

The web landing page (`/`) is marketing only since W-16 (#4435). This page covers the app's Home tab.

### Home tab

**Mobile route:** `packages/mobile/app/(tabs)/home/index.tsx`

**Layout:** A `FlashList` whose rows are the feed. Everything above the feed is the list header: the sections the climber switched on, in their order, then a **Customize Home** text button, then the feed heading. The top chrome (account avatar, notifications, find climbers) floats over the list as on the other tabs.

**Signed out:** a "Sign in to see your feed" placard comes before any section. Native redirects to login before Home renders, so this is mostly the browser app.

### Sections

Six sections. The climber shows or hides each one and orders the first five. The feed stays last because it scrolls forever.

| Id            | Name          | What it shows                                                                                   | Default |
| ------------- | ------------- | ----------------------------------------------------------------------------------------------- | ------- |
| `board`       | Your board    | `BoardSummaryCard` (moved from Session): Browse climbs, Change board                            | hidden  |
| `session`     | Session       | Start a session, or the running session's timer and Open session. Both open the Session tab     | hidden  |
| `playlists`   | Playlists     | Liked climbs and Projects (smart playlists, with counts), then All playlists on Discover        | hidden  |
| `climbingNow` | Climbing now  | `LiveSessionsRail`, unchanged                                                                   | shown   |
| `beta`        | Fresh beta    | The newest community beta videos, a horizontal shelf (`HomeBetaSection`); see below             | hidden  |
| `feed`        | Feed          | Crew feed (My crew) or the board's recent sessions (gym scope); locked last                     | shown   |

The defaults are today's Home (Climbing now, then the feed), so nobody's Home changes on an update. **Focused** shows Your board, Session and Playlists and hides Climbing now, Fresh beta and the feed, which is the Boardz Home (#6289). Focused keeps the climber's order; **Restore defaults** resets order and switches.

Rules that hold in every layout:

- A hidden section is not mounted, so its queries never start. A hidden feed asks for nothing, shows nothing even with pages still cached, and never pages.
- Nothing above the feed mounts before Home's first focus (`useHasBeenFocused`), so launching on Climbs costs Home nothing. Climbing now mounts as before and holds its own reads until the scope settles.
- While the Session card shows, Climbing now never offers Start (`showStartPrompt={false}` → `planLiveRail`), so Start is offered once.
- The scope menu (My crew / a gym / Everyone / Find a gym) shows while the feed or Climbing now does. Without either, the chrome shows a plain "Home" title. The header buttons stay in every layout, so notifications and find climbers survive an empty Home.
- Every section switched off: "Your Home is empty" with a Customize Home button. The header Customize button hides then, so it is not offered twice.
- Pull to refresh refetches only the visible sections: Climbing now and the feed as before, `SESSION_SUMMARY_QUERY_KEY` for Session, `SMART_PLAYLIST_COUNTS_QUERY_KEY` for Playlists, `RECENT_BETA_LINKS_QUERY_KEY` for Fresh beta. Your board reads the phone and has nothing to fetch. The spinner follows the feed's refetch while the feed shows; without it, it stays up until the sections' refetches settle.
- `testID="home-screen"` and the screenshot smoke marker stay in every layout.

### Customize Home

The **Customize Home** button opens a `ModalSheet` (`HomeCustomizeSheet`), like the climb's View options: a switch per section, ↑/↓ arrows for the five above the feed (`SectionLayoutList` in a `BottomSheetFlatList`), Show all and Focused at the head of the list (they scroll with it, so the switches stay reachable at the largest text), Restore defaults under the list. Choices apply at once and Home redraws behind the sheet. The feed row has a switch and no arrows, in its own group.

Settings › Home (its own page beside Board and Climbs & grades, QA on #6546) starts with "Open the app on" (Climbs | Home, #6536), then the sections with their switches and ↑/↓ arrows, the feed as a switch on its own, then Show all, Focused and Restore defaults. The page is the native form (#6477) except for one hosted row: the native form has no reorderable row, so the movable sections are the sheet's `SectionLayoutList` rows inside a full-bleed `custom` row (`SectionLayoutFormList`), sized from what it draws so Dynamic Type grows it. That one row is an exception to the settings-form rule (#6480) that Marco asked for. Android has no such row: its Compose form drew no hosted React Native row on a Pixel 8 Pro (QA on #6546), so there each section is a native switch in the saved order with native ↑/↓ buttons before its label, on the page itself. The root row's value names the matching preset: Default, Focused or Custom. The page, the sheet and Home read and write the same store, so a move in one shows in the others. Both surfaces share `useHomeSectionControls`, and both sheets of this kind (Customize Home and the climb's View options) are built from `SectionLayoutSheet.tsx`.

### Fresh beta

The shelf Home showed until the Climbing now rail replaced it (#5518, June 2026), back as a switch that starts off. It reads `recentBetaLinks(limit: 20, boardType, layoutId)` through `useRecentBetaLinks`: with Home's selected board (the home board by default, in either feed mode) it keeps to that board type and layout and says "Fresh beta on this board"; with none it is every board ("Fresh beta"). The server does the layout filter, so there is no over-fetch. Each card is the shared `BetaVideoCard` (opens the video); the climb name under it opens the climb in the player. One page, at most 20, in a horizontal `FlatList` with fixed `getItemLayout`. It mounts after Home's first focus and asks once the scope settles. Unlike the old shelf it has no fold-away chevron: the Home switch hides it, and the shared beta-shelf fold state is left to the other shelves.

Every edit reports `Setting Changed { page: 'homeScreen', key, value }`: a switch is `key: <section id>, value: <boolean>`; a move is `key: 'moveUp' | 'moveDown', value: <section id>`; a preset is `key: 'preset', value: 'showAll' | 'focused' | 'default'`. No new event.

### Storage

`homeSectionsStore` in `packages/mobile/src/lib/home-sections.ts` is a `createSectionLayoutStore` over the MMKV settings key `homeSectionsV1` (`SectionLayoutRecord | null`, through `settingsLayoutStorage`). It is synchronous, so Home knows the layout before its first frame. A layout equal to the defaults is stored as `null`, so a climber who never customised follows a later release's defaults; a section added later slots in where the defaults put it. The record is per device and survives sign-out; Reset all settings clears it. Older bundles ignore the key.

Screenshot builds start every launch on the default Home and never save an edit, so captures stay identical across runs on the same simulator. An edit still applies for the rest of that launch, so a capture can show a customised Home.

The pure rules (order, visibility, `lockedLast`, unknown ids) live in `src/lib/section-layout.ts`; the play drawer's View options uses the same code (see `docs/mobile-sheets-vs-routes.md`).

### Offline

| Section      | Data                                             | Offline                                                                                  |
| ------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Your board   | `activeBoard` (AsyncStorage)                     | Works. Browse opens Climbs (a downloaded board, or its placard); Change board lists offline boards |
| Session      | queue session id (local); `sessionSummary`       | The card shows; the timer stays hidden until the start time loads                        |
| Playlists    | `mySmartPlaylistCounts` (network)                | Rows show without counts; each list shows its own offline state                          |
| Climbing now | `followedLiveSessions`                           | The rail's existing offline row                                                          |
| Fresh beta   | `recentBetaLinks` (network)                      | A "No signal" or "Offline mode is on" row, no request; server trouble shows Retry        |
| Feed         | `crewFeed` / `sessionGroupedFeed`                | The existing `OfflineState` placard                                                      |

No board: Your board shows Choose board, and a first pick lands on Climbs. A failed board restore shows Retry. A board change from the card comes back to Home (`returnTo: '/(tabs)/home'`).

### Navigation

- Your board → Browse climbs → Climbs tab; Change board → `/boards` (back to Home)
- Session → Session tab (`/(tabs)/record`). Start reports `Start Session Prompt Tapped { surface: 'home_session_card', variant: 'home_session_card' }`, with the other Start invitations
- Playlists → `/(tabs)/discover/smart/[type]` with `source: 'home'` (`Smart Playlist Opened`), pushed `withAnchor` onto the Discover stack's `index` (`unstable_settings` in `app/(tabs)/discover/_layout.tsx`). The JS tab bars (Android, iPad, browser) mount a tab on first visit, so without the anchor a Discover tab never opened this launch would hold only the list, and Back would leave Discover's main page unreachable. All playlists → Discover tab
- Climbing now and feed cards → as before (join preview, session detail, play drawer)
