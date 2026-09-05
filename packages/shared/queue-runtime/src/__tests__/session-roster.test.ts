import { describe, expect, it } from 'vitest';
import { countConnectedSessionPeers, countDistinctSessionUsers, dedupeSessionUsers } from '../session-roster';

type Roster = { id: string; userId?: string | null };

describe('session-roster dedupe', () => {
  it('collapses multiple entries for one authenticated user by userId', () => {
    // The exact production shape: one logged-in person whose reconnects landed
    // as separate connection-keyed entries, all carrying the same userId.
    const roster: Roster[] = [
      { id: 'conn-1', userId: 'user-A' },
      { id: 'conn-2', userId: 'user-A' },
      { id: 'conn-3', userId: 'user-A' },
    ];
    expect(countDistinctSessionUsers(roster)).toBe(1);
    expect(dedupeSessionUsers(roster)).toEqual([{ id: 'conn-1', userId: 'user-A' }]);
  });

  it('keeps distinct anonymous participants separate via their connection id', () => {
    const roster: Roster[] = [{ id: 'anon-1', userId: null }, { id: 'anon-2', userId: null }, { id: 'anon-3' }];
    expect(countDistinctSessionUsers(roster)).toBe(3);
    expect(dedupeSessionUsers(roster)).toHaveLength(3);
  });

  it('counts a real mixed party once per human', () => {
    const roster: Roster[] = [
      { id: 'user-A', userId: 'user-A' },
      { id: 'conn-x', userId: 'user-A' }, // duplicate of user-A
      { id: 'user-B', userId: 'user-B' },
      { id: 'anon-1', userId: null },
    ];
    expect(countDistinctSessionUsers(roster)).toBe(3);
    expect(dedupeSessionUsers(roster).map((user) => user.id)).toEqual(['user-A', 'user-B', 'anon-1']);
  });

  it('preserves order and returns the first entry seen for each identity', () => {
    // First-in-array wins, regardless of what the connection ids imply.
    const roster: Roster[] = [
      { id: 'conn-1', userId: 'user-A' },
      { id: 'conn-2', userId: 'user-A' },
    ];
    expect(dedupeSessionUsers(roster)).toEqual([{ id: 'conn-1', userId: 'user-A' }]);
  });

  it('handles the empty roster', () => {
    expect(countDistinctSessionUsers([])).toBe(0);
    expect(dedupeSessionUsers([])).toEqual([]);
  });
});

// `countConnectedSessionPeers` exists because `countDistinctSessionUsers` was
// the wrong question for a gate. These cases are the field shapes that made a
// lone climber's swipes stop lighting their own board in #4683.
describe('countConnectedSessionPeers', () => {
  type Peer = { id: string; userId?: string | null; connectionState?: string | null };
  const self = { participantId: 'me' };

  it('does not count the climber themselves', () => {
    const roster: Peer[] = [{ id: 'me', userId: 'user-me', connectionState: 'CONNECTED' }];
    expect(countConnectedSessionPeers(roster, self)).toBe(0);
  });

  it('does not count the climber\u2019s own stale entry from a reconnect', () => {
    // The reconnect landed before the previous connection’s `UserLeft`. The old
    // entry is keyed on the dead connection id and carries no userId, so
    // `userId ?? id` gives it a DIFFERENT key from the live one — dedupe cannot
    // merge them, and the participant count read two humans where there was one.
    const roster: Peer[] = [
      { id: 'me', userId: 'user-me', connectionState: 'CONNECTED' },
      { id: 'dead-conn', userId: null, connectionState: 'RECONNECTING' },
    ];
    expect(countDistinctSessionUsers(roster)).toBe(2);
    expect(countConnectedSessionPeers(roster, self)).toBe(0);
  });

  it('excludes the climber by userId when their entry is connection-keyed', () => {
    // The other half of the same race: the socket momentarily authenticated
    // anonymously, so the live entry is keyed on the connection id while still
    // carrying the userId.
    const roster: Peer[] = [{ id: 'some-conn', userId: 'user-me', connectionState: 'CONNECTED' }];
    expect(countConnectedSessionPeers(roster, { participantId: 'me', userId: 'user-me' })).toBe(0);
  });

  it('counts a genuine peer', () => {
    const roster: Peer[] = [
      { id: 'me', userId: 'user-me', connectionState: 'CONNECTED' },
      { id: 'bo', userId: 'user-bo', connectionState: 'CONNECTED' },
    ];
    expect(countConnectedSessionPeers(roster, self)).toBe(1);
  });

  it('counts distinct anonymous peers separately', () => {
    const roster: Peer[] = [
      { id: 'me', connectionState: 'CONNECTED' },
      { id: 'anon-1', connectionState: 'CONNECTED' },
      { id: 'anon-2', connectionState: 'CONNECTED' },
    ];
    expect(countConnectedSessionPeers(roster, self)).toBe(2);
  });

  it('skips a peer the server says is not connected', () => {
    const roster: Peer[] = [
      { id: 'me', userId: 'user-me', connectionState: 'CONNECTED' },
      { id: 'bo', userId: 'user-bo', connectionState: 'RECONNECTING' },
    ];
    expect(countConnectedSessionPeers(roster, self)).toBe(0);
  });

  it('treats an ABSENT connectionState as connected', () => {
    // A backend that does not send the field must behave as it did before the
    // filter existed. Reading a missing field as \u201cnot connected\u201d would report an
    // empty crew for every session and silently disable the feature.
    const roster: Peer[] = [
      { id: 'me', userId: 'user-me' },
      { id: 'bo', userId: 'user-bo' },
    ];
    expect(countConnectedSessionPeers(roster, self)).toBe(1);
  });

  it('returns 0 for a null or empty roster', () => {
    expect(countConnectedSessionPeers(null, self)).toBe(0);
    expect(countConnectedSessionPeers([], self)).toBe(0);
  });
});
