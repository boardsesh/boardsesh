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
  driverParticipantId: string | null;
  /**
   * Per-board BLE connection holders: boardId -> stable participantId. The
   * holder is the single member whose phone writes frames to that board, and
   * any entry means the shared "wall connected" indicator is lit. Optional so
   * existing session constructors that predate the connection-holder model
   * don't have to set it (treated as empty).
   */
  wallConnectionsByBoard?: Record<number, string>;
  lastConnectedBoardSerial: string | null;
  boardPath: string;
};

export type RuntimeSessionEvent<TUser extends RuntimeSessionUser = RuntimeSessionUser> =
  | { __typename: 'UserJoined'; user: TUser }
  | { __typename: 'UserPresenceChanged'; user: TUser }
  | { __typename: 'UserLeft'; userId: string }
  | { __typename: 'LeaderChanged'; leaderId: string; leaderConnectionId?: string | null }
  | { __typename: 'DriverChanged'; driverParticipantId?: string | null; previousDriverParticipantId?: string | null }
  | { __typename: 'WallConnectionChanged'; boardId: number; holderParticipantId?: string | null }
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
    case 'DriverChanged':
      return { ...prev, driverParticipantId: event.driverParticipantId ?? null };
    case 'WallConnectionChanged': {
      const next = { ...prev.wallConnectionsByBoard };
      if (event.holderParticipantId) {
        next[event.boardId] = event.holderParticipantId;
      } else {
        delete next[event.boardId];
      }
      return { ...prev, wallConnectionsByBoard: next };
    }
    case 'SessionBoardSerialChanged':
      return { ...prev, lastConnectedBoardSerial: event.lastConnectedBoardSerial ?? null };
    case 'SessionBoardPathChanged':
      return { ...prev, boardPath: event.boardPath };
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
