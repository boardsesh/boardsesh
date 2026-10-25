/**
 * F3 (#6666) compatibility simulation: a server built on `now-slot.ts` in one
 * crew with two shipped JS clients, the shipped Swift Live Activity reducer and
 * two new clients, over seeded random operations, at `QUEUE_NOW_SLOT_PERCENT`
 * 0 and 100 (docs/current-climb-outside-queue.md, sections 2, 3, 8 and 9).
 *
 * The shipped clients run the frozen copies in `@boardsesh/queue/testing`, so a
 * later change to the live reducer can't redefine "an old phone". The checks:
 *
 * - After every published event, every client but the request's origin holds
 *   the server's queue and current climb (v1 and v2 hashes); the origin does
 *   once its request's events are all in (its optimistic state may differ for
 *   one round trip, section 3).
 * - Every new client's `historyCount` equals the server's.
 * - The Swift port's current uuid is in its list, and its list is the server's.
 *   Every wall repaint it does (`persistAndNotify`) lights the climb an event
 *   named, or for a `CurrentClimbChanged(null)` the climb it just cleared, and
 *   never follows a `FullSync` under the same sequence: the `FullSync` resets
 *   its index to 0, so that repaint would light an unrelated climb.
 * - A clear never publishes the trailing event.
 * - For every `CurrentClimbChanged` the server publishes, the frozen reducer
 *   applied to the state just before it gives exactly the stored array and
 *   current climb. That keeps `chooseQueueEvent` from sending a pointer event
 *   for a reshape.
 * - No orphan current climb is ever stored, at either percent.
 *
 * The server model is a stand-in for PR 2's resolvers, and the new clients a
 * minimal model of PR 3's reducer, both on `now-slot.ts`. Placement-less
 * requests at percent 0 follow today's server rules, except that no orphan is
 * stored (section 8, kill switches).
 */

import { describe, it, expect } from 'vitest';
import { computeQueueStateHash, computeQueueStateHashOrdered } from '../state-hash';
import {
  HISTORY_TRIM_AT,
  capHistory,
  chooseQueueEvent,
  clampInsertPosition,
  historyAndUpNextCount,
  historyLine,
  historyOf,
  isUpNextFull,
  lineAfterDelta,
  normaliseHistoryCount,
  normaliseOrphanCurrent,
  placeOnWall,
  reorderAcrossLine,
  upNextStart,
} from '../now-slot';
import type { CurrentClimbPlacement, NowSlotQueueEvent, NowSlotRewrite, NowSlotState } from '../now-slot';
import { MAX_SYNCED_QUEUE_ITEMS } from '../limits';
import type { Climb, ClimbQueueItem } from '../types';
import {
  legacyEvaluateQueueEventSequence,
  legacyMapQueueEventToAction,
  legacyQueueReducer,
  swiftApply,
  swiftSequenceDecision,
  swiftShouldRepaintBoard,
  toSwiftQueueItem,
} from '../testing';
import type {
  LegacyQueueAction,
  LegacyQueueState,
  LegacySyncQueueEvent,
  SwiftQueueEvent,
  SwiftQueueState,
} from '../testing';

// MARK: - Deterministic randomness

function createRandom(seed: number) {
  let mulberryState = seed >>> 0;
  const next = () => {
    mulberryState = (mulberryState + 0x6d2b79f5) >>> 0;
    let mixed = mulberryState;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (exclusiveMax: number) => Math.floor(next() * exclusiveMax),
    pick: <TValue>(values: readonly TValue[]): TValue => values[Math.floor(next() * values.length)],
  };
}

type Random = ReturnType<typeof createRandom>;

// MARK: - Climbs

const CLIMB_POOL_SIZE = 400;
const ANGLES = [40, 45] as const;

function makeClimb(climbNumber: number, angle: number, boardType: string | undefined): Climb {
  return {
    uuid: `climb-${climbNumber}`,
    boardType,
    angle,
    setter_username: 'setter',
    name: `Climb ${climbNumber}`,
    frames: 'p1r12',
    ascensionist_count: 0,
    difficulty: '6a',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
    mirrored: false,
  };
}

// MARK: - Server state and wire events

/** What the server stores. `historyCount` is null only in a room written before PR 2. */
type ServerView = {
  queue: readonly ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  historyCount: number | null;
  sequence: number;
};

type SimEvent =
  | {
      type: 'FullSync';
      sequence: number;
      queue: ClimbQueueItem[];
      currentClimbQueueItem: ClimbQueueItem | null;
      historyCount: number | null;
    }
  | {
      type: 'CurrentClimbChanged';
      sequence: number;
      item: ClimbQueueItem | null;
      clientId: string | null;
      correlationId: string | null;
    }
  | { type: 'QueueItemAdded'; sequence: number; item: ClimbQueueItem; position: number }
  | { type: 'QueueItemRemoved'; sequence: number; uuid: string }
  | { type: 'QueueReordered'; sequence: number; uuid: string; oldIndex: number; newIndex: number };

/** An event with the stored state it was published under. */
type Publication = { event: SimEvent; stored: ServerView };

function toLegacyEvent(event: SimEvent): LegacySyncQueueEvent {
  switch (event.type) {
    case 'FullSync':
      return {
        __typename: 'FullSync',
        state: { queue: event.queue, currentClimbQueueItem: event.currentClimbQueueItem },
      };
    case 'CurrentClimbChanged':
      return {
        __typename: 'CurrentClimbChanged',
        currentItem: event.item,
        clientId: event.clientId,
        correlationId: event.correlationId,
      };
    case 'QueueItemAdded':
      return { __typename: 'QueueItemAdded', addedItem: event.item, position: event.position };
    case 'QueueItemRemoved':
      return { __typename: 'QueueItemRemoved', uuid: event.uuid };
    case 'QueueReordered':
      return { __typename: 'QueueReordered', uuid: event.uuid, oldIndex: event.oldIndex, newIndex: event.newIndex };
  }
}

