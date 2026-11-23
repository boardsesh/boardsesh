# Duplicate board review

Use **Report duplicate board** on a public board to request consolidation, or
open **Moderation → Board merges** to review requests. The website and mobile
app share the same backend operation. Gym management links to this queue with
the gym selected. After merging gyms, review their boards separately: a shared
gym or controller serial does not prove that two listings are the same wall.

## Which boards can merge

Only public, readable catalogue boards can merge. The board type, size and hold
sets must agree; hold-set order does not matter. Layouts must agree except for
Tension Board 2 Mirror (10) and Spray (11), which can describe the same physical
wall. Angle differences are allowed. Other layout differences represent separate
boards. These rules apply to merging; existing Edit board behavior is unchanged.

The reviewer chooses the surviving listing. Its identity, owner, gym and current
configuration remain authoritative. Past ticks and wall events retain their
original climb and angle details. Spray walls and private boards are excluded.

## Who can act

Any signed-in climber who can read every selected board may submit a request.
Gym owners and gym admins may merge boards they administer through their current
gym links. Community admins and leaders may act within their board-type scope;
global admins may act across types. Every selected board is checked, including
the survivor. Board ownership alone and gym editor membership do not grant merge
permission. Community reviewers can reconcile misplaced or unlinked boards.

Direct merges require confirmation. Approving a request performs the same merge;
rejecting one leaves the boards unchanged. Permissions and board state are
checked again when the transaction runs, so an old preview cannot authorize a
merge after a board moves gym, changes privacy or configuration, or the reviewer
loses their role. Reload the preview and review the new state before retrying.

## History and old references

Consolidation preserves stored history and moves references to the survivor.
Duplicate rows remain as merge tombstones so old UUIDs and slugs resolve through
the existing board merge chain. Imported source identities remain available for
provenance, and sync must not revive a merged listing. Audits record who acted,
the reason, and the references moved. There is no automatic production cleanup
and no one-click undo: a mistaken decision needs an audit-led repair.

Kiosk slots in the survivor's gym follow the survivor and duplicate slots fold
into one. A kiosk in another gym cannot retain a slot for the moved board: that
slot is removed and a board-specific leaderboard falls back to the whole gym.
The comparison and confirmation warn about this, and the audit retains the old
kiosk layouts for repair.

The acting mobile client refreshes its active board after success. Other clients
follow the existing foreground self-heal contract: return to the app to resolve
an old active-board selection. In-flight writes to a merged listing fail the
active-row check rather than recreating history under the retired ID.

See [merge tombstones](board-merge-tombstones.md) for serial deduplication and
stale-reference recovery, and [gym board management](../web/gym-board-management.md)
for the separate unlink and delete actions.

## Manual checks

1. Report two duplicate public boards; find one pending moderation request.
2. Review as an authorized manager; choose the survivor and confirm.
3. Open the gym; find one listing and the combined board history.
4. Open an old duplicate link; reach the surviving board.
5. Try another layout; only the TB2 Mirror/Spray exception permits merging.
