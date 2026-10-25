/**
 * Tests for `setCurrentClimbAndPublish` — the shared helper consolidated in
 * Phase 3.2 of the queue-control-bar pivot simplify pass.
 *
 * The helper now accepts `item: ClimbQueueItem | null`. Coverage here exists
 * because the consolidation pulled three call sites (queue/setCurrentClimb
 * with non-null item, queue/setCurrentClimb with null item, the widget
 * re-assert handler) through the same path, and the null-item branch had its
 * own retry+publish ladder before the refactor.
 *
 * Behaviours verified:
 *  1. `item: null` → publishes `CurrentClimbChanged { item: null }`, never
 *     `FullSync`. The wire format change is the user-visible bit of the
 *     refactor — a regression here would break clear-current-climb syncs.
 *  2. `item: null, shouldAddToQueue: true` → the `shouldAddToQueue` flag is
 *     ignored (no climb to add); still emits `CurrentClimbChanged`.
 *  3. `item: null` → `pushRecentClimb` is not called. The ring buffer only
 *     accepts authoritative wall climbs; a clear is not one.
 *  4. `item: <climb>, shouldAddToQueue: true, not in queue` → publishes
 *     `FullSync` whose queue has the new climb inserted immediately after the
 *     current climb (issue #2217), falling back to append when there is no
 *     current climb to anchor to.
 *  5. `item: <climb>, shouldAddToQueue: true, already in queue` → publishes
 *     `CurrentClimbChanged` (no second copy of the queue item).
 *  6. `clientId` / `correlationId` flow through to `CurrentClimbChanged`
 *     unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { navigateToQueueItem, setCurrentClimbAndPublish } from '../services/queue-navigation';
import type { RoomManager } from '../services/room-manager/room-manager';
import type { pubsub as PubSubInstance } from '../pubsub/index';
// The mocked room manager + pubsub satisfy only the slice of the interfaces
// that `setCurrentClimbAndPublish` touches; the casts at call sites narrow
// the structural types so we don't need to stub the full surface.

function makeClimb(uuid = 'item-1', climbUuid = 'climb-1'): ClimbQueueItem {
  return {
    uuid,
    climb: { uuid: climbUuid, name: 'Test Climb' },
    addedBy: 'participant-1',
    suggested: false,
  } as ClimbQueueItem;
}

type MockedRoomManager = {
  getQueueState: ReturnType<typeof vi.fn>;
  updateQueueState: ReturnType<typeof vi.fn>;
  pushRecentClimb: ReturnType<typeof vi.fn>;
};

function makeRoomManager(
  overrides: Partial<{
    queue: ClimbQueueItem[];
    currentClimb: ClimbQueueItem | null;
    sequence: number;
    stateHash: string;
    version: number;
  }> = {},
): MockedRoomManager {
  const initialQueue = overrides.queue ?? [];
  const sequence = overrides.sequence ?? 1;
  const stateHash = overrides.stateHash ?? 'hash-1';
  return {
    getQueueState: vi.fn().mockResolvedValue({
      queue: initialQueue,
      currentClimbQueueItem: overrides.currentClimb ?? null,
      sequence: 0,
      stateHash: 'hash-0',
      version: overrides.version ?? 0,
    }),
    updateQueueState: vi.fn().mockResolvedValue({ sequence, stateHash, version: 1, previousStateHash: 'hash-0' }),
    pushRecentClimb: vi.fn().mockResolvedValue(undefined),
  };
}

function makePubsub(): { publishQueueEvent: ReturnType<typeof vi.fn> } {
  return { publishQueueEvent: vi.fn() };
}

describe('setCurrentClimbAndPublish — null-item path', () => {
  let roomManager: ReturnType<typeof makeRoomManager>;
  let pubsub: ReturnType<typeof makePubsub>;

  beforeEach(() => {
    roomManager = makeRoomManager();
    pubsub = makePubsub();
  });

  it('publishes CurrentClimbChanged with item: null (not FullSync)', async () => {
    await setCurrentClimbAndPublish(
      'session-1',
      null,
      false,
      roomManager as unknown as RoomManager,
      pubsub as unknown as typeof PubSubInstance,
      'client-1',
      'corr-1',
    );

    expect(pubsub.publishQueueEvent).toHaveBeenCalledTimes(1);
    const [sessionId, event] = pubsub.publishQueueEvent.mock.calls[0];
    expect(sessionId).toBe('session-1');
    expect(event.__typename).toBe('CurrentClimbChanged');
    expect(event.item).toBeNull();
    expect(event.clientId).toBe('client-1');
    expect(event.correlationId).toBe('corr-1');
  });

  it('ignores shouldAddToQueue: true when item is null (still CurrentClimbChanged, no queue append)', async () => {
    await setCurrentClimbAndPublish(
      'session-1',
      null,
      true,
      roomManager as unknown as RoomManager,
      pubsub as unknown as typeof PubSubInstance,
    );

    expect(pubsub.publishQueueEvent).toHaveBeenCalledTimes(1);
    expect(pubsub.publishQueueEvent.mock.calls[0][1].__typename).toBe('CurrentClimbChanged');
    // updateQueueState gets the original (empty) queue — no append happened.
    expect(roomManager.updateQueueState).toHaveBeenCalledWith('session-1', [], null, 0, 0);
  });

  it('does not call pushRecentClimb when item is null (ring buffer skipped)', async () => {
    await setCurrentClimbAndPublish(
      'session-1',
      null,
      false,
      roomManager as unknown as RoomManager,
      pubsub as unknown as typeof PubSubInstance,
    );

    expect(roomManager.pushRecentClimb).not.toHaveBeenCalled();
  });

  it('defaults clientId / correlationId to null on the wire when omitted', async () => {
    await setCurrentClimbAndPublish(
      'session-1',
      null,
      false,
      roomManager as unknown as RoomManager,
      pubsub as unknown as typeof PubSubInstance,
    );

    const event = pubsub.publishQueueEvent.mock.calls[0][1];
    expect(event.clientId).toBeNull();
    expect(event.correlationId).toBeNull();
  });
});

describe('setCurrentClimbAndPublish — non-null item', () => {
  let pubsub: ReturnType<typeof makePubsub>;

  beforeEach(() => {
    pubsub = makePubsub();
  });

  it('publishes FullSync when shouldAddToQueue=true and the climb is not in the queue', async () => {
    const roomManager = makeRoomManager({ queue: [] });
    const item = makeClimb();

    await setCurrentClimbAndPublish(
      'session-1',
      item,
      true,
      roomManager as unknown as RoomManager,
      pubsub as unknown as typeof PubSubInstance,
    );

    expect(pubsub.publishQueueEvent).toHaveBeenCalledTimes(1);
    const event = pubsub.publishQueueEvent.mock.calls[0][1];
    expect(event.__typename).toBe('FullSync');
    expect(event.state.queue).toEqual([item]);
    expect(event.state.currentClimbQueueItem).toEqual(item);
    expect(roomManager.pushRecentClimb).toHaveBeenCalledWith('session-1', 'climb-1');
  });

  it('inserts a new climb immediately after the current climb, not at the end (issue #2217)', async () => {
    const climbA = makeClimb('item-a', 'climb-a');
    const climbB = makeClimb('item-b', 'climb-b');
    const climbC = makeClimb('item-c', 'climb-c');
    const newClimb = makeClimb('item-x', 'climb-x');
    const roomManager = makeRoomManager({ queue: [climbA, climbB, climbC], currentClimb: climbA });

    await setCurrentClimbAndPublish(
      'session-1',
      newClimb,
      true,
      roomManager as unknown as RoomManager,
      pubsub as unknown as typeof PubSubInstance,
    );

    const event = pubsub.publishQueueEvent.mock.calls[0][1];
    expect(event.__typename).toBe('FullSync');
    // New climb slots in right after the current climb (A), pushing A into
    // history — NOT appended after C.
    expect(event.state.queue).toEqual([climbA, newClimb, climbB, climbC]);
    expect(event.state.currentClimbQueueItem).toEqual(newClimb);
    // The persisted queue matches the published order.
    expect(roomManager.updateQueueState).toHaveBeenCalledWith(
      'session-1',
      [climbA, newClimb, climbB, climbC],
      newClimb,
      0,
      1,
    );
  });

  it('falls back to appending when there is no current climb to anchor the insertion', async () => {
    const climbA = makeClimb('item-a', 'climb-a');
    const climbB = makeClimb('item-b', 'climb-b');
    const newClimb = makeClimb('item-x', 'climb-x');
    const roomManager = makeRoomManager({ queue: [climbA, climbB], currentClimb: null });

    await setCurrentClimbAndPublish(
      'session-1',
      newClimb,
      true,
      roomManager as unknown as RoomManager,
      pubsub as unknown as typeof PubSubInstance,
    );

    const event = pubsub.publishQueueEvent.mock.calls[0][1];
    expect(event.__typename).toBe('FullSync');
    expect(event.state.queue).toEqual([climbA, climbB, newClimb]);
    // The persisted queue matches the published order (append fallback).
    // Outside QUEUE_NOW_SLOT_PERCENT this is today's append, so A and B are
    // filed under History (the line is the new climb's index).
    expect(roomManager.updateQueueState).toHaveBeenCalledWith('session-1', [climbA, climbB, newClimb], newClimb, 0, 2);
  });

  it('inserts after current regardless of the suggested flag (web peek-promotion shape)', async () => {
    // Web's setCurrentClimbQueueItem promotes a suggested/peek climb via
    // setCurrentClimb(item, suggested). The positioning here is driven purely by
    // the current-climb anchor, NOT by `suggested` — pin that so a future change
    // can't accidentally special-case suggested climbs back to appending.
    const climbA = makeClimb('item-a', 'climb-a');
    const climbB = makeClimb('item-b', 'climb-b');
    const suggestedClimb = { ...makeClimb('item-x', 'climb-x'), suggested: true } as ClimbQueueItem;
    const roomManager = makeRoomManager({ queue: [climbA, climbB], currentClimb: climbA });

    await setCurrentClimbAndPublish(
      'session-1',
      suggestedClimb,
      true,
      roomManager as unknown as RoomManager,
      pubsub as unknown as typeof PubSubInstance,
    );

    const event = pubsub.publishQueueEvent.mock.calls[0][1];
    expect(event.__typename).toBe('FullSync');
    expect(event.state.queue).toEqual([climbA, suggestedClimb, climbB]);
    expect(event.state.currentClimbQueueItem).toEqual(suggestedClimb);
  });

  it('publishes CurrentClimbChanged when shouldAddToQueue=true but the climb is already queued', async () => {
    const item = makeClimb();
    const roomManager = makeRoomManager({ queue: [item] });

    await setCurrentClimbAndPublish(
      'session-1',
      item,
      true,
      roomManager as unknown as RoomManager,
      pubsub as unknown as typeof PubSubInstance,
    );

    expect(pubsub.publishQueueEvent).toHaveBeenCalledTimes(1);
    expect(pubsub.publishQueueEvent.mock.calls[0][1].__typename).toBe('CurrentClimbChanged');
    expect(pubsub.publishQueueEvent.mock.calls[0][1].item).toEqual(item);
  });
});

// ---------------------------------------------------------------------------
// F3: the Now slot (#6666, docs/current-climb-outside-queue.md, sections 1-3,
// 8 and 9). A stateful in-memory room so the placement, the cap and the event
// choice can be read off what was stored and published.
// ---------------------------------------------------------------------------

type StoredRoom = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  historyCount: number;
  version: number;
  sequence: number;
};

function makeRoom(initial: { queue: ClimbQueueItem[]; current: ClimbQueueItem | null; historyCount?: number }) {
  const room: StoredRoom = {
    queue: initial.queue,
    currentClimbQueueItem: initial.current,
    historyCount: initial.historyCount ?? 0,
    version: 7,
    sequence: 40,
  };
  const roomManager = {
    getQueueState: vi.fn(async () => ({
      ...room,
      stateHash: `hash-${room.sequence}`,
      stateHashOrdered: `ordered-${room.sequence}`,
      currentChangedAt: '2026-10-24T10:00:00.000Z',
    })),
    updateQueueState: vi.fn(
      async (
        _sessionId: string,
        queue: ClimbQueueItem[],
        current: ClimbQueueItem | null,
        _expectedVersion: number | undefined,
        historyCount: number,
      ) => {
        room.queue = queue;
        room.currentClimbQueueItem = current;
        room.historyCount = historyCount;
        room.version += 1;
        room.sequence += 1;
        return {
          version: room.version,
          sequence: room.sequence,
          stateHash: `hash-${room.sequence}`,
          stateHashOrdered: `ordered-${room.sequence}`,
          historyCount,
          currentChangedAt: '2026-10-24T10:00:00.000Z',
          previousStateHash: null,
          previousStateHashOrdered: null,
        };
      },
    ),
    pushRecentClimb: vi.fn().mockResolvedValue(undefined),
  };
  return { room, roomManager };
}

/** A fresh queue item for climb `climbUuid` at 40°. */
function wallItem(uuid: string, climbUuid = `climb-${uuid}`, angle = 40): ClimbQueueItem {
  return {
    uuid,
    climb: { uuid: climbUuid, name: climbUuid, angle },
    addedBy: 'participant-1',
    suggested: false,
  } as ClimbQueueItem;
}

