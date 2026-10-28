/**
 * Next and Previous in now-slot mode (F3), replayed the way the mobile queue
 * provider runs them: the selectors pick a target, a playlist peek is minted
 * into a fresh queue item, the track learns its `resume`, the provider
 * resolves the open with `placeOnWall`, and the reducer (and, in a session,
 * the server) places the resolved entry again.
 *
 * A tester on F3 (26 Oct) reported Next going back to the climb he had just
 * logged, and Next off a search list pulling up a History entry from an hour
 * earlier, after which every Next replayed old History entries.
 */
import { describe, it, expect } from 'vitest';
import type {
  Climb,
  ClimbQueue,
  ClimbQueueItem,
  CurrentClimbPlacement,
  HistoryCopyRule,
  NowSlotRewrite,
  PlaylistSuggestionSource,
  PlaylistTrackResume,
} from '@boardsesh/queue';
import {
  appendPlaylistTrackPage,
  capHistory,
  createPlaylistSuggestionSource,
  findPlaylistClimbIndex,
  historyCopyRuleFor,
  historyLine,
  isPlaylistPeekQueueItemUuid,
  placeOnWall,
  playlistSuggestionSourceMatches,
  samePlaylistTrackResume,
  upNextStart,
  withPlaylistTrackResume,
} from '@boardsesh/queue';
import {
  anchoredSuggestionSource,
  resolveTrackListClimbUuid,
  resolveTrackPosition,
  selectNextQueueItemWithSuggestions,
  selectPreviousQueueItemWithSuggestions,
} from '../queue-navigation';

const BOARD_KEY = 'moonboard:1:1:1';
const PAGE_SIZE = 3;

function makeClimb(uuid: string): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: 'p1r12',
    setter_username: 'setter',
    angle: 40,
    ascensionist_count: 0,
    difficulty: '6a/V3',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
  };
}

/** A list the climber can open: its climbs in order, loaded a page at a time. */
type ClimbList = { id: string; climbs: Climb[] };

/** The provider state navigation reads, solo. */
type Session = {
  queue: ClimbQueue;
  current: ClimbQueueItem | null;
  historyCount: number;
  /** The track the provider holds (`rawPlaylistSuggestionSource`). */
  held: PlaylistSuggestionSource | null;
  /** The list the held track came from, and how much of it is loaded. */
  list: ClimbList | null;
  loaded: number;
  mintedCount: number;
};

/** What one step did. */
type Step = {
  action: string;
  from: ClimbQueueItem | null;
  to: ClimbQueueItem | null;
  rewrite: NowSlotRewrite;
  /** Where the entry now on the wall sat before the step, -1 for a fresh one. */
  landedIndexBefore: number;
  lineBefore: number;
};

function emptySession(): Session {
  return { queue: [], current: null, historyCount: 0, held: null, list: null, loaded: 0, mintedCount: 0 };
}

function mint(session: Session, climb: Climb, suggested: boolean): ClimbQueueItem {
  session.mintedCount += 1;
  return { uuid: `q${session.mintedCount}`, climb, ...(suggested ? { suggested: true } : {}) };
}

function navigationSource(session: Session): PlaylistSuggestionSource | null {
  return anchoredSuggestionSource(session.held, session.current);
}

/** `storeTrackResume` in queue-provider.tsx. */
function storeTrackResume(
  session: Session,
  walked: PlaylistSuggestionSource | null,
  trackResume: PlaylistTrackResume | null | undefined,
): void {
  if (trackResume === undefined || !walked) return;
  if (samePlaylistTrackResume(walked.resume, trackResume)) return;
  if (session.held && playlistSuggestionSourceMatches(session.held, walked)) {
    session.held = withPlaylistTrackResume(session.held, trackResume);
  }
}

/**
 * `dispatchSetCurrent` in now-slot mode, solo. The provider resolves the open
 * with `historyCopy`; the reducer, and in a session the server, place the
 * resolved entry with the rule for a request that carries `placement`. Both
 * must land on the same queue, or a crew's phones drift.
 */
function place(
  session: Session,
  action: string,
  item: ClimbQueueItem,
  placement: CurrentClimbPlacement,
  historyCopy: HistoryCopyRule,
): Step {
  const before = { queue: session.queue, currentClimbQueueItem: session.current, historyCount: session.historyCount };
  const resolved = placeOnWall(before, item, placement, undefined, historyCopy);
  const resolvedItem = resolved.currentClimbQueueItem ?? item;
  const stored = placeOnWall(before, resolvedItem, placement, false, historyCopyRuleFor(placement));
  expect(stored.queue.map(({ uuid }) => uuid)).toEqual(resolved.queue.map(({ uuid }) => uuid));
  const capped = capHistory(stored);
  session.queue = capped.queue;
  session.current = capped.currentClimbQueueItem;
  session.historyCount = capped.historyCount;
  return {
    action,
    from: before.currentClimbQueueItem,
    to: session.current,
    rewrite: resolved.rewrite,
    landedIndexBefore: before.queue.findIndex(({ uuid }) => uuid === resolvedItem.uuid),
    lineBefore: historyLine(before),
  };
}

