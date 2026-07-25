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
  | { __typename: 'SessionRosterSnapshot'; users: TUser[]; boardPath?: string | null }
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
    case 'SessionRosterSnapshot': {
      // REPLACE, not merge: this is an authoritative full roster, so members
      // who dropped while we weren't watching are gone and new members appear.
      const snapshotUsers = event.users.map((user) => coerceRuntimeUser(user, options));
      // Re-inject our own connection row if the snapshot was computed a beat
      // before the backend registered our JOIN — otherwise a fresh subscribe
      // would erase us from our own crew list until the next delta. Anchored on
      // our stable connection id (`clientId`), which the snapshot preserves.
      const selfInSnapshot = snapshotUsers.find((user) => user.id === prev.clientId);
      const selfRow = prev.users.find((user) => user.id === prev.clientId);
      const users = selfInSnapshot || !selfRow ? snapshotUsers : [...snapshotUsers, selfRow];
      return {
        ...prev,
        users,
        // Re-derive top-level leadership from the snapshot's own self entry
        // (mirrors the LeaderChanged handler's clientId check). When the snapshot
        // omits us it has no opinion on our leadership — it raced our JOIN — so
        // keep the prior value rather than silently demoting on incomplete data.
        isLeader: selfInSnapshot ? selfInSnapshot.isLeader : prev.isLeader,
        // Falsy (empty/absent) boardPath keeps the current one — a real boardPath
        // is always a non-empty route, so `||` only ever falls through on the
        // unreachable session-vanished-mid-subscribe case the seed guards.
        boardPath: event.boardPath || prev.boardPath,
      };
    }
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
    default: {
      // Exhaustiveness guard — its value is the COMPILE-TIME trap: a new
      // RuntimeSessionEvent member that a mapper can emit but this switch doesn't
      // handle fails to typecheck here (the `never` assignment), so an unhandled
      // event can't slip through. At runtime this default just returns prev
      // unchanged — the same safe no-op both call sites already fall back to on
      // the null path — so it's belt-and-suspenders; the compile error is the
      // real protection.
      const unhandled: never = event;
      void unhandled;
      return prev;
    }
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
