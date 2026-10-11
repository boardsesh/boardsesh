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
4. (Removed in #6004: this step set a `boardsesh-climb-session-id` cookie. Nothing read it after the climbing UI moved to the app, and the helper is deleted.)
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

**Stop session:** calls `deactivateSession()`, toggles to stopped state showing close button instead of stop button.

**Tour mode:** accepts `tourMockSession` prop (a `SessionDetail` with fake participants and ticks from `getMockSessionDetail()`) and `tourActiveSection` to force collapsible sections during onboarding.

### Session Join Flow (`/join/[sessionId]`)

**Server-side (`page.tsx`), since #6004:**

The page is what someone sees when they were sent an invite and have no app. A phone with the app never reaches it: the universal link (iOS) and the `/join` App Link (Android) open the app's join screen first.

- Generates rich OG metadata: title "Join {leaderName} on the wall | Boardsesh" or "Join the crew on the wall | Boardsesh", description with send count and board info, OG image via `/api/og/session?sessionId=...&variant=join`.
- `robots: { index: false, follow: true }` on every branch (join pages are not indexed).
- Looks the invite up through the backend's unauthenticated `sessionInvitePreview` query (`session-invite.ts`) and renders inside `PageShell`:
  - **live / dormant**: who started it, the board (and angle), the gym when there is one, both store buttons, and an "Open in the app" button for someone who already has it. A dormant session says nobody is connected right now and that it can still be joined.
  - **ended**: "This session has ended", with the store buttons under "Start your own session".
  - **not found** (unknown or malformed id): "We can't find this session", same store buttons.
  - **lookup failed** (backend down or rate limited): the invite without details. Never "not found".
- Always a 200. A missing session still has something to offer the visitor, which a 404 page would not.

**Client islands:**

- `SessionInviteInstallCta`: both store buttons, always, as real anchors. Links come from `buildStoreUrl` with `placement: 'join-page'`, campaign `session-invite`, and the session id in the Google Play link id (`utm_content=join-page.<session id>`). The App Store token stays `join-page`. Each click fires `App Install Click` with `placement: 'join-page'` and `sessionId`.
- `SessionInviteOpenApp`: an anchor to `com.boardsesh.app://join/{sessionId}`, shown for a live, dormant or lookup-failed invite. A link tapped inside another app's built-in browser (Instagram, WhatsApp) skips the universal link and the App Link, so the phone never offers the app; this link asks for it by the app's own scheme. Fires `Session Invite Open In App Clicked`. Without the app it opens nothing, so it sits below the store buttons as the secondary action.
- `SessionInviteLandingTracker`: one `Session Invite Page Viewed` per landing (`sessionId` unless the state is `not_found`, `state`, `hasHost`, `hasGym`), sent through `trackBeforeNavigation` so it is flushed before a store button or the app takes the visitor away.

Removed in #6004: the `JoinRedirect` spinner, the `/api/internal/join/{sessionId}` 307 to the board list, and the `boardsesh-climb-session-id` cookie that route and the middleware's `?session=` rewrite set. The rewrite still strips `?session=` from old URLs; it no longer keeps the id.

**In the app (`packages/mobile/app/join/[sessionId].tsx`):**

- A phone with the app opens this screen from the invite link (universal link, App Link, or the app's own scheme). It needs sign-in; a signed-out invitee is sent to login and the link is replayed afterwards.
- It asks `session` first. When that is null (nobody connected) it asks `sessionInvitePreview`:
  - **live**: the host connected between the two reads. `session` is asked once more; if it still has nothing, the join card shows with the board and no climber count.
  - **dormant**: the join card, with "nobody connected right now" in place of the climber count.
  - **host away**: the session is running, nobody is connected, and the backend withheld the board path (a spray wall that is not open to everyone). The screen says the host has to open Boardsesh and offers a retry. Once the host is connected, `session` answers with the path and the join card shows.
  - **ended**: "This session has ended".
  - **not found**: neither query knows the id.
- Dead ends fire `Session Join Outcome`; a join fires `Session Joined`. See `docs/growth-metrics.md`.

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
