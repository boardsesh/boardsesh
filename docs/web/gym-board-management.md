# Manage gym boards

Who may change which board is decided in `docs/product/gym-board-governance.md`
(decision 1). In short: a board belongs to the climber who made it, and a gym
listing belongs to the gym.

- **Remove from gym** is the staff tool for a climber's board. The gym's owner,
  admins and editors, and a community admin or leader covering the gym, can take
  a climber's board off the gym's listing. The board stays with its creator.
  A synced (SYSTEM) board can't be removed, except by a global admin: the gym's
  owner or admin deletes it instead.
- **Delete** is for the board's creator; for the gym's owner and admins on a
  synced (SYSTEM) board at their gym; and for a global admin on any board. Gym
  staff can no longer delete a climber's board (they could from #8007 until
  this change).
- The creator's own Remove from gym is an unlink (`linkBoardToGym` with no
  gym). Both clients show it as the same **Remove from gym** action.

The backend says which action a viewer has on every board:
`UserBoard.canDelete` and `UserBoard.canRemoveFromGym`. Both clients read these
flags and never rebuild the rule. Every document that selects `BOARD_FIELDS` or
`GYM_BOARD_FIELDS` asks for them.

Gym management never overrides a board's privacy: a non-owner must already be
able to read the board. Location privacy may hide a readable board's gym link;
the backend checks the stored gym link.

## Manage gym → Boards on www

`components/gym-entity/manage/gym-boards-tab.tsx`. The tab opens directly with
`/gym/{slug}/manage?tab=boards`; a domain claim's success page and the claim
dialog's approved state link there ("Check your boards").

- **Header.** "Climbers and public board data put these boards here. Fix any
  that are wrong, and remove the ones that aren't on your walls." Owners and
  admins get **Add a board** (link one of their own boards). Everyone else with
  edit access (editors, community roles) reads: "The owner and admins add their
  own boards and delete boards. You can remove boards that aren't on your walls
  and add ones near your gym."
- **Where a board came from.** Each row's second line says "Added by you",
  "Added by {name}", "Added by a climber" (the creator's privacy hides their
  name, and the server sends no owner id either) or "From public board data"
  (owned by the SYSTEM account, `SYSTEM_BOARD_OWNER_ID` in
  `@boardsesh/shared-schema`). The rule is `boardOriginFor`, shared with the
  app's confirms. The rows come from `GET_GYM_BOARDS_FOR_MANAGE`, which adds
  `ownerDisplayName` to `GYM_BOARD_FIELDS`. That fragment stays without it
  because the anonymous leaderboard embed selects it.
- **Remove from gym** shows when `canRemoveFromGym`. Not red. The confirm reads
  "Remove {board} from {gym}?" and says who keeps it: "It stays in your boards"
  for the creator, "{name} keeps it in their boards" for staff. The creator's
  removal runs `linkBoardToGym` with no gym; anyone else's runs
  `detachBoardFromGym`. A synced board has no Remove for gym staff (Delete
  instead); if the server still refuses with `SYSTEM_BOARD_DELETE_INSTEAD`, the
  snackbar says to delete it.
- **Delete** shows when `canDelete`. The confirm reads "Delete {board} for
  everyone?", names who added it, and says logged sends stay in their
  logbooks. It initially focuses Cancel and blocks repeated submissions while
  pending. A failed deletion leaves the board available for retry. Success
  refreshes the board list, gym counts, and server content.
- **Boards near your gym** (strays) lists boards within about 150 m, or left
  by a merged listing, for anyone with gym edit access. **Add to gym** attaches
  one.
- **`BOARD_REMOVED_BY_GYM`** on a link shows "This gym's staff took this board
  off their listing. Ask them to put it back." The app's board editor shows the
  same line when a creator re-picks the gym.

- **Reported boards** (docs/product/directory-reports.md). A row with waiting
  reports the viewer can act on (`openReportCount`, selected by
  `GET_GYM_BOARDS_FOR_MANAGE`) carries a **Reported** chip and a **Review**
  button, and reported rows sort first. Review
  (`board-report-review-dialog.tsx`) reads `boardReports` and lists each
  reason with its climber count and what they said, never who: reporters are
  anonymous to creators and staff, and the dialog never renders a name even
  for a global admin. Its actions are the row's own: **Fix the setup** opens
  the editor (`canEdit`), **Remove from {gym}** and **Delete board** open the
  tab's confirms (`canRemoveFromGym`, `canDelete`), and **It's right as it is**
  closes every waiting report the viewer may close as `kept`, with an optional
  note the reporters receive. A report in the admin queue (routed to the team,
  or open 14 days) is shown with "Our team is looking at this one" and can't
  be kept here; one still with the creator or staff shows the date it moves
  to the team.