/** A list row tap with Light on tap: Play from the list (`use-playlist-activation`). */
function tapListRow(session: Session, list: ClimbList, index: number): Step | null {
  const loaded = session.list?.id === list.id ? session.loaded : Math.min(PAGE_SIZE, list.climbs.length);
  const loadedClimbs = list.climbs.slice(0, loaded);
  const climb = loadedClimbs[index];
  if (!climb) return null;
  session.list = list;
  session.loaded = loaded;
  session.held = createPlaylistSuggestionSource({
    playlistUuid: list.id,
    activatedClimb: climb,
    climbs: loadedClimbs,
    boardKey: BOARD_KEY,
    ...(loaded < list.climbs.length ? { continuation: { loaderId: list.id, nextPage: 1 } } : {}),
  });
  // Re-tapping the climb on the wall only points the track at this list.
  if (session.current?.climb.uuid === climb.uuid) return null;
  return place(session, `tap ${list.id}[${index}]`, mint(session, climb, true), 'NOW', 'reuse');
}

/** The track pages in the next page of its list (`use-track-paging`). */
function loadNextPage(session: Session): string | null {
  const { held, list } = session;
  if (!held || !list || held.playlistUuid !== list.id || session.loaded >= list.climbs.length) return null;
  const page = session.loaded / PAGE_SIZE;
  const climbs = list.climbs.slice(session.loaded, session.loaded + PAGE_SIZE);
  session.loaded += climbs.length;
  session.held = appendPlaylistTrackPage(held, {
    page,
    pageSize: PAGE_SIZE,
    climbs,
    filteredOut: false,
    nextPage: session.loaded < list.climbs.length ? page + 1 : null,
  });
  return `page ${list.id} to ${session.loaded}`;
}

/** `nextClimb` in queue-provider.tsx: a forward step puts up a fresh copy over History. */
function next(session: Session): Step | null {
  const walked = navigationSource(session);
  const selection = selectNextQueueItemWithSuggestions(
    session.queue,
    session.current,
    walked,
    undefined,
    undefined,
    undefined,
    session.historyCount,
  );
  if (!selection.item) return null;
  const item = isPlaylistPeekQueueItemUuid(selection.item.uuid)
    ? mint(session, selection.item.climb, true)
    : selection.item;
  storeTrackResume(session, walked, selection.trackResume);
  return place(session, 'next', item, 'NOW', 'fresh');
}

/** `previousClimb` in queue-provider.tsx. */
function previous(session: Session): Step | null {
  const walked = navigationSource(session);
  const { item: target, trackResume } = selectPreviousQueueItemWithSuggestions(
    session.queue,
    session.current,
    walked,
    undefined,
    undefined,
    undefined,
    session.historyCount,
  );
  if (!target) return null;
  const item = isPlaylistPeekQueueItemUuid(target.uuid) ? mint(session, target.climb, true) : target;
  storeTrackResume(session, walked, trackResume);
  const onTrack =
    walked !== null &&
    session.current?.climb?.uuid !== undefined &&
    findPlaylistClimbIndex(walked, session.current.climb.uuid) >= 0;
  return place(session, 'previous', item, onTrack ? 'NOW' : 'STEP', 'reuse');
}

/** "Start playlist" or Play last: the list goes into Up next as queued climbs, unflagged. */
function loadIntoQueue(session: Session, list: ClimbList): void {
  const start = upNextStart(session.queue, session.current, session.historyCount);
  const entries = list.climbs.map((climb) => mint(session, climb, false));
  session.queue = [...session.queue.slice(0, start), ...entries, ...session.queue.slice(start)];
}

/** Play next: one queued climb at the head of Up next, unflagged. */
function playNext(session: Session, climb: Climb): void {
  const start = upNextStart(session.queue, session.current, session.historyCount);
  session.queue = [...session.queue.slice(0, start), mint(session, climb, false), ...session.queue.slice(start)];
}

/** The list's next climb from `item`: the climb after the list climb the walk is at. */
function listSuccessorUuid(session: Session, item: ClimbQueueItem): string | undefined {
  const walked = anchoredSuggestionSource(session.held, item);
  const listClimbUuid = resolveTrackListClimbUuid(resolveTrackPosition(session.queue, item, walked), walked);
  if (!walked || !listClimbUuid) return undefined;
  return walked.climbs[findPlaylistClimbIndex(walked, listClimbUuid) + 1]?.uuid;
}

