# Manage gym boards

Who may change which board is decided in `docs/product/gym-board-governance.md`
(decision 1). In short: a board belongs to the climber who made it, and a gym
listing belongs to the gym.

- **Remove from gym** is the staff tool for a climber's board. The gym's owner,
  admins and editors, and a community admin or leader covering the gym, can take
  any board off the gym's listing. The board stays with its creator.
- **Delete** is for the board's creator; for the gym's owner and admins on a
  synced (SYSTEM) board at their gym; and for a global admin on any board. Gym
  staff can no longer delete a climber's board (they could from #8007 until
  this change).
- **Unlink** is the creator's own version of Remove from gym.

The backend now says which action a viewer has on every board:
`UserBoard.canDelete` and `UserBoard.canRemoveFromGym`. The website's
**Manage gym → Boards** tab still rebuilds the old delete rule in
`gym-board-permissions.ts` until the client change that reads these fields
lands; until then a Delete on a climber's board is refused by the backend.

Gym management never overrides a board's privacy: a non-owner must already be
able to read the board. Location privacy may hide a readable board's gym link;
the backend checks the stored gym link. **Delete** names the board in a
confirmation dialog, initially focuses Cancel, and prevents repeated submissions
while deletion is pending. A failed deletion leaves the board available for
retry. Success refreshes the board list, gym counts, and server content.

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

A removal by anyone but the board's creator holds the board off that gym: the
creator's `linkBoardToGym` (and `updateSprayWall` with a gym) to the same gym is
refused with `BOARD_REMOVED_BY_GYM` and "This gym's staff took this board off
their listing. Ask them to re-list it." The board also stops appearing under
"boards near your gym" (`strayBoardsForGym`). Staff lift the hold by putting
the board back: `attachBoardToGym` with its uuid, while it is still unlinked,
or, when the staff member owns the board, `linkBoardToGym` on the gym's staff
path.

### The record

Every staff action on a board is written to `board_moderation_events`, in the
same transaction as the change: `removed_from_gym`, `deleted` (by anyone but the
creator), `edited_by_staff` (`updateBoard`, `adminUpdateBoard` and the spray-wall
edits a climber sees: details, look, commit, publish and discard of a draft, each
with the changed fields or the mutation name) and `relinked`. Each row keeps the
role the actor used. The latest `removed_from_gym` or `relinked` row for a board
and gym decides the hold.

## Checks

1. Open Manage gym → Boards as a gym admin; a synced board offers Delete.
2. Delete a climber's board as a gym admin; the backend refuses it.
3. Remove a climber's board from the gym; it leaves the list.
4. As its creator, link it back; the app names the gym's staff.
5. Open the same gym as an editor; no board offers Delete.
