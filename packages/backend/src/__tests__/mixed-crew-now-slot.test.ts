/**
 * F3 mixed crew (#6666, docs/current-climb-outside-queue.md, sections 3 and 9).
 *
 * S1 to S18 from the "Step by step" table, through the real resolvers and a
 * real Redis, with three subscribers fed every published event in order:
 *
 * - O, a shipped JS phone: the frozen reducer and event mapping from
 *   `@boardsesh/queue/testing`, so later reducer edits can't change what "an
 *   old client" does;
 * - N, a new phone in now-slot mode: places locally with `placeOnWall`, never
 *   trims in a session, applies server events as given and moves the line with
 *   `lineAfterDelta` (the same stand-in the shared simulation uses for PR 3);
 * - the native Live Activity socket: the TS port of the Swift reducer.
 *
 * After every step all three must agree with the server (hashes, N's
 * `historyCount`, Swift's list and current climb) and no orphan may be stored.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import type { ClimbQueueItem, QueueEvent } from '@boardsesh/shared-schema';
import {
  computeQueueStateHash,
  computeQueueStateHashOrdered,
  lineAfterDelta,
  placeOnWall,
  upNextStart,
  type CurrentClimbPlacement,
} from '@boardsesh/queue';
import {
  legacyEvaluateQueueEventSequence,
  legacyMapQueueEventToAction,
  legacyQueueReducer,
  swiftApply,
  swiftSequenceDecision,
  swiftShouldRepaintBoard,
  toSwiftQueueItem,
  type LegacyQueueAction,
  type LegacyQueueState,
  type LegacySyncQueueEvent,
  type SwiftQueueEvent,
  type SwiftQueueState,
} from '@boardsesh/queue/testing';
import { sql } from 'drizzle-orm';

vi.mock('../db/queries/climbs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/queries/climbs')>();
  return { ...actual, matchClimbByFrames: vi.fn(), getClimbByUuid: vi.fn() };
});

import { matchClimbByFrames, getClimbByUuid } from '../db/queries/climbs';
import { roomManager } from '../services/room-manager';
import type { QueueState } from '../services/room-manager/types';
import { queueMutations } from '../graphql/resolvers/queue/mutations';
import { controllerMutations } from '../graphql/resolvers/controller/mutations';
import { buildBoardQueuePreview } from '../services/board-queue-preview';
import { buildContentStateFromQueueState } from '../services/apns/content-state';
import { pubsub } from '../pubsub/index';
import { db } from '../db/client';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';
const BOARD_PATH = '/kilter/1/2/3/40';
// Connection ids are fresh per test: the distributed state's startup cleanup
// reaps the previous test's (dead) instance, and a reused id would lose the
// connection hash this test just registered.
let OLD = 'conn-old';
let NEW = 'conn-new';
let NATIVE = 'conn-native';

async function isRedisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, { connectTimeout: 1000, maxRetriesPerRequest: 0, lazyConnect: true });
  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
    return true;
  } catch {
    probe.disconnect();
    return false;
  }
}

const redisAvailable = await isRedisAvailable();

function wallItem(uuid: string, climbUuid = `climb-${uuid}`): ClimbQueueItem {
  return {
    uuid,
    climb: {
      uuid: climbUuid,
      setter_username: 'setter',
      name: climbUuid,
      description: '',
      frames: 'p1r12',
      angle: 40,
      ascensionist_count: 1,
      difficulty: '6A',
      quality_average: '3',
      stars: 3,
      difficulty_error: '0',
      mirrored: false,
      benchmark_difficulty: null,
    },
    addedBy: 'tester',
    tickedBy: [],
    suggested: false,
  };
}

const uuidsOf = (queue: readonly { uuid: string }[]) => queue.map(({ uuid }) => uuid);

function hashesMatch(
  queue: readonly ClimbQueueItem[],
  currentUuid: string | null,
  server: Pick<QueueState, 'queue' | 'currentClimbQueueItem'>,
): boolean {
  const serverCurrentUuid = server.currentClimbQueueItem?.uuid ?? null;
  return (
    computeQueueStateHash([...queue], currentUuid) === computeQueueStateHash([...server.queue], serverCurrentUuid) &&
    computeQueueStateHashOrdered([...queue], currentUuid) ===
      computeQueueStateHashOrdered([...server.queue], serverCurrentUuid)
  );
}

/** A shipped JS phone. */
class OldPhone {
  state: LegacyQueueState = { queue: [], currentClimbQueueItem: null, pendingCurrentClimbUpdates: [] };
  lastSequence: number | null = null;
  private correlationCounter = 0;

  constructor(readonly clientId: string) {}

  /** The frozen reducer's queue, in the backend's item type. */
  get queue(): ClimbQueueItem[] {
    return this.state.queue as unknown as ClimbQueueItem[];
  }

  nextCorrelationId() {
    this.correlationCounter += 1;
    return `${this.clientId}-${this.correlationCounter}`;
  }