function upNextClimbUuids(session: Session): Set<string> {
  const start = upNextStart(session.queue, session.current, session.historyCount);
  return new Set(session.queue.slice(start).map(({ climb }) => climb.uuid));
}

/**
 * The invariants a forward step keeps:
 *
 * 1. Next never pulls a History entry forward. The one exception is the entry
 *    right behind the current climb when it holds the list's next climb: that
 *    is Previous then Next on a list, and reusing it keeps the back-and-forth
 *    from adding a copy per swipe. A climb further back in History goes up as a
 *    fresh copy and its History entry stays put.
 * 2. Next never lands on the climb that was current before the last Next (A,
 *    Next to B, Next back to A) unless A really is next: queued in Up next, or
 *    the list's next climb.
 */
function checkedNext(session: Session, previousStep: Step | null): { step: Step | null; violation: string | null } {
  const upNextBefore = upNextClimbUuids(session);
  const successorBefore = session.current ? listSuccessorUuid(session, session.current) : undefined;
  const step = next(session);
  if (!step) return { step, violation: null };
  const landedClimbUuid = step.to?.climb.uuid;
  const inHistory = step.landedIndexBefore >= 0 && step.landedIndexBefore < step.lineBefore;
  const isListNeighbourBehind = step.landedIndexBefore === step.lineBefore - 1 && landedClimbUuid === successorBefore;
  if (inHistory && !isListNeighbourBehind) {
    return {
      step,
      violation: `Next pulled History entry ${step.to?.uuid} forward (index ${step.landedIndexBefore}, line ${step.lineBefore}, ${step.rewrite})`,
    };
  }
  const leftClimbUuid = previousStep?.action === 'next' ? previousStep.from?.climb.uuid : undefined;
  if (
    leftClimbUuid !== undefined &&
    landedClimbUuid === leftClimbUuid &&
    !upNextBefore.has(leftClimbUuid) &&
    successorBefore !== leftClimbUuid
  ) {
    return { step, violation: `Next went back to ${leftClimbUuid}, the climb current before the last Next` };
  }
  return { step, violation: null };
}

/**
 * Two `nextClimb` calls against one snapshot: the provider reads its refs at
 * gesture time, and a held swipe can fire twice before the first commits. The
 * second must not move the wall again.
 */
function doubleNext(session: Session, previousStep: Step | null): { step: Step | null; violation: string | null } {
  const walked = navigationSource(session);
  const stale = selectNextQueueItemWithSuggestions(
    session.queue,
    session.current,
    walked,
    undefined,
    undefined,
    undefined,
    session.historyCount,
  );
  const first = checkedNext(session, previousStep);
  if (!first.step || first.violation || !stale.item) return first;
  const item = isPlaylistPeekQueueItemUuid(stale.item.uuid) ? mint(session, stale.item.climb, true) : stale.item;
  storeTrackResume(session, walked, stale.trackResume);
  const second = place(session, 'next', item, 'NOW', 'fresh');
  return {
    step: second,
    violation: second.to?.uuid === first.step.to?.uuid ? null : `a held Next moved on to ${second.to?.uuid}`,
  };
}

function expectConsistent(session: Session, trace: string[]): void {
  const uuids = session.queue.map(({ uuid }) => uuid);
  expect(new Set(uuids).size, trace.join('\n')).toBe(uuids.length);
  if (session.current) expect(session.queue.indexOf(session.current), trace.join('\n')).toBe(session.historyCount);
}

/** mulberry32: a small seeded PRNG, so a red seed replays exactly. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** A small pool, so lists overlap and History keeps holding climbs a new list offers again. */
const POOL = Array.from({ length: 14 }, (_, index) => makeClimb(`c${index}`));

function shuffledList(random: () => number, id: string, length: number): ClimbList {
  const pool = [...POOL];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }
  return { id, climbs: pool.slice(0, length) };
}

const climbsOf = (list: ClimbList) => list.climbs.map(({ uuid }) => uuid).join(' ');

