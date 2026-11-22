# Manage gym boards

The website's **Manage gym → Boards** tab offers **Delete** to the board's
owner and the owner or admin of its current linked gym. Gym editors and
community moderators do not gain deletion permission from those roles alone.
Gym management never overrides a board's privacy: a non-owner must already
have access to the board. The initial gym setup screen does not offer deletion.
Location privacy may hide a readable board's gym link; gym admins can still
delete it through the scoped board list. The backend checks the stored gym link.

**Unlink** remains a separate, board-owner-only action. It removes the gym
association while keeping the board available elsewhere. **Delete** names the
board in a confirmation dialog, initially focuses Cancel, and prevents repeated
submissions while deletion is pending. A failed deletion leaves the board
available for retry. Success refreshes the board list, gym counts, and server
content.

## Backend behavior

The existing `deleteBoard(boardUuid: ID!): Boolean!` mutation checks ownership or
administration of the active linked gym and rechecks access against the current
board after acquiring the write lock. Moving or unlinking the board, or
revoking gym administration, while a deletion waits must prevent stale gym
authority from deleting it.

Deletion soft-deletes the board and freezes catalog sync so a later import
cannot restore it. Climbs and logged ascents remain stored. Spray boards reuse
the existing spray-wall cleanup, including wall tombstones, feed retraction,
and removal of the public photo copy. That path keeps the existing account and
wall lock order before locking the board and rechecking generic deletion
access. Direct `deleteSprayWall` permissions remain unchanged.

Public queue previews are retracted according to the board's policy before
deletion, including system-owned and unlisted boards. Private preview channels
receive no deletion event.

## Checks

1. Open Manage gym → Boards as an owner or gym admin; find Delete.
2. Select Delete; confirm the dialog names the intended board.
3. Select Cancel; the board remains in the list.
4. Confirm deletion of a disposable test board; its row disappears.
5. Open the same gym as an editor; other owners' boards have no Delete.