const uuidsOf = (queue: ClimbQueueItem[]) => queue.map((queueItem) => queueItem.uuid);

type PublishedCall = [string, { __typename: string } & Record<string, unknown>, { buffer?: boolean }?];

function publishedEvents(pubsubMock: { publishQueueEvent: ReturnType<typeof vi.fn> }) {
  return (pubsubMock.publishQueueEvent.mock.calls as PublishedCall[]).map(([, event, options]) => ({
    event,
    options,
  }));
}

async function placeClimb(
  room: ReturnType<typeof makeRoom>,
  item: ClimbQueueItem | null,
  options: {
    shouldAddToQueue?: boolean | null;
    placement?: 'NOW' | 'STEP' | null;
    clientId?: string;
    correlationId?: string;
  } = {},
) {
  const pubsubMock = makePubsub();
  const outcome = await setCurrentClimbAndPublish(
    'session-f3',
    item,
    options.shouldAddToQueue,
    room.roomManager as unknown as RoomManager,
    pubsubMock as unknown as typeof PubSubInstance,
    options.clientId ?? 'client-old',
    options.correlationId ?? 'corr-1',
    options.placement ?? null,
  );
  return { outcome, events: publishedEvents(pubsubMock) };
}

describe('setCurrentClimbAndPublish — F3 Now slot', () => {
  const previousPercent = process.env.QUEUE_NOW_SLOT_PERCENT;

  afterEach(() => {
    if (previousPercent === undefined) delete process.env.QUEUE_NOW_SLOT_PERCENT;
    else process.env.QUEUE_NOW_SLOT_PERCENT = previousPercent;
  });

  // Start of every case: A, B (current), C, D. History [A], Up next [C, D].
  const itemA = wallItem('a');
  const itemB = wallItem('b');
  const itemC = wallItem('c');
  const itemD = wallItem('d');
  const standardRoom = () => makeRoom({ queue: [itemA, itemB, itemC, itemD], current: itemB });

  describe('inside the percent (100)', () => {
    beforeEach(() => {
      process.env.QUEUE_NOW_SLOT_PERCENT = '100';
    });

    it('none: re-lighting the current climb is a pointer event with the origin correlation id', async () => {
      const room = standardRoom();
      const { outcome, events } = await placeClimb(room, itemB, { shouldAddToQueue: true });
      expect(outcome.rewrite).toBe('none');
      expect(events).toHaveLength(1);
      expect(events[0].event).toMatchObject({
        __typename: 'CurrentClimbChanged',
        clientId: 'client-old',
        correlationId: 'corr-1',
      });
    });

    it('next: Up next[0] moves the pointer one step forward (S9)', async () => {
      const room = standardRoom();
      const { outcome, events } = await placeClimb(room, itemC, { shouldAddToQueue: false });
      expect(outcome.rewrite).toBe('next');
      expect(uuidsOf(room.room.queue)).toEqual(['a', 'b', 'c', 'd']);
      expect(room.room.historyCount).toBe(2);
      expect(events.map(({ event }) => event.__typename)).toEqual(['CurrentClimbChanged']);
    });

    it('step: the last History entry moves the pointer back, and the climb left becomes Up next[0]', async () => {
      const room = standardRoom();
      const { outcome, events } = await placeClimb(room, itemA, { shouldAddToQueue: false });
      expect(outcome.rewrite).toBe('step');
      expect(room.room.currentClimbQueueItem?.uuid).toBe('a');
      expect(events.map(({ event }) => event.__typename)).toEqual(['CurrentClimbChanged']);
    });

    it('STEP onto a History entry that is no longer last (a crewmate opened first) is still a pointer step', async () => {
      const room = makeRoom({ queue: [itemA, itemB, itemC, itemD], current: itemC });
      const { outcome, events } = await placeClimb(room, itemA, { placement: 'STEP' });
      expect(outcome.rewrite).toBe('step');
      expect(uuidsOf(room.room.queue)).toEqual(['a', 'b', 'c', 'd']);
      expect(events.map(({ event }) => event.__typename)).toEqual(['CurrentClimbChanged']);
    });

    it('move-up-next: a queue-row tap on D skips nothing; C stays Up next (S7) with FullSync + same-sequence trailing', async () => {
      const room = standardRoom();
      const { outcome, events } = await placeClimb(room, itemD, { shouldAddToQueue: true });
      expect(outcome.rewrite).toBe('move-up-next');
      expect(uuidsOf(room.room.queue)).toEqual(['a', 'b', 'd', 'c']);
      expect(room.room.currentClimbQueueItem?.uuid).toBe('d');
      expect(events.map(({ event }) => event.__typename)).toEqual(['FullSync', 'CurrentClimbChanged']);
      const [fullSync, trailing] = events;
      expect(trailing.event.sequence).toBe(fullSync.event.sequence);
      expect(trailing.event).toMatchObject({ clientId: 'client-old', correlationId: null });
      expect((trailing.event.item as ClimbQueueItem).uuid).toBe('d');
      // The trailing event stays out of the replay buffer; the FullSync doesn't.
      expect(trailing.options).toEqual({ buffer: false });
      expect(fullSync.options).toBeUndefined();
      expect(fullSync.event).toMatchObject({ state: expect.objectContaining({ historyCount: 2 }) });
    });

    it("dedupe-up-next: the issue's case — a fresh uuid for C moves C into Now, no copy (S3)", async () => {
      const room = standardRoom();
      const freshC = wallItem('c-prime', 'climb-c');
      const { outcome, events } = await placeClimb(room, freshC, { shouldAddToQueue: true });
      expect(outcome.rewrite).toBe('dedupe-up-next');
      expect(uuidsOf(room.room.queue)).toEqual(['a', 'b', 'c', 'd']);
      expect(room.room.currentClimbQueueItem?.uuid).toBe('c');
      expect(events.map(({ event }) => event.__typename)).toEqual(['FullSync', 'CurrentClimbChanged']);
    });

    it('dedupe-current: a fresh uuid for the current climb is a FullSync so the old phone drops its copy (S4)', async () => {
      const room = standardRoom();
      const { outcome, events } = await placeClimb(room, wallItem('b-prime', 'climb-b'), { shouldAddToQueue: true });
      expect(outcome.rewrite).toBe('dedupe-current');
      expect(uuidsOf(room.room.queue)).toEqual(['a', 'b', 'c', 'd']);
      expect(events.map(({ event }) => event.__typename)).toEqual(['FullSync', 'CurrentClimbChanged']);
    });

    it('insert: a new climb lands at the Now slot as a plain FullSync (S1, S5)', async () => {
      const room = standardRoom();
      const { outcome, events } = await placeClimb(room, wallItem('x'), { placement: 'NOW' });
      expect(outcome.rewrite).toBe('insert');
      expect(uuidsOf(room.room.queue)).toEqual(['a', 'b', 'x', 'c', 'd']);
      expect(events.map(({ event }) => event.__typename)).toEqual(['FullSync']);
    });

    it('next-from-line: with nothing current an old Next naming queue[0] lights Up next[0] (S12) with FullSync + trailing', async () => {
      const room = makeRoom({ queue: [itemA, itemC, itemD], current: null, historyCount: 1 });
      const { outcome, events } = await placeClimb(room, itemA, { shouldAddToQueue: false });
      expect(outcome.rewrite).toBe('next-from-line');
      expect(room.room.currentClimbQueueItem?.uuid).toBe('c');
      expect(uuidsOf(room.room.queue)).toEqual(['a', 'c', 'd']);
      expect(room.room.historyCount).toBe(1);
      expect(events.map(({ event }) => event.__typename)).toEqual(['FullSync', 'CurrentClimbChanged']);
      // Not a pointer event: the old phone's correlation id would drop it as its own echo.
      expect(events[1].event.correlationId).toBeNull();
    });

    it('a long History stays History when an old phone presses Next after a removal (S15)', async () => {
      const history = Array.from({ length: 60 }, (_, index) => wallItem(`h${index + 1}`));
      const room = makeRoom({ queue: [...history, itemC, itemD], current: null, historyCount: 60 });
      const { outcome } = await placeClimb(room, history[0], { shouldAddToQueue: false });
      expect(outcome.rewrite).toBe('next-from-line');
      expect(room.room.currentClimbQueueItem?.uuid).toBe('c');
      expect(room.room.historyCount).toBe(60);
    });

    it('a row tap on queue[0] with nothing current lights the climb tapped, not Up next[0] (S18)', async () => {
      const history = [wallItem('h1'), wallItem('h2'), wallItem('h3')];
      const room = makeRoom({ queue: [...history, itemC, itemD], current: null, historyCount: 3 });
      const { outcome } = await placeClimb(room, history[0], { shouldAddToQueue: true });
      expect(outcome.rewrite).toBe('move-history');
      expect(uuidsOf(room.room.queue)).toEqual(['h2', 'h3', 'h1', 'c', 'd']);
      expect(room.room.currentClimbQueueItem?.uuid).toBe('h1');
    });

    it('the native socket (no shouldAddToQueue) naming queue[0] after a clear is never read as an old Next', async () => {
      const room = makeRoom({ queue: [itemA, wallItem('a2'), itemC], current: null, historyCount: 2 });
      const { outcome } = await placeClimb(room, itemA, {});
      expect(outcome.rewrite).toBe('move-history');
      expect(room.room.currentClimbQueueItem?.uuid).toBe('a');
    });

    it('clear: the current climb stays as History, line = its index + 1, pointer CurrentClimbChanged(null)', async () => {
      const room = standardRoom();
      const { outcome, events } = await placeClimb(room, null);
      expect(outcome.rewrite).toBe('clear');
      expect(room.room.historyCount).toBe(2);
      expect(events).toHaveLength(1);
      expect(events[0].event).toMatchObject({ __typename: 'CurrentClimbChanged', item: null });
    });

    it.each([
      ['a new phone (placement NOW)', { placement: 'NOW' as const }],
      ['the native socket or an old phone (no placement)', {}],
    ])('a clear that drops the cleared climb is a lone FullSync for %s', async (_label, request) => {
      // One climb on the wall and 500 Up next: the cleared climb would be
      // History's only entry at 501, so the cap removes it.
      const current = wallItem('now');
      const upNext = Array.from({ length: 500 }, (_, index) => wallItem(`u${index}`));
      const room = makeRoom({ queue: [current, ...upNext], current, historyCount: 0 });
      const { outcome, events } = await placeClimb(room, null, request);
      expect(outcome.rewrite).toBe('clear');
      expect(outcome.trimmedCount).toBe(1);
      expect(outcome.event).toBe('fullsync');
      expect(uuidsOf(room.room.queue)).toEqual(uuidsOf(upNext));
      expect(room.room.currentClimbQueueItem).toBeNull();
      expect(room.room.historyCount).toBe(0);
      expect(events.map(({ event }) => event.__typename)).toEqual(['FullSync']);
    });

    it('the History cap trims to 100 at 125 and publishes FullSync + trailing', async () => {
      const history = Array.from({ length: 124 }, (_, index) => wallItem(`h${index + 1}`));
      const current = wallItem('now');
      const room = makeRoom({ queue: [...history, current, itemC], current });
      // Next onto C makes History 125 entries long.
      const { outcome, events } = await placeClimb(room, itemC, { shouldAddToQueue: false });
      expect(outcome.trimmedCount).toBe(25);
      // 100 History + C current; Up next is empty.
      expect(room.room.queue).toHaveLength(101);
      expect(room.room.historyCount).toBe(100);
      expect(room.room.currentClimbQueueItem?.uuid).toBe('c');
      expect(events.map(({ event }) => event.__typename)).toEqual(['FullSync', 'CurrentClimbChanged']);
    });
  });

  describe('outside the percent (unset = 0)', () => {
    beforeEach(() => {
      delete process.env.QUEUE_NOW_SLOT_PERCENT;
    });

    it("keeps today's pointer move for a placement-less queue-row tap", async () => {
      const room = standardRoom();
      const { outcome, events } = await placeClimb(room, itemD, { shouldAddToQueue: true });
      expect(outcome.rewrite).toBe('legacy-pointer');
      expect(uuidsOf(room.room.queue)).toEqual(['a', 'b', 'c', 'd']);
      expect(room.room.currentClimbQueueItem?.uuid).toBe('d');
      expect(room.room.historyCount).toBe(3);
      expect(events.map(({ event }) => event.__typename)).toEqual(['CurrentClimbChanged']);
    });

    it("keeps today's copy for a placement-less fresh uuid of a queued climb", async () => {
      const room = standardRoom();
      const { outcome } = await placeClimb(room, wallItem('c-prime', 'climb-c'), { shouldAddToQueue: true });
      expect(outcome.rewrite).toBe('insert');
      expect(uuidsOf(room.room.queue)).toEqual(['a', 'b', 'c-prime', 'c', 'd']);
    });

    it('gives a placement-carrying call the new rules at any percent', async () => {
      const room = standardRoom();
      const { outcome, events } = await placeClimb(room, wallItem('c-prime', 'climb-c'), { placement: 'NOW' });
      expect(outcome.rewrite).toBe('dedupe-up-next');
      expect(outcome.nowSlotRules).toBe(true);
      expect(uuidsOf(room.room.queue)).toEqual(['a', 'b', 'c', 'd']);
      expect(events.map(({ event }) => event.__typename)).toEqual(['FullSync', 'CurrentClimbChanged']);
    });

    it('trims History for a placement NOW at percent 0 and publishes FullSync + trailing', async () => {
      const history = Array.from({ length: 124 }, (_, index) => wallItem(`h${index + 1}`));
      const current = wallItem('now');
      const room = makeRoom({ queue: [...history, current], current });
      const { outcome, events } = await placeClimb(room, wallItem('x'), { placement: 'NOW' });
      expect(outcome.trimmedCount).toBe(25);
      expect(room.room.historyCount).toBe(100);
      expect(events.map(({ event }) => event.__typename)).toEqual(['FullSync', 'CurrentClimbChanged']);
    });

    it('does not trim a placement-less call at percent 0', async () => {
      const history = Array.from({ length: 124 }, (_, index) => wallItem(`h${index + 1}`));
      const current = wallItem('now');
      const room = makeRoom({ queue: [...history, current, itemC], current });
      const { outcome } = await placeClimb(room, itemC, { shouldAddToQueue: false });
      expect(outcome.trimmedCount).toBe(0);
      expect(room.room.queue).toHaveLength(126);
    });
  });

  describe.each(['0', '100'])('at QUEUE_NOW_SLOT_PERCENT=%s', (percent) => {
    beforeEach(() => {
      process.env.QUEUE_NOW_SLOT_PERCENT = percent;
    });

    it("inserts the native socket's stale item at the Now slot plus the trailing event, never an orphan", async () => {
      const room = standardRoom();
      const stale = wallItem('gone');
      const { outcome, events } = await placeClimb(room, stale, {});
      expect(outcome.rewrite).toBe('insert');
      expect(uuidsOf(room.room.queue)).toEqual(['a', 'b', 'gone', 'c', 'd']);
      expect(room.room.currentClimbQueueItem?.uuid).toBe('gone');
      expect(events.map(({ event }) => event.__typename)).toEqual(['FullSync', 'CurrentClimbChanged']);
      expect(events[1].options).toEqual({ buffer: false });
    });

    it('normalises a room holding a pre-F3 orphan on its first write', async () => {
      const orphan = wallItem('orphan');
      const room = makeRoom({ queue: [itemA, itemC, itemD], current: orphan, historyCount: 0 });
      const { events } = await placeClimb(room, itemC, { shouldAddToQueue: false });
      // The orphan was inserted at the line (0), then C went on the wall.
      expect(room.room.queue.some((queueItem) => queueItem.uuid === 'orphan')).toBe(true);
      expect(room.room.queue.some((queueItem) => queueItem.uuid === room.room.currentClimbQueueItem?.uuid)).toBe(true);
      expect(events[0].event.__typename).toBe('FullSync');
    });

    it('a clear in a room holding a pre-F3 orphan is a lone FullSync', async () => {
      const orphan = wallItem('orphan');
      const room = makeRoom({ queue: [itemA, itemC, itemD], current: orphan, historyCount: 0 });
      const { outcome, events } = await placeClimb(room, null);
      expect(outcome.event).toBe('fullsync');
      expect(room.room.currentClimbQueueItem).toBeNull();
      expect(room.room.queue.some((queueItem) => queueItem.uuid === 'orphan')).toBe(true);
      expect(events.map(({ event }) => event.__typename)).toEqual(['FullSync']);
    });

    it('keeps the line through a clear (historyCount = cleared index + 1)', async () => {
      const room = standardRoom();
      await placeClimb(room, null);
      expect(room.room.currentClimbQueueItem).toBeNull();
      expect(room.room.historyCount).toBe(2);
    });
  });
});

