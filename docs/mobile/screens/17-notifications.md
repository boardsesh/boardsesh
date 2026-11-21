# Mobile notifications

`packages/mobile/src/components/notifications/NotificationsScreen.tsx` is shared
by Home and Profile stacks. A bell opens it inside the current stack so Back
returns to the caller. The list is a FlashList with separate recycling types for
climb thumbnails, ordinary avatar rows, and follow requests.

Grouping is server-side by type and entity; the client flattens cursor pages.
Mark all as read appears when there are unread notifications. Follow requests
provide Approve/Decline actions. Offline/unavailable, failed, loading, and empty
states use the screen's query-state handling.

## Notification copy

The table records the notification meanings; native glyph selection belongs to
`NotificationRow` and copy selection to `notification-copy.ts`.

| Type                             | Text Pattern                        |
| -------------------------------- | ----------------------------------- |
| `new_follower`                   | "X followed you"                    |
| `comment_reply`                  | "X replied to your comment: [body]" |
| `comment_on_tick`                | "X commented on your tick: [body]"  |
| `comment_on_climb`               | "X commented on your climb: [body]" / no body: "X commented on your climb [name]" |
| `comment_on_session`             | "X commented on your session: [body]" |
| `comment_on_playlist`            | "X commented on your playlist: [body]" |
| `comment_on_board`               | "X commented on your board: [body]" / spray wall: "X commented on your Spraywall: [body]" (picked on `boardType`) |
| `comment_on_gym`                 | "X commented on your gym: [body]" / no body: "X commented on your gym [name]" |
| `vote_on_tick`                   | "X liked your tick"                 |
| `vote_on_comment`                | "X liked your comment"              |
| `proposal_created`               | "X created a proposal" / hide: "X reported [name]" |
| `proposal_on_your_climb`         | "X reported your climb [name]" (hide) / "X proposed a grade change on your climb" (grade) — pick on `proposalType` |
| `proposal_approved`              | "X's proposal was approved" / hide: "The crew hid [name] after your report" |
| `proposal_rejected`              | "X's proposal was rejected" / hide: "Your report on [name] was closed without hiding it" |
| `proposal_vote`                  | "X voted on a proposal" / hide: "X agreed with your report on [name]" |
| `new_climb` / `new_climb_global` | "X added a new climb" |
| `new_climbs_synced`              | "X new climbs synced from [setter]" |

Every hide string names the climb, so each hide branch is gated on `climbName`
and falls back to the plain proposal wording when the group carries none — the
mobile copy module (`packages/mobile/src/components/notifications/notification-copy.ts`)
cannot call `t`, so there is no fallback word to interpolate.

## Tap behavior

`use-notification-navigation.ts` marks an unread group as read before routing.
A single follower opens that profile; multiple followers open the follow-back
list. Follow requests open the requester. Comment and vote types open the
entity's comment thread using the backend's thread entity pair. Gym claim approval
opens gym editing; spray recognition results use their import route.

Proposal notifications with a proposal UUID open Moderation when enabled; otherwise
they retain the climb fallback. Other climb-bearing rows open the player using
the notification's board/render context. `new_climbs_synced` uses its supplied
climb, not an invented mobile setter-profile destination. No Next.js
`/api/internal/climb-redirect` fetch is involved.

## Data operations

The hooks in `src/lib/graphql/hooks/use-notifications.ts` own grouped reads,
unread counts, mark-group/all actions, and follow-request responses. Realtime
notification delivery updates those queries. Preserve account boundaries and
entity visibility when adding a notification type.
