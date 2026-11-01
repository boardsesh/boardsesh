import type { SessionUser } from '@boardsesh/shared-schema';

export type CurrentClimbMoverFace = { username: string; avatarUrl: string | null };

type CurrentClimbMoverInput = {
  currentChangedBy: string | null | undefined;
  participantId: string | null | undefined;
  sessionUsers: ReadonlyArray<Pick<SessionUser, 'id' | 'username' | 'avatarUrl'>>;
};

/** Resolve only the server-stamped participant through the privacy-projected roster. */
export function resolveCurrentClimbMoverFace({
  currentChangedBy,
  participantId,
  sessionUsers,
}: CurrentClimbMoverInput): CurrentClimbMoverFace | null {
  if (!currentChangedBy || !participantId || currentChangedBy === participantId) return null;
  const participant = sessionUsers.find(({ id }) => id === currentChangedBy);
  const username = participant?.username?.trim();
  return username ? { username, avatarUrl: participant?.avatarUrl ?? null } : null;
}
