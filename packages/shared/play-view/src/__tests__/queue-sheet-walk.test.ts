import { describe, expect, it } from 'vitest';
import type { Climb, ClimbQueue, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import {
  createPlaylistSuggestionSource,
  isPlaylistPeekQueueItemUuid,
  placeOnWall,
  planPlayNext,
  upNextStart,
  withoutListWalkFlag,
  withPlaylistTrackResume,
} from '@boardsesh/queue';
import type { ActiveBoardForCompatibility } from '@boardsesh/board-config';
import {
  anchoredSuggestionSource,
  computeNavigationTargetsWithSuggestions,
  resolveNavigationSuggestionSource,
  resolvePreviewStepSource,
  selectNextQueueItemWithSuggestions,
} from '../queue-navigation';
import { resolveThenFromListItems } from '../queue-sheet-walk';

// The queue sheet's "Then from Projects" rows (Then-signposts, 2026-11-02) must
// be exactly the climbs swipes from the queue's current climb reach after Up
// next, in order. These tests hold the rows to two independent walks:
//
//  - the player's own look: the step a swipe outside a drive takes, built from
//    the same calls `use-play-navigation-model.ts` makes
//    (`resolveNavigationSuggestionSource`, `computeNavigationTargetsWithSuggestions`,
//    `resolvePreviewStepSource`), one swipe at a time;
//  - Next while driving: the queue provider's `nextClimb`, which commits each
//    step (`selectNextQueueItemWithSuggestions`, a peek minted into a fresh
//    entry, `placeOnWall` at the Now slot, the step's resume stored on the track).
//
// Every scenario also states its expected rows by hand, so a change that moved
// the rows and the walks together still fails here.

const KILTER: ActiveBoardForCompatibility = { boardName: 'kilter', layoutId: 1 };

function climb(uuid: string, board: { boardType?: string; layoutId?: number } = {}): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: '',
    setter_username: 'setter',
    angle: 40,
    ascensionist_count: 0,
    difficulty: '6a/V3',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
    ...board,
  } as Climb;
}

const LIST = ['s1', 's2', 's3', 's4', 's5', 's6'].map((uuid) => climb(uuid));
const [S1, S2, S3, S4, S5, S6] = LIST;

function entry(uuid: string, entryClimb: Climb, extra: Partial<ClimbQueueItem> = {}): ClimbQueueItem {
  return { uuid, climb: entryClimb, ...extra };
}

/** A list walk's own entry: a list tap or a committed swipe on it. */
function walked(uuid: string, entryClimb: Climb): ClimbQueueItem {
  return entry(uuid, entryClimb, { suggested: true });
}

function projects(activated: Climb, climbs: Climb[] = LIST): PlaylistSuggestionSource {
  return createPlaylistSuggestionSource({
    playlistUuid: 'projects',
    activatedClimb: activated,
    climbs,
    boardKey: 'kilter:1:10:1',
    label: 'Projects',
  });
}

type Scenario = {
  queue: ClimbQueue;
  current: ClimbQueueItem | null;
  source: PlaylistSuggestionSource | null;
  historyCount: number | null;
  activeConfig?: ActiveBoardForCompatibility;
};

const climbUuids = (items: readonly ClimbQueueItem[]) => items.map((item) => item.climb.uuid);

/** What the sheet lists under "Then from". */
function thenFrom({ queue, current, source, historyCount, activeConfig }: Scenario): string[] {
  return climbUuids(resolveThenFromListItems(queue, current, source, { activeConfig, historyCount }));
}

/** The queue entries the sheet lists under Now and Up next: from the History / Up next line on. */
function shownInQueueRows({ queue, current, historyCount }: Scenario): Set<string> {
  const line = upNextStart(queue, current, historyCount);
  return new Set(queue.slice(line).map((item) => item.uuid));
}

/**
 * Swipes outside a drive, as the player takes them: each lands on a preview
 * that carries the step's list (#7227), and the next swipe walks from it.
 */
