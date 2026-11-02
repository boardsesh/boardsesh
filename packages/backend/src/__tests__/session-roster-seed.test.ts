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
//
// The crew rest clock (#5382) rides the same subscription: its seed is ALWAYS
// the second event, so the last describe block below proves the seed, live
// delivery between two members, the re-seed on resubscribe, the one-FIRE-per-
// beat claim over the wire, a once-only clock turning auto-advance off for the
// crew, and that an installed app's document (no fragment for the new type)
// keeps its subscription working.

import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { randomUUID } from 'crypto';
import { HeadlessParticipant, startTestBackend, waitFor, type TestBackend } from './helpers/headless-queue-client';

/**
 * A frozen copy of the mobile app's SESSION_UPDATES_SUBSCRIPTION as installed
 * before #5382 (packages/mobile/src/lib/graphql/operations.ts). It has no
 * fragment for SessionRestCadenceChanged. Never update it: it stands for every
 * bundle already on climbers' phones.
 */
const PRE_REST_CADENCE_MOBILE_SESSION_UPDATES = `
  subscription SessionUpdates($sessionId: ID!) {
    sessionUpdates(sessionId: $sessionId) {
      __typename
      ... on SessionRosterSnapshot {
        users { id username isLeader avatarUrl userId connectionState }
        boardPath
      }
      ... on UserJoined {
        user { id username isLeader avatarUrl userId connectionState }
      }
      ... on UserLeft {
        userId
      }
      ... on UserPresenceChanged {
        user { id username isLeader avatarUrl userId connectionState }
      }
      ... on LeaderChanged {
        leaderId
        leaderConnectionId
      }
      ... on WallConfirmedClimb {
        climbUuid
        confirmedAt
        confirmedByParticipantId
        queueItemUuid
      }
      ... on WallDisconnected {
        disconnectedByParticipantId
      }
      ... on SessionEnded {
        reason
        newPath
      }
      ... on SessionBoardPathChanged {
        boardPath
        changedByParticipantId
      }
      ... on SessionNameChanged {
        name
        changedByParticipantId
      }
      ... on SessionBoardSerialChanged {
        lastConnectedBoardSerial
      }
      ... on SessionStatsUpdated {
        sessionId
        totalSends
        totalFlashes
        totalAttempts
        tickCount
        participants {
          userId
          displayName
          avatarUrl
          sends
          flashes
          attempts
        }
        gradeDistribution {
          grade
          flash
          send
          attempt
        }
        boardTypes
        hardestGrade
        durationMinutes
        goal
      }
    }
  }
`;