  dispatchLocal(action: LegacyQueueAction) {
    this.state = legacyQueueReducer(this.state, action);
  }

  receive(event: QueueEvent) {
    if (event.__typename === 'PlaybackStateChanged') return;
    if (event.__typename !== 'FullSync') {
      const decision = legacyEvaluateQueueEventSequence(this.lastSequence, event.sequence);
      if (decision === 'ignore-stale') return;
      if (decision === 'gap') throw new Error(`${this.clientId}: sequence gap at ${event.sequence}`);
    }
    this.lastSequence = event.sequence;
    const legacyEvent =
      event.__typename === 'ClimbMirrored'
        ? { __typename: 'ClimbMirrored' as const, mirrored: event.mirrored, mirroredUuid: event.uuid ?? null }
        : (event as unknown as LegacySyncQueueEvent);
    const mapping = legacyMapQueueEventToAction(legacyEvent, { myClientId: this.clientId });
    if (mapping.kind === 'dispatch') this.state = legacyQueueReducer(this.state, mapping.action);
  }
}

type NewPhoneState = { queue: ClimbQueueItem[]; currentClimbQueueItem: ClimbQueueItem | null; historyCount: number };

/** A new phone in now-slot mode (the PR 3 stand-in, as in the shared simulation). */
class NewPhone {
  state: NewPhoneState = { queue: [], currentClimbQueueItem: null, historyCount: 0 };
  lastSequence: number | null = null;

  constructor(readonly clientId: string) {}

  receive(event: QueueEvent) {
    if (event.__typename === 'PlaybackStateChanged') return;
    if (event.__typename === 'FullSync') {
      this.state = {
        queue: [...event.state.queue],
        currentClimbQueueItem: event.state.currentClimbQueueItem,
        historyCount: event.state.historyCount ?? 0,
      };
      this.lastSequence = event.sequence;
      return;
    }
    if (this.lastSequence !== null && event.sequence <= this.lastSequence) return;
    if (this.lastSequence !== null && event.sequence > this.lastSequence + 1) {
      throw new Error(`${this.clientId}: sequence gap at ${event.sequence}`);
    }
    this.lastSequence = event.sequence;
    const { queue, currentClimbQueueItem } = this.state;

    switch (event.__typename) {
      case 'CurrentClimbChanged': {
        if (event.clientId === this.clientId) return;
        if (event.item === null) {
          this.state = {
            queue,
            currentClimbQueueItem: null,
            historyCount: lineAfterDelta(this.state, { kind: 'clear' }),
          };
          return;
        }
        const pointedIndex = queue.findIndex(({ uuid }) => uuid === event.item?.uuid);
        if (pointedIndex >= 0) {
          this.state = { queue, currentClimbQueueItem: queue[pointedIndex], historyCount: pointedIndex };
          return;
        }
        const insertIndex = upNextStart(queue, currentClimbQueueItem, this.state.historyCount);
        this.state = {
          queue: [...queue.slice(0, insertIndex), event.item, ...queue.slice(insertIndex)],
          currentClimbQueueItem: event.item,
          historyCount: insertIndex,
        };
        return;
      }
      case 'QueueItemAdded': {
        if (queue.some(({ uuid }) => uuid === event.item.uuid)) return;
        const insertIndex = Math.min(Math.max(event.position ?? queue.length, 0), queue.length);
        this.state = {
          queue: [...queue.slice(0, insertIndex), event.item, ...queue.slice(insertIndex)],
          currentClimbQueueItem,
          historyCount: lineAfterDelta(this.state, { kind: 'add', index: insertIndex }),
        };
        return;
      }
      case 'QueueItemRemoved': {
        if (!queue.some(({ uuid }) => uuid === event.uuid)) return;
        this.state = {
          queue: queue.filter(({ uuid }) => uuid !== event.uuid),
          currentClimbQueueItem: currentClimbQueueItem?.uuid === event.uuid ? null : currentClimbQueueItem,
          historyCount: lineAfterDelta(this.state, { kind: 'remove', uuid: event.uuid }),
        };
        return;
      }
      case 'QueueReordered': {
        const { oldIndex, newIndex } = event;
        if (queue[oldIndex]?.uuid !== event.uuid || newIndex >= queue.length) return;
        const reordered = [...queue];
        const [moved] = reordered.splice(oldIndex, 1);
        reordered.splice(newIndex, 0, moved);
        this.state = {
          queue: reordered,
          currentClimbQueueItem,
          historyCount: lineAfterDelta(this.state, { kind: 'reorder', oldIndex, newIndex }),
        };
        return;
      }
      case 'ClimbMirrored':
        return;
    }
  }
}