describe("now-slot Next and Previous over a tester's session (26 Oct)", () => {
  const playlist: ClimbList = { id: 'playlist', climbs: ['p0', 'p1', 'p2', 'p3'].map(makeClimb) };

  it('Next off a search list onto a climb History holds puts up a fresh copy and leaves History alone', () => {
    const session = emptySession();
    // A playlist start: its climbs sit in Up next, and the tap dedupes onto one.
    loadIntoQueue(session, playlist);
    expect(tapListRow(session, playlist, 0)?.rewrite).toBe('dedupe-up-next');
    expect(next(session)?.to?.climb.uuid).toBe('p1');
    expect(next(session)?.to?.climb.uuid).toBe('p2');
    expect(next(session)?.to?.climb.uuid).toBe('p3');
    const [p0Entry, p1Entry] = session.queue;
    // A search an hour later whose second page holds p0 and p1 again.
    const search: ClimbList = { id: 'search', climbs: ['s0', 's1', 's2', 'p0', 'p1', 's3'].map(makeClimb) };
    tapListRow(session, search, 1);
    expect(next(session)?.to?.climb.uuid).toBe('s2');
    loadNextPage(session);
    const historyBefore = session.queue.slice(0, session.historyCount + 1).map(({ uuid }) => uuid);

    const ontoP0 = next(session);
    expect(ontoP0?.to?.climb.uuid).toBe('p0');
    expect(ontoP0?.to?.uuid).not.toBe(p0Entry.uuid);
    expect(ontoP0?.rewrite).toBe('insert');
    expect(session.queue.slice(0, session.historyCount).map(({ uuid }) => uuid)).toEqual(historyBefore);

    // The next Next walks the list on, not the old playlist entries.
    const ontoP1 = next(session);
    expect(ontoP1?.to?.climb.uuid).toBe('p1');
    expect(ontoP1?.to?.uuid).not.toBe(p1Entry.uuid);
    expect(session.queue.slice(0, 2)).toEqual([p0Entry, p1Entry]);
  });

  it('a list tap on a climb History holds still reuses its History entry', () => {
    const session = emptySession();
    loadIntoQueue(session, playlist);
    tapListRow(session, playlist, 0);
    next(session);
    const p0Entry = session.queue[0];
    const search: ClimbList = { id: 'search', climbs: ['p0', 's1'].map(makeClimb) };
    const tap = tapListRow(session, search, 0);
    expect(tap?.rewrite).toBe('dedupe-history');
    expect(session.current).toBe(p0Entry);
  });

  it('Previous then Next on a list goes back to the climb ahead, reusing its entry', () => {
    const session = emptySession();
    const search: ClimbList = { id: 'search', climbs: ['a', 'b', 'c', 'd'].map(makeClimb) };
    tapListRow(session, search, 0);
    const ontoB = next(session);
    expect(ontoB?.to?.climb.uuid).toBe('b');
    expect(previous(session)?.to?.climb.uuid).toBe('a');
    const backToB = checkedNext(session, null);
    expect(backToB.violation).toBeNull();
    expect(backToB.step?.to).toBe(ontoB?.to);
    const onward = checkedNext(session, backToB.step);
    expect(onward.violation).toBeNull();
    expect(onward.step?.to?.climb.uuid).toBe('c');
  });

  it('keeps the forward-step invariants over seeded random walks', () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 300 && failures.length < 3; seed += 1) {
      const random = seededRandom(seed);
      const session = emptySession();
      let currentList = shuffledList(random, 'playlist', 6);
      loadIntoQueue(session, currentList);
      const trace = [`load ${currentList.id} [${climbsOf(currentList)}] into Up next`];
      let previousStep: Step | null = null;
      let searchCount = 0;
      for (let stepIndex = 0; stepIndex < 60; stepIndex += 1) {
        const roll = random();
        let step: Step | null = null;
        let violation: string | null = null;
        if (roll < 0.4) {
          ({ step, violation } = checkedNext(session, previousStep));
        } else if (roll < 0.43) {
          ({ step, violation } = doubleNext(session, previousStep));
        } else if (roll < 0.58) {
          step = previous(session);
        } else if (roll < 0.76) {
          const loadedRows = session.list?.id === currentList.id ? session.loaded : PAGE_SIZE;
          step = tapListRow(session, currentList, Math.floor(random() * loadedRows));
        } else if (roll < 0.86) {
          const paged = loadNextPage(session);
          if (paged) trace.push(paged);
          continue;
        } else if (roll < 0.92) {
          const queued = POOL[Math.floor(random() * POOL.length)];
          playNext(session, queued);
          trace.push(`play next ${queued.uuid}`);
          continue;
        } else {
          searchCount += 1;
          currentList = shuffledList(random, `search${searchCount}`, 7);
          trace.push(`new list ${currentList.id} [${climbsOf(currentList)}]`);
          continue;
        }
        if (!step) continue;
        trace.push(
          `${step.action}: ${step.from?.climb.uuid ?? '-'}/${step.from?.uuid ?? '-'} to ${step.to?.climb.uuid}/${step.to?.uuid} (${step.rewrite})`,
        );
        expectConsistent(session, trace);
        if (violation) {
          failures.push(`seed ${seed}: ${violation}\n  ${trace.join('\n  ')}`);
          break;
        }
        previousStep = step;
      }
    }
    expect(failures, failures.join('\n\n')).toEqual([]);
  });
});
