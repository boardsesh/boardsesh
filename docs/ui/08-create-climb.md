## Create Climb

### Create Climb Form

**Web component:** `packages/web/app/components/create-climb/create-climb-form.tsx`

**Web route:** `/b/{board_slug}/{angle}/create` or `/{board_name}/{layout_id}/{size_id}/{set_ids}/{angle}/create`

**Mobile status:** Stack screen within board flow. Header hidden on web.

**Layout:** Full-screen. Board renderer (interactive, takes most of the screen). Floating action bar at bottom. Settings drawer as bottom sheet overlay.

**Board renderer:**

- `ZoomableBoard` wrapping `BoardRenderer` (Aurora) or `MoonBoardRenderer` (MoonBoard)
- **Hold selection:** Tap any hold on the board to open hold type picker popover. The `useHoldTypePicker` hook tracks which hold was tapped and anchors the popover.
- **Hold states cycle (via HoldTypePicker popover):**
  - OFF (cleared/unset) -- transparent
  - STARTING (green) -- max 2 allowed
  - HAND (blue) -- unlimited
  - FINISH (pink) -- max 2 allowed
  - FOOT (orange) -- not available on MoonBoard
  - Clear (X icon) -- removes hold
- **Hold indicator:** Colored circle rendered on each selected hold, matching the hold state color from `HOLD_STATE_MAP[boardName]`
- **Heatmap overlay:** `CreateClimbHeatmapOverlay` component. Shows hold usage frequency across all climbs as a heat map. Toggle via fire icon button. Opacity 0.7.

**Hold Type Picker (Popover):**

- **Web component:** `packages/web/app/components/create-climb/hold-type-picker.tsx`
- Anchored to tapped hold element, opens above (`anchorOrigin: top center`, `transformOrigin: bottom center`)
- **Setter mode:** Horizontal row of color swatches (25px circles with 2px border). Each shows hold state color and label below (11px caption). "Clear" swatch has X icon.
- States disabled when at max count (STARTING at 2, FINISH at 2) and current hold is not already that state.
- **Board-specific options:**
  - Kilter/Tension/etc: STARTING, HAND, FINISH, FOOT
  - MoonBoard: STARTING, HAND, FINISH (no FOOT)

**Bottom action bar (floating over board):**

- **Left section:** Draft count badge + Drafts button (opens DraftsDrawer)
- **Center section:** Name input, description input (when settings open)
- **Right section:**
  - Heatmap toggle (fire icon, Aurora only)
  - Settings gear (opens settings drawer)
  - Clear/delete button (resets all holds)
  - Save button (context-dependent icon):
    - Not authenticated: `LoginOutlined` (opens auth modal)
    - Edit locked (published >24h ago): `LockOutlined` (disabled)
    - Just saved: `CheckCircleOutlined` (green, no click handler, auto-resets after 3s)
    - Saving: `CircularProgress`
    - Ready to save: `SaveOutlined` or `CloudUploadOutlined`
  - "Set Active" button (`PlayCircleOutlineOutlined`) -- pushes WIP climb to party queue

**Form fields (in settings drawer):**

- Name input (`TextField`): Required for publish. When empty and save is tapped, settings drawer auto-opens.
- Description input (multiline `TextField`)
- Draft toggle (`Switch`): When ON, climb is saved as draft (not publicly visible). Default ON.
- MoonBoard-specific: Grade select, Benchmark toggle, Angle select

**Autosave:** Form state (holds, name, description, isDraft) is debounced (500ms) and persisted to IndexedDB via `saveAutosave()`. Restored on mount if not forking. Cleared on successful save or manual clear.

**Save flow:**

1. Validates: name required for publish; at least 1 hold for Aurora (isValid); START + FINISH for MoonBoard publish
2. If not authenticated: opens auth modal with pending form values
3. **First save:** Creates new climb via `saveClimb()` (Aurora) or `SAVE_MOONBOARD_CLIMB_MUTATION` (MoonBoard)
4. **Subsequent saves:** Updates existing climb via `updateClimb()` within 24h edit window (published) or indefinitely (drafts)
5. On success: `markJustSaved()` -- 3s confirmation state, clears autosave, syncs to queue via `syncSavedClimbToQueue()`
6. On duplicate error (`CLIMB_IS_DUPLICATE`): shows inline Alert + opens SimilarClimbsList drawer showing the matching climb

