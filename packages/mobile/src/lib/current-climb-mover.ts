import type { SessionUser } from '@boardsesh/shared-schema';

/** Resolve only the server-stamped participant through the privacy-projected roster. */
export function resolveCurrentClimbMoverName({
  currentChangedBy,
  participantId,
  sessionUsers,
}: {
  currentChangedBy: string | null | undefined;
  participantId: string | null | undefined;
  sessionUsers: ReadonlyArray<Pick<SessionUser, 'id' | 'username'>>;
}): string | null {
  if (!currentChangedBy || !participantId || currentChangedBy === participantId) return null;
  return sessionUsers.find(({ id }) => id === currentChangedBy)?.username?.trim() || null;
}
