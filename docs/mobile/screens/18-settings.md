# Mobile settings

Settings routes live under `packages/mobile/app/settings/` with scoped exports in
the account and Wall display stacks. Native form models and controls live under
`packages/mobile/src/components/`; persisted settings are owned by
`packages/mobile/src/settings/`. Credentials use their secure authentication
store, not the general preferences store.

## Appearance and layout

**Screen:** `packages/mobile/app/settings/index.tsx`

The mobile Settings screen contains appearance and UI-style controls that have no direct web equivalent.

**Appearance** (system / light / dark):

- `SegmentedControl` with three options persisted as `ThemeOverride` in key-value storage.

**UI Style**:

- `SegmentedControl` with three options: Auto, Liquid Glass, Material.
- Persisted as `UiVariantPreference` via `useTheme().setUiVariant`.
- **Auto**: resolves to Liquid Glass on every iPhone (including iOS < 26, via the blur surface fallback) and Material on Android. `resolveUiVariant` keys this on `Platform.OS === 'ios'`, not glass capability.
- **Liquid Glass**: the glass aesthetic. On every iPhone it uses the native `NativeTabs` tab bar; on a glass-capable device (iOS 26) that bar adds the bottom accessory and `GlassView` surfaces, and on iOS < 26 surfaces fall back to frosted `BlurView` while the current climb rides the floating JS queue bar. On Android it falls back to the JS `MaterialTabBar` + solid surfaces. The tab chrome is resolved by `useTabChrome()` (`resolveTabChrome`).
- **Material**: JS `MaterialTabBar` + opaque M3 surfaces.
- All three options are always **selectable** on every platform — any phone can opt into Liquid Glass, falling back to JS buttons where the native iOS 26 chrome can't render. An explanatory footnote switches between `mobile.settings.uiStyle.description` (glass-capable), `mobile.settings.uiStyle.glassFallback` (iOS < 26), and `mobile.settings.uiStyle.glassFallbackAndroid` (Android) based on capability and platform.

**Board** (Settings › Board; `BoardLookScreen`, `board-look-model.ts`): the look rail and its two leaves, then, in this order, the Spraywalls look switch, the MoonBoard grid letters switch (MoonBoard active only), **GPU acceleration**, then the lighting groups.

- **GPU acceleration** is a switch with a hint ("Draws lit holds with your phone's graphics chip. Turn off if the board flickers or stutters."), on by default, stored as `gpuAcceleration` in the MMKV settings store. Off sends every board surface to the PNG renderer at once. It can only turn the GPU off: the remote `aura-gpu-enabled` switch outranks it and the rollout still decides when it is on. The row is hidden when the binary has no native overlay module or the remote switch is off. A change reports `Setting Changed { page: 'board', key: 'gpuAcceleration' }`. See `docs/rendering/gpu-climb-overlay-experiment.md`.

**Home** (its own page in the root's second group, after Board and Climbs & grades; the row's value is the matching preset: Default, Focused or Custom):

