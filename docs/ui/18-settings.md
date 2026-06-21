## 11. Settings

### 11.1 Profile Section

**Layout:** Card with "Profile" title and "Manage your profile" subtitle.

**Avatar uploader:**

- 96x96 `Avatar` preview.
- "Upload" / "Change" outlined button (toggles based on whether an avatar exists).
- "Remove" outlined button (visible when an avatar is set).
- Hidden file input accepting `image/jpeg, image/png, image/gif, image/webp`.
- Max input size: 10MB. Images are compressed client-side: resized to max 1024px on longest side, JPEG at 0.85 quality, white fill for transparency.
- Uploads via `POST /api/avatars` to the backend with `Bearer` auth token.
- Hint text below avatar buttons.

**Display Name:**

- `TextField` with person icon adornment, max 100 chars, placeholder text.

**Instagram Profile URL:**

- `TextField` with Instagram icon adornment.
- Validated against `instagram.com/<username>` pattern.

**Email:**

- `TextField`, disabled/read-only, person icon adornment.
- Helper text explaining it cannot be changed.

**Save button:** Full-width contained button. Shows `CircularProgress` spinner while saving. Calls `PUT /api/internal/profile`.

---

### 11.2 Display Preferences

Card with "Display" title and subtitle.

**Grade Format Toggle:**

- `ToggleButtonGroup` with two options: "V-Grade" (V3, V6) and "Font" (6A, 7C+).
- Persisted via `useGradeFormat` hook (IndexedDB).

**Apple Health Integration** (iOS only, conditionally rendered):

- `FormControlLabel` with `Switch` toggle.
- Label and subtitle text.
- Only visible when `isHealthKitAvailable()` returns true.

---

### Mobile: More tab — UI Style

**Screen:** `packages/mobile/app/(tabs)/profile/more.tsx`

The mobile More tab contains appearance and UI-style controls that have no direct web equivalent.

**Appearance** (system / light / dark):

- `SegmentedControl` with three options persisted as `ThemeOverride` in key-value storage.

**UI Style**:

- `SegmentedControl` with three options: Auto, Liquid Glass, Material.
- Persisted as `UiVariantPreference` via `useTheme().setUiVariant`.
- **Auto**: resolves to Liquid Glass on every iPhone (including iOS < 26, via the blur surface fallback) and Material on Android. `resolveUiVariant` keys this on `Platform.OS === 'ios'`, not glass capability.
- **Liquid Glass**: the glass aesthetic. On a glass-capable device (iOS 26) it uses the native `NativeTabs` tab bar + `GlassView` surfaces; on iOS < 26 it falls back to the JS `MaterialTabBar` + frosted `BlurView` surfaces; on Android it falls back to the JS `MaterialTabBar` + solid surfaces. Whether the native tab bar mounts is gated by `useNativeTabBar()` (`liquidGlass && useGlassCapability()`).
- **Material**: JS `MaterialTabBar` + opaque M3 surfaces.
- All three options are always **selectable** on every platform — any phone can opt into Liquid Glass, falling back to JS buttons where the native iOS 26 chrome can't render. An explanatory footnote switches between `mobile.more.uiStyle.description` (glass-capable), `mobile.more.uiStyle.glassFallback` (iOS < 26), and `mobile.more.uiStyle.glassFallbackAndroid` (Android) based on capability and platform.

**Grade Format** (V-Grade / Font / Both):

- `SegmentedControl` persisted via `useGradeFormat()`.

**Accessibility**:

- Adds hold-role colour overrides for STARTING, HAND, FINISH, and FOOT.
- Each role has a Default/User mode. Default stores no override and uses the board's canonical colour.
- User mode opens a bottom sheet with RGB channel inputs and a live swatch preview.
- Overrides are persisted in AsyncStorage via `useHoldColorOverrides()` and shared with board rendering plus Bluetooth payload encoding.

---

### 11.3 Password Management

**Component:** `SetPasswordSection`

**When password is set:**

- Card with green checkmark icon + "Password Enabled" title.
- Description showing the email address.

**When password is not set:**

- Card with "Set Password" title and description.
- Info alert showing linked OAuth providers (Google, Apple, Facebook).
- Form with:
  - Password field (min 8, max 128 chars, `new-password` autocomplete, lock icon).
  - Confirm password field.
  - "Set Password" contained button with lock icon.
- Validation: required, min length, max length, passwords must match.

---

### 11.4 Aurora Account Linking

**Web component:** `AuroraCredentialsSection`
**Mobile component:** `BoardAccountsSection` on Connected apps

Card for each board type (iterates `AURORA_BOARDS`: kilter, tension).

**Not Connected state:**

- Board name + "Board" suffix as title.
- Description text (Kilter has special "shutdown" text).
- Buttons:
  - "Link Account" contained button (non-Kilter only): Opens link dialog.
  - "Import JSON" outlined button: Opens file picker.
  - "Request Data" outlined button (Kilter only): Opens pre-filled mailto link to Aurora Climbing.

