## 10. Notifications

### 10.1 Notification Center (`/notifications`)

**Layout:**

- Page title "Notifications" in the layout header.
- "Mark all as read" text button (right-aligned, visible only when `unreadCount > 0`).
- `List` of `NotificationItem` components with infinite scroll.
- Empty state: Bell icon (`NotificationsNoneOutlined`, 40px, neutral-300 color) + "Nothing yet" text.
- Loading state: Centered `CircularProgress` (24px).

### 10.2 Notification Item Display

Each `NotificationItem` is a `ListItem` with:

- **Background**: Transparent when read; faint primary color tint (`primary + 08` opacity) when unread.
- **Avatar area**: Single `Avatar` (40x40) for single-actor notifications; `AvatarGroup` (max 3, 28x28 each) for multi-actor notifications. Avatar shows actor's image or a type-specific fallback icon.
- **Primary text**: Actor summary + action text, bold when unread, 2-line clamp. Examples:
  - "Alice followed you"
  - "Bob and 2 others liked your tick"
  - "Carol replied to your comment: [preview]"
- **Secondary text row**: Relative timestamp + unread dot indicator.
  - Timestamp formats: "just now", "5m", "2h", "3d", or full date.
  - Blue dot: 6x6 circle with `primary` color, margin-left 0.5.

**Notification Types and Icons:**

| Type                             | Text Pattern                        | Icon                |
| -------------------------------- | ----------------------------------- | ------------------- |
| `new_follower`                   | "X followed you"                    | `PersonAddOutlined` |
| `comment_reply`                  | "X replied to your comment: [body]" | `ChatBubbleOutline` |
| `comment_on_tick`                | "X commented on your tick: [body]"  | `ChatBubbleOutline` |
| `comment_on_climb`               | "X commented on the climb: [body]"  | `ChatBubbleOutline` |
| `vote_on_tick`                   | "X liked your tick"                 | `ThumbUpOutlined`   |
| `vote_on_comment`                | "X liked your comment"              | `ThumbUpOutlined`   |
| `proposal_created`               | "X created a proposal" / hide: "X reported [name]" | `LightbulbOutlined` |
| `proposal_on_your_climb`         | "X reported your climb [name]" (hide) / "X proposed a grade change on your climb" (grade) — pick on `proposalType` | `LightbulbOutlined` |
| `proposal_approved`              | "X's proposal was approved" / hide: "The crew hid [name] after your report" | `LightbulbOutlined` |
| `proposal_rejected`              | "X's proposal was rejected" / hide: "Your report on [name] was closed without hiding it" | `LightbulbOutlined` |
| `proposal_vote`                  | "X voted on a proposal" / hide: "X agreed with your report on [name]" | `LightbulbOutlined` |
| `new_climb` / `new_climb_global` | "X added a new climb"               | `AddCircleOutline`  |
| `new_climbs_synced`              | "X new climbs synced from [setter]" | `AddCircleOutline`  |

Every hide string names the climb, so each hide branch is gated on `climbName`
and falls back to the plain proposal wording when the group carries none — the
mobile copy module (`packages/mobile/src/components/notifications/notification-copy.ts`)
cannot call `t`, so there is no fallback word to interpolate.

**Actor Summarization:**

- 1 actor: "Alice"
- 2 actors: "Alice and Bob"
- 3+ actors: "Alice and N others"

**Tap behavior:**

1. Marks the notification group as read (via `markGroupAsReadMutation`).
2. Navigates to relevant content:
   - `new_follower` -> `/profile/<actorId>`
   - `new_climbs_synced` -> `/setter/<setterUsername>`
   - Climb-related (with `climbUuid` + `boardType`) -> Fetches climb URL via `/api/internal/climb-redirect` and navigates.

**React Native adaptation:**

- Use a `FlashList` with custom `renderItem` for notification rows.
- Unread dot via a small `View` with absolute positioning.
- Navigation via `router.push`.
- Tap haptic feedback.

**Data operations:**

- `groupedNotifications` / `useGroupedNotifications` -- Cursor-paginated grouped notifications.
- `unreadNotificationCount` / `useUnreadNotificationCount` -- Badge count for tab bar / header.
- `markNotificationRead` -- Mark a single notification as read.
- `markGroupNotificationsRead` / `useMarkGroupAsRead` -- Mark a notification group as read.
- `markAllNotificationsRead` / `useMarkAllAsRead` -- Mark all notifications as read.
- `notificationReceived` subscription -- Real-time notification delivery.

---