function toSwiftEvent(event: SimEvent): SwiftQueueEvent {
  switch (event.type) {
    case 'FullSync':
      return {
        kind: 'fullSync',
        items: event.queue.map(toSwiftQueueItem),
        currentItem: event.currentClimbQueueItem ? toSwiftQueueItem(event.currentClimbQueueItem) : null,
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
        position: event.position,
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
  }
}

function fullSyncOf(view: ServerView): SimEvent {
  return {
    type: 'FullSync',
    sequence: view.sequence,
    queue: [...view.queue],
    currentClimbQueueItem: view.currentClimbQueueItem,
    historyCount: view.historyCount,
  };
}

const uuidsOf = (queue: readonly { uuid: string }[]) => queue.map(({ uuid }) => uuid);

function hasOrphan(view: { queue: readonly ClimbQueueItem[]; currentClimbQueueItem: ClimbQueueItem | null }) {
  const current = view.currentClimbQueueItem;
  return current !== null && !view.queue.some(({ uuid }) => uuid === current.uuid);
}

// MARK: - Clients

interface SimClient {
  readonly clientId: string;
  receive(event: SimEvent): void;
  /** Throws when this client disagrees with the server. */
  assertMatches(server: ServerView, context: string): void;
}

function assertHashesMatch(
  label: string,
  queue: readonly ClimbQueueItem[],
  currentUuid: string | null,
  server: ServerView,
  context: string,
) {
  const serverCurrentUuid = server.currentClimbQueueItem?.uuid ?? null;
  const v1Matches =
    computeQueueStateHash([...queue], currentUuid) === computeQueueStateHash([...server.queue], serverCurrentUuid);
  const v2Matches =
    computeQueueStateHashOrdered([...queue], currentUuid) ===
    computeQueueStateHashOrdered([...server.queue], serverCurrentUuid);
  if (!v1Matches || !v2Matches) {
    throw new Error(
      `${context}: ${label} hash drift\n  client ${uuidsOf(queue).join(' ')} | ${currentUuid}\n  server ${uuidsOf(
        server.queue,
      ).join(' ')} | ${serverCurrentUuid}`,
    );
  }
}

/** A shipped JS phone: frozen reducer, frozen event mapping, frozen sequence check. */
class LegacyJsClient implements SimClient {
  state: LegacyQueueState = { queue: [], currentClimbQueueItem: null, pendingCurrentClimbUpdates: [] };
  lastSequence: number | null = null;
  private correlationCounter = 0;

  constructor(readonly clientId: string) {}

  nextCorrelationId(): string {
    this.correlationCounter += 1;
    return `${this.clientId}-correlation-${this.correlationCounter}`;
  }

  dispatchLocal(action: LegacyQueueAction) {
    this.state = legacyQueueReducer(this.state, action);
  }

  receive(event: SimEvent) {
    if (event.type !== 'FullSync') {
      const decision = legacyEvaluateQueueEventSequence(this.lastSequence, event.sequence);
      if (decision === 'ignore-stale') return;
      if (decision === 'gap') throw new Error(`${this.clientId}: unexpected sequence gap at ${event.sequence}`);
    }
    this.lastSequence = event.sequence;
    const mapping = legacyMapQueueEventToAction(toLegacyEvent(event), { myClientId: this.clientId });
    if (mapping.kind === 'dispatch') this.state = legacyQueueReducer(this.state, mapping.action);
  }

  /** The watchdog / failed-write resync: apply the server's state as a FullSync. */
  resync(server: ServerView) {
    this.receive(fullSyncOf(server));
  }

  assertMatches(server: ServerView, context: string) {
    assertHashesMatch(this.clientId, this.state.queue, this.state.currentClimbQueueItem?.uuid ?? null, server, context);
  }
}

/** The shipped native Live Activity socket: the Swift `QueueStateReducer` port. */
class SwiftClient implements SimClient {
  state: SwiftQueueState = { items: [], currentIndex: 0 };
  lastKnown = -1;
  /** The current climb the last event named (null after a clear or a FullSync with nothing current). */
  private namedCurrent: string | null = null;
  private lastFullSyncSequence: number | null = null;
  /** Every wall repaint: the uuid `displayCurrentItem` lights, or null when it clears the board. */
  readonly paints: (string | null)[] = [];

  constructor(readonly clientId: string) {}

  receive(event: SimEvent) {
    const swiftEvent = toSwiftEvent(event);
    const decision = swiftSequenceDecision(swiftEvent, this.lastKnown);
    if (decision.kind === 'resync') throw new Error(`${this.clientId}: unexpected resync at ${event.sequence}`);
    this.lastKnown = decision.newLastSequence;
    this.state = swiftApply(swiftEvent, this.state);
    if (swiftShouldRepaintBoard(swiftEvent)) this.checkRepaint(swiftEvent);
    if (swiftEvent.kind === 'fullSync') {
      this.namedCurrent = swiftEvent.currentItem?.uuid ?? null;
      this.lastFullSyncSequence = swiftEvent.sequence;
    } else if (swiftEvent.kind === 'currentClimbChanged') {
      this.namedCurrent = swiftEvent.item?.uuid ?? null;
    }
  }

  /** `BoardBleManager.displayCurrentItem(items:currentIndex:)`: lights items[currentIndex]. */
  private checkRepaint(event: SwiftQueueEvent) {
    const { items, currentIndex } = this.state;
    const painted = items[currentIndex]?.uuid ?? null;
    this.paints.push(painted);
    if (event.kind !== 'currentClimbChanged') return;
    if (event.item) {
      if (painted !== event.item.uuid) {
        throw new Error(`${this.clientId}: repaint lit ${painted}, the event named ${event.item.uuid}`);
      }
      return;
    }
    if (event.sequence === this.lastFullSyncSequence) {
      throw new Error(
        `${this.clientId}: CurrentClimbChanged(null) trailed a FullSync at ${event.sequence}; the repaint lit ${painted} from index ${currentIndex}`,
      );
    }
    // A pointer clear keeps the cleared climb's index, so the wall stays on it
    // (today's behaviour). A clear with nothing current already is today's too.
    if (this.namedCurrent !== null && painted !== this.namedCurrent) {
      throw new Error(`${this.clientId}: a clear lit ${painted}, not the cleared climb ${this.namedCurrent}`);
    }
  }

  assertMatches(server: ServerView, context: string) {
    const { items, currentIndex } = this.state;
    if (items.length > 0 && (currentIndex < 0 || currentIndex >= items.length)) {
      throw new Error(`${context}: swift index ${currentIndex} outside its list`);
    }
    const serverCurrent = server.currentClimbQueueItem;
    // A room written before PR 2 can hold an orphan: Swift appends it to its
    // own list, as today, until the first write normalises the room.
    if (!hasOrphan(server)) {
      const swiftUuids = uuidsOf(items).join(' ');
      const serverUuids = uuidsOf(server.queue).join(' ');
      if (swiftUuids !== serverUuids) {
        throw new Error(`${context}: swift list drift\n  swift  ${swiftUuids}\n  server ${serverUuids}`);
      }
    }
    // With nothing current the native index is a fallback (index 0 after a
    // FullSync, unchanged after CurrentClimbChanged(null)), today's behaviour.
    if (serverCurrent && items[currentIndex]?.uuid !== serverCurrent.uuid) {
      throw new Error(`${context}: swift current ${items[currentIndex]?.uuid} != server ${serverCurrent.uuid}`);
    }
  }
}

type NewClientState = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  historyCount: number | null;
};

/**
 * A new phone in now-slot mode, modelled on `now-slot.ts`: it places locally
 * with the function the server runs, never trims in a session, applies server
 * events as given and moves the line with `lineAfterDelta`. A `FullSync` with
 * an orphan is kept as received. Stand-in for the PR 3 reducer.
 */
class NowSlotClient implements SimClient {
  state: NewClientState = { queue: [], currentClimbQueueItem: null, historyCount: 0 };
  lastSequence: number | null = null;

  constructor(readonly clientId: string) {}

  receive(event: SimEvent) {
    if (event.type === 'FullSync') {
      this.state = {
        queue: [...event.queue],
        currentClimbQueueItem: event.currentClimbQueueItem,
        historyCount: event.historyCount,
      };
      this.lastSequence = event.sequence;
      return;
    }
    if (this.lastSequence !== null && event.sequence <= this.lastSequence) return;
    if (this.lastSequence !== null && event.sequence > this.lastSequence + 1) {
      throw new Error(`${this.clientId}: unexpected sequence gap at ${event.sequence}`);
    }
    this.lastSequence = event.sequence;

    const { queue, currentClimbQueueItem } = this.state;
    switch (event.type) {
      case 'CurrentClimbChanged': {
        // Own echo: the local placement already ran.
        if (event.clientId === this.clientId) return;
        if (event.item === null) {
          this.state = {
            queue,
            currentClimbQueueItem: null,
            historyCount: lineAfterDelta(this.state, { kind: 'clear' }),
          };
          return;
        }
        // A server event never re-runs placement: the pointer goes to the named uuid.
        const pointedIndex = queue.findIndex(({ uuid }) => uuid === event.item?.uuid);
        if (pointedIndex >= 0) {
          this.state = { queue, currentClimbQueueItem: queue[pointedIndex], historyCount: pointedIndex };
          return;
        }
        // Only a dropped add gets here: insert at upNextStart, today's insert-after-current.
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
        const insertIndex = Math.min(Math.max(event.position, 0), queue.length);
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
        if (oldIndex < 0 || oldIndex >= queue.length || newIndex < 0 || newIndex >= queue.length) return;
        if (queue[oldIndex].uuid !== event.uuid) return;
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
    }
  }

  resync(server: ServerView) {
    this.receive(fullSyncOf(server));
  }

  assertMatches(server: ServerView, context: string) {
    assertHashesMatch(this.clientId, this.state.queue, this.state.currentClimbQueueItem?.uuid ?? null, server, context);
    if (this.state.historyCount !== server.historyCount) {
      throw new Error(`${context}: ${this.clientId} historyCount ${this.state.historyCount} != ${server.historyCount}`);
    }
  }
}

// MARK: - Server

type SetCurrentClimbRequest = {
  item: ClimbQueueItem | null;
  shouldAddToQueue?: boolean;
  placement?: CurrentClimbPlacement;
  clientId: string | null;
  correlationId: string | null;
};

type SimStats = {
  /** Rows the server's placeOnWall applied. */
  rewrites: Map<NowSlotRewrite, number>;
  /** Rows a new phone's own placeOnWall applied before sending the resolved item. */
  localRewrites: Map<NowSlotRewrite, number>;
  events: Map<NowSlotQueueEvent | 'controller', number>;
  trims: number;
  pointerChecks: number;
  clampedAdds: number;
  clampedReorders: number;
  orphansNormalised: number;
  maxQueueLength: number;
  /** `addQueueItem` calls the server refused with `QUEUE_FULL`. */
  queueFullRejections: number;
};

function bump<TKey>(counts: Map<TKey, number>, key: TKey) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

type ServerState = Omit<ServerView, 'sequence'>;

class SimServer {
  state: ServerState = { queue: [], currentClimbQueueItem: null, historyCount: 0 };
  sequence = 0;
  context = '';
  clients: SimClient[] = [];

