## Session Management

### Start Session Drawer

The Start Session drawer is the entry point for creating a new climbing session. On web it is implemented as a full-height bottom `SwipeableDrawer` (`start-sesh-drawer.tsx`) containing a `SessionCreationForm`.

**Layout and behaviour:**

- Opens from the bottom, pinned to `height: 100%` using `useDrawerDragResize` with both `initialHeight` and `expandedHeight` set to `'100%'`. The drag handle is in the header but swipe-to-dismiss is disabled (`swipeEnabled={false}`).
- Header contains the title (i18n key `session:creation.drawerTitle`) with drag handle styling via `drawerCss.dragHeaderWrapper`.
- Footer is sticky at the bottom: a full-width `contained` `Button` with a `PlayCircleOutlineOutlined` icon, or a `CircularProgress` spinner (size 16) while the session is being created. Label comes from `session:creation.submitDefault`.
- Below the header, a short blurb differs for signed-in vs anonymous users (`creation.loggedInBlurb` / `creation.anonymousBlurb`).
- Anonymous users see a "Sign in for more" text button (`LoginOutlined` icon) that opens the auth modal.

**Board selector:**

- Heading: "Boards near you" (`creation.boardsNearYou`).
- When no board is selected or the selector is expanded, a `BoardDiscoveryScroll` renders horizontally with: the user's saved boards (`useMyBoards`), popular board configs, and a "Custom" option that opens a `BoardSelectorDrawer` from the top.
- Once a board is selected, the scroll collapses to a single `BoardScrollCard` in `"collapsed"` size with a grey overlay and `EditOutlined` icon. Tapping it re-expands the scroll.
- Auto-selection on open: if the user is on a named board route (`/b/{slug}`), the matching `UserBoard` is auto-selected. If on a generic board route (`/{board}/{layout}/{size}/{sets}/{angle}/...`), a custom config is built from the current route's resolved board details. Runs once per drawer open via `hasAutoSelectedRef`.

**AI queue generator:**

- When no queue has been generated, a full-width outlined `Button` with `AutoFixHighOutlined` icon shows "Generate Queue" (or a hint to select a board first when `generatorBoardDetails` is null).
- After generation, the button is replaced by a summary chip: primary border, `selectedLight` background, showing count of generated climbs. Includes a "Regenerate" text button and a close `IconButton` to clear.
- Opens a `PlaylistGeneratorDrawer` with `targetType="session"`. Generation accumulates climbs in a `runBufferRef` and only commits to `generatedQueue` on `onComplete` when `added > 0`. Dismissing mid-run preserves the prior queue.
- Generated queue items get `suggested: true` and a random UUID. The angle from the generator is pinned onto each climb explicitly.
- On session creation, the generated queue is appended after any carried-over queue from the current board.

**Form fields (`SessionCreationForm`):**

| Field             | Type                                    | Constraints             | Notes                                                                                                                                                         |
| ----------------- | --------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session name      | `TextField` (small)                     | Optional, max 100 chars | Placeholder from i18n                                                                                                                                         |
| Session goal      | `TextField` (small, multiline 2-4 rows) | Optional, max 500 chars | Helper text shows character count                                                                                                                             |
| Session colour    | 12 circular `Chip` buttons              | Optional, tap to toggle | Colours: `#F44336, #E91E63, #9C27B0, #673AB7, #3F51B5, #2196F3, #00BCD4, #009688, #4CAF50, #8BC34A, #FF9800, #FF5722`. Selected chip gets a 3px white border. |
| Discoverable      | `Switch`                                | Boolean, defaults false | Hidden for anonymous users. Label + description text.                                                                                                         |
| Permanent session | `Switch` + `FormControlLabel`           | Boolean, defaults false | Only shown when `isGymAdmin` is true.                                                                                                                         |

**Submit flow:**

1. Resolves `boardPath` and `navigateUrl` from selection (named board, custom path, or current route).
2. Calls `createSession(formData, boardPath)`.
3. Merges existing same-board queue with generated queue; sets initial queue for the new session.
4. Sets the session cookie via `setClimbSessionCookie`.
5. Calls `activateSession` with board details and parsed params.
6. Navigates to `navigateUrl` via `router.push`.
7. Fires `registerSessionStart` and analytics.
8. Closes the drawer and shows a success snackbar.
9. On error: logs to console, shows error snackbar, throws so the form preserves data for retry.

**Mobile adaptation:**

- Replace `SwipeableDrawer` with a React Native bottom sheet (e.g. `@gorhom/bottom-sheet`) at full height.
- Replace `BoardDiscoveryScroll` with a horizontal `FlatList` of board cards.
- Replace MUI `TextField`, `Switch`, `Chip` with React Native equivalents styled via the mobile theme.
- The colour picker becomes a grid of `TouchableOpacity` circles.
- The footer button becomes a sticky `View` at the bottom of the sheet with a native `Button`.
- The board selector drawer becomes a nested bottom sheet or a pushed screen.

### Session Overview Panel

