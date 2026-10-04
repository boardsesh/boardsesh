## 9. Feed

### 9.1 Feed Page (`/feed`)

The feed is the social hub of the app. It uses three tabs with URL-based state (`?tab=sessions|proposals|comments`).

**Global controls:**

- **Board Filter Strip** (authenticated only): Same horizontal chip row as the library page, filtering all feed content by board.
- **Full-width Tabs**: Sessions (default), Proposals, Comments. Tab state synced to URL params.

---

### 9.2 Sessions Tab (default)

**Component:** `ActivityFeed`

**Sign-in prompt:** An info `Alert` for unauthenticated users.

**Session Feed Cards** (`SessionFeedCard`):
Each card represents a climbing session and contains:

- **Header row**: Participant avatar(s) (single `Avatar` or `AvatarGroup` max 3), participant name(s) linked to profiles, relative timestamp ("5m ago", "2h ago"), duration (e.g., "1h 30min"), session title (auto-generated from date + board types).
- **Goal** (if set): Flag icon + goal text.
- **Stats chips row** (flex wrap):
  - Flash count (amber background, lightning icon).
  - Send count (green background, check icon, excludes flashes).
  - Attempt count (neutral background, error icon).
  - Hardest grade badge (color-coded by grade).
- **Grade distribution chart**: `CssBarChart`, 80px height (60px mobile), no legend.
- **Outcome doughnut** (desktop only, min-width 768px): Flash/Send/Attempt breakdown, 120px wide.
- **Board types + climb count**: Bottom row with board names and total ticks.
- **Social row**: Like button (`VoteButton`, like-only mode) + comment button (`FeedCommentButton`).

The entire body area (below the header) links to `/session/<sessionId>`. A
board-scoped daily highlight adds `highlightTickUuid` so its social target stays
on the tick selected by that board's feed; a bare daily URL still resolves the
global highlight.

Across mobile Home and the web activity feed, board-scoped daily highlights keep
their vote and comment target on the tick selected for that board. Opening the
card shows the climber's full sessionless day, while the social row remains
attached to that selected tick.

**Empty states:**

- Authenticated, no sessions: "Follow climbers to see their activity" with "Find Climbers" button (opens `UnifiedSearchDrawer` in users mode).
- Unauthenticated, no recent activity: "No recent activity" message.

**Infinite scroll:** `useInfiniteScroll` hook with sentinel `div` and `IntersectionObserver`. Skeleton loading cards during fetch.

---

### 9.3 Proposals Tab

**Component:** `ProposalFeed`

- Paginated list of community climb proposals using `BROWSE_PROPOSALS` query.
- Each proposal rendered as a `ProposalCard` component.
- Vote buttons (Support/Oppose).
- Proposal reason and community discussion.
- Vote count with approval status (Approved/Rejected/Pending).
- Empty state: Gavel icon + "No proposals yet" message.
- Infinite scroll with sentinel.

---

### 9.4 Comments Tab

**Component:** `CommentFeed`

Each comment rendered as a `CommentFeedCard`:

- **Header**: User avatar (32x32, linked to profile), display name (linked to profile), context text ("commented on a climb"), relative timestamp (via `dayjs.fromNow()`).
- **Comment body**: Blockquote-styled box with left border, secondary background.
- **Social row**: `VoteButton` (up/down votes, not like-only), reply count.

Entity type labels map: session, climb, proposal, tick (ascent), comment, board, gym, playlist_climb.

Empty state: Chat bubble icon + "No comments yet" message.

---

### 9.5 Find Climbers Drawer

- `UnifiedSearchDrawer` opened from the empty feed state.
- Default category set to "users".
- Allows searching for climbers to follow.

**Data operations:**

- `sessionGroupedFeed` / `GET_SESSION_GROUPED_FEED` -- Cursor-paginated session feed with optional board/user filters.
- `browseProposals` / `BROWSE_PROPOSALS` -- Paginated proposals with optional board filter.
- `globalCommentFeed` / `GET_GLOBAL_COMMENT_FEED` -- Cursor-paginated global comment feed with optional board filter.
- `vote` -- Vote on entities (sessions, comments, ticks).
- `addComment` -- Add a comment to an entity.
- `voteOnProposal` -- Vote on a climb proposal.

---