  constructor(
    /** `QUEUE_NOW_SLOT_PERCENT` for this session: 0 or 100. */
    readonly percent: 0 | 100,
    readonly stats: SimStats,
  ) {}

  view(): ServerView {
    return { ...this.state, sequence: this.sequence };
  }

  /**
   * Store a write under the next sequence. Returns what was stored.
   * `trimFollows` is `addQueueItem`'s write 1, which may pass the cap by one
   * because its write 2 (the trim `FullSync`) comes straight after it.
   */
  private commit(next: ServerState, trimFollows = false): ServerView {
    if (hasOrphan(next)) throw new Error(`${this.context}: the server stored an orphan current climb`);
    if (next.historyCount === null) throw new Error(`${this.context}: a write left historyCount to a default`);
    const resolvedLine = historyLine(next);
    if (next.historyCount !== resolvedLine) {
      throw new Error(`${this.context}: stored historyCount ${next.historyCount}, line is ${resolvedLine}`);
    }
    this.state = {
      queue: next.queue,
      currentClimbQueueItem: next.currentClimbQueueItem,
      historyCount: next.historyCount,
    };
    if (this.percent === 100 && !trimFollows) {
      // Section 5: History + Up next <= 500, and the climb on the wall is extra.
      const limit = MAX_SYNCED_QUEUE_ITEMS + (next.currentClimbQueueItem ? 1 : 0);
      if (next.queue.length > limit) {
        throw new Error(`${this.context}: stored ${next.queue.length} entries, over ${limit}`);
      }
    }
    this.sequence += 1;
    if (!trimFollows) this.stats.maxQueueLength = Math.max(this.stats.maxQueueLength, next.queue.length);
    return this.view();
  }

  /**
   * Deliver each event to every client. Every client but `originId` must match
   * the state the event was published under right away; the origin must once
   * the last event is in.
   */
  private publish(publications: Publication[], originId: string | null) {
    let observed: NowSlotState<ClimbQueueItem> = this.stateBefore;
    publications.forEach(({ event, stored }, index) => {
      if (event.type === 'CurrentClimbChanged') this.assertLegacyPredicts(observed, event, stored);
      for (const client of this.clients) client.receive(event);
      const isLast = index === publications.length - 1;
      for (const client of this.clients) {
        if (isLast || client.clientId !== originId) {
          client.assertMatches(stored, `${this.context} after ${event.type} #${index + 1}`);
        }
      }
      observed = stored;
    });
  }

  /** The stored state when the current request arrived. */
  private stateBefore: ServerState = this.state;

  private begin(): ServerState {
    this.stateBefore = this.state;
    return this.state;
  }

  /**
   * The frozen legacy reducer, as a crewmate that holds `observed`, must turn
   * this `CurrentClimbChanged` into exactly the stored array and current climb.
   */
  private assertLegacyPredicts(
    observed: NowSlotState<ClimbQueueItem>,
    event: SimEvent & { type: 'CurrentClimbChanged' },
    stored: ServerView,
  ) {
    const mapping = legacyMapQueueEventToAction(toLegacyEvent(event), { myClientId: 'legacy-observer' });
    if (mapping.kind !== 'dispatch') throw new Error(`${this.context}: CurrentClimbChanged was not dispatched`);
    const predicted = legacyQueueReducer(
      {
        queue: [...observed.queue],
        currentClimbQueueItem: observed.currentClimbQueueItem,
        pendingCurrentClimbUpdates: [],
      },
      mapping.action,
    );
    const predictedUuids = uuidsOf(predicted.queue).join(' ');
    const storedUuids = uuidsOf(stored.queue).join(' ');
    const predictedCurrent = predicted.currentClimbQueueItem?.uuid ?? null;
    const storedCurrent = stored.currentClimbQueueItem?.uuid ?? null;
    if (predictedUuids !== storedUuids || predictedCurrent !== storedCurrent) {
      throw new Error(
        `${this.context}: a shipped reducer would not reach the stored state from this CurrentClimbChanged\n` +
          `  predicted ${predictedUuids} | ${predictedCurrent}\n  stored    ${storedUuids} | ${storedCurrent}`,
      );
    }
    this.stats.pointerChecks += 1;
  }

  private pointerEvent(stored: ServerView, clientId: string | null, correlationId: string | null): Publication {
    return {
      event: {
        type: 'CurrentClimbChanged',
        sequence: stored.sequence,
        item: stored.currentClimbQueueItem,
        clientId,
        correlationId,
      },
      stored,
    };
  }

  private publishFor(eventKind: NowSlotQueueEvent, stored: ServerView, request: SetCurrentClimbRequest) {
    if (request.item === null && eventKind === 'fullsync+trailing') {
      throw new Error(`${this.context}: a clear published the trailing event (section 5)`);
    }
    bump(this.stats.events, eventKind);
    const fullSync: Publication = { event: fullSyncOf(stored), stored };
    if (eventKind === 'pointer') {
      this.publish([this.pointerEvent(stored, request.clientId, request.correlationId)], request.clientId);
    } else if (eventKind === 'fullsync') {
      this.publish([fullSync], request.clientId);
    } else {
      this.publish([fullSync, this.pointerEvent(stored, request.clientId, null)], request.clientId);
    }
  }

  /**
   * Invariant 1 for the writes that don't place a climb: a room still holding
   * a pre-PR-2 orphan is normalised by its first write, with a `FullSync`.
   */
  private normaliseStoredOrphan() {
    if (!hasOrphan(this.state)) return;
    this.stats.orphansNormalised += 1;
    const normalised = normaliseOrphanCurrent(this.begin());
    const stored = this.commit(normalised);
    this.publish([{ event: fullSyncOf(stored), stored }], null);
  }

