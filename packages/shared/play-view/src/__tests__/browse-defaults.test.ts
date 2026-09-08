import { describe, expect, it } from 'vitest';
import { shouldDefaultToBrowse } from '../browse-defaults';

describe('shouldDefaultToBrowse', () => {
  const cases: { name: string; sessionActive: boolean; connectedPeerCount: number; expected: boolean }[] = [
    { name: 'solo, no session at all', sessionActive: false, connectedPeerCount: 0, expected: false },
    // The ordinary state right after starting a session: the climber is alone
    // in it, so swipes keep driving their own wall.
    { name: 'session of one — nobody has joined yet', sessionActive: true, connectedPeerCount: 0, expected: false },
    { name: 'one peer — an audience exists', sessionActive: true, connectedPeerCount: 1, expected: true },
    { name: 'a full crew', sessionActive: true, connectedPeerCount: 5, expected: true },
    // A roster that outlived its session id is stale bookkeeping; it must not
    // keep gestures view-only after the session ended.
    { name: 'peers left over after the session ended', sessionActive: false, connectedPeerCount: 3, expected: false },
    {
      name: 'session id with an empty roster (pre-JOIN response)',
      sessionActive: true,
      connectedPeerCount: 0,
      expected: false,
    },
  ];

  it.each(cases)('$name', ({ sessionActive, connectedPeerCount, expected }) => {
    expect(shouldDefaultToBrowse({ sessionActive, connectedPeerCount })).toBe(expected);
  });

  it('flips only across the 0 → 1 peer boundary', () => {
    // The value is consumed as a context/prop by high-fanout surfaces, so the
    // boundary is the whole point: a crew growing 1 → 2 → 3 must not churn it.
    const counts = [0, 1, 2, 3, 11];
    expect(
      counts.map((connectedPeerCount) => shouldDefaultToBrowse({ sessionActive: true, connectedPeerCount })),
    ).toEqual([false, true, true, true, true]);
  });

  // The regression that took #4683 back out. The gate used to be fed a count of
  // roster PARTICIPANTS, which always includes the climber themselves — so the
  // threshold had to be `> 1`, and any second entry for that same human (a
  // reconnect landing before `UserLeft`, a socket that momentarily authenticated
  // anonymously) read as an audience and stopped a lone climber's swipes from
  // lighting their own board. Counting peers removes the self-entry from the
  // arithmetic entirely, so a doubled solo roster can no longer reach the gate:
  // `countConnectedSessionPeers` is what decides who counts, and it is tested
  // against exactly those shapes in @boardsesh/queue-runtime.
  it('takes peers, not participants — a lone climber can never reach the gate', () => {
    expect(shouldDefaultToBrowse({ sessionActive: true, connectedPeerCount: 0 })).toBe(false);
  });
});
