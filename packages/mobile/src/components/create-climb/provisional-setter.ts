// Kept out of `use-create-climb-screen.ts` so the rule is testable on its own,
// and out of `@boardsesh/create-climb-react` because it is about the queue row
// the mobile editor builds, which web has no equivalent of.

/**
 * Whose name a climb carries in the queue after the editor saves it.
 *
 * A new climb is the saver's. An EDITED climb stays its setter's, whoever saved
 * it: a wall owner fixing a start hold has not taken the climb, and the server
 * never rewrites `user_id` or `setter_username` on an update. Falls back to the
 * saver only while the climb being edited has not loaded.
 */
export function resolveProvisionalSetter(
  editedClimb: { userId?: string | null; setter_username?: string | null } | null | undefined,
  saver: { id?: string | null; displayName?: string | null } | null | undefined,
): { userId: string | null; setter_username: string } {
  if (editedClimb) {
    return { userId: editedClimb.userId ?? null, setter_username: editedClimb.setter_username ?? '' };
  }
  return { userId: saver?.id ?? null, setter_username: saver?.displayName ?? '' };
}