function toSwiftEvent(event: QueueEvent): SwiftQueueEvent | null {
  switch (event.__typename) {
    case 'FullSync':
      return {
        kind: 'fullSync',
        items: event.state.queue.map(toSwiftQueueItem),
        currentItem: event.state.currentClimbQueueItem ? toSwiftQueueItem(event.state.currentClimbQueueItem) : null,
        sequence: event.sequence,
      };
    case 'CurrentClimbChanged':
      return {
        kind: 'currentClimbChanged',
        item: event.item ? toSwiftQueueItem(event.item) : null,
        sequence: event.sequence,
      };
    case 'QueueItemAdded':
      return {
        kind: 'itemAdded',
        item: toSwiftQueueItem(event.item),
        position: event.position ?? 0,
        sequence: event.sequence,
      };
    case 'QueueItemRemoved':
      return { kind: 'itemRemoved', uuid: event.uuid, sequence: event.sequence };
    case 'QueueReordered':
      return {
        kind: 'reordered',
        uuid: event.uuid,
        oldIndex: event.oldIndex,
        newIndex: event.newIndex,
        sequence: event.sequence,
      };
    default:
      return null;
  }
}

/** The native Live Activity socket (Swift reducer port). Records every wall repaint. */
class NativeSocket {
  state: SwiftQueueState = { items: [], currentIndex: 0 };
  lastKnown = -1;
  repaints: string[] = [];

  receive(event: QueueEvent) {
    const swiftEvent = toSwiftEvent(event);
    if (!swiftEvent) return;
    const decision = swiftSequenceDecision(swiftEvent, this.lastKnown);
    if (decision.kind === 'resync') throw new Error(`native: resync at ${event.sequence}`);
    this.lastKnown = decision.newLastSequence;
    this.state = swiftApply(swiftEvent, this.state);
    if (swiftShouldRepaintBoard(swiftEvent)) {
      const current = this.state.items[this.state.currentIndex];
      if (current) this.repaints.push(current.uuid);
    }
  }

  get currentUuid(): string | null {
    return this.state.items[this.state.currentIndex]?.uuid ?? null;
  }
}

const ctxFor = (connectionId: string, sessionId: string) => ({
  connectionId,
  sessionId,
  rateLimitTokens: 1000,
  rateLimitLastReset: Date.now(),
});

type Crew = Awaited<ReturnType<typeof createCrew>>;

async function createCrew() {
  const sessionId = uuidv4();
  for (const connectionId of [OLD, NEW, NATIVE]) {
    await roomManager.registerClient(connectionId);
    await roomManager.joinSession(connectionId, sessionId, BOARD_PATH, connectionId);
  }
  const publishSpy = vi.spyOn(pubsub, 'publishQueueEvent');
  const old = new OldPhone(OLD);
  const fresh = new NewPhone(NEW);
  const native = new NativeSocket();
  let delivered = 0;
  const published: { event: QueueEvent; buffered: boolean }[] = [];

  const deliver = () => {
    const calls = publishSpy.mock.calls as [string, QueueEvent, { buffer?: boolean }?][];
    for (; delivered < calls.length; delivered++) {
      const [eventSessionId, event, options] = calls[delivered];
      if (eventSessionId !== sessionId) continue;
      published.push({ event, buffered: options?.buffer !== false });
      old.receive(event);
      fresh.receive(event);
      native.receive(event);
    }
  };

  const server = () => roomManager.getQueueState(sessionId);

  return {
    sessionId,
    old,
    fresh,
    native,
    published,
    deliver,
    server,
    /** Event typenames published since `mark`. */
    eventsSince(mark: number) {
      return published.slice(mark).map(({ event }) => event.__typename);
    },
    async seed(queue: ClimbQueueItem[], current: ClimbQueueItem | null, historyCount = 0) {
      await roomManager.updateQueueState(sessionId, queue, current, undefined, historyCount);
      const state = await server();
      const fullSync: QueueEvent = { __typename: 'FullSync', sequence: state.sequence, state };
      for (const client of [old, fresh, native]) client.receive(fullSync);
      delivered = publishSpy.mock.calls.length;
      published.length = 0;
    },
    async kioskUpNext() {
      return buildBoardQueuePreview(1, await server()).upNext.map(({ queueItemUuid }) => queueItemUuid);
    },
    /** All three subscribers agree with the server, and no orphan is stored. */
    async assertConverged(label: string) {
      const state = await server();
      const current = state.currentClimbQueueItem;
      expect(current === null || state.queue.some(({ uuid }) => uuid === current.uuid), `${label}: orphan`).toBe(true);
      expect(hashesMatch(old.queue, old.state.currentClimbQueueItem?.uuid ?? null, state), `${label}: old`).toBe(true);
      expect(
        hashesMatch(fresh.state.queue, fresh.state.currentClimbQueueItem?.uuid ?? null, state),
        `${label}: new`,
      ).toBe(true);
      expect(fresh.state.historyCount, `${label}: new historyCount`).toBe(state.historyCount);
      expect(uuidsOf(native.state.items), `${label}: native list`).toEqual(uuidsOf(state.queue));
      if (current) {
        expect(native.currentUuid, `${label}: native current`).toBe(current.uuid);
        // APNs never sees an orphan, so a current climb always yields a push.
        expect(buildContentStateFromQueueState(state), `${label}: APNs content state`).not.toBeNull();
      }
      return state;
    },
    /** O commits an open: the shipped optimistic dispatch, then the request. */
    async oldSetCurrent(item: ClimbQueueItem, shouldAddToQueue: boolean) {
      const correlationId = old.nextCorrelationId();
      old.dispatchLocal({
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item, shouldAddToQueue, insertAfterCurrent: true, isServerEvent: false, correlationId },
      });
      await queueMutations.setCurrentClimb({}, { item, shouldAddToQueue, correlationId }, ctxFor(OLD, sessionId));
      deliver();
    },
    /** N puts a climb on the wall: local placement, then the request with `placement`. */
    async newSetCurrent(item: ClimbQueueItem, placement: CurrentClimbPlacement) {
      const placed = placeOnWall(fresh.state, item, placement, false);
      fresh.state = {
        queue: placed.queue,
        currentClimbQueueItem: placed.currentClimbQueueItem,
        historyCount: placed.historyCount,
      };
      await queueMutations.setCurrentClimb(
        {},
        { item: placed.currentClimbQueueItem ?? item, shouldAddToQueue: false, correlationId: 'new-1', placement },
        ctxFor(NEW, sessionId),
      );
      deliver();
    },
    /** The lock-screen Next / Previous: the native index ± 1, no shouldAddToQueue. */
    async nativeStep(offset: 1 | -1) {
      const target = native.state.items[native.state.currentIndex + offset];
      const item = (await server()).queue.find(({ uuid }) => uuid === target?.uuid) ?? null;
      if (!item) throw new Error('native step has no target');
      await queueMutations.setCurrentClimb({}, { item, correlationId: 'native-1' }, ctxFor(NATIVE, sessionId));
      deliver();
    },
    async remove(connectionId: string, uuid: string) {
      if (connectionId === OLD) old.dispatchLocal({ type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid } });
      await queueMutations.removeQueueItem({}, { uuid }, ctxFor(connectionId, sessionId));
      deliver();
    },
  };
}