- **Open the app on** (Climbs / Home) first: a segmented row persisted as `startupScreen` in the MMKV settings store, Climbs by default, read through `normaliseStartupScreen()`. Applies from the next start and never navigates. Links, notification taps, onboarding and a post-login return still open where they point. See `01-navigation.md` → "Mobile: library entry and tab variants". A change reports one `Setting Changed { page: 'homeScreen', key: 'startupScreen' }`.
- Then the Home sections (Your board, Session, Playlists, Climbing now, Fresh beta) in the saved order, each with a switch and ↑/↓ arrows, then the feed's switch (it stays last), then Show all, Focused and Restore defaults. Native form like Board and Climbs & grades (`HomeSettingsScreen`, `home-settings-model.ts`), except the movable rows: the form has no reorderable row, so they are the Customize Home sheet's `SectionLayoutList` rows hosted in one full-bleed `custom` row (`SectionLayoutFormList`). That is a deliberate exception to the native-form rule (#6480), at Marco's ask on #6546. On Android the page has no hosted row (the Compose form drew none on a Pixel 8 Pro): each section is a native switch in the saved order with native ↑/↓ icon buttons before its label (`MoreToggleRow.actions`, drawn by `MoreForm.android` only), disabled at the ends. TalkBack stops on each button and reads "Move Playlists up"; the Compose bridge has no custom accessibility actions. Stored as `homeSectionsV1` in the MMKV settings store, shared with the sheet and Home. See `02-home.md`.

**Quick filters** (Settings › Climbs & grades, after Climb list and Climb view; the row's value is Default until either list's chips or their order change, then Custom):

- Two groups, Climbs (the chips above the Climbs list, key `pinnedFilterChips`) and Playlists (the chips above every playlist, smart playlist and setter page, key `pinnedPlaylistChips`), then Restore defaults, which resets both. Each group lists its pinned filters first, in the order the chip row draws them, each with a switch and ↑/↓ arrows, then the other filters in the sheet's order with a switch only. Switching one on puts it last; switching one off sends it back down. Rows use the Filters sheet's names for each control. Same build as Settings › Home (`QuickFiltersSettingsScreen`, `quick-filters-settings-model.ts`): the pinned rows are hosted `SectionLayoutFormList` rows on iOS and the browser, native switches with native move buttons on Android. Every change reports `Setting Changed` under the `quickFilters` page (`climbs.grade`, `playlists.moveUp`…). The route is in every settings mirror and is also re-exported as `(tabs)/climbs/quick-filters` and `(tabs)/discover/quick-filters`, so a filter sheet can push it over its list. The chip order is described in `docs/design/mobile-chrome.md` → "Quick filter capsules".

**Grade Format** (V-Grade / Font / Both):

- `SegmentedControl` persisted via `useGradeFormat()`.

**Accessibility**:

- Adds hold-role colour overrides for STARTING, HAND, FINISH, and FOOT.
- Each role has a Default/User mode. Default stores no override and uses the board's canonical colour.
- User mode opens a bottom sheet with RGB channel inputs and a live swatch preview.
- Overrides are persisted in AsyncStorage via `useHoldColorOverrides()` and shared with board rendering plus Bluetooth payload encoding.

---

## Profile and account

`EditProfileScreen` owns profile changes. Account routes provide password/recovery,
privacy, export, connected apps, and deletion tasks. Deletion remains an explicit
confirmed backend operation; signing out clears account-scoped state through the
authentication provider. Read [mobile auth flow](../../auth/mobile-auth-flow.md),
[privacy](../../product/privacy.md), and [data exports](../../product/user-data-exports.md) before changing
those behaviors. The removed web MUI profile card and its internal REST URL are
not a mobile API contract.

## Manufacturer accounts and imports

**Component:** `BoardAccountsSection` on Connected apps

Card for each board type (iterates `AURORA_BOARDS`). Kilter renders **two** cards:
"Kilter (Aurora)" for the legacy Aurora-built app (JSON import + data request) and
"Kilter (new)" for the new Kilter Grips account, which links via username/password.
The "Kilter (new)" card shows when the `kilter-oauth-linking` PostHog flag is on,
or whenever a Kilter account is already linked.

**Not Connected state:**

- Board name + "Board" suffix as title (or "Kilter (Aurora)" / "Kilter (new)").
- Description text.
- Buttons:
  - "Link Account" button (non-Kilter boards): Opens link dialog.
  - "Sign in to Kilter" button (Kilter new card): Opens the Kilter
    username/password dialog, which links via the ROPC password grant.
  - "Import JSON" button: Opens file picker.
  - "Request Data" button (Kilter Aurora card): Opens pre-filled mailto
    link to Aurora Climbing.

**Connected state:**

- Board name as title + status chip:
  - Active: "Connected"
  - Error: "Error"
  - Expired: "Expired"
  - Syncing: "Syncing"
- Info rows: Username, last synced timestamp.
- Error message (if any).
- Unsynced counts warning alert (ascents + climbs).
- Buttons: "Unlink" (with confirmation) + "Import JSON".

**Link Account Dialog:**

- Title: "Link <Board> Account" (or "Sign in to Kilter" for Kilter).
- Username + password text fields. For Kilter the submit calls the ROPC password
  endpoint; the password is exchanged for a refresh token server-side and never
  stored.
- "Link Account" button.

**Reconnect:** a connected card whose `syncStatus` is `expired` shows a
"Reconnect" button that reopens the same link dialog (re-submitting resets the
credential to `pending` so the daemon picks it up again).

**Import Flow** (unified dialog with phase transitions):

1. **Preview phase**: Shows parsed export data counts (draft climbs, ascents, attempts, circuits). Cancel/Confirm buttons.
2. **Importing phase**: Step-by-step progress with `ImportProgressSteps`:
   - Steps: Importing draft climbs -> Resolving climb names -> Checking for duplicates -> Importing ascents -> Importing attempts -> Importing circuits -> Building sessions.
   - Each step shows: complete checkmark, active spinner, or pending circle.
   - Active step shows progress bar with count (e.g., "142 / 500").
3. **Complete phase**: Results summary per category (imported/skipped/failed counts). Unresolved climbs warning (shows up to 20 names).
4. **Error phase**: Error alert with message.

**Connected apps behavior:**

- Route: `packages/mobile/app/settings/integrations.tsx`.
- Board account cards render above platform/device integration cards.
- A **MoonBoard** card renders first, above the Aurora-board cards on web and mobile.
  MoonBoard isn't in `AURORA_BOARDS`, so the card is self-contained — no
  credential, status chip, or sync flow. It offers two actions: "Request your
  data" opens a pre-filled mailto to `moonboardsupport@moonclimbing.com` (body
  is copied to the clipboard on mobile), and "Import data" opens a CSV picker.
  The CSV import previews MoonBoard logbook row counts and the angles found,
  stores each entry at its logged angle (25° or 40°, default 40°), turns
  Project/Fail rows into attempts, and streams progress from
  `/api/moonboard-import`. Column order doesn't matter; see
  `docs/integrations/integrations.md` for how rows are matched to climbs.
- Uses backend REST endpoints instead of Next internal routes.
- Kilter links via the username/password (ROPC) "Sign in to Kilter" card when the
  `kilter-oauth-linking` PostHog flag is on; otherwise only the "Kilter (Aurora)"
  JSON-import / data-request card shows. The username/password path also serves
  users for whom the dormant OAuth flow can't run (no Kilter-registered redirect
  URI). Two-factor or social-login-only Kilter accounts can't use ROPC and must
  fall back to JSON import.
- Non-Kilter boards use the same username/password link dialog semantics as
  web.
- JSON import reads a local file with `expo-document-picker`, previews the
  shared parsed counts, streams import progress from the backend, and surfaces
  partial/unresolved results in the same phase model as web.
- Strava cards are hidden unless the `strava-integration` feature flag is on;
  static mobile builds can enable it with
  `EXPO_PUBLIC_STRAVA_INTEGRATION=true`.

---

See [integrations](../../integrations/integrations.md), [Kilter sync](../../data/kilter-sync.md), and
[Aurora sync](../../data/aurora-sync.md) for backend contracts and source-specific limits.