  setCurrentClimb(request: SetCurrentClimbRequest) {
    const before = this.begin();
    if (hasOrphan(before)) this.stats.orphansNormalised += 1;

    if (request.placement != null || this.percent === 100) {
      const placed = placeOnWall(before, request.item, request.placement, request.shouldAddToQueue);
      const capped = capHistory(placed);
      bump(this.stats.rewrites, placed.rewrite);
      if (capped.trimmedCount > 0) this.stats.trims += 1;
      if (historyLine(capped) >= HISTORY_TRIM_AT) throw new Error(`${this.context}: History not trimmed`);
      const eventKind = chooseQueueEvent(before, request, capped);
      this.publishFor(eventKind, this.commit(capped), request);
      return;
    }

    // Outside the percent: today's rules (`setCurrentClimbAndPublish`), no
    // caps, except that an orphan is never stored.
    const normalised = normaliseOrphanCurrent(before);
    const { queue, currentClimbQueueItem: current } = normalised;
    const reshaped: NowSlotQueueEvent = 'fullsync+trailing';
    const { item } = request;
    if (item === null) {
      const stored = this.commit({
        queue,
        currentClimbQueueItem: null,
        historyCount: lineAfterDelta(normalised, { kind: 'clear' }),
      });
      // A clear has nothing to repaint: a plain FullSync when it normalised.
      this.publishFor(normalised.normalised ? 'fullsync' : 'pointer', stored, request);
      return;
    }
    const existingIndex = queue.findIndex(({ uuid }) => uuid === item.uuid);
    if (existingIndex >= 0) {
      const stored = this.commit({ queue, currentClimbQueueItem: queue[existingIndex], historyCount: existingIndex });
      this.publishFor(normalised.normalised ? reshaped : 'pointer', stored, request);
      return;
    }
    const currentIndex = current ? queue.findIndex(({ uuid }) => uuid === current.uuid) : -1;
    if (request.shouldAddToQueue === true) {
      // Insert after the current climb, or append with nothing current (#2217).
      const insertIndex = currentIndex === -1 ? queue.length : currentIndex + 1;
      const stored = this.commit({
        queue: [...queue.slice(0, insertIndex), item, ...queue.slice(insertIndex)],
        currentClimbQueueItem: item,
        historyCount: insertIndex,
      });
      this.publishFor(normalised.normalised ? reshaped : 'fullsync', stored, request);
      return;
    }
    // The native socket's stale item: inserted at the Now slot, never an orphan.
    const insertIndex = upNextStart(queue, current, normalised.historyCount);
    const stored = this.commit({
      queue: [...queue.slice(0, insertIndex), item, ...queue.slice(insertIndex)],
      currentClimbQueueItem: item,
      historyCount: insertIndex,
    });
    this.publishFor(reshaped, stored, request);
  }

  /** `setClimbFromLedPositions`: a fresh uuid, then `FullSync` + the controller's `CurrentClimbChanged`. */
  ledDetect(item: ClimbQueueItem) {
    const before = this.begin();
    let next: ServerState;
    if (this.percent === 100) {
      const placed = placeOnWall(before, item);
      const capped = capHistory(placed);
      bump(this.stats.rewrites, placed.rewrite);
      if (capped.trimmedCount > 0) this.stats.trims += 1;
      next = capped;
    } else {
      const { queue, currentClimbQueueItem: current } = normaliseOrphanCurrent(before);
      const currentIndex = current ? queue.findIndex(({ uuid }) => uuid === current.uuid) : -1;
      const insertIndex = currentIndex === -1 ? queue.length : currentIndex + 1;
      next = {
        queue: [...queue.slice(0, insertIndex), item, ...queue.slice(insertIndex)],
        currentClimbQueueItem: item,
        historyCount: insertIndex,
      };
    }
    bump(this.stats.events, 'controller');
    const stored = this.commit(next);
    this.publish([{ event: fullSyncOf(stored), stored }, this.pointerEvent(stored, 'controller', null)], null);
  }

  /**
   * `addQueueItem`. Inside the percent: `QUEUE_FULL`, the History clamp, and
   * the two-write add (`QueueItemAdded`, then a `FullSync` when it clamped or
   * History needs a trim). Returns false for a `QUEUE_FULL` rejection.
   */
  addQueueItem(item: ClimbQueueItem, position: number | undefined, originId: string): boolean {
    this.normaliseStoredOrphan();
    const before = this.begin();
    if (this.percent === 100 && isUpNextFull(before)) {
      this.stats.queueFullRejections += 1;
      return false;
    }

    const { index, clamped } =
      this.percent === 100
        ? clampInsertPosition(before, position)
        : {
            index:
              position !== undefined && position >= 0 && position <= before.queue.length
                ? position
                : before.queue.length,
            clamped: false,
          };
    if (clamped) this.stats.clampedAdds += 1;
    const added = this.commit(
      {
        queue: [...before.queue.slice(0, index), item, ...before.queue.slice(index)],
        currentClimbQueueItem: before.currentClimbQueueItem,
        historyCount: lineAfterDelta(before, { kind: 'add', index }),
      },
      this.percent === 100,
    );
    const publications: Publication[] = [
      { event: { type: 'QueueItemAdded', sequence: added.sequence, item, position: index }, stored: added },
    ];
    if (this.percent === 100) {
      const capped = capHistory(added);
      if (clamped || capped.trimmedCount > 0) {
        if (capped.trimmedCount > 0) this.stats.trims += 1;
        const trimmed = this.commit(capped);
        publications.push({ event: fullSyncOf(trimmed), stored: trimmed });
      }
    }
    this.publish(publications, originId);
    return true;
  }

  removeQueueItem(uuid: string, originId: string) {
    this.normaliseStoredOrphan();
    const before = this.begin();
    if (!before.queue.some((queued) => queued.uuid === uuid)) return;
    const stored = this.commit({
      queue: before.queue.filter((queued) => queued.uuid !== uuid),
      currentClimbQueueItem: before.currentClimbQueueItem?.uuid === uuid ? null : before.currentClimbQueueItem,
      historyCount: lineAfterDelta(before, { kind: 'remove', uuid }),
    });
    this.publish([{ event: { type: 'QueueItemRemoved', sequence: stored.sequence, uuid }, stored }], originId);
  }

  reorderQueueItem(uuid: string, oldIndex: number, newIndex: number, originId: string) {
    this.normaliseStoredOrphan();
    const before = this.begin();
    if (before.queue[oldIndex]?.uuid !== uuid) return;
    const reordered =
      this.percent === 100
        ? reorderAcrossLine(before, oldIndex, newIndex)
        : applyReorderAsGiven(before, oldIndex, newIndex);
    if (!reordered) return;
    if (reordered.clamped) this.stats.clampedReorders += 1;
    const stored = this.commit(reordered);
    const event: SimEvent = reordered.clamped
      ? fullSyncOf(stored)
      : { type: 'QueueReordered', sequence: stored.sequence, uuid, oldIndex, newIndex: reordered.newIndex };
    this.publish([{ event, stored }], originId);
  }

  /**
   * A whole-queue write. A sent `historyCount` goes through
   * `normaliseHistoryCount`; without one the line is the current index, or with
   * nothing current just after the last payload entry that is in the stored
   * History (section 3). A payload orphan is inserted at that line. Caps apply
   * inside the percent and to every write that carries `historyCount`.
   * Returns false when the server throws.
   */
  setQueue(
    queue: ClimbQueueItem[],
    current: ClimbQueueItem | null,
    historyCount: number | undefined,
    originId: string,
  ): boolean {
    const before = this.begin();
    const storedHistory = new Set(uuidsOf(historyOf(before)));
    const derivedLine = queue.reduce((line, queued, index) => (storedHistory.has(queued.uuid) ? index + 1 : line), 0);
    const line = normaliseHistoryCount(historyCount, queue, current) ?? derivedLine;
    const normalised = normaliseOrphanCurrent({ queue, currentClimbQueueItem: current, historyCount: line });

    let next: ServerState = normalised;
    if (historyCount !== undefined || this.percent === 100) {
      const capped = capHistory(normalised);
      if (capped.currentClimbQueueItem && isUpNextFull(capped, 0)) return false;
      // With nothing current the excess comes off the head instead of throwing.
      // The climb on the wall doesn't count toward the cap.
      const excess = Math.max(historyAndUpNextCount(capped) - MAX_SYNCED_QUEUE_ITEMS, 0);
      next = {
        queue: capped.queue.slice(excess),
        currentClimbQueueItem: capped.currentClimbQueueItem,
        historyCount: lineAfterDelta(capped, { kind: 'trim', count: excess }),
      };
      if (capped.trimmedCount + excess > 0) this.stats.trims += 1;
    } else if (queue.length > MAX_SYNCED_QUEUE_ITEMS + (queue.some(({ uuid }) => uuid === current?.uuid) ? 1 : 0)) {
      // The raw guard: 501 entries when the payload's current climb is in it, else 500.
      return false;
    }
    const stored = this.commit(next);
    this.publish([{ event: fullSyncOf(stored), stored }], originId);
    return true;
  }