function swipeLook(scenario: Scenario, maxSwipes = 40): ClimbQueueItem[] {
  const { queue, current, source, historyCount, activeConfig } = scenario;
  const reached: ClimbQueueItem[] = [];
  let previewItem: ClimbQueueItem | null = null;
  let previewSource: PlaylistSuggestionSource | null = null;
  for (let swipe = 0; swipe < maxSwipes; swipe += 1) {
    const displayed: ClimbQueueItem | null = previewItem ?? current;
    const navigationSource = resolveNavigationSuggestionSource({
      previewItem,
      previewSource,
      committedItem: current,
      committedSource: source,
    });
    const targets = computeNavigationTargetsWithSuggestions(
      queue,
      displayed,
      navigationSource,
      activeConfig,
      undefined,
      undefined,
      historyCount,
    );
    if (!targets.canNext || !targets.nextItem) break;
    previewSource = resolvePreviewStepSource(navigationSource, targets.nextTrackResume, {
      steppedOffQueueItemUuid: displayed?.uuid,
      offWall: previewItem === null,
    });
    previewItem = targets.nextItem;
    reached.push(previewItem);
  }
  return reached;
}

/**
 * Next while driving, as the queue provider's `nextClimb` takes it: every step
 * goes up, a list peek as a fresh entry at the Now slot.
 *
 * Always committed with the now-slot rule (`placeOnWall`), so a scenario with
 * `historyCount: null` still drives as now-slot mode does from the same queue:
 * a legacy-mode row holds the look and the sheet to each other, not legacy
 * mode's own commit (insert after current, the reducer's `SET_CURRENT_CLIMB`).
 * The queue provider's own suites drive legacy mode through the real reducer.
 */
function driveNext(scenario: Scenario, maxSteps = 40): string[] {
  const { activeConfig } = scenario;
  let state = {
    queue: scenario.queue,
    currentClimbQueueItem: scenario.current,
    historyCount: scenario.historyCount ?? 0,
  };
  let source = scenario.source;
  let fresh = 0;
  const reached: string[] = [];
  for (let step = 0; step < maxSteps; step += 1) {
    const walkedSource = anchoredSuggestionSource(source, state.currentClimbQueueItem);
    const { item, trackResume } = selectNextQueueItemWithSuggestions(
      state.queue,
      state.currentClimbQueueItem,
      walkedSource,
      activeConfig,
      undefined,
      undefined,
      state.historyCount,
    );
    if (!item) break;
    if (walkedSource && trackResume !== undefined) {
      source = withPlaylistTrackResume(walkedSource, trackResume, state.currentClimbQueueItem?.uuid);
    }
    fresh += 1;
    const committed = isPlaylistPeekQueueItemUuid(item.uuid)
      ? entry(`fresh-${fresh}`, item.climb, { suggested: true })
      : item;
    const placed = placeOnWall(state, committed, 'NOW', undefined, 'fresh');
    state = {
      queue: placed.queue,
      currentClimbQueueItem: placed.currentClimbQueueItem,
      historyCount: placed.historyCount ?? 0,
    };
    if (!state.currentClimbQueueItem) break;
    reached.push(state.currentClimbQueueItem.climb.uuid);
  }
  return reached;
}

/** The look's swipes split where the sheet splits them: queue rows first, then the rest. */
function splitLook(scenario: Scenario) {
  const shown = shownInQueueRows(scenario);
  const reached = swipeLook(scenario);
  const firstOffQueue = reached.findIndex((item) => !shown.has(item.uuid));
  const upNextPart = firstOffQueue < 0 ? reached : reached.slice(0, firstOffQueue);
  const listPart = firstOffQueue < 0 ? [] : reached.slice(firstOffQueue);
  return { upNextPart: climbUuids(upNextPart), listPart, reached: climbUuids(reached) };
}