**Connected state:**

- Board name as title + status chip:
  - Active: green `CheckCircleOutlined` + "Connected"
  - Error: red `WarningAmberOutlined` + "Error"
  - Expired: yellow `AccessTimeOutlined` + "Expired"
  - Syncing: blue `SyncOutlined` + "Syncing"
- Info rows: Username, last synced timestamp.
- Error message (if any).
- Unsynced counts warning alert (ascents + climbs).
- Buttons: "Unlink" (red, with confirmation popover) + "Import JSON".

**Link Account Dialog:**

- Title: "Link <Board> Account"
- Username + password text fields.
- "Link Account" contained button.

**Import Flow** (unified dialog with phase transitions):

1. **Preview phase**: Shows parsed export data counts (draft climbs, ascents, attempts, circuits). Cancel/Confirm buttons.
2. **Importing phase**: Step-by-step progress with `ImportProgressSteps`:
   - Steps: Importing draft climbs -> Resolving climb names -> Checking for duplicates -> Importing ascents -> Importing attempts -> Importing circuits -> Building sessions.
   - Each step shows: complete checkmark, active spinner, or pending circle.
   - Active step shows progress bar with count (e.g., "142 / 500").
3. **Complete phase**: Results summary per category (imported/skipped/failed counts). Unresolved climbs warning (shows up to 20 names).
4. **Error phase**: Error alert with message.

**Mobile Connected apps differences:**

- Route: `packages/mobile/app/(tabs)/profile/integrations.tsx`.
- Board account cards render above platform/device integration cards.
- Uses backend REST endpoints instead of Next internal routes.
- Kilter can connect through OAuth only when `KILTER_SYNC_ALLOWED_USER_IDS`
  allows the current user; otherwise the card offers JSON import and data
  request actions.
- Non-Kilter boards use the same username/password link dialog semantics as
  web.
- JSON import reads a local file with `expo-document-picker`, previews the
  shared parsed counts, streams import progress from the backend, and surfaces
  partial/unresolved results in the same phase model as web.
- Strava cards are hidden unless the `strava-integration` feature flag is on;
  static mobile builds can enable it with
  `EXPO_PUBLIC_STRAVA_INTEGRATION=true`.

---

### 11.5 ESP32 Controllers

**Component:** `ControllersSection`

**Controller List:**

- Cards for each registered controller showing:
  - Name (or "Unnamed Controller").
  - Status chip: Online (green), Offline (default), Never Connected (default).
  - Board type chip (primary color).
  - Layout/Size info row.
  - Last seen timestamp (formatted as relative time: "just now", "5m ago", "2h ago", or full date).
  - "Delete Controller" red outlined button with confirmation popover.

**Add Controller Dialog:**

- Name input (optional, max 100 chars).
- Cascading select dropdowns: Board Type -> Layout -> Size -> Hold Sets (multi-select, auto-selects all on size change).
- "Register Controller" contained button.

**API Key Success Dialog:**

- Warning alert: "Save this key now -- you won't be able to see it again."
- Controller name display.
- Monospace read-only text field with the API key.
- "Copy to Clipboard" outlined button.
- "Done" contained button.

---

### 11.6 Account Deletion

**Component:** `DeleteAccountSection`

**Main card:**

- "Delete Account" title.
- Warning text about permanent deletion.
- "Delete Account" red outlined button.

**Confirmation Dialog:**

- Title: "Delete Your Account".
- Warning text about irreversibility.
- Loading state while fetching `deleteAccountInfo` (published climb count).
- Published climbs notice: "You have X published climbs. These will be preserved but..."
- Checkbox: "Remove my setter name from published climbs" (visible when user has published climbs).
- Type "DELETE" confirmation text field.
- Cancel (text) + "Delete Account" (red contained, disabled until "DELETE" is typed) buttons.
- Calls `DELETE_ACCOUNT` mutation, then `signOut` and redirect to home.

**Data operations:**

- `profile` -- REST `GET /api/internal/profile`.
- `updateProfile` -- REST `PUT /api/internal/profile`.
- `auroraCredentials` -- REST `GET/POST/DELETE /api/aurora-credentials`.
- `auroraImport` -- streaming REST `POST /api/aurora-import`.
- `kilterCredentialHandoff` -- REST `POST /api/board-credentials/kilter/handoff`, then browser redirects through `/board-credentials/kilter/start` and `/board-credentials/kilter/callback`, then the app finalizes with `POST /api/board-credentials/kilter/finalize`.
- `myControllers` -- REST `GET/POST/DELETE /api/internal/controllers`.
- `deleteAccountInfo` / `GET_DELETE_ACCOUNT_INFO` -- GraphQL query for published climb count.
- `deleteAccount` / `DELETE_ACCOUNT` -- GraphQL mutation.
- `saveAuroraCredential` -- REST POST.
- `deleteAuroraCredential` -- REST DELETE.
- `registerController` -- REST POST (returns API key).
- `deleteController` -- REST DELETE.

---