  /** Widget / Garmin REST navigate. Inside the percent it stops at the ends; outside it wraps, as today. */
  widgetNavigate(direction: 1 | -1) {
    this.normaliseStoredOrphan();
    const before = this.begin();
    const { queue } = before;
    if (queue.length === 0) return;
    const current = before.currentClimbQueueItem;
    const currentIndex = current ? queue.findIndex(({ uuid }) => uuid === current.uuid) : -1;
    let targetIndex: number;
    if (this.percent === 100) {
      const line = historyLine(before);
      targetIndex = currentIndex >= 0 ? currentIndex + direction : direction === 1 ? line : line - 1;
      if (targetIndex < 0 || targetIndex >= queue.length) return; // out_of_bounds
    } else {
      const baseIndex = currentIndex >= 0 ? currentIndex : 0;
      targetIndex = (baseIndex + direction + queue.length) % queue.length;
    }
    const stored = this.commit({
      queue: [...queue],
      currentClimbQueueItem: queue[targetIndex],
      historyCount: targetIndex,
    });
    bump(this.stats.events, 'pointer');
    this.publish([this.pointerEvent(stored, null, null)], null);
  }

  /** The first subscribe: a `FullSync` of whatever the room holds, orphan included. */
  subscribeAll() {
    const subscribed = this.view();
    for (const client of this.clients) {
      client.receive(fullSyncOf(subscribed));
      client.assertMatches(subscribed, `${this.context} initial FullSync`);
    }
  }
}

/** A reorder applied at the indexes sent, as the resolver does outside the percent. */
function applyReorderAsGiven(state: ServerState, oldIndex: number, newIndex: number) {
  if (newIndex < 0 || newIndex >= state.queue.length) return null;
  const queue = [...state.queue];
  const [moved] = queue.splice(oldIndex, 1);
  queue.splice(newIndex, 0, moved);
  return {
    queue,
    currentClimbQueueItem: state.currentClimbQueueItem,
    historyCount: lineAfterDelta(state, { kind: 'reorder', oldIndex, newIndex }),
    newIndex,
    clamped: false,
  };
}

// MARK: - The crew

type Crew = {
  server: SimServer;
  oldPhones: LegacyJsClient[];
  swift: SwiftClient;
  newPhones: NowSlotClient[];
  removedItems: ClimbQueueItem[];
  random: Random;
  mintUuid: () => string;
  randomClimb: () => Climb;
};

/**
 * The room the crew joins: empty, one a pre-PR-2 native path left with an
 * orphan current climb, or one whose Up next already holds 500 climbs with
 * nothing current (the cap edge of section 5).
 */
type RoomStart = 'empty' | 'orphan' | 'full-up-next';

function createCrew(seed: number, percent: 0 | 100, start: RoomStart, stats: SimStats): Crew {
  const oldPhones = [new LegacyJsClient('old-1'), new LegacyJsClient('old-2')];
  const swift = new SwiftClient('swift');
  const newPhones = [new NowSlotClient('new-1'), new NowSlotClient('new-2')];
  const server = new SimServer(percent, stats);
  server.clients = [...oldPhones, swift, ...newPhones];
  const random = createRandom(seed);
  let uuidCounter = 0;
  const crew: Crew = {
    server,
    oldPhones,
    swift,
    newPhones,
    removedItems: [],
    random,
    mintUuid: () => {
      uuidCounter += 1;
      return `item-${seed}-${uuidCounter}`;
    },
    randomClimb: () =>
      makeClimb(random.int(CLIMB_POOL_SIZE), random.pick(ANGLES), random.pick(['kilter', undefined] as const)),
  };
  if (start === 'orphan') {
    // A room the shipped native stale-item path wrote before PR 2: [A B C]
    // with an orphan current climb and no historyCount.
    server.state = {
      queue: [0, 1, 2].map(() => freshItem(crew, crew.randomClimb())),
      currentClimbQueueItem: freshItem(crew, crew.randomClimb()),
      historyCount: null,
    };
  }
  if (start === 'full-up-next') {
    server.state = {
      queue: Array.from({ length: MAX_SYNCED_QUEUE_ITEMS }, () => freshItem(crew, crew.randomClimb())),
      currentClimbQueueItem: null,
      historyCount: 0,
    };
  }
  server.context = `seed ${seed} percent ${percent}`;
  server.subscribeAll();
  return crew;
}

function freshItem(crew: Crew, climb: Climb): ClimbQueueItem {
  return { uuid: crew.mintUuid(), climb: { ...climb } };
}

/** A climb already in the room, as a fresh open (logbook or session-history re-tap) would mint it. */
function queuedClimb(crew: Crew): Climb | null {
  const { queue } = crew.server.state;
  return queue.length === 0 ? null : crew.random.pick(queue).climb;
}

// Shipped JS phone operations, as `queue-provider.tsx` sends them today.

function oldPhoneSetCurrent(crew: Crew, phone: LegacyJsClient, item: ClimbQueueItem, shouldAddToQueue: boolean) {
  const correlationId = phone.nextCorrelationId();
  phone.dispatchLocal({
    type: 'DELTA_UPDATE_CURRENT_CLIMB',
    payload: { item, shouldAddToQueue, insertAfterCurrent: true, isServerEvent: false, correlationId },
  });
  crew.server.setCurrentClimb({ item, shouldAddToQueue, clientId: phone.clientId, correlationId });
}

function legacyCurrentIndex(phone: LegacyJsClient): number {
  const { queue, currentClimbQueueItem } = phone.state;
  return currentClimbQueueItem ? queue.findIndex(({ uuid }) => uuid === currentClimbQueueItem.uuid) : -1;
}

/** `findNextQueueItem` / `findPreviousQueueItem`: with nothing current (or an orphan) Next is queue[0], Previous nothing. */
function oldPhoneNeighbour(phone: LegacyJsClient, offset: 1 | -1): ClimbQueueItem | null {
  const { queue, currentClimbQueueItem } = phone.state;
  if (!currentClimbQueueItem) return offset === 1 ? (queue[0] ?? null) : null;
  return queue[legacyCurrentIndex(phone) + offset] ?? null;
}

type Operation<TActor> = [weight: number, run: (crew: Crew, actor: TActor) => string | null];

const oldPhoneOperations: Operation<LegacyJsClient>[] = [
  [
    12,
    (crew, phone) => {
      oldPhoneSetCurrent(crew, phone, freshItem(crew, crew.randomClimb()), true);
      return 'open a new climb (Put on the wall, track swipe to a fresh climb)';
    },
  ],
  [
    8,
    (crew, phone) => {
      const climb = queuedClimb(crew);
      if (!climb) return null;
      oldPhoneSetCurrent(crew, phone, freshItem(crew, climb), true);
      return 're-tap a queued climb from session history';
    },
  ],
  [
    6,
    (crew, phone) => {
      const { queue, currentClimbQueueItem } = phone.state;
      if (queue.length === 0) return null;
      // Mostly Up next rows, sometimes History. The board history sheet reuses
      // the queue-item uuid the same way.
      const upNext = queue.slice(upNextStart(queue, currentClimbQueueItem, 0));
      const row = upNext.length > 0 && crew.random.next() < 0.7 ? crew.random.pick(upNext) : crew.random.pick(queue);
      oldPhoneSetCurrent(crew, phone, row, true);
      return 'tap a queue row';
    },
  ],
  [
    7,
    (crew, phone) => {
      const next = oldPhoneNeighbour(phone, 1);
      if (!next) return null;
      oldPhoneSetCurrent(crew, phone, next, false);
      return 'Next';
    },
  ],
  [
    3,
    (crew, phone) => {
      // Previous, or a track back-swipe onto a queued neighbour (findQueuedListNeighbour).
      const previous = oldPhoneNeighbour(phone, -1);
      if (!previous) return null;
      oldPhoneSetCurrent(crew, phone, previous, false);
      return 'Previous';
    },
  ],
  [
    5,
    (crew, phone) => {
      const item = freshItem(crew, crew.randomClimb());
      // Add to queue appends; Play next goes after the current climb, or to 0
      // with nothing current (playNextInsertPosition).
      const currentIndex = legacyCurrentIndex(phone);
      const position = crew.random.next() < 0.5 ? undefined : currentIndex === -1 ? 0 : currentIndex + 1;
      phone.dispatchLocal({ type: 'DELTA_ADD_QUEUE_ITEM', payload: { item, position } });
      if (!crew.server.addQueueItem(item, position, phone.clientId)) phone.resync(crew.server.view());
      return position === undefined ? 'add to queue' : 'play next';
    },
  ],
  [
    4,
    (crew, phone) => {
      if (phone.state.queue.length === 0) return null;
      // Removing the current climb (S11) is what leaves the room with nothing current.
      const { currentClimbQueueItem } = phone.state;
      const removed =
        currentClimbQueueItem && crew.random.next() < 0.4 ? currentClimbQueueItem : crew.random.pick(phone.state.queue);
      crew.removedItems.push(removed);
      phone.dispatchLocal({ type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid: removed.uuid } });
      crew.server.removeQueueItem(removed.uuid, phone.clientId);
      return 'remove';
    },
  ],
  [
    2,
    (crew, phone) => {
      const { queue } = phone.state;
      if (queue.length === 0) return null;
      // Remove, then Undo (restoreQueueItems): a setQueue composed from the
      // live state with the entry back at its index, no historyCount.
      const removedIndex = crew.random.int(queue.length);
      const removed = queue[removedIndex];
      phone.dispatchLocal({ type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid: removed.uuid } });
      crew.server.removeQueueItem(removed.uuid, phone.clientId);
      const live = phone.state.queue;
      const restored = [...live.slice(0, removedIndex), removed, ...live.slice(removedIndex)];
      if (!crew.server.setQueue(restored, phone.state.currentClimbQueueItem, undefined, phone.clientId)) {
        phone.resync(crew.server.view());
      }
      return 'remove, then Undo';
    },
  ],
  [
    4,
    (crew, phone) => {
      const { queue } = phone.state;
      if (queue.length < 2) return null;
      const oldIndex = crew.random.int(queue.length);
      const newIndex = crew.random.int(queue.length);
      if (oldIndex === newIndex) return null;
      const { uuid } = queue[oldIndex];
      phone.dispatchLocal({ type: 'DELTA_REORDER_QUEUE_ITEM', payload: { uuid, oldIndex, newIndex } });
      crew.server.reorderQueueItem(uuid, oldIndex, newIndex, phone.clientId);
      return 'reorder';
    },
  ],
  [
    1,
    (crew, phone) => {
      if (!crew.server.setQueue([...phone.state.queue], phone.state.currentClimbQueueItem, undefined, phone.clientId)) {
        phone.resync(crew.server.view());
      }
      return 'write the whole queue back';
    },
  ],
];