/** Every parity claim at once: the rows are the look's list part, which follows all of Up next. */
function expectParity(scenario: Scenario, expected: { upNext: string[]; thenFrom: string[] }) {
  const { upNextPart, listPart, reached } = splitLook(scenario);
  expect(thenFrom(scenario)).toEqual(expected.thenFrom);
  expect(upNextPart).toEqual(expected.upNext);
  // After the walk leaves the queue rows it never comes back to one: the rows
  // under Then from are what is left once Up next is played.
  const shown = shownInQueueRows(scenario);
  expect(listPart.filter((item) => shown.has(item.uuid))).toEqual([]);
  expect(climbUuids(listPart)).toEqual(thenFrom(scenario));
  // Next while driving lands on the same climbs in the same order.
  expect(driveNext(scenario)).toEqual(reached);
}

describe('Then from rows: parity with the swipe walk', () => {
  it('Up next empty: the rest of the list after the current climb', () => {
    const current = walked('e-s3', S3);
    const scenario: Scenario = {
      queue: [walked('e-s1', S1), current],
      current,
      source: projects(S1),
      historyCount: 1,
    };
    expectParity(scenario, { upNext: [], thenFrom: ['s4', 's5', 's6'] });
  });

  it('Up next filled: every queued climb first, then the list picks up after the current climb', () => {
    const current = walked('e-s3', S3);
    const scenario: Scenario = {
      queue: [current, entry('u1', climb('x1')), entry('u2', climb('x2'))],
      current,
      source: projects(S1),
      historyCount: 0,
    };
    expectParity(scenario, { upNext: ['x1', 'x2'], thenFrom: ['s4', 's5', 's6'] });
  });

  it('list resumed after Up next: playing Up next in the middle of the list, the list picks up where it left', () => {
    const left = walked('e-s3', S3);
    const current = entry('u1', climb('x1'));
    const source = withPlaylistTrackResume(projects(S1), { climbUuid: 's3', queueItemUuid: 'e-s3' });
    const scenario: Scenario = {
      queue: [left, current, entry('u2', climb('x2'))],
      current,
      source,
      historyCount: 1,
    };
    expectParity(scenario, { upNext: ['x2'], thenFrom: ['s4', 's5', 's6'] });
  });

  it('a list loaded into Up next carries on there, and Then from starts past its last queued climb', () => {
    const current = entry('e-s3', S3);
    const scenario: Scenario = {
      queue: [current, entry('q-s4', S4), entry('q-s5', S5), entry('u1', climb('x1'))],
      current,
      source: projects(S1),
      historyCount: 0,
    };
    expectParity(scenario, { upNext: ['s4', 's5', 'x1'], thenFrom: ['s6'] });
  });

  it('lists a list climb History still holds, because a swipe goes there', () => {
    const current = walked('e-s3', S3);
    const scenario: Scenario = {
      queue: [entry('old-s5', S5), walked('e-s1', S1), current, entry('u1', climb('x1'))],
      current,
      source: projects(S1),
      historyCount: 2,
    };
    expectParity(scenario, { upNext: ['x1'], thenFrom: ['s4', 's5', 's6'] });
  });

  it("after Previous: Next goes back to the list's next climb in History, so it is listed", () => {
    // Previous from s4 put s3 up right after it: the queue reads s4, s3, and
    // the next swipe lands on that s4 entry rather than minting a copy.
    const current = walked('e-s3', S3);
    const back = walked('e-s4', S4);
    const scenario: Scenario = {
      queue: [walked('e-s1', S1), back, current],
      current,
      source: projects(S1),
      historyCount: 2,
    };
    expectParity(scenario, { upNext: [], thenFrom: ['s4', 's5', 's6'] });
    expect(resolveThenFromListItems(scenario.queue, current, scenario.source)[0]).toBe(back);
  });

  it('lists a climb queued on purpose again where the list reaches it, as a swipe goes there twice', () => {
    const current = walked('e-s3', S3);
    const scenario: Scenario = {
      queue: [current, entry('u1', climb('x1')), entry('q-s5', S5)],
      current,
      source: projects(S1),
      historyCount: 0,
    };
    expectParity(scenario, { upNext: ['x1', 's5'], thenFrom: ['s4', 's5', 's6'] });
  });

  it('workout: its queued climbs play as Up next, then the list', () => {
    const current = walked('e-s2', S2);
    const workout = ['w1', 'w2', 'w3'].map((uuid) => walked(`q-${uuid}`, climb(uuid)));
    const scenario: Scenario = {
      queue: [current, ...workout],
      current,
      source: projects(S1),
      historyCount: 0,
    };
    expectParity(scenario, { upNext: ['w1', 'w2', 'w3'], thenFrom: ['s3', 's4', 's5', 's6'] });
  });

  it('workout with no list: nothing comes after it', () => {
    const current = walked('q-w1', climb('w1'));
    const scenario: Scenario = {
      queue: [current, walked('q-w2', climb('w2')), walked('q-w3', climb('w3'))],
      current,
      source: null,
      historyCount: 0,
    };
    expectParity(scenario, { upNext: ['w2', 'w3'], thenFrom: [] });
  });

  it("crew: the room's Up next first, then the climber's own list", () => {
    const peer = { id: 'peer', username: 'peer', avatarUrl: null };
    const current = walked('e-s2', S2);
    const scenario: Scenario = {
      queue: [
        current,
        entry('c1', climb('x1'), { addedBy: peer.id, addedByUser: peer }),
        entry('c2', climb('x2'), { addedBy: peer.id, addedByUser: peer }),
      ],
      current,
      source: projects(S1),
      historyCount: 0,
    };
    expectParity(scenario, { upNext: ['x1', 'x2'], thenFrom: ['s3', 's4', 's5', 's6'] });
  });

  it("crew: a crewmate's put-up off the climber's list leaves no Then from", () => {
    const peer = { id: 'peer', username: 'peer', avatarUrl: null };
    const current = entry('c0', climb('x0'), { addedBy: peer.id, addedByUser: peer });
    // The provider only walks a track that still anchors the current climb.
    const source = anchoredSuggestionSource(projects(S1), current);
    const scenario: Scenario = {
      queue: [walked('e-s2', S2), current, entry('c1', climb('x1'), { addedBy: peer.id, addedByUser: peer })],
      current,
      source,
      historyCount: 1,
    };
    expect(source).toBeNull();
    expectParity(scenario, { upNext: ['x1'], thenFrom: [] });
  });

  it('a queued climb this wall cannot draw stays in Up next and the walk goes past it, as a swipe does', () => {
    const current = walked('e-s4', S4);
    const scenario: Scenario = {
      queue: [current, entry('u1', climb('x1', { boardType: 'tension', layoutId: 9 })), entry('u2', climb('x2'))],
      current,
      source: projects(S1),
      historyCount: 0,
      activeConfig: KILTER,
    };
    expectParity(scenario, { upNext: ['x2'], thenFrom: ['s5', 's6'] });
  });

  it('nothing current and Up next played: the list from the climb it was activated on', () => {
    const scenario: Scenario = {
      queue: [walked('e-s1', S1), walked('e-s2', S2)],
      current: null,
      source: projects(S2),
      historyCount: 2,
    };
    expectParity(scenario, { upNext: [], thenFrom: ['s3', 's4', 's5', 's6'] });
  });

  it('the last climb of the list has nothing after it', () => {
    const current = walked('e-s6', S6);
    const scenario: Scenario = { queue: [current], current, source: projects(S1), historyCount: 0 };
    expectParity(scenario, { upNext: [], thenFrom: [] });
  });

  // Issue #7247: Play next on a climb History holds from a walk down this same
  // list. The sheet lists it under Up next; swipes walked past it as a list
  // climb, because the move kept the walk's flag. Built through the real Play
  // next plan, committed as the provider commits it, in both modes, with the
  // climb walked twice so History still holds a copy after the move.
  describe.each([
    { mode: 'now-slot', lineOf: (queue: ClimbQueue, current: ClimbQueueItem): number | null => queue.indexOf(current) },
    { mode: 'legacy', lineOf: (): number | null => null },
  ])('Play next on a climb History holds from this list ($mode)', ({ lineOf }) => {
    /** Play next by climb, committed as the queue provider commits each plan. */
    function afterPlayNext(queue: ClimbQueue, current: ClimbQueueItem, target: Climb): Scenario {
      const plan = planPlayNext(queue, current, { climbUuid: target.uuid }, lineOf(queue, current));
      const dropFlag = (entries: ClimbQueue, uuid: string) =>
        entries.map((item) => (item.uuid === uuid ? withoutListWalkFlag(item) : item));
      let next: ClimbQueue;
      if (plan.kind === 'replace') next = plan.queue;
      else if (plan.kind === 'unflag') next = dropFlag(queue, plan.uuid);
      else if (plan.kind === 'move') {
        // One reorder, a splice out and back in, and the flag dropped by uuid.
        next = [...queue];
        const [moved] = next.splice(plan.oldIndex, 1);
        next.splice(plan.newIndex, 0, moved);
        if (plan.dropListWalkFlag) next = dropFlag(next, plan.uuid);
      } else throw new Error(`Play next planned ${plan.kind}`);
      return { queue: next, current, source: projects(S1), historyCount: lineOf(next, current) };
    }

    it('Up next plays it first, then the list after the climb on the wall, with a copy still in History', () => {
      const current = walked('e-s4', S4);
      const history = [walked('e-s2', S2), walked('e-s1', S1), walked('e-s2-again', S2), walked('e-s3', S3)];
      const scenario = afterPlayNext([...history, current], current, S2);
      expect(scenario.queue.filter((item) => item.climb.uuid === 's2')).toHaveLength(2);
      expectParity(scenario, { upNext: ['s2'], thenFrom: ['s5', 's6'] });
    });

    // The climb on the wall slides down one as the walked climb leaves History,
    // so it lands ahead of the Up next already queued, never behind it.
    it('goes ahead of the Up next already queued', () => {
      const current = walked('e-s4', S4);
      const history = [walked('e-s2', S2), walked('e-s1', S1), walked('e-s3', S3)];
      const scenario = afterPlayNext([...history, current, entry('u1', climb('x1'))], current, S2);
      expectParity(scenario, { upNext: ['s2', 'x1'], thenFrom: ['s5', 's6'] });
    });

    it('a climb further on the list plays as Up next, and the list still reaches it again', () => {
      const current = walked('e-s2', S2);
      const history = [walked('e-s4', S4), walked('e-s1', S1)];
      const scenario = afterPlayNext([...history, current], current, S4);
      expectParity(scenario, { upNext: ['s4'], thenFrom: ['s3', 's4', 's5', 's6'] });
    });

    it("mends the walked climb an older build moved into Up next with the walk's flag", () => {
      const current = walked('e-s4', S4);
      const stale = [walked('e-s1', S1), current, walked('e-s2', S2)];
      // As 2.7.0 left it: the walk passes the climb the sheet lists under Up next.
      const staleScenario: Scenario = {
        queue: stale,
        current,
        source: projects(S1),
        historyCount: lineOf(stale, current),
      };
      expect(swipeLook(staleScenario)[0]).not.toBe(stale[2]);
      expectParity(afterPlayNext(stale, current, S2), { upNext: ['s2'], thenFrom: ['s5', 's6'] });
    });
  });

  it('no list: the walk never leaves the queue', () => {
    const current = entry('cur', climb('x0'));
    const scenario: Scenario = {
      queue: [current, entry('u1', climb('x1'))],
      current,
      source: null,
      historyCount: 0,
    };
    expectParity(scenario, { upNext: ['x1'], thenFrom: [] });
  });
});