The `SessionOverviewPanel` (`session-overview-panel.tsx`) renders session statistics in two modes:

**Compact mode** (`compact={true}`, used in the session mini-bar drawer):

- Board thumbnail: 90px square `BoardRenderer` with rounded corners, `boxShadow: var(--shadow-xs)`, neutral-100 background.
- Board name (capitalised) or named board name, displayed as bold `body2` text.
- Angle selector: `AngleSelector` component rendered next to the board name when `currentAngle` and `onAngleChange` are provided.
- Session goal: flag icon (`FlagOutlined`, 16px, action colour) + `body2` secondary text with the goal text. Only shown when a goal is set.

**Full mode** (`compact={false}`, used in standalone session detail pages):

- Stats chips row (`flexWrap: 'wrap'`, gap 1):
  - Flashes: green `Chip` with `FlashOnOutlined` icon, `success` colour. Only shown when > 0.
  - Sends (non-flash): primary `Chip` with `CheckCircleOutlineOutlined` icon. Sends minus flashes to avoid double-counting. Only shown when > 0.
  - Attempts: outlined `Chip` with `ErrorOutlineOutlined` icon. Only shown when > 0.
  - Duration: outlined `Chip` with `TimerOutlined` icon. Formatted as "X min" for < 60 minutes, "Xh Ym" otherwise. Only shown when > 0.
  - Total climbs: outlined `Chip` with count.
  - Hardest grade: outlined `Chip` with formatted grade. Shows a `Skeleton` (rounded, 80x32) while grade format is loading.
- Board types row: small outlined `Chip` per board type (capitalised).
- Grade distribution card: `CssBarChart` at 160px height (120px mobile), gap 3, with legend row below (10x10 colour squares + caption labels from `SESSION_GRADE_LEGEND`).

**Summary text builder** (`buildSessionSummaryParts`):

Produces an array of human-readable strings for collapsed pill display: flashes count, non-flash sends count, attempts count, total climb count, and hardest grade (formatted). Used by `CollapsibleSection` in embedded mode.

### Session Summary Dialog

The session summary appears when a session ends, displayed as a `Dialog` (`session-summary-dialog.tsx`) wrapping a `SessionSummaryView`.

**Dialog:**

- `maxWidth="sm"`, `fullWidth`.
- Title changes based on how the session ended: `summary.dialogTitle` for manual end, `summary.autoFinishedDialogTitle` when auto-finished after inactivity.
- Actions row: optional "Save to Apple Health" button (outlined, `FavoriteOutlined` icon) when HealthKit is available, plus a "Done" contained button.
- HealthKit auto-sync: if the user has enabled auto-sync (`useHealthKitAutoSync`), the workout is saved automatically on first dialog open via `useEffect`. Button states: saving, saved, error (retry).

**Session Summary View (`SessionSummaryView`):**

- Header stat cards: three side-by-side `Card` components with `flex: 1, minWidth: 120`:
  - Total Sends: `h4` primary colour, bold 700 weight.
  - Total Attempts: `h4` default colour, bold 700 weight.
  - Duration: `h5` with `TimerOutlined` icon, bold 700 weight. Only shown when `durationMinutes` is set. Formatted same as overview panel.
- Goal card: `FlagOutlined` icon + "Goal" label + goal text. Only shown when set.
- Hardest climb card: `EmojiEventsOutlined` icon (warning colour) + "Hardest send" label + climb name (bold 600) + grade `Chip` with vivid colour from `getGradeColor` and white text.
- Grade distribution card:
  - Title: `subtitle2` "Grade distribution".
  - Each grade row: grade label (40px min-width, right-aligned, bold 600) + `LinearProgress` bar (16px height, rounded, width proportional to `count / maxGradeCount`) with vivid grade colour + count number (20px min-width).
  - Skeleton placeholders while grade format loads.
- Participants card:
  - Title: `subtitle2` "Participants".
  - Dense `List`: each participant has a 32x32 `Avatar` (image or `PersonOutlined` fallback), display name (bold 600 `body2`), and "X sends / Y attempts" caption.

### Session Detail Page (`/session/[sessionId]`)

A server-rendered page that fetches session data via GraphQL (`GET_SESSION_DETAIL`) and renders `SessionDetailContent`.

**Metadata generation:**

- Title: `{sessionName} | Boardsesh`.
- Description: includes participant names and send count, or a fallback.
- OG image: dynamic via `/api/og/session?sessionId=...` with version-based cache busting.
- Canonical URL: `/session/{sessionId}`.
- Twitter card: `summary_large_image`.

**`SessionDetailContent` (`session-detail-content.tsx`):**

This component serves two modes:

1. **Standalone page** (`embedded=false`): full-page layout with header bar, social features, and climb list.
2. **Embedded in drawer** (`embedded=true`): compact layout with collapsible sections, used inside `SeshSettingsDrawer`.

**Standalone page layout:**