// New phone operations: local placement with the server's own function.

function newPhonePlace(
  crew: Crew,
  phone: NowSlotClient,
  item: ClimbQueueItem | null,
  placement: CurrentClimbPlacement,
) {
  const placed = placeOnWall(phone.state, item, placement, false);
  bump(crew.server.stats.localRewrites, placed.rewrite);
  phone.state = {
    queue: placed.queue,
    currentClimbQueueItem: placed.currentClimbQueueItem,
    historyCount: placed.historyCount,
  };
  // With placement the phone sends shouldAddToQueue: false (section 7).
  crew.server.setCurrentClimb({
    item: placed.currentClimbQueueItem,
    shouldAddToQueue: false,
    placement,
    clientId: phone.clientId,
    correlationId: null,
  });
}

function newPhoneUpNextStart(phone: NowSlotClient): number {
  const { queue, currentClimbQueueItem, historyCount } = phone.state;
  return upNextStart(queue, currentClimbQueueItem, historyCount);
}

const newPhoneOperations: Operation<NowSlotClient>[] = [
  [
    12,
    (crew, phone) => {
      newPhonePlace(crew, phone, freshItem(crew, crew.randomClimb()), 'NOW');
      return 'open from search (NOW)';
    },
  ],
  [
    8,
    (crew, phone) => {
      const climb = queuedClimb(crew);
      if (!climb) return null;
      newPhonePlace(crew, phone, freshItem(crew, climb), 'NOW');
      return 'open a queued climb from the logbook (NOW)';
    },
  ],
  [
    2,
    (crew, phone) => {
      const current = phone.state.currentClimbQueueItem;
      if (!current) return null;
      newPhonePlace(crew, phone, freshItem(crew, current.climb), 'NOW');
      return 'open the climb on the wall again from the logbook (NOW)';
    },
  ],
  [
    6,
    (crew, phone) => {
      if (phone.state.queue.length === 0) return null;
      newPhonePlace(crew, phone, crew.random.pick(phone.state.queue), 'NOW');
      return 'tap a queue or History row (NOW)';
    },
  ],
  [
    6,
    (crew, phone) => {
      const next = phone.state.queue[newPhoneUpNextStart(phone)];
      if (!next) return null;
      newPhonePlace(crew, phone, next, 'NOW');
      return 'Next';
    },
  ],
  [
    2,
    (crew, phone) => {
      const line = historyLine(phone.state);
      if (line === 0) return null;
      newPhonePlace(crew, phone, phone.state.queue[line - 1], 'STEP');
      return 'Previous (STEP)';
    },
  ],
  [
    2,
    (crew, phone) => {
      if (!phone.state.currentClimbQueueItem) return null;
      newPhonePlace(crew, phone, null, 'NOW');
      return 'take the climb off the wall';
    },
  ],
  [
    4,
    (crew, phone) => {
      if (isUpNextFull(phone.state)) return null; // "Up next is full (500)"
      const item = freshItem(crew, crew.randomClimb());
      const { queue, currentClimbQueueItem } = phone.state;
      const index = crew.random.next() < 0.5 ? queue.length : newPhoneUpNextStart(phone);
      phone.state = {
        queue: [...queue.slice(0, index), item, ...queue.slice(index)],
        currentClimbQueueItem,
        historyCount: lineAfterDelta(phone.state, { kind: 'add', index }),
      };
      const position = index === queue.length ? undefined : index;
      if (!crew.server.addQueueItem(item, position, phone.clientId)) phone.resync(crew.server.view());
      return position === undefined ? 'add to queue' : 'play next';
    },
  ],
  [
    3,
    (crew, phone) => {
      if (phone.state.queue.length === 0) return null;
      const removed = crew.random.pick(phone.state.queue);
      crew.removedItems.push(removed);
      phone.state = {
        queue: phone.state.queue.filter(({ uuid }) => uuid !== removed.uuid),
        currentClimbQueueItem:
          phone.state.currentClimbQueueItem?.uuid === removed.uuid ? null : phone.state.currentClimbQueueItem,
        historyCount: lineAfterDelta(phone.state, { kind: 'remove', uuid: removed.uuid }),
      };
      crew.server.removeQueueItem(removed.uuid, phone.clientId);
      return 'remove';
    },
  ],
  [
    2,
    (crew, phone) => {
      const { queue } = phone.state;
      if (queue.length === 0) return null;
      // Remove, then Undo with historyCount: the line goes back with the entry.
      const removedIndex = crew.random.int(queue.length);
      const removed = queue[removedIndex];
      phone.state = {
        queue: queue.filter(({ uuid }) => uuid !== removed.uuid),
        currentClimbQueueItem:
          phone.state.currentClimbQueueItem?.uuid === removed.uuid ? null : phone.state.currentClimbQueueItem,
        historyCount: lineAfterDelta(phone.state, { kind: 'remove', uuid: removed.uuid }),
      };
      crew.server.removeQueueItem(removed.uuid, phone.clientId);
      const live = phone.state;
      const restored = [...live.queue.slice(0, removedIndex), removed, ...live.queue.slice(removedIndex)];
      const historyCount = lineAfterDelta(live, { kind: 'add', index: removedIndex });
      if (!crew.server.setQueue(restored, live.currentClimbQueueItem, historyCount, phone.clientId)) {
        phone.resync(crew.server.view());
      }
      return 'remove, then Undo with historyCount';
    },
  ],
  [
    3,
    (crew, phone) => {
      const { queue } = phone.state;
      if (queue.length < 2) return null;
      const oldIndex = crew.random.int(queue.length);
      const reordered = reorderAcrossLine(phone.state, oldIndex, crew.random.int(queue.length));
      if (!reordered || oldIndex === reordered.newIndex) return null;
      const { uuid } = queue[oldIndex];
      phone.state = {
        queue: reordered.queue,
        currentClimbQueueItem: reordered.currentClimbQueueItem,
        historyCount: reordered.historyCount,
      };
      crew.server.reorderQueueItem(uuid, oldIndex, reordered.newIndex, phone.clientId);
      return 'reorder';
    },
  ],
];

