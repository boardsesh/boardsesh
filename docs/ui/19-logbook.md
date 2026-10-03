## 12. Logbook

### 12.1 Personal Ascents List

**Component:** `LogbookView` (per-climb view within the play/detail screen)

Displays ascents for a specific climb filtered from the user's logbook. Sorted newest-first by `climbed_at`.

**Logbook Entry Card** (`LogbookEntryCard`):
Each card is a full-width `Card` containing:

- **User row** (crew logbook mode only): 32x32 avatar linked to profile + display name.
- **Primary info row** (flex wrap):
  - Date/time in absolute format ("MMM D, YYYY h:mm A").
  - Angle chip (e.g., "40 degrees", primary color).
  - Ascent status icon (Flash / Send / Attempt via `AscentStatusIcon`).
  - Mirrored chip (Tension boards only, secondary color, only when `isMirror` is true).
- **Quality rating**: Read-only `Rating` (1-5 stars, small size). Only shown for successful ascents with quality > 0.
- **Attempt count**: "X attempts" text.
- **Comment**: Pre-wrapped secondary text.
- **Social row** (only for persisted ticks with `tickUuid`):
  - `VoteButton` (like-only mode) with initial up/down votes.
  - `FeedCommentButton` with comment count.

Wrapped in `VoteSummaryProvider` for bulk vote state hydration (max 100 tick UUIDs per batch).

### 12.2 Crew Logbook View

**Component:** `CrewLogbookView`

Shows logs from followed users on the same climb. Uses `GET_FOLLOWING_CLIMB_ASCENTS` query, which returns the 100 newest logs (`items`, newest first, every angle, attempts included), `hasMore`, and a `summary` (`climberCount`, `senderCount`, and the same pair per angle in `byAngle`) that is not bound by the 100-row cap. Take header counts from `summary`, never from `items.length`. Show `effectiveQuality` (the tick's own stars, or the climber's synced rating for that climb and angle; sends and flashes only). Logs on a spray wall the viewer cannot see are left out of both the list and the counts. Logs stored under a uuid that was deduplicated into the climb are included in both, and keep their own `climbUuid` on the item, so do not filter items by the uuid you asked with. Each entry rendered as `LogbookEntryCard` with user info (avatar, name). Empty states: sign-in prompt, load error, "No crew ascents yet".

### 12.3 Logging an Ascent (Tick)

**Component:** `LogAscentForm`

**Type toggle:** Full-width `ToggleButtonGroup` with "Ascent" and "Attempt" options.

**Form fields (label-value rows, 120px label width):**

| Field         | Component                     | Details                                                                                                                       |
| ------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Boulder       | Text + optional Mirrored chip | Climb name (bold), mirror toggle chip (Tension boards only) with tooltip                                                      |
| Date and Time | `DateTimePicker`              | Defaults to now, small size                                                                                                   |
| Angle         | `Select` with angle options   | Board-specific angles, defaults to effective angle from route/party/climb. Error state when null. 0 degrees is a valid angle. |
| Attempts      | `TextField` type number       | Min 1, max 999, default 1. Flash = 1 attempt, Send = 2+ attempts                                                              |
| Quality       | `Rating` (ascent only)        | 1-5 stars, default 0                                                                                                          |
| Difficulty    | `Select` (ascent only)        | Grade override dropdown, "No override" default                                                                                |
| Notes         | `TextField` multiline         | 3 rows, optional                                                                                                              |
| Beta Video    | `TextField` (ascent only)     | URL input, validated against TikTok/Instagram/YouTube patterns. Helper text shown.                                            |

**Submit button:** Full-width, large, contained. Text shows "Log at X degrees" when angle is set, or generic "Log" when not. Disabled when saving, video URL invalid, or angle is null.

**Cancel button:** Full-width, large, outlined.

**Wall Drift Banner:**

- Warning `Alert` shown when the party session's current climb differs from the one being logged.
- Shows which climb is on the wall vs. which is being logged.
- "Switch to [climb name]" outlined button (with dirty-form confirmation via `window.confirm`).
- Dismissable via close button.

### 12.4 Logbook Feed (Library Page)

**Component:** `LogbookFeed` (within the library/playlists page context)

Full logbook browser with:

**Search and Filters** (`LogbookSearchForm`):

- Search text field with magnifying glass icon.
- Board filter strip (same as other pages).
- Collapsible filter sections:
  - **Grade range**: Min/max grade pickers using `InlineGradePicker`.
  - **Result type**: Sends/Attempts toggles, Flash only, Benchmark only switches.
  - **Date range**: From/To date pickers.
  - **Angle range**: Slider for angle range filter.
- **Sort options**: Field selector (Newest, Hardest, Most Attempts, etc.) with direction toggle (ascending/descending).

**Feed Items** (`LogbookFeedItem`):
Swipeable cards with:

- Climb thumbnail (`AscentThumbnail`).
- Board/layout display name.
- Climb name, grade, ascent status icon.
- Date, angle, attempt count, quality stars.
- Comment preview.
- Climb icons (benchmark, mirror).
- Swipe actions: Edit (left swipe), Delete (right swipe).
- Inline editing: Star picker, grade picker, attempts picker, comment field.
- Three-dot menu: Edit, Delete, Post to Instagram, Attach Beta Video.

**Export:**

- Download button for per-board JSON export via backend API.

**Data operations:**

- `ticks` / `userTicks` -- User's tick/ascent data (used by `BoardProvider`).
- `userAscentsFeed` / `GET_USER_ASCENTS_FEED` -- Paginated ascent feed with filters (board, grade range, status, date range, angle range, sort).
- `saveTick` -- Creates a new tick/ascent.
- `updateTick` / `useUpdateTick` -- Updates an existing tick (quality, grade, attempts, comment).
- `deleteTick` / `DELETE_TICK` -- Deletes a tick.
- `attachBetaLink` -- Attaches a beta video URL to a tick.
- `followingClimbAscents` / `GET_FOLLOWING_CLIMB_ASCENTS` -- The 100 newest logs from followed users on a specific climb, plus `hasMore` and a `summary` of climber and sender counts (overall and per angle) that covers all of them. Signed-in only, 120 requests a minute.

---