describe('navigateToQueueItem — F3 orphan normalisation', () => {
  const itemA = wallItem('a');
  const itemC = wallItem('c');
  const itemD = wallItem('d');

  async function navigate(room: ReturnType<typeof makeRoom>, targetIndex: number) {
    const pubsubMock = makePubsub();
    const result = await navigateToQueueItem(
      'session-f3',
      targetIndex,
      room.roomManager as unknown as RoomManager,
      pubsubMock as unknown as typeof PubSubInstance,
      'client-widget',
      'corr-widget',
    );
    return { result, events: publishedEvents(pubsubMock) };
  }

  it('keeps a pre-F3 orphan in History on a widget Next and publishes FullSync + trailing', async () => {
    // Stored before F3: [A | C D] with orphan X current, line 1. The widget's
    // Next reads queue[historyCount] = C.
    const orphan = wallItem('orphan');
    const room = makeRoom({ queue: [itemA, itemC, itemD], current: orphan, historyCount: 1 });
    const { result, events } = await navigate(room, 1);

    expect(result?.item.uuid).toBe('c');
    expect(uuidsOf(room.room.queue)).toEqual(['a', 'orphan', 'c', 'd']);
    expect(room.room.currentClimbQueueItem?.uuid).toBe('c');
    expect(room.room.historyCount).toBe(2);
    expect(events.map(({ event }) => event.__typename)).toEqual(['FullSync', 'CurrentClimbChanged']);
    expect(events[1].options).toEqual({ buffer: false });
    expect(events[1].event.correlationId).toBeNull();
  });

  it('keeps the pointer event when nothing needed normalising', async () => {
    const room = makeRoom({ queue: [itemA, itemC, itemD], current: itemA });
    const { result, events } = await navigate(room, 1);

    expect(result?.item.uuid).toBe('c');
    expect(uuidsOf(room.room.queue)).toEqual(['a', 'c', 'd']);
    expect(room.room.historyCount).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].event).toMatchObject({ __typename: 'CurrentClimbChanged', correlationId: 'corr-widget' });
  });
});