// Native, widget and controller operations.

const deviceOperations: Operation<null>[] = [
  [
    3,
    (crew) => {
      const { items, currentIndex } = crew.swift.state;
      const target = crew.random.next() < 0.6 ? currentIndex + 1 : currentIndex - 1;
      if (target < 0 || target >= items.length) return null;
      // ClimbNavigationIntent: step the native index, send the item without shouldAddToQueue.
      crew.swift.state = { items, currentIndex: target };
      const item = crew.server.state.queue.find(({ uuid }) => uuid === items[target].uuid);
      if (!item) throw new Error('swift list out of step with the server');
      crew.server.setCurrentClimb({ item, clientId: crew.swift.clientId, correlationId: 'swift-navigation' });
      // A lock-screen press lights the climb it named, never Up next[0] in its
      // place (the native socket sends no shouldAddToQueue).
      if (crew.server.state.currentClimbQueueItem?.uuid !== item.uuid) {
        throw new Error(
          `lock-screen press named ${item.uuid}, server lit ${crew.server.state.currentClimbQueueItem?.uuid}`,
        );
      }
      return 'lock-screen Next / Previous';
    },
  ],
  [
    1,
    (crew) => {
      const stale = crew.removedItems.filter(
        ({ uuid }) => !crew.server.state.queue.some((queued) => queued.uuid === uuid),
      );
      if (stale.length === 0) return null;
      crew.server.setCurrentClimb({
        item: crew.random.pick(stale),
        clientId: crew.swift.clientId,
        correlationId: 'swift-stale',
      });
      return 'lock-screen navigation with a stale item';
    },
  ],
  [
    2,
    (crew) => {
      crew.server.widgetNavigate(crew.random.next() < 0.8 ? 1 : -1);
      return 'widget navigate';
    },
  ],
  [
    2,
    (crew) => {
      const climb = crew.random.next() < 0.5 ? queuedClimb(crew) : crew.randomClimb();
      if (!climb) return null;
      crew.server.ledDetect(freshItem(crew, climb));
      return 'ESP32 reads a climb off the LEDs';
    },
  ],
];

type Actor = { weight: number; run: (crew: Crew) => string | null };

function buildActors(crew: Crew): Actor[] {
  return [
    ...crew.oldPhones.flatMap((phone) =>
      oldPhoneOperations.map(([weight, run]) => ({ weight, run: (target: Crew) => run(target, phone) })),
    ),
    ...crew.newPhones.flatMap((phone) =>
      newPhoneOperations.map(([weight, run]) => ({ weight, run: (target: Crew) => run(target, phone) })),
    ),
    ...deviceOperations.map(([weight, run]) => ({ weight, run: (target: Crew) => run(target, null) })),
  ];
}

function pickActor(actors: Actor[], random: Random): Actor {
  const totalWeight = actors.reduce((sum, actor) => sum + actor.weight, 0);
  let roll = random.next() * totalWeight;
  for (const actor of actors) {
    roll -= actor.weight;
    if (roll < 0) return actor;
  }
  return actors[actors.length - 1];
}

function runSimulation(seed: number, percent: 0 | 100, start: RoomStart, operationCount: number, stats: SimStats) {
  const crew = createCrew(seed, percent, start, stats);
  const actors = buildActors(crew);
  let performed = 0;
  let attempts = 0;
  while (performed < operationCount) {
    attempts += 1;
    if (attempts > operationCount * 20) throw new Error(`seed ${seed}: the simulation stopped making progress`);
    const actor = pickActor(actors, crew.random);
    crew.server.context = `seed ${seed} percent ${percent} op ${performed + 1}`;
    if (actor.run(crew) !== null) performed += 1;
  }
}

function emptyStats(): SimStats {
  return {
    rewrites: new Map(),
    localRewrites: new Map(),
    events: new Map(),
    trims: 0,
    pointerChecks: 0,
    clampedAdds: 0,
    clampedReorders: 0,
    orphansNormalised: 0,
    maxQueueLength: 0,
    queueFullRejections: 0,
  };
}

// MARK: - Tests

const SEEDS = [6666, 20261024, 4979];
const OPERATIONS_PER_RUN = 1000;
const PERCENTS = [0, 100] as const;

describe.each(PERCENTS)('legacy client simulation at QUEUE_NOW_SLOT_PERCENT=%i', (percent) => {
  const stats = emptyStats();

  it.each(SEEDS)('keeps every client in step with the server over 1,000 operations (seed %i)', (seed) => {
    expect(() => runSimulation(seed, percent, 'empty', OPERATIONS_PER_RUN, stats)).not.toThrow();
  });

  it.each(SEEDS)('normalises a room written before PR 2 that holds an orphan (seed %i)', (seed) => {
    expect(() => runSimulation(seed + 1, percent, 'orphan', OPERATIONS_PER_RUN, stats)).not.toThrow();
  });

  it('exercised the rows and events it is meant to cover', () => {
    // A new phone resolves a dedupe locally and sends the existing entry's
    // uuid, so the server only dedupes for placement-less requests, which run
    // placeOnWall only inside the percent. `next-from-line` (an old phone's
    // Next) likewise shows only at 100.
    const serverRewrites: NowSlotRewrite[] =
      percent === 100
        ? [
            'none',
            'next',
            'next-from-line',
            'step',
            'move-history',
            'move-up-next',
            'dedupe-current',
            'dedupe-up-next',
            'dedupe-history',
            'insert',
            'clear',
          ]
        : ['none', 'next', 'step', 'move-history', 'move-up-next', 'insert', 'clear'];
    for (const rewrite of serverRewrites) expect(stats.rewrites.get(rewrite) ?? 0, rewrite).toBeGreaterThan(0);
    for (const rewrite of ['dedupe-current', 'dedupe-up-next', 'dedupe-history'] as const) {
      expect(stats.localRewrites.get(rewrite) ?? 0, `local ${rewrite}`).toBeGreaterThan(0);
    }
    for (const eventKind of ['pointer', 'fullsync', 'fullsync+trailing', 'controller'] as const) {
      expect(stats.events.get(eventKind) ?? 0, eventKind).toBeGreaterThan(0);
    }
    expect(stats.trims).toBeGreaterThan(0);
    expect(stats.pointerChecks).toBeGreaterThan(0);
    expect(stats.orphansNormalised).toBeGreaterThan(0);
    expect(stats.maxQueueLength).toBeGreaterThan(HISTORY_TRIM_AT);
    if (percent === 100) {
      expect(stats.clampedAdds).toBeGreaterThan(0);
      expect(stats.clampedReorders).toBeGreaterThan(0);
    }
  });
});

