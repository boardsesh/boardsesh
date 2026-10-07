// Kept out of `use-create-climb-screen.ts` so the rule is testable on its own,
// and out of `@boardsesh/create-climb-react` because it is about the queue row
// the mobile editor builds, which web has no equivalent of.

type EditedClimb = { userId?: string | null; setter_username?: string | null };
type Saver = { id?: string | null; displayName?: string | null };

/**
 * Whose name a climb carries in the queue after the editor saves it.
 *
 * A new climb is the saver's. An EDITED climb stays its setter's: the server
 * never rewrites `user_id` or `setter_username` on an update. Falls back to the
 * saver only while the climb being edited has not loaded.
 *
 * One exception, which keeps what the editor did before #5955. A row can arrive
 * with no `userId` at all (a legacy row, or a read that does not carry the
 * field) while its setter name is the saver's own. Queueing that as `userId:
 * null` would take the Edit action off a climber's own climb the moment they
 * saved it, where it used to carry their id. So when the names agree, the saver
 * is taken to be the setter.
 */
export function resolveProvisionalSetter(
  editedClimb: EditedClimb | null | undefined,
  saver: Saver | null | undefined,
): { userId: string | null; setter_username: string } {
  if (!editedClimb) return { userId: saver?.id ?? null, setter_username: saver?.displayName ?? '' };

  const setterName = editedClimb.setter_username ?? '';
  if (editedClimb.userId) return { userId: editedClimb.userId, setter_username: setterName };

  const saverName = saver?.displayName ?? '';
  const saverIsSetterByName = saverName !== '' && saverName === setterName;
  return { userId: saverIsSetterByName ? (saver?.id ?? null) : null, setter_username: setterName };
}