- **Suggested setups.** A "Set up wrong" report whose reporters picked a
  setup lists it under the report, grouped by equal setup ("2 climbers
  suggested Original · 12×14 · Commercial · Bolt Ons"), with **Use this
  setup** for a viewer who may edit the board (`canEdit`). It sends
  `updateBoard` with that layout, size, sets and, on a board that doesn't
  tilt, angle (`suggestedSetupUpdateInput`; the grouping and the "has this
  setup now" check are `groupSuggestedSetups` and `setupMatches`, all in
  `@boardsesh/directory-moderation` and shared with the app), which closes
  the board's "Set up wrong" reports as fixed. A save that would copy another
  board of the same owner opens the edit form's duplicate prompt
  (`duplicate-board-config-dialog.tsx`); Save anyway sends
  `allowDuplicateConfig`. A suggestion the board already has reads "The board
  has this setup now". While a Use this setup button shows, Fix the setup
  reads **Edit it yourself**. While a setup saves, every other answer (the
  other Use this setup buttons, Edit it yourself, Remove, Delete, It's right
  as it is, and the keep step's Send) is disabled and its handler refuses, so
  a report never closes as kept while its setup changes.

`gym-board-permissions.ts` keeps only `canManageGymBoards` (owner or admin: who
may link their own boards) and `linkableBoards`.

## Manage gym for someone who can't manage it

A signed-in climber who opens `/gym/{slug}/manage` on a public gym they can't
edit gets "You can't edit this gym" and who can, from `Gym.listingState`:
"{gym} staff run this listing", "{name} added this gym, so they can change it",
or "Nobody runs this gym on Boardsesh yet" (`manage-no-access.tsx`). Then
**Claim this gym** (when `canClaim`, the claim dialog), **Report a problem**
(while the `directory-reports` flag is on) and **Back to {gym}**.

## The board menu in the app

The picker's board menu (`board-card-menu.ts`) draws Edit from `canEdit`,
**Remove from {gym}** from `canRemoveFromGym` (with the gym's name), and Delete
from `canDelete`. A board read before the flags existed (an older offline
snapshot) falls back to the owner-only rule. A board the viewer follows and
doesn't own offers **Remove from your boards**, which only touches their own
list and is not red. Delete is the only red row, and its confirm says "for
everyone" and that logged sends stay. Staff removal runs `useDetachBoardFromGym`.

## Backend behavior

### Delete

`deleteBoard(boardUuid: ID!)` runs `requireBoardDeleteAccess`: the creator; the
owner or an admin of the board's live linked gym when the board is owned by
SYSTEM; or a global admin (a `community_roles` admin row with no board type). A
board-scoped admin, a community leader and a gym editor never qualify. A
non-owner must pass the board's read check, so admin status does not reveal a
private board by uuid. The gate runs again after the write lock is taken, so
moving or unlinking the board, or revoking gym administration, while a deletion
waits prevents stale authority from deleting it.

Deletion soft-deletes the board and freezes catalog sync so a later import
cannot restore it. Climbs and logged ascents remain stored. Spray boards reuse
the spray-wall cleanup, including wall tombstones, feed retraction, and removal
of the public photo copy. `deleteSprayWall` applies the same gate, read check
included, after its account and wall locks; before this change it used the
wider edit gate and skipped the read check.

Public queue previews are retracted according to the board's policy before
deletion, including system-owned and unlisted boards. Private preview channels
receive no deletion event.

### Remove from gym

`detachBoardFromGym` is gated on `requireGymEditAccess` for the gym, and the
board must be listed there. It clears `gym_id` and sets `sync_frozen_at`, so the
hourly location sync cannot write a synced board's gym link back.

A synced (SYSTEM) board is refused with `SYSTEM_BOARD_DELETE_INSTEAD` and "This
board comes from public board data. Delete it instead, or report it.", unless
the caller is a global admin. Removed, it would be a frozen pin with no gym that
"boards near your gym" hides and only a global admin could delete.
`UserBoard.canRemoveFromGym` is false for it on the same terms.

A removal by anyone but the board's creator holds the board off that gym: the
creator's `linkBoardToGym` (and `updateSprayWall` with a gym) to the same gym is
refused with `BOARD_REMOVED_BY_GYM` and "This gym's staff took this board off
their listing. Ask them to re-list it." The board also stops appearing under
"boards near your gym" (`strayBoardsForGym`). Staff lift the hold by putting
the board back: `attachBoardToGym` with its uuid, or, when the staff member owns
the board, `linkBoardToGym` on the gym's staff path. The uuid re-list works only
while the board is unlinked, its location is not hidden, and its creator has not
linked or unlinked it anywhere since the removal. The creator's link is checked
again under the board's row lock, so a removal that lands while it waits wins.

### The record

Every staff action on a board is written to `board_moderation_events`, in the
same transaction as the change: `removed_from_gym`, `deleted` (by anyone but the
creator), `edited_by_staff` (`updateBoard`, `adminUpdateBoard` and the spray-wall
edits a climber sees: details, look, commit, publish and discard of a draft, each
with the changed fields or the mutation name) and `relinked`. Each row keeps the
role the actor used. The creator's own gym link changes are recorded too, as
`board_owner` rows, so a re-list can see them. The latest `removed_from_gym` or
`relinked` row for a board and gym, by `id`, decides the hold.

## Checks

1. Open Manage gym → Boards as a gym admin; a synced board offers Delete and
   reads "From public board data".
2. A climber's board offers Remove from gym and no Delete; its row names who
   added it.
3. Remove a climber's board from the gym; it leaves the list.
4. As its creator, link it back in the app; the editor names the gym's staff.
5. Open the same gym as an editor; no board offers Delete, and the hint says
   what an editor can do.
6. With the `directory-reports` flag on, report a board from the gym page as a
   climber; as the gym's admin, the board sits first in Manage gym → Boards
   with a Reported chip, and Review lists the reason without the reporter's
   name.
7. Open Manage gym for a gym you don't run; the page says who runs it and
   offers Claim this gym and Report a problem.