- Back button (`ArrowBackOutlined`, links to `/`).
- Session name (`h6`, truncated) or auto-generated name from `generateSessionName(firstTickAt, boardTypes)`.
- Date subtitle (`caption`, formatted as "Wed, Jan 15, 2025").
- Share button (`IosShare` icon) using `shareWithFallback`.
- Share button: opens the native share flow or copies the session URL.
- `SessionOverviewPanel` in full mode.
- Session-level social row: `VoteButton` (like only) + comment toggle (`ChatBubbleOutlineOutlined` with comment count badge) + collapsible `CommentSection`.
- HealthKit save button (for participants only).
- Divider, then "Climbs (N)" heading.
- `ClimbsList` with tick details rendered below each climb via `renderItemExtra`. Tick details show per-user rows in multi-user sessions: avatar, name, status chip (flash=success, send=primary, attempt=outlined), attempt text, vote button, comment toggle, and delete button (own ticks only, with `ConfirmPopover`).
- Clicking a climb calls `navigateToClimb`: in solo mode sets it as current climb via queue actions, in party mode skips `setCurrentClimb` to avoid yanking the wall. Non-embedded mode fetches a redirect URL from `/api/internal/climb-redirect`.

**Embedded mode layout:**

- `SessionOverviewPanel` in compact mode (board thumbnail + angle selector).
- `CollapsibleSection` with three pill-shaped sections:
  - **Invite** (key: `'invite'`): share link text, share button (`IosShare`), QR toggle (`QrCode2Outlined`). QR code rendered via `QRCodeSVG` at 180px, level M. Tour mode shows a disabled preview with a non-URL QR payload.
  - **Activity** (key: `'activity'`): summary parts as pill text, expands to full `ClimbsList` with tick details. Shows "No climbs yet" when empty.
  - **Analytics** (key: `'analytics'`): grade count summary, expands to `CssBarChart` with legend. Shows "Log some climbs" when empty.
- `tourActiveSection` prop can force a specific section open and disable user interaction with headers (used by onboarding tour).

### Session Settings Drawer

The `SeshSettingsDrawer` (`sesh-settings-drawer.tsx`) is the session management panel opened from the session mini-bar.

**Header:**

- Board thumbnail (36px square, rounded 6px).
- Session name (bold `subtitle1`, truncated with ellipsis).
- Live timer (`monospace`, bold 600, secondary colour) via `useSessionTimer`.
- Stop button (`StopCircleOutlined`, error colour) or close button (`CloseOutlined`) when stopped/touring.

**Body:**

- When loading: centred `CircularProgress` (28px).
- When error: `Alert` with severity "warning".
- Delegates to `SessionDetailContent` in embedded mode with invite content, angle change handler, and named board name.
- Uses `useSessionDetail` hook to fetch live data; falls back to a constructed `SessionDetail` from persistent session state while loading.

**Angle change:** replaces the angle segment in the current URL pathname, preserving query string from `window.location.search`.

**Stop session:** calls `deactivateSession()` + `clearClimbSessionCookie()`, toggles to stopped state showing close button instead of stop button.

**Tour mode:** accepts `tourMockSession` prop (a `SessionDetail` with fake participants and ticks from `getMockSessionDetail()`) and `tourActiveSection` to force collapsible sections during onboarding.

### Session Join Flow (`/join/[sessionId]`)

**Server-side (`page.tsx`):**

- Generates rich OG metadata: title "Join {leaderName}'s session | Boardsesh" or "Join a climbing session | Boardsesh", description with send count and board info, OG image via `/api/og/session?sessionId=...&variant=join`.
- `robots: { index: false, follow: true }` (join pages are not indexed).
- Renders a `<noscript>` fallback with `<meta httpEquiv="refresh">` pointing to `/api/internal/join/{sessionId}`.

**Client-side (`JoinRedirect`):**

- Full-screen centred layout: `CircularProgress` (48px) + "Joining session..." text.
- `useEffect` immediately sets `window.location.href` to the join API endpoint.
- The API endpoint handles session joining server-side and redirects the user to the board page with the session cookie set.

**Mobile adaptation:**

- Deep link handling: `/join/{sessionId}` URLs should be registered as universal links / app links.
- The join flow can use `expo-linking` to handle the deep link and call the `joinSession` mutation directly.
- Show a native loading screen during the join process.
- On success, navigate to the board page with the session activated.

### Data Layer

| Operation                              | Type     | Purpose                                                         |
| -------------------------------------- | -------- | --------------------------------------------------------------- |
| `createSession`                        | Mutation | Creates a new session with form data and board path             |
| `joinSession`                          | Mutation | Adds the current user to an existing session                    |
| `endSession` / `endSessionWithSummary` | Action   | Ends the active session and fetches summary                     |
| `deactivateSession`                    | Action   | Deactivates the session locally without ending it on the server |
| `sessionDetail`                        | Query    | Fetches full session data including ticks, participants, stats  |
| `sessionSummary`                       | Query    | Fetches end-of-session summary data                             |
| `nearbySessions`                       | Query    | Lists discoverable sessions near the user                       |
| `mySessions`                           | Query    | Lists sessions the user has participated in                     |

---
