## 8. Profile

### 8.1 Main Profile Page (`/profile/[user_id]`)

**User Card** (top):

- 80x80 `Avatar` with profile image (or `PersonOutlined` fallback).
- Display name (`h6`) beside the avatar.
- Follow/Unfollow button (for other users' profiles) using `FollowButton` with `FOLLOW_USER` / `UNFOLLOW_USER` mutations. Optimistic follower count update.
- `FollowerCount` component showing follower/following counts. Tapping opens a follower/following list drawer.
- Email address (own profile only, body2, secondary text).
- Instagram link (if set): Instagram icon + formatted handle (strips URL prefix). External link, opens in new tab.

**Activity Overview** (last 3 months):

- A `CssBarChart` showing weekly activity bars. Built from all boards' tick data via `buildWeeklyBars`. Height 100px (80px mobile). No legend.

**Beta Videos Section**:

- `ProfileBetaSection` component showing beta videos contributed by this user.

**Navigation Cards** (vertical stack, 1.5 spacing):
Three `ProfileNavCard` components, each a `Card` with icon, title, subtitle, and chevron-right:

| Card           | Icon                    | Route                      | Subtitle                                   |
| -------------- | ----------------------- | -------------------------- | ------------------------------------------ |
| Statistics     | `ShowChartOutlined`     | `/profile/<id>/statistics` | "X sends logged" or "Start climbing"       |
| Sessions       | `TimelineOutlined`      | `/profile/<id>/sessions`   | "Activity and session history"             |
| Created Climbs | `FitnessCenterOutlined` | `/profile/<id>/climbs`     | "Climbs you've set" / "Climbs they've set" |

**React Native adaptation:**

- `ScrollView` with vertical layout.
- Avatar, name, and follow button in a horizontal row.
- Navigation cards as `Pressable` rows with `router.push`.
- Activity chart as a simplified bar chart using `react-native-svg` or similar.

---

### 8.2 Statistics Sub-page (`/profile/[user_id]/statistics`)

**Filter controls:**

- Header injects a filter button via `StatsFilterBridgeInjector`.
- `StatsFilterDrawer` bottom sheet with:
  - Board selector (all boards or specific board).
  - Timeframe selector (All time, Last 3 months, Last 6 months, Last year, Custom).
  - Custom date range (from/to date pickers).
- Active filter indicator in the header.

**Stats Summary** (`StatsSummary` component):

- Hardest send grade and hardest flash grade.
- Total ascents, total sessions.
- Percentile ranking vs other climbers (from `userClimbPercentile` query).
- Weekly activity bar chart (`CssBarChart`).
- Aggregated grade distribution stacked bar chart.
- Flash vs Redpoint breakdown bar chart.
- V-Points progression timeline chart.

**Board Stats Section** (`BoardStatsSection` component):

- Per-board breakdown when a specific board is selected.
- Grade distribution by board layout with color-coded bars.
- Filtered logbook entries.

---

### 8.3 Sessions Sub-page (`/profile/[user_id]/sessions`)

- Uses `ProfileSubPageLayout` wrapper.
- Renders `ActivityFeed` component filtered by `userId`.
- Shows session cards from this user's climbing history (same `SessionFeedCard` used in the main feed).
- Each session card: participant avatars, relative time, duration, climb count, sends/flashes/attempts chips, hardest grade badge, grade distribution bar chart, outcome doughnut (desktop only), board types, like/comment buttons.

---

### 8.4 Created Climbs Sub-page (`/profile/[user_id]/climbs`)

- Uses `ProfileSubPageLayout` wrapper.
- Renders `UserClimbList` component filtered by `userId`.
- List of climbs created/set by this user.
- Board/layout filter available.
- Tapping a climb navigates to climb detail.

---

### 8.5 Personal Dashboard (`/you`)

- Progress dashboard with personal stats and charts.
- Tab navigation: Progress, Sessions, Logbook.
- Requires authentication (redirects to home if not logged in).

**Current mobile Profile tab:**

- Progress starts with an all-board, all-time overview: distinct climbs sent,
  layout count, and three ranked layout rows with counts and best-send grades.
  The remaining layouts expand inline in the virtualized list.
- Board/time filters live with the detailed Progress section below this lifetime
  overview. Activity includes attempts; lifetime records are labeled separately
  from filtered charts.
- Logbook displays canonical board/layout identity on every climb row, including
  when a day heading already names a custom wall. One history covers all boards.
- Session detail leads with board/date/participants and Sends/Hardest, followed
  by the grade chart, full notes, and existing session content.

**Data operations:**

- `publicProfile` -- Profile data for any user.
- `userProfileStats` -- Aggregated statistics (total ascents, sessions, grade distribution).
- `userClimbPercentile` -- Percentile ranking among all climbers.
- `userAscentsFeed` -- Paginated ascent feed for a user.
- `userGroupedAscentsFeed` -- Grouped ascent feed by session.
- `followers` / `following` -- Follower/following lists.
- `isFollowing` -- Whether the current user follows the target.
- `followUser` / `unfollowUser` -- Follow/unfollow mutations.
- `userBetaLinks` -- Beta videos contributed by the user.
- `sessionGroupedFeed` -- Session-grouped feed filtered by user.
- `userClimbs` -- Climbs created by the user.
- `setterProfile` / `setterClimbs` -- Setter-specific profile and climbs.

---