/** A, B (current), C, D. History [A], Up next [C, D]. */
async function standardStart(crew: Crew) {
  const items = { A: wallItem('a'), B: wallItem('b'), C: wallItem('c'), D: wallItem('d') };
  await crew.seed([items.A, items.B, items.C, items.D], items.B);
  return items;
}

describe.skipIf(!redisAvailable)('F3 mixed crew against the real resolvers and Redis', () => {
  let redis: Redis;
  const previousPercent = process.env.QUEUE_NOW_SLOT_PERCENT;

  beforeEach(async () => {
    redis = new Redis(REDIS_URL);
    roomManager.reset();
    await roomManager.initialize(redis);
    process.env.QUEUE_NOW_SLOT_PERCENT = '100';
    const suffix = uuidv4().slice(0, 8);
    OLD = `conn-old-${suffix}`;
    NEW = `conn-new-${suffix}`;
    NATIVE = `conn-native-${suffix}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    roomManager.reset();
    await redis.quit();
    if (previousPercent === undefined) delete process.env.QUEUE_NOW_SLOT_PERCENT;
    else process.env.QUEUE_NOW_SLOT_PERCENT = previousPercent;
  });

  it('S1: N opens X from search: X takes the Now slot, one FullSync', async () => {
    const crew = await createCrew();
    await standardStart(crew);
    await crew.newSetCurrent(wallItem('x'), 'NOW');
    const state = await crew.assertConverged('S1');
    expect(uuidsOf(state.queue)).toEqual(['a', 'b', 'x', 'c', 'd']);
    expect(crew.eventsSince(0)).toEqual(['FullSync']);
    expect(crew.native.state.currentIndex).toBe(2);
    expect(await crew.kioskUpNext()).toEqual(['c', 'd']);
  });

  it("S2: N opens D from its logbook: D's own entry moves, FullSync + trailing repaints D", async () => {
    const crew = await createCrew();
    const { D } = await standardStart(crew);
    await crew.newSetCurrent(D, 'NOW');
    const state = await crew.assertConverged('S2');
    expect(uuidsOf(state.queue)).toEqual(['a', 'b', 'd', 'c']);
    expect(crew.eventsSince(0)).toEqual(['FullSync', 'CurrentClimbChanged']);
    expect(crew.published[1].buffered).toBe(false);
    expect(crew.published[1].event.sequence).toBe(crew.published[0].event.sequence);
    expect(crew.native.repaints).toEqual(['d']);
  });

  it("S3: the issue's case in a crew: O's session-history tap mints C′, the server reuses C", async () => {
    const crew = await createCrew();
    await standardStart(crew);
    await crew.oldSetCurrent(wallItem('c-prime', 'climb-c'), true);
    const state = await crew.assertConverged('S3');
    expect(uuidsOf(state.queue)).toEqual(['a', 'b', 'c', 'd']);
    expect(state.currentClimbQueueItem?.uuid).toBe('c');
    expect(uuidsOf(crew.old.state.queue)).not.toContain('c-prime');
    expect(crew.native.repaints).toEqual(['c']);
  });

  it('S4: O taps the current climb in session history (B′): no copy, the wall re-lights B', async () => {
    const crew = await createCrew();
    await standardStart(crew);
    await crew.oldSetCurrent(wallItem('b-prime', 'climb-b'), true);
    const state = await crew.assertConverged('S4');
    expect(uuidsOf(state.queue)).toEqual(['a', 'b', 'c', 'd']);
    expect(crew.eventsSince(0)).toEqual(['FullSync', 'CurrentClimbChanged']);
    expect(crew.native.repaints).toEqual(['b']);
  });

  it('S5: O swipes forward on a search track to a new climb: inserted at the Now slot', async () => {
    const crew = await createCrew();
    await standardStart(crew);
    await crew.oldSetCurrent(wallItem('y'), true);
    const state = await crew.assertConverged('S5');
    expect(uuidsOf(state.queue)).toEqual(['a', 'b', 'y', 'c', 'd']);
    expect(crew.eventsSince(0)).toEqual(['FullSync']);
  });

  it("S6: O swipes back onto A's History entry: today's pointer move, B goes to Up next", async () => {
    const crew = await createCrew();
    const { A } = await standardStart(crew);
    await crew.oldSetCurrent(A, false);
    const state = await crew.assertConverged('S6');
    expect(state.currentClimbQueueItem?.uuid).toBe('a');
    expect(crew.eventsSince(0)).toEqual(['CurrentClimbChanged']);
    expect(crew.native.repaints).toEqual(['a']);
  });

  it('S7: O taps queue row D: D moves into Now and C stays Up next', async () => {
    const crew = await createCrew();
    const { D } = await standardStart(crew);
    await crew.oldSetCurrent(D, true);
    const state = await crew.assertConverged('S7');
    expect(uuidsOf(state.queue)).toEqual(['a', 'b', 'd', 'c']);
    expect(crew.native.repaints).toEqual(['d']);
  });

  it('S8: O previews D, then Put on the wall mints D′: the server reuses D', async () => {
    const crew = await createCrew();
    await standardStart(crew);
    await crew.oldSetCurrent(wallItem('d-prime', 'climb-d'), true);
    const state = await crew.assertConverged('S8');
    expect(uuidsOf(state.queue)).toEqual(['a', 'b', 'd', 'c']);
    expect(state.currentClimbQueueItem?.uuid).toBe('d');
  });

  it("S9: O's lock-screen Next is a pointer move the Swift index predicted", async () => {
    const crew = await createCrew();
    await standardStart(crew);
    await crew.nativeStep(1);
    const state = await crew.assertConverged('S9');
    expect(state.currentClimbQueueItem?.uuid).toBe('c');
    expect(crew.eventsSince(0)).toEqual(['CurrentClimbChanged']);
    expect(crew.native.state.currentIndex).toBe(2);
  });

  it.each(['0', '100'])(
    "the native socket's stale item (already left the queue) is inserted at the Now slot at percent %s",
    async (percent) => {
      process.env.QUEUE_NOW_SLOT_PERCENT = percent;
      const crew = await createCrew();
      const { D } = await standardStart(crew);
      // A crewmate removed D; the locked phone still steps onto it before the removal reaches it.
      await queueMutations.removeQueueItem({}, { uuid: D.uuid }, ctxFor(NEW, crew.sessionId));
      await queueMutations.setCurrentClimb(
        {},
        { item: D, correlationId: 'native-stale' },
        ctxFor(NATIVE, crew.sessionId),
      );
      crew.deliver();
      const state = await crew.assertConverged('native stale');
      expect(uuidsOf(state.queue)).toEqual(['a', 'b', 'd', 'c']);
      expect(state.currentClimbQueueItem?.uuid).toBe('d');
      expect(crew.eventsSince(1)).toEqual(['FullSync', 'CurrentClimbChanged']);
      expect(crew.native.repaints).toEqual(['d']);
    },
  );

  it('S10: the ESP32 reads C off the LEDs: the queued C is reused, the controller event follows', async () => {
    const crew = await createCrew();
    const { C } = await standardStart(crew);
    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES ('f3-controller-owner', 'f3@controller.test', 'F3 Owner', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    const ownerCtx = {
      connectionId: `owner-${uuidv4()}`,
      isAuthenticated: true,
      userId: 'f3-controller-owner',
    } as unknown as Parameters<typeof controllerMutations.registerController>[2];
    const registered = await controllerMutations.registerController(
      undefined,
      { input: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2,3', name: 'F3 Controller' } },
      ownerCtx,
    );
    await controllerMutations.authorizeControllerForSession(
      undefined,
      { controllerId: registered.controllerId, sessionId: crew.sessionId },
      ownerCtx,
    );
    vi.mocked(matchClimbByFrames).mockResolvedValue({ uuid: C.climb.uuid, name: C.climb.name } as Awaited<
      ReturnType<typeof matchClimbByFrames>
    >);
    vi.mocked(getClimbByUuid).mockResolvedValue({ ...C.climb } as Awaited<ReturnType<typeof getClimbByUuid>>);
    await controllerMutations.setClimbFromLedPositions(
      undefined,
      { sessionId: crew.sessionId, frames: C.climb.frames },
      {
        connectionId: `controller-${uuidv4()}`,
        isAuthenticated: false,
        controllerId: registered.controllerId,
        controllerApiKey: registered.apiKey,
        controllerMac: 'AA:BB:CC:DD:EE:FF',
        rateLimitTokens: 60,
        rateLimitLastReset: Date.now(),
      } as unknown as Parameters<typeof controllerMutations.setClimbFromLedPositions>[2],
    );
    crew.deliver();
    const state = await crew.assertConverged('S10');
    expect(uuidsOf(state.queue)).toEqual(['a', 'b', 'c', 'd']);
    expect(state.currentClimbQueueItem?.uuid).toBe('c');
    expect(crew.eventsSince(0)).toEqual(['FullSync', 'CurrentClimbChanged']);
    expect(crew.published[1].event).toMatchObject({ clientId: 'AA:BB:CC:DD:EE:FF' });
  });

  it('S11: removing the current climb keeps History as History (historyCount 1)', async () => {
    const crew = await createCrew();
    const { B } = await standardStart(crew);
    await crew.remove(NEW, B.uuid);
    const state = await crew.assertConverged('S11');
    expect(uuidsOf(state.queue)).toEqual(['a', 'c', 'd']);
    expect(state.currentClimbQueueItem).toBeNull();
    expect(state.historyCount).toBe(1);
    expect(crew.eventsSince(0)).toEqual(['QueueItemRemoved']);
    expect(crew.native.currentUuid).toBe('c');
    expect(await crew.kioskUpNext()).toEqual(['c', 'd']);
  });

  it("S12: after S11 O's Next names queue[0]; the server lights C and A stays History", async () => {
    const crew = await createCrew();
    const { A, B } = await standardStart(crew);
    await crew.remove(NEW, B.uuid);
    await crew.oldSetCurrent(A, false);
    const state = await crew.assertConverged('S12');
    expect(state.currentClimbQueueItem?.uuid).toBe('c');
    expect(state.historyCount).toBe(1);
    expect(crew.eventsSince(1)).toEqual(['FullSync', 'CurrentClimbChanged']);
    expect(crew.native.repaints).toEqual(['c']);
  });

  it("S13: after S11 N's Next picks queue[historyCount] as a pointer move", async () => {
    const crew = await createCrew();
    const { B, C } = await standardStart(crew);
    await crew.remove(NEW, B.uuid);
    await crew.newSetCurrent(C, 'NOW');
    const state = await crew.assertConverged('S13');
    expect(state.currentClimbQueueItem?.uuid).toBe('c');
    expect(crew.eventsSince(1)).toEqual(['CurrentClimbChanged']);
  });

  it("S14 (residual): N's move inside O's Undo round trip is overwritten by the Undo", async () => {
    const crew = await createCrew();
    const { A, B, D } = await standardStart(crew);
    await crew.remove(OLD, A.uuid);
    // O composes its Undo from its live state before N's FullSync reaches it.
    const undoQueue = [A, ...crew.old.queue];
    const baselineSequence = crew.old.lastSequence ?? 0;
    await crew.newSetCurrent(D, 'NOW');
    await queueMutations.setQueue(
      {},
      { queue: undoQueue, currentClimbQueueItem: B, baselineSequence },
      ctxFor(OLD, crew.sessionId),
    );
    crew.deliver();
    const state = await crew.assertConverged('S14');
    // The residual, recorded: N's move is lost, the Undo's array and current climb win.
    expect(uuidsOf(state.queue)).toEqual(['a', 'b', 'c', 'd']);
    expect(state.currentClimbQueueItem?.uuid).toBe('b');
    expect(crew.native.repaints).toEqual(['d']);
    expect(crew.native.currentUuid).toBe('b');
  });

  it("S15: a 60-entry History stays History through a removal and O's Next", async () => {
    const crew = await createCrew();
    const history = Array.from({ length: 60 }, (_, index) => wallItem(`h${index + 1}`));
    const current = wallItem('x');
    const upNext = [wallItem('c'), wallItem('d')];
    await crew.seed([...history, current, ...upNext], current);
    await crew.remove(NEW, current.uuid);
    let state = await crew.assertConverged('S15 removal');
    expect(state.historyCount).toBe(60);
    expect(await crew.kioskUpNext()).toEqual(['c', 'd']);

    await crew.oldSetCurrent(history[0], false);
    state = await crew.assertConverged('S15 next');
    expect(state.currentClimbQueueItem?.uuid).toBe('c');
    expect(state.historyCount).toBe(60);
    expect(crew.fresh.state.historyCount).toBe(60);
    expect(await crew.kioskUpNext()).toEqual(['d']);
    expect(crew.eventsSince(0)).toEqual(['QueueItemRemoved', 'FullSync', 'CurrentClimbChanged']);
  });

  it("S16: O's Play next at position 0 with nothing current is clamped to the head of Up next", async () => {
    const crew = await createCrew();
    const { B } = await standardStart(crew);
    await crew.remove(NEW, B.uuid);
    const playNext = wallItem('x');
    crew.old.dispatchLocal({ type: 'DELTA_ADD_QUEUE_ITEM', payload: { item: playNext, position: 0 } });
    await queueMutations.addQueueItem({}, { item: playNext, position: 0 }, ctxFor(OLD, crew.sessionId));
    crew.deliver();
    const state = await crew.assertConverged('S16');
    expect(uuidsOf(state.queue)).toEqual(['a', 'x', 'c', 'd']);
    expect(state.historyCount).toBe(1);
    expect(crew.eventsSince(1)).toEqual(['QueueItemAdded', 'FullSync']);
    expect(crew.published[1].event).toMatchObject({ __typename: 'QueueItemAdded', position: 1 });
    expect(await crew.kioskUpNext()).toEqual(['x', 'c', 'd']);
  });

  it('S17: the same Play next outside the percent lands at 0 and the line moves with it', async () => {
    process.env.QUEUE_NOW_SLOT_PERCENT = '0';
    const crew = await createCrew();
    const { B } = await standardStart(crew);
    await crew.remove(NEW, B.uuid);
    const playNext = wallItem('x');
    crew.old.dispatchLocal({ type: 'DELTA_ADD_QUEUE_ITEM', payload: { item: playNext, position: 0 } });
    await queueMutations.addQueueItem({}, { item: playNext, position: 0 }, ctxFor(OLD, crew.sessionId));
    crew.deliver();
    const state = await crew.assertConverged('S17');
    expect(uuidsOf(state.queue)).toEqual(['x', 'a', 'c', 'd']);
    expect(state.historyCount).toBe(2);
    expect(crew.eventsSince(1)).toEqual(['QueueItemAdded']);
    expect(await crew.kioskUpNext()).toEqual(['c', 'd']);
  });

  it("S18: after S15's removal O taps the first row: the climb tapped goes on the wall", async () => {
    const crew = await createCrew();
    const history = Array.from({ length: 60 }, (_, index) => wallItem(`h${index + 1}`));
    const current = wallItem('x');
    await crew.seed([...history, current, wallItem('c'), wallItem('d')], current);
    await crew.remove(NEW, current.uuid);
    await crew.oldSetCurrent(history[0], true);
    const state = await crew.assertConverged('S18');
    expect(state.currentClimbQueueItem?.uuid).toBe('h1');
    expect(uuidsOf(state.queue).slice(58)).toEqual(['h60', 'h1', 'c', 'd']);
    expect(crew.native.repaints).toEqual(['h1']);
  });

  it('nothing current at percent 0: an add, a History removal and a reorder never erase the line', async () => {
    process.env.QUEUE_NOW_SLOT_PERCENT = '0';
    const crew = await createCrew();
    const history = [wallItem('h1'), wallItem('h2'), wallItem('h3')];
    const upNext = [wallItem('c'), wallItem('d')];
    await crew.seed([...history, ...upNext], null, 3);

    const added = wallItem('e');
    await queueMutations.addQueueItem({}, { item: added }, ctxFor(OLD, crew.sessionId));
    crew.deliver();
    let state = await crew.assertConverged('add');
    expect(state.historyCount).toBe(3);

    await crew.remove(OLD, 'h2');
    state = await crew.assertConverged('remove');
    expect(state.historyCount).toBe(2);

    await queueMutations.reorderQueueItem({}, { uuid: 'd', oldIndex: 3, newIndex: 2 }, ctxFor(OLD, crew.sessionId));
    crew.deliver();
    state = await crew.assertConverged('reorder');
    expect(state.historyCount).toBe(2);

    // The next FullSync carries the line.
    await queueMutations.replaceQueueItem({}, { uuid: 'c', item: wallItem('c') }, ctxFor(OLD, crew.sessionId));
    crew.deliver();
    const lastFullSync = crew.published.at(-1)?.event;
    expect(lastFullSync).toMatchObject({ __typename: 'FullSync', state: expect.objectContaining({ historyCount: 2 }) });
  });

  it("an old phone's reorder across the line with nothing current is clamped and published as a FullSync", async () => {
    const crew = await createCrew();
    const { B } = await standardStart(crew);
    await crew.remove(NEW, B.uuid);
    crew.old.dispatchLocal({ type: 'DELTA_REORDER_QUEUE_ITEM', payload: { uuid: 'd', oldIndex: 2, newIndex: 0 } });
    await queueMutations.reorderQueueItem({}, { uuid: 'd', oldIndex: 2, newIndex: 0 }, ctxFor(OLD, crew.sessionId));
    crew.deliver();
    const state = await crew.assertConverged('reorder clamp');
    expect(uuidsOf(state.queue)).toEqual(['a', 'd', 'c']);
    expect(state.historyCount).toBe(1);
    expect(crew.eventsSince(1)).toEqual(['FullSync']);
  });

  it('the watchdog firing inside the gap resyncs to the same state the FullSync brings', async () => {
    const crew = await createCrew();
    await standardStart(crew);
    const copy = wallItem('c-prime', 'climb-c');
    crew.old.dispatchLocal({
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: {
        item: copy,
        shouldAddToQueue: true,
        insertAfterCurrent: true,
        isServerEvent: false,
        correlationId: 'w-1',
      },
    });
    await queueMutations.setCurrentClimb(
      {},
      { item: copy, shouldAddToQueue: true, correlationId: 'w-1' },
      ctxFor(OLD, crew.sessionId),
    );
    // The 60 s tick lands before the FullSync is delivered: one extra resync.
    const watchdogState = await crew.server();
    crew.old.receive({ __typename: 'FullSync', sequence: watchdogState.sequence, state: watchdogState });
    crew.deliver();
    await crew.assertConverged('watchdog');
  });

  it('(residual) a setQueue composed inside the gap writes the old phone copy back', async () => {
    const crew = await createCrew();
    const { B } = await standardStart(crew);
    const copy = wallItem('c-prime', 'climb-c');
    crew.old.dispatchLocal({
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: {
        item: copy,
        shouldAddToQueue: true,
        insertAfterCurrent: true,
        isServerEvent: false,
        correlationId: 'g-1',
      },
    });
    // O composes a write-back (an Undo) from its optimistic A B C′ C D before the dedupe arrives.
    const composed = [...crew.old.queue];
    await queueMutations.setCurrentClimb(
      {},
      { item: copy, shouldAddToQueue: true, correlationId: 'g-1' },
      ctxFor(OLD, crew.sessionId),
    );
    await queueMutations.setQueue({}, { queue: composed, currentClimbQueueItem: copy }, ctxFor(OLD, crew.sessionId));
    crew.deliver();
    const state = await crew.assertConverged('gap write-back');
    expect(uuidsOf(state.queue)).toEqual(['a', 'b', 'c-prime', 'c', 'd']);
    expect(state.currentClimbQueueItem?.uuid).toBe('c-prime');
    expect(B.uuid).toBe('b');
  });

  it("(residual) an old coalescer's deferred add of a throttled open lands at the head of Up next", async () => {
    const crew = await createCrew();
    await standardStart(crew);
    const copy = wallItem('c-prime', 'climb-c');
    crew.old.dispatchLocal({
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: {
        item: copy,
        shouldAddToQueue: true,
        insertAfterCurrent: true,
        isServerEvent: false,
        correlationId: 't-1',
      },
    });
    // The open was throttled, so the shipped code re-sends C′ as a plain add at its local index.
    const localIndex = crew.old.state.queue.findIndex(({ uuid }) => uuid === copy.uuid);
    await queueMutations.addQueueItem({}, { item: copy, position: localIndex }, ctxFor(OLD, crew.sessionId));
    // The failed write's resync.
    const resyncState = await crew.server();
    crew.old.receive({ __typename: 'FullSync', sequence: resyncState.sequence, state: resyncState });
    crew.deliver();
    const state = await crew.assertConverged('deferred add');
    expect(uuidsOf(state.queue)).toEqual(['a', 'b', 'c-prime', 'c', 'd']);
    expect(state.currentClimbQueueItem?.uuid).toBe('b');
  });

  it('a 130-entry History outside the percent: N presses Next, the server trims, no hash drift', async () => {
    process.env.QUEUE_NOW_SLOT_PERCENT = '0';
    const crew = await createCrew();
    const history = Array.from({ length: 130 }, (_, index) => wallItem(`h${index + 1}`));
    const current = wallItem('x');
    const next = wallItem('c');
    await crew.seed([...history, current, next], current);
    await crew.newSetCurrent(next, 'NOW');
    const state = await crew.assertConverged('130 History');
    expect(state.historyCount).toBe(100);
    expect(state.currentClimbQueueItem?.uuid).toBe('c');
    expect(crew.eventsSince(0)).toEqual(['FullSync', 'CurrentClimbChanged']);
  });
});
