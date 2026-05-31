// End-to-end integration tests for the QUEUE CLIENT against a REAL backend.
//
// Unlike `integration.test.ts` (which drives the server with raw GraphQL to
// assert backend broadcasts), this suite drives the actual cross-platform
// client modules — @boardsesh/queue (reducer + sync coordinator),
// @boardsesh/queue-runtime (event mapping), and @boardsesh/queue-react
// (createQueueMutations, extracted in #2417) — via the `HeadlessParticipant`
// harness. Each test is four phones in one party session talking to one live
// backend.
//
// Every queue-mutating test asserts two invariants once the dust settles:
//   1. cross-client: all participants agree on queue ORDER, current climb, and
//      mirror flags (see expectConverged);
//   2. client↔server: each participant's locally-computed FNV hash equals the
//      server's authoritative hash — the same drift check that ships in prod.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vite-plus/test';
import {
  HeadlessParticipant,
  startTestBackend,
  makeClimb,
  assertConverged,
  waitFor,
  type TestBackend,
} from './helpers/headless-queue-client';

describe('Queue client ↔ real backend (4-participant party session)', () => {
  let backend: TestBackend;
  const live: HeadlessParticipant[] = [];
  let sessionCounter = 0;

  const nextSessionId = () => `qcs-${Date.now()}-${sessionCounter++}`;

  // Spawn a party of named participants, joined sequentially so the first is the
  // deterministic leader. Tracked for teardown in afterEach.
  async function spawnParty(names: string[]): Promise<HeadlessParticipant[]> {
    const sessionId = nextSessionId();
    const party: HeadlessParticipant[] = [];
    for (const name of names) {
      const participant = new HeadlessParticipant(backend.url, sessionId, name);
      await participant.join();
      party.push(participant);
      live.push(participant);
    }
    // Everyone has seen everyone before the test body runs.
    await waitFor(() => party.every((p) => p.users.length === names.length), { label: 'full roster' });
    return party;
  }

  // A standard 4-person party with four distinct climbs already queued (a,b,c,d).
  async function partyWithFourClimbs() {
    const party = await spawnParty(['Alice', 'Bob', 'Cara', 'Dre']);
    const climbs = [makeClimb('a'), makeClimb('b'), makeClimb('c'), makeClimb('d')];
    await party[0].mutations.addQueueItem(climbs[0]);
    await party[1].mutations.addQueueItem(climbs[1]);
    await party[2].mutations.addQueueItem(climbs[2]);
    await party[3].mutations.addQueueItem(climbs[3]);
    await assertConverged(party);
    return { party, climbs };
  }

  beforeAll(async () => {
    backend = await startTestBackend();
  });

  afterAll(async () => {
    await backend.teardown();
  });

  afterEach(async () => {
    await Promise.all(live.map((p) => p.dispose()));
    live.length = 0;
  });

  describe('Presence & roster', () => {
    it('shows all four members to everyone, with exactly one leader', async () => {
      const party = await spawnParty(['Alice', 'Bob', 'Cara', 'Dre']);

      for (const participant of party) {
        expect(participant.users).toHaveLength(4);
        expect(participant.users.filter((user) => user.isLeader)).toHaveLength(1);
      }
      // First joiner is the leader; the others are not.
      expect(party[0].isLeader).toBe(true);
      expect(party.slice(1).every((p) => p.isLeader === false)).toBe(true);
    });

    it('drops a member from everyone’s roster when they leave', async () => {
      const party = await spawnParty(['Alice', 'Bob', 'Cara', 'Dre']);
      const [, , , dre] = party;

      await dre.leave();

      const remaining = party.slice(0, 3);
      await waitFor(() => remaining.every((p) => p.users.length === 3), { label: 'roster shrinks to 3' });
      for (const participant of remaining) {
        expect(participant.users.some((user) => user.username === 'Dre')).toBe(false);
      }
    });
  });

  describe('Collaborative queue editing', () => {
    it('converges when every participant adds a different climb', async () => {
      const { party, climbs } = await partyWithFourClimbs();

      for (const participant of party) {
        expect(participant.queueUuids()).toEqual(climbs.map((climb) => climb.uuid));
      }
    });

    it('reconciles every client to the server after a simultaneous-add flurry', async () => {
      const party = await spawnParty(['Alice', 'Bob', 'Cara', 'Dre']);
      const climbs = [makeClimb('a'), makeClimb('b'), makeClimb('c'), makeClimb('d')];

      // Four phones adding at the same instant contend on one session queue;
      // the broadcast stream can transiently diverge from the persisted state
      // (a server-side concurrency property, not the client's concern). What the
      // client guarantees is recovery: the hash-drift watchdog full-resyncs each
      // client to the server's authoritative truth.
      await Promise.all(party.map((participant, index) => participant.mutations.addQueueItem(climbs[index])));
      await Promise.all(party.map((participant) => participant.forceFullResync()));
      await assertConverged(party);

      // Every client matches the server exactly — nothing invented locally.
      const server = await party[0].serverState();
      const serverUuids = server.queueState.queue.map((item) => item.uuid);
      for (const participant of party) {
        expect(participant.queueUuids()).toEqual(serverUuids);
      }
    });

    it('broadcasts a current-climb change to everyone', async () => {
      const { party, climbs } = await partyWithFourClimbs();
      const [, bob] = party;

      await bob.navigateToClimb(climbs[2]); // c is already in the queue
      await assertConverged(party);

      for (const participant of party) {
        expect(participant.currentUuid).toBe(climbs[2].uuid);
      }
    });

    it('suppresses the sender’s own current-climb echo (correlation-id match)', async () => {
      const { party } = await partyWithFourClimbs();
      const [, bob] = party;
      const fresh = makeClimb('e'); // not yet in the queue

      await bob.navigateToClimb(fresh, true);
      await assertConverged(party);

      // The echo carrying Bob's correlationId is recognized and drained — if
      // suppression were broken the pending id would linger until its 30s TTL.
      await waitFor(() => bob.pendingUpdateCount() === 0, { label: 'Bob pending drained', timeout: 3000 });
      for (const participant of party) {
        expect(participant.currentUuid).toBe(fresh.uuid);
        expect(participant.queueUuids()).toContain(fresh.uuid); // added once, not twice
        expect(participant.queueUuids().filter((uuid) => uuid === fresh.uuid)).toHaveLength(1);
      }
    });

    it('removes a climb (including the current one) for everyone', async () => {
      const { party, climbs } = await partyWithFourClimbs();
      const [, bob, cara] = party;

      await bob.navigateToClimb(climbs[1]); // current = b
      await assertConverged(party);
      await cara.mutations.removeQueueItem(climbs[1].uuid);
      await assertConverged(party);

      for (const participant of party) {
        expect(participant.queueUuids()).toEqual([climbs[0].uuid, climbs[2].uuid, climbs[3].uuid]);
        expect(participant.currentUuid).toBeNull(); // removing the current clears it
      }
    });

    it('reorders the queue for everyone', async () => {
      const { party, climbs } = await partyWithFourClimbs();

      // Move a (index 0) to the end → b, c, d, a
      await party[0].reorder(climbs[0].uuid, 0, 3);
      await assertConverged(party);

      const expectedOrder = [climbs[1].uuid, climbs[2].uuid, climbs[3].uuid, climbs[0].uuid];
      for (const participant of party) {
        expect(participant.queueUuids()).toEqual(expectedOrder);
      }
    });

    it('replaces a queue item for everyone (FullSync path)', async () => {
      const { party, climbs } = await partyWithFourClimbs();
      const replacement = makeClimb('e');

      await party[3].mutations.replaceQueueItem(climbs[1].uuid, replacement);
      await assertConverged(party);

      for (const participant of party) {
        expect(participant.queueUuids()).toEqual([climbs[0].uuid, replacement.uuid, climbs[2].uuid, climbs[3].uuid]);
      }
    });

    it('clears the queue and current climb for everyone', async () => {
      const { party, climbs } = await partyWithFourClimbs();

      await party[0].navigateToClimb(climbs[0]); // give it a current to clear
      await assertConverged(party);
      // Clearing is current-then-queue: setCurrentClimb(null) broadcasts the
      // null current, setQueue([]) empties the list via FullSync.
      await party[0].mutations.setCurrentClimb(null);
      await party[0].mutations.setQueue([], null);
      await assertConverged(party);

      for (const participant of party) {
        expect(participant.queueUuids()).toEqual([]);
        expect(participant.currentUuid).toBeNull();
      }
    });
  });

  describe('Driver / wall control', () => {
    it('makes the caller the driver for everyone and broadcasts the climb', async () => {
      const { party, climbs } = await partyWithFourClimbs();
      const [alice] = party;

      await alice.takeWall(climbs[0]);

      await waitFor(() => party.every((p) => p.driverParticipantId === alice.participantId), {
        label: 'driver = Alice',
      });
      await assertConverged(party);
      for (const participant of party) {
        expect(participant.currentUuid).toBe(climbs[0].uuid);
      }
    });

    it('hands the wall to another participant on take, and clears it on release', async () => {
      const { party, climbs } = await partyWithFourClimbs();
      const [alice, bob] = party;

      await alice.takeWall(climbs[0]);
      await waitFor(() => party.every((p) => p.driverParticipantId === alice.participantId), {
        label: 'driver = Alice',
      });

      // Yank-on-press: Bob takes it from Alice.
      await bob.takeWall(climbs[1]);
      await waitFor(() => party.every((p) => p.driverParticipantId === bob.participantId), { label: 'driver = Bob' });

      await bob.mutations.releaseControl();
      await waitFor(() => party.every((p) => p.driverParticipantId === null), { label: 'driver released' });
    });

    it('broadcasts a wall confirmation to every member', async () => {
      const { party, climbs } = await partyWithFourClimbs();
      const [alice, bob] = party;

      // The climb must have been on the wall recently for the confirm to be accepted.
      await alice.takeWall(climbs[0]);
      await waitFor(() => party.every((p) => p.driverParticipantId === alice.participantId), {
        label: 'driver = Alice',
      });

      await bob.mutations.confirmClimbOnWall(climbs[0].climb.uuid);

      await waitFor(() => party.every((p) => p.wallConfirmations.some((c) => c.climbUuid === climbs[0].climb.uuid)), {
        label: 'wall confirmation fanned out',
      });
    });

    it('propagates board serial and board path to every member', async () => {
      const party = await spawnParty(['Alice', 'Bob', 'Cara', 'Dre']);
      const [alice] = party;

      await alice.mutations.setSessionBoardSerial('SN-TEST-1234');
      await waitFor(() => party.every((p) => p.boardSerial === 'SN-TEST-1234'), { label: 'board serial synced' });

      await alice.mutations.setSessionBoardPath('/kilter/1/2/3/50');
      await waitFor(() => party.slice(1).every((p) => p.boardPath === '/kilter/1/2/3/50'), {
        label: 'board path synced',
      });
    });
  });

  describe('Resilience', () => {
    it('catches a reconnecting client up via EVENTS_REPLAY', async () => {
      const { party, climbs } = await partyWithFourClimbs();
      const [alice, bob, cara] = party;

      await cara.disconnect();

      // While Cara is offline, the others edit the queue.
      const offlineAdd = makeClimb('e');
      await alice.mutations.addQueueItem(offlineAdd);
      await bob.mutations.removeQueueItem(climbs[0].uuid);

      await cara.reconnect();
      await assertConverged(party);

      const expected = [climbs[1].uuid, climbs[2].uuid, climbs[3].uuid, offlineAdd.uuid];
      for (const participant of party) {
        expect(participant.queueUuids()).toEqual(expected);
      }
    });

    it('detects a sequence gap and self-heals via resync', async () => {
      const { party } = await partyWithFourClimbs();
      const [alice, , cara] = party;

      // Cara silently misses the next delta, opening a gap on the one after.
      cara.dropNextInboundEvents(1);
      await alice.mutations.addQueueItem(makeClimb('e')); // dropped by Cara
      await alice.mutations.addQueueItem(makeClimb('f')); // gap → Cara resyncs

      await assertConverged(party);
      expect(cara.gapDetected).toBeGreaterThanOrEqual(1);
      // Everyone (including the recovered Cara) ends on the same 6-item queue.
      for (const participant of party) {
        expect(participant.queueUuids()).toHaveLength(6);
      }
    });
  });
});