describe('legacy client simulation from a room whose Up next is full', () => {
  // Section 5: the climb on the wall doesn't count toward the 500 cap. With
  // nothing current and 500 climbs in Up next, an open stores 501 entries and
  // is never refused; adds are refused with QUEUE_FULL; a clear drops the
  // cleared climb when there is no other History to trim. Every commit at 100
  // asserts at most 501 entries with a climb current and 500 without.
  const stats = emptyStats();

  it.each(SEEDS)('keeps every client in step at the cap (seed %i)', (seed) => {
    expect(() => runSimulation(seed + 2, 100, 'full-up-next', OPERATIONS_PER_RUN / 2, stats)).not.toThrow();
  });

  it('reached the 501-entry array and trimmed History to stay there', () => {
    expect(stats.maxQueueLength).toBe(MAX_SYNCED_QUEUE_ITEMS + 1);
    expect(stats.trims).toBeGreaterThan(0);
  });

  it('refuses an old phone’s add with QUEUE_FULL, then takes its open as the 501st entry', () => {
    const localStats = emptyStats();
    const crew = createCrew(1, 100, 'full-up-next', localStats);
    const [phone] = crew.oldPhones;
    const added = freshItem(crew, crew.randomClimb());
    phone.dispatchLocal({ type: 'DELTA_ADD_QUEUE_ITEM', payload: { item: added, position: undefined } });
    expect(crew.server.addQueueItem(added, undefined, phone.clientId)).toBe(false);
    phone.resync(crew.server.view());
    phone.assertMatches(crew.server.view(), 'after QUEUE_FULL');
    expect(localStats.queueFullRejections).toBe(1);

    const opened = freshItem(crew, crew.randomClimb());
    oldPhoneSetCurrent(crew, phone, opened, true);
    const stored = crew.server.view();
    expect(stored.queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);
    expect(stored.currentClimbQueueItem?.uuid).toBe(opened.uuid);
    expect(stored.historyCount).toBe(0);
  });

  it('a clear that drops the cleared climb is one FullSync, and the native socket lights nothing', () => {
    const crew = createCrew(3, 100, 'full-up-next', emptyStats());
    const [phone] = crew.oldPhones;
    const upNext = crew.server.view().queue;
    // A climb outside the pool, so the open is an insert, never a dedupe.
    const opened = freshItem(crew, makeClimb(CLIMB_POOL_SIZE, 40, undefined));
    oldPhoneSetCurrent(crew, phone, opened, true);
    expect(crew.server.view().queue).toHaveLength(MAX_SYNCED_QUEUE_ITEMS + 1);

    const received: SimEvent['type'][] = [];
    crew.server.clients.push({
      clientId: 'recorder',
      receive: (event) => received.push(event.type),
      assertMatches: () => {},
    });
    const paintsBefore = crew.swift.paints.length;
    crew.server.setCurrentClimb({ item: null, clientId: phone.clientId, correlationId: 'clear' });

    expect(received).toEqual(['FullSync']);
    const stored = crew.server.view();
    expect(uuidsOf(stored.queue)).toEqual(uuidsOf(upNext));
    expect(stored.currentClimbQueueItem).toBeNull();
    expect(stored.historyCount).toBe(0);
    expect(crew.swift.paints.length).toBe(paintsBefore);
    expect(crew.swift.state.currentIndex).toBe(0);

    // What the trailing event would have done: repaint from the FullSync's index 0.
    const relit = swiftApply({ kind: 'currentClimbChanged', item: null, sequence: stored.sequence }, crew.swift.state);
    expect(relit.items[relit.currentIndex].uuid).toBe(upNext[0].uuid);
    expect(swiftShouldRepaintBoard({ kind: 'currentClimbChanged', item: null, sequence: stored.sequence })).toBe(true);
  });
});

describe('the simulation’s own guard', () => {
  it('catches a pointer event for a reshape', () => {
    // Publish a pointer event for a dedupe and the frozen reducer inserts the
    // fresh uuid instead of reusing C.
    const itemA: ClimbQueueItem = { uuid: 'A', climb: makeClimb(1, 40, undefined) };
    const itemB: ClimbQueueItem = { uuid: 'B', climb: makeClimb(2, 40, undefined) };
    const itemC: ClimbQueueItem = { uuid: 'C', climb: makeClimb(3, 40, undefined) };
    const freshC: ClimbQueueItem = { uuid: 'C-prime', climb: makeClimb(3, 40, undefined) };
    const before = { queue: [itemA, itemB, itemC], currentClimbQueueItem: itemB, historyCount: 1 };
    const placed = placeOnWall(before, freshC, undefined, true);
    expect(chooseQueueEvent(before, { item: freshC, shouldAddToQueue: true }, placed)).toBe('fullsync+trailing');

    const mapping = legacyMapQueueEventToAction({ __typename: 'CurrentClimbChanged', currentItem: freshC });
    if (mapping.kind !== 'dispatch') throw new Error('expected a dispatch');
    const legacy = legacyQueueReducer(
      { queue: [itemA, itemB, itemC], currentClimbQueueItem: itemB, pendingCurrentClimbUpdates: [] },
      mapping.action,
    );
    expect(uuidsOf(legacy.queue)).toEqual(['A', 'B', 'C-prime', 'C']);
    expect(uuidsOf(placed.queue)).toEqual(['A', 'B', 'C']);
  });

  it('a lock-screen Previous after a clear lights the climb it named, not Up next[0]', () => {
    // Swift ignores CurrentClimbChanged(null) and keeps the cleared climb's
    // index, so its Previous from History [A B] names queue[0] = A with no
    // shouldAddToQueue. That must not be read as an old phone's Next.
    const [itemA, itemB, itemC, itemD] = ['A', 'B', 'C', 'D'].map((uuid, index) => ({
      uuid,
      climb: makeClimb(index + 1, 40, undefined),
    }));
    const queue = [itemA, itemB, itemC, itemD];
    const onB: SwiftQueueState = { items: queue.map(toSwiftQueueItem), currentIndex: 1 };
    const afterClear = swiftApply({ kind: 'currentClimbChanged', item: null, sequence: 2 }, onB);
    expect(afterClear.currentIndex).toBe(1);

    const named = queue[afterClear.currentIndex - 1];
    const before = { queue, currentClimbQueueItem: null, historyCount: 2 };
    const placed = placeOnWall(before, named);
    expect(placed.currentClimbQueueItem?.uuid).toBe('A');
    expect(placed.rewrite).toBe('move-history');
    expect(chooseQueueEvent(before, { item: named }, placed)).toBe('fullsync+trailing');
  });

  it('a stale CurrentClimbChanged at the same sequence as its FullSync is dropped by JS and applied by Swift', () => {
    expect(legacyEvaluateQueueEventSequence(7, 7)).toBe('ignore-stale');
    expect(swiftSequenceDecision({ kind: 'currentClimbChanged', item: null, sequence: 7 }, 7)).toEqual({
      kind: 'apply',
      newLastSequence: 7,
    });
  });
});