describe('publishQueueEvent buffer option (the F3 trailing event)', () => {
  it('keeps a buffer:false event out of the replay buffer but still runs the queue-event hooks', async () => {
    const { pubsub: realPubsub } = await import('../pubsub/index');
    const bufferSpy = vi
      .spyOn(realPubsub as unknown as { storeEventInBuffer: () => Promise<void> }, 'storeEventInBuffer')
      .mockResolvedValue(undefined);
    const hook = vi.fn();
    const unregister = realPubsub.addQueueEventHook(hook);
    try {
      const trailing = {
        __typename: 'CurrentClimbChanged' as const,
        sequence: 9,
        stateHash: 'hash',
        stateHashOrdered: 'ordered',
        item: wallItem('t'),
        clientId: null,
        correlationId: null,
      };
      realPubsub.publishQueueEvent('session-buffer', trailing, { buffer: false });
      expect(bufferSpy).not.toHaveBeenCalled();
      expect(hook).toHaveBeenCalledWith('session-buffer', trailing);

      realPubsub.publishQueueEvent('session-buffer', { ...trailing, sequence: 10 });
      expect(bufferSpy).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
      bufferSpy.mockRestore();
    }
  });
});

describe('QUEUE_NOW_SLOT_PERCENT parser', () => {
  it.each([
    [undefined, 0],
    ['', 0],
    ['abc', 0],
    ['-5', 0],
    ['150', 100],
    [' 50 ', 50],
    ['10', 10],
  ])('reads %s as %d', async (raw, expected) => {
    const { parseNowSlotPercent } = await import('../services/queue-now-slot-rollout');
    expect(parseNowSlotPercent(raw)).toBe(expected);
  });

  it('puts every session in at 100, none at 0, and a stable subset in between', async () => {
    const { isNowSlotSession, nowSlotBucket } = await import('../services/queue-now-slot-rollout');
    const previous = process.env.QUEUE_NOW_SLOT_PERCENT;
    try {
      const sessionIds = Array.from({ length: 200 }, (_, index) => `session-${index}`);
      process.env.QUEUE_NOW_SLOT_PERCENT = '100';
      expect(sessionIds.every((sessionId) => isNowSlotSession(sessionId))).toBe(true);
      process.env.QUEUE_NOW_SLOT_PERCENT = '0';
      expect(sessionIds.some((sessionId) => isNowSlotSession(sessionId))).toBe(false);
      process.env.QUEUE_NOW_SLOT_PERCENT = '50';
      const inside = sessionIds.filter((sessionId) => isNowSlotSession(sessionId));
      expect(inside.every((sessionId) => nowSlotBucket(sessionId) < 50)).toBe(true);
      expect(inside.length).toBeGreaterThan(50);
      expect(inside.length).toBeLessThan(150);
    } finally {
      if (previous === undefined) delete process.env.QUEUE_NOW_SLOT_PERCENT;
      else process.env.QUEUE_NOW_SLOT_PERCENT = previous;
    }
  });
});
