export type RuntimeSessionUser = {
  id: string;
  username: string;
  isLeader: boolean;
  avatarUrl?: string | null;
  userId?: string | null;
  connectionState?: string | null;
};

export type RuntimeSessionState<TUser extends RuntimeSessionUser = RuntimeSessionUser> = {
  users: TUser[];
  isLeader: boolean;
  clientId: string;
  lastConnectedBoardSerial: string | null;
  boardPath: string;
};

export type RuntimeSessionEvent<TUser extends RuntimeSessionUser = RuntimeSessionUser> =
  | { __typename: 'UserJoined'; user: TUser }
  | { __typename: 'UserPresenceChanged'; user: TUser }
  | { __typename: 'UserLeft'; userId: string }
  | { __typename: 'LeaderChanged'; leaderId: string; leaderConnectionId?: string | null }
  | { __typename: 'WallDisconnected'; disconnectedByParticipantId?: string | null }
  | { __typename: 'SessionBoardSerialChanged'; lastConnectedBoardSerial?: string | null }
  | { __typename: 'SessionBoardPathChanged'; boardPath: string; changedByParticipantId?: string | null }
  | { __typename: 'SessionEnded'; reason?: string | null; newPath?: string | null };

export type ApplySessionRuntimeEventOptions<TUser extends RuntimeSessionUser, TEventUser extends RuntimeSessionUser> = {
  coerceUser?: (user: TEventUser) => TUser;
};

export function applySessionRuntimeEvent<
  TUser extends RuntimeSessionUser,
  TEventUser extends RuntimeSessionUser,
  TSession extends RuntimeSessionState<TUser>,
>(
  prev: TSession | null,
  event: RuntimeSessionEvent<TEventUser>,
  options: ApplySessionRuntimeEventOptions<TUser, TEventUser> = {},
): TSession | null {
  if (!prev) return prev;

  switch (event.__typename) {
    case 'UserJoined':
    case 'UserPresenceChanged':
      return {
        ...prev,
        users: upsertRuntimeSessionUser(prev.users, coerceRuntimeUser(event.user, options)),
      };
    case 'UserLeft':
      return { ...prev, users: prev.users.filter((user) => user.id !== event.userId) };
    case 'LeaderChanged': {
      const localEntry = prev.users.find((user) => user.id === prev.clientId);
      const isAnonymous = localEntry !== undefined && !localEntry.userId;
      const effectiveLeaderConnectionId = event.leaderConnectionId ?? (isAnonymous ? event.leaderId : null);
      return {
        ...prev,
        isLeader: effectiveLeaderConnectionId === prev.clientId,
        users: prev.users.map((user) => ({
          ...user,
          isLeader: user.id === event.leaderId,
        })),
      };
    }
    case 'SessionBoardSerialChanged':
      return { ...prev, lastConnectedBoardSerial: event.lastConnectedBoardSerial ?? null };
    case 'SessionBoardPathChanged':
      return { ...prev, boardPath: event.boardPath };
    case 'WallDisconnected':
      // Transient wall-control signal — turning the lightbulb off is handled by
      // the client UI layer, not the durable session roster. No session-state
      // change here (the current climb is intentionally preserved).
      return prev;
    case 'SessionEnded':
      return prev;
  }
}

function coerceRuntimeUser<TUser extends RuntimeSessionUser, TEventUser extends RuntimeSessionUser>(
  user: TEventUser,
  options: ApplySessionRuntimeEventOptions<TUser, TEventUser>,
): TUser {
  return options.coerceUser ? options.coerceUser(user) : (user as unknown as TUser);
}

export function upsertRuntimeSessionUser<TUser extends RuntimeSessionUser>(users: TUser[], user: TUser): TUser[] {
  const existingIndex = users.findIndex((existingUser) => existingUser.id === user.id);
  if (existingIndex === -1) {
    return [...users, user];
  }

  const nextUsers = [...users];
  nextUsers[existingIndex] = {
    ...nextUsers[existingIndex],
    ...user,
  };
  return nextUsers;
}