The server rechecks MoonBoard ownership and the 24-hour window after locking the
climb row, so a concurrent edit cannot extend or bypass the window. Publishing a
draft sets `publishedAt` and starts the window; published climbs cannot return to
draft state.

**Heatmap data:** The mobile overlay uses the shared GraphQL `holdHeatmap` query.
Anonymous configuration results are cached in Redis for five minutes with passive
expiry. Creating or editing a climb does not actively invalidate that cache, so a
new hold placement can take up to five minutes to appear in the community heatmap.

**Bluetooth preview:** When BLE is connected (Aurora boards only), `sendFramesToBoard(frames)` fires on every `litUpHoldsMap` change, sending current hold pattern to the physical board in real-time.

**Drafts drawer:**

- Lists user's draft climbs for current board configuration
- Each draft can be loaded back into the form (`handleLoadDraft`) or deleted
- Count shown as badge on drafts button

**MoonBoard OCR import:**

- Hidden file input (`<input type="file">`) for screenshot upload
- Processes via `parseScreenshot()` from `@boardsesh/moonboard-ocr/browser`
- Extracts holds, name, grade, setter from MoonBoard app screenshots
- Warning on angle mismatch

**Fork flow:** When `forkFrames`/`forkName` props are provided (from "Fork" action on existing climb):

- Holds pre-populated from fork source
- Name set to "{original name} fork"
- In edit mode: name preserved as-is

**Data sources:**

- `saveClimb()` / `updateClimb()` from `useBoardProvider()` (Aurora)
- `SAVE_MOONBOARD_CLIMB_MUTATION` GraphQL mutation (MoonBoard)
- `CHECK_MOONBOARD_CLIMB_DUPLICATES_QUERY` for MoonBoard duplicate detection
- `SEARCH_CLIMBS_COUNT` for drafts count badge
- `useCreateClimb()` hook managing hold state, frame string generation
- `useMoonBoardCreateClimb()` hook for MoonBoard-specific hold management
- `useBoardBluetooth()` for BLE connection and frame sending

**User actions:**

- Tap hold on board -> opens hold type picker
- Select hold type from picker -> updates hold state and color
- Pinch/zoom board (ZoomableBoard)
- Toggle heatmap overlay
- Enter climb name and description
- Toggle draft status
- Save/publish climb
- Clear all holds and form
- Open drafts drawer and load a draft
- Set climb as active in party queue
- MoonBoard: import from screenshot, select grade, toggle benchmark, change angle

**States:**

- Empty (no holds selected): save disabled
- Valid (holds placed): save enabled if name provided
- Saving: spinner on save button
- Just saved: green checkmark for 3s, then reverts
- Edit locked: lock icon (published climb older than 24h)
- Duplicate detected: inline error Alert with "View matching climb" option
- OCR processing: loading state during screenshot analysis
- MoonBoard duplicate checking: loading indicator during server-side check
- Autosave active: form state being debounced and persisted

**Validation:**

- Aurora: must have at least 1 hold (`isValid = totalHolds > 0`)
- MoonBoard publish: must have STARTING and FINISH holds
- MoonBoard draft: no hold requirements
- Name required for all saves (auto-opens settings drawer if missing)

**Navigation:**

- Back button (from header on mobile) -> returns to climb list
- Bulk import link (MoonBoard) -> navigates to `/import` page

**Mobile adaptation notes:**

- `ZoomableBoard` maps to `react-native-gesture-handler` pinch/pan gestures + `react-native-reanimated` transforms
- Hold type picker: bottom sheet instead of popover (finger occlusion on small screens)
- File input for OCR: `expo-image-picker` or `expo-document-picker`
- BLE via `react-native-ble-plx` -- direct connection, no browser API
- Autosave to AsyncStorage instead of IndexedDB
- Keyboard handling: `KeyboardAvoidingView` for name/description inputs when settings drawer is open