const SETTINGS_CONFIG = {
  mode: 'afterTick',
  targetSeconds: 90,
  autoAdvance: true,
  advanceOn: 'deadline',
  source: 'settings',
};

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

  describe('crew rest clock (#5382)', () => {
    it('seeds the clock right after the roster, even when it is off', async () => {
      const sessionId = `rest-seed-${randomUUID().slice(0, 8)}`;
      const alex = new HeadlessParticipant(backend.url, sessionId, 'Alex');
      try {
        await alex.join();
        await waitFor(() => alex.restCadenceEvents.length > 0, { label: 'rest clock seed' });

        expect(alex.sessionEventTypes.slice(0, 2)).toEqual(['SessionRosterSnapshot', 'SessionRestCadenceChanged']);
        expect(alex.restCadenceEvents[0]).toMatchObject({
          restCadence: null,
          revision: 0,
          isSnapshot: true,
          action: null,
        });
        expect(alex.restCadenceEvents[0].serverNow).toMatch(/^\d{13}$/);
      } finally {
        await alex.dispose();
      }
    }, 30_000);

    it('carries one member’s clock to the other live, and re-seeds it on resubscribe', async () => {
      const sessionId = `rest-live-${randomUUID().slice(0, 8)}`;
      const alex = new HeadlessParticipant(backend.url, sessionId, 'Alex');
      const blake = new HeadlessParticipant(backend.url, sessionId, 'Blake');
      try {
        await alex.join();
        await blake.join();
        await waitFor(() => blake.restCadenceEvents.length > 0, { label: 'Blake rest clock seed' });

        const armed = await alex.setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG, elapsedMs: 0 });
        expect(armed.applied).toBe(true);
        await waitFor(() => blake.restCadenceEvents.length > 1, { label: 'Blake live rest clock' });

        const live = blake.restCadenceEvents[1];
        expect(live).toMatchObject({ revision: armed.change.revision, isSnapshot: false, action: 'ARM' });
        expect(live.restCadence).toMatchObject({ ...SETTINGS_CONFIG, isRunning: true });
        // The setter is named by the same id Blake's roster shows for Alex.
        expect(live.restCadence?.setByParticipantId).toBe(alex.participantId);
        expect(blake.users.map((user) => user.id)).toContain(alex.participantId);

        await blake.disconnect();
        blake.restCadenceEvents = [];
        await blake.reconnect();
        await waitFor(() => blake.restCadenceEvents.length > 0, { label: 'Blake rest clock re-seed' });
        expect(blake.restCadenceEvents[0]).toMatchObject({
          revision: armed.change.revision,
          isSnapshot: true,
          action: null,
          restCadence: { ...SETTINGS_CONFIG, setByParticipantId: alex.participantId },
        });
      } finally {
        await blake.dispose();
        await alex.dispose();
      }
    }, 30_000);

    it('lets only one of two phones claim a beat', async () => {
      const sessionId = `rest-fire-${randomUUID().slice(0, 8)}`;
      const alex = new HeadlessParticipant(backend.url, sessionId, 'Alex');
      const blake = new HeadlessParticipant(backend.url, sessionId, 'Blake');
      try {
        await alex.join();
        await blake.join();
        const armed = await alex.setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG, elapsedMs: 90_000 });
        const fire = { action: 'FIRE' as const, expectedRevision: armed.change.revision, firedBeatAgoMs: 0 };

        const [fromAlex, fromBlake] = await Promise.all([alex.setRestCadence(fire), blake.setRestCadence(fire)]);

        expect([fromAlex.applied, fromBlake.applied].filter(Boolean)).toHaveLength(1);
        const winner = fromAlex.applied ? fromAlex : fromBlake;
        const loser = fromAlex.applied ? fromBlake : fromAlex;
        expect(loser.change.revision).toBe(winner.change.revision);
        expect(loser.change.action).toBeNull();
        // A write sent after both FIREs returned is published after anything they published, so
        // once it arrives every FIRE event the server sent is already in: no sleep needed.
        const sentinel = await alex.setRestCadence({ action: 'PAUSE' });
        expect(sentinel.applied).toBe(true);
        await waitFor(() => alex.restCadenceEvents.some((event) => event.revision === sentinel.change.revision), {
          label: 'the write after the FIREs',
        });
        expect(alex.restCadenceEvents.filter((event) => event.action === 'FIRE')).toHaveLength(1);
      } finally {
        await blake.dispose();
        await alex.dispose();
      }
    }, 30_000);

    it('turns auto-advance off for the whole crew when a once-only clock’s FIRE lands', async () => {
      const sessionId = `rest-once-${randomUUID().slice(0, 8)}`;
      const alex = new HeadlessParticipant(backend.url, sessionId, 'Alex');
      const blake = new HeadlessParticipant(backend.url, sessionId, 'Blake');
      try {
        await alex.join();
        await blake.join();
        // Alex's phone built the 4x4 and sends the set rest; Blake's phone holds the board.
        const armed = await alex.setRestCadence({
          action: 'ARM',
          config: { ...SETTINGS_CONFIG, autoAdvanceOnce: true },
          elapsedMs: 90_000,
        });
        expect(armed.applied).toBe(true);
        // The shared selection the app sends carries the flag both ways (#5382 mobile).
        expect(armed.change.restCadence).toMatchObject({ autoAdvance: true, autoAdvanceOnce: true });

        const fired = await blake.setRestCadence({ action: 'FIRE', expectedRevision: armed.change.revision });
        expect(fired.applied).toBe(true);
        expect(fired.change.restCadence).toMatchObject({ autoAdvance: false, autoAdvanceOnce: false });
        await waitFor(() => alex.restCadenceEvents.some((event) => event.revision === fired.change.revision), {
          label: 'Alex hears the advance',
        });
        expect(alex.restCadenceEvents.find((event) => event.revision === fired.change.revision)).toMatchObject({
          action: 'FIRE',
          restCadence: { autoAdvance: false, autoAdvanceOnce: false },
        });
      } finally {
        await blake.dispose();
        await alex.dispose();
      }
    }, 30_000);

    it('keeps an installed app’s subscription working: it gets a bare typename and roster deltas still flow', async () => {
      const sessionId = `rest-legacy-${randomUUID().slice(0, 8)}`;
      const installed = new HeadlessParticipant(backend.url, sessionId, 'Installed', undefined, {
        sessionUpdatesDocument: PRE_REST_CADENCE_MOBILE_SESSION_UPDATES,
      });
      const current = new HeadlessParticipant(backend.url, sessionId, 'Current');
      const lateJoiner = new HeadlessParticipant(backend.url, sessionId, 'Late');
      try {
        await installed.join();
        await current.join();
        await current.setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG });
        await waitFor(() => installed.restCadenceEvents.length > 1, { label: 'installed app rest clock events' });

        expect(installed.restCadenceEvents).toEqual([
          { __typename: 'SessionRestCadenceChanged' },
          { __typename: 'SessionRestCadenceChanged' },
        ]);

        await lateJoiner.join();
        await waitFor(() => installed.users.some((user) => user.username === 'Late'), {
          label: 'installed app sees the late joiner',
        });
      } finally {
        await lateJoiner.dispose();
        await current.dispose();
        await installed.dispose();
      }
    }, 30_000);
  });
});
