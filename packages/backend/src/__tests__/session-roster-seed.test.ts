// End-to-end test for the sessionUpdates roster SEED against a REAL backend
// (`startTestBackend`) — issue #2860 ("[RN] Board presence drift").
//
// Roster/presence deltas (UserJoined/UserLeft/UserPresenceChanged/…) carry no
// sequence number and have no replay buffer, so a single dropped delta silently
// diverges a member's crew list. The fix: `sessionUpdates` now yields a
// `SessionRosterSnapshot` as its FIRST event, re-baselining the roster on every
// (re)subscribe. This suite proves, over the real wire:
//   1. the seed is the first session event a subscriber receives (before deltas);
//   2. a late joiner's seed already carries the full existing roster — it never
//      depends on catching an earlier member's UserJoined delta.

import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { randomUUID } from 'crypto';
import { HeadlessParticipant, startTestBackend, type TestBackend } from './helpers/headless-queue-client';

describe('sessionUpdates roster seed ↔ real backend (#2860)', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await startTestBackend();
  });

  afterAll(async () => {
    await backend.teardown();
  });

  it('yields a SessionRosterSnapshot as the first session event, before any delta', async () => {
    const sessionId = `roster-seed-${randomUUID().slice(0, 8)}`;
    const alex = new HeadlessParticipant(backend.url, sessionId, 'Alex');
    try {
      await alex.join();
      await alex.waitForRosterSnapshot();

      expect(alex.sessionEventTypes[0]).toBe('SessionRosterSnapshot');
      // The seed payload (not the JOIN response) carries the roster.
      expect(alex.rosterSnapshotUsers?.map((u) => u.username)).toContain('Alex');
    } finally {
      await alex.dispose();
    }
  }, 30_000);

  it('seeds a late joiner with the full existing roster', async () => {
    const sessionId = `roster-seed-${randomUUID().slice(0, 8)}`;
    const alex = new HeadlessParticipant(backend.url, sessionId, 'Alex');
    const blake = new HeadlessParticipant(backend.url, sessionId, 'Blake');
    try {
      await alex.join();
      await blake.join();
      await blake.waitForRosterSnapshot();

      // Blake's very first session event is the seed, and it already lists Alex —
      // Blake never had to catch Alex's UserJoined delta to know Alex is present.
      expect(blake.sessionEventTypes[0]).toBe('SessionRosterSnapshot');
      const seededUsernames = (blake.rosterSnapshotUsers ?? []).map((u) => u.username).sort();
      expect(seededUsernames).toContain('Alex');
      expect(seededUsernames).toContain('Blake');
    } finally {
      await blake.dispose();
      await alex.dispose();
    }
  }, 30_000);
});
