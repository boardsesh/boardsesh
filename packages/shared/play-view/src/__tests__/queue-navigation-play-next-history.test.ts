/**
 * Issue #7247: Play next on a climb History already holds, while the climber
 * walks a list. The owner's report from 2.7.0: Now was "Debaser 8x12", 13 of
 * Search results' 11,312; MacroDre was row 41, the head of Up next, and also
 * in History, because the climber had walked it from the same results earlier.
 * The queue sheet listed MacroDre under Up next and "Then from Search results"
 * after it, while every swipe walked Search results and never reached it, and
 * the top bar never said "Up next first · 1 climb".
 *
 * Play next on a climb History holds moves that History entry to the head of
 * Up next (`planPlayNext`). A climb walked from a list carries the walk's
 * `suggested` flag, and the walk reads a flagged climb on its own list as the
 * list itself, never as Up next (#6777). The move kept the flag, so the climb
 * the climber queued on purpose was walked past. These tests replay the
 * owner's queue through the real Play next plan, in now-slot mode and in
 * legacy mode.
 */
import { describe, expect, it } from 'vitest';
import type { Climb, ClimbQueue, ClimbQueueItem } from '@boardsesh/queue';
import {
  createPlaylistSuggestionSource,
  getPlaylistPeekQueueItemUuid,
  planPlayNext,
  upNextStart,
  withoutListWalkFlag,
  withPlaylistTrackResume,
} from '@boardsesh/queue';
import {
  computeNavigationTargetsWithSuggestions,
  countUpNextBeforeList,
  findUpcomingQueueItemsWithSuggestions,
  prepareQueueNavigation,
  resolveStepTrack,
  resolveTrackPosition,
  resolveUpNextProgress,
  selectNextQueueItemWithSuggestions,
  selectPreviousQueueItemWithSuggestions,
  stepCrossesIntoList,
  upNextHandsBackToList,
} from '../queue-navigation';
import { resolveThenFromListItems } from '../queue-sheet-walk';

function climb(uuid: string): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: `p${uuid}r12`,
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

// Search results: 20 loaded climbs. MacroDre is the 5th, Debaser the 13th.
const RESULTS = Array.from({ length: 20 }, (_, index) => climb(`r${index + 1}`));
const MACRO_DRE = RESULTS[4];
const DEBASER = RESULTS[12];
const SEARCH = createPlaylistSuggestionSource({
  playlistUuid: 'search',
  activatedClimb: RESULTS[0],
  climbs: RESULTS,
  boardKey: 'kilter:1:10:1',
  label: 'Search results',
  total: 11312,
});

/** A list walk's own entry: a list tap or a committed swipe on Search results. */
function walked(uuid: string, walkedClimb: Climb): ClimbQueueItem {
  return { uuid, climb: walkedClimb, suggested: true };
}

/**
 * The owner's queue before Play next: 40 climbs of History (an older session
 * off another list, then two passes down Search results that both reached
 * MacroDre), and Debaser on the wall.
 */
function ownersQueue(): { queue: ClimbQueue; current: ClimbQueueItem } {
  const olderSession = Array.from({ length: 22 }, (_, index) => ({
    uuid: `old-${index}`,
    climb: climb(`other-${index}`),
  }));
  const firstPass = RESULTS.slice(0, 12).map((resultClimb) => walked(`first-${resultClimb.uuid}`, resultClimb));
  const secondPass = RESULTS.slice(4, 10).map((resultClimb) => walked(`second-${resultClimb.uuid}`, resultClimb));
  const current = walked('now-debaser', DEBASER);
  return { queue: [...olderSession, ...firstPass, ...secondPass, current], current };
}

/**
 * Play next on MacroDre from a list row (by climb, so the plan picks the queue
 * entry), committed the way the queue provider commits each plan: a `move` is
 * one reorder, which the reducer and the resolver apply as a splice, plus the
 * flag dropped by uuid when the plan says so; an `unflag` is that drop alone;
 * a `replace` is the plan's queue in one write.
 */
function playNextMacroDre(queue: ClimbQueue, current: ClimbQueueItem, historyCount: number | null): ClimbQueue {
  const plan = planPlayNext(queue, current, { climbUuid: MACRO_DRE.uuid }, historyCount);
  const dropFlag = (entries: ClimbQueue, uuid: string) =>
    entries.map((item) => (item.uuid === uuid ? withoutListWalkFlag(item) : item));
  if (plan.kind === 'replace') return plan.queue;
  if (plan.kind === 'unflag') return dropFlag(queue, plan.uuid);
  if (plan.kind === 'move') {
    const next = [...queue];
    const [moved] = next.splice(plan.oldIndex, 1);
    next.splice(plan.newIndex, 0, moved);
    return plan.dropListWalkFlag ? dropFlag(next, plan.uuid) : next;
  }
  throw new Error(`Play next MacroDre planned ${plan.kind}`);
}

const MODES = [
  // Now-slot mode resolves the line at the current climb's index.
  { mode: 'now-slot', historyCountOf: (queue: ClimbQueue, current: ClimbQueueItem) => queue.indexOf(current) },
  // Legacy mode never reads a line.
  { mode: 'legacy', historyCountOf: () => null },
] as const;

describe.each(MODES)(
  'Play next on a climb History holds, while walking a list ($mode, #7247)',
  ({ historyCountOf }) => {
    function setUp() {
      const { queue: before, current } = ownersQueue();
      const queue = playNextMacroDre(before, current, historyCountOf(before, current));
      const historyCount = historyCountOf(queue, current);
      const prepared = prepareQueueNavigation(queue);
      const line = upNextStart(queue, current, historyCount);
      const upNextEntry = queue[line];
      return { queue, current, historyCount, prepared, line, upNextEntry };
    }

    it("is the owner's shape: MacroDre heads Up next at row 41, and History still holds it", () => {
      const { queue, current, line, upNextEntry } = setUp();
      expect(queue.indexOf(current)).toBe(39);
      expect(line).toBe(40);
      expect(upNextEntry.climb.uuid).toBe(MACRO_DRE.uuid);
      expect(queue.slice(0, 39).some((item) => item.climb.uuid === MACRO_DRE.uuid)).toBe(true);
    });

    it('swipes from the climb on the wall play MacroDre first, then pick Search results up after Debaser', () => {
      const { queue, current, historyCount, prepared, upNextEntry } = setUp();
      const selection = selectNextQueueItemWithSuggestions(
        queue,
        current,
        SEARCH,
        undefined,
        undefined,
        prepared,
        historyCount,
      );
      expect(selection.item).toBe(upNextEntry);
      expect(selection.trackResume).toEqual({ climbUuid: DEBASER.uuid, queueItemUuid: current.uuid });

      const walk = findUpcomingQueueItemsWithSuggestions(
        queue,
        current,
        SEARCH,
        4,
        undefined,
        undefined,
        prepared,
        historyCount,
      );
      expect(walk.map((item) => item.uuid)).toEqual([
        upNextEntry.uuid,
        getPlaylistPeekQueueItemUuid('r14'),
        getPlaylistPeekQueueItemUuid('r15'),
        getPlaylistPeekQueueItemUuid('r16'),
      ]);
    });

    it('the then-signposts say "Up next first · 1 climb": Next steps into Up next', () => {
      const { queue, current, historyCount, prepared } = setUp();
      const position = resolveTrackPosition(queue, current, SEARCH, prepared);
      expect(position).toEqual({ kind: 'list', trackIndex: 12 });
      const targets = computeNavigationTargetsWithSuggestions(
        queue,
        current,
        SEARCH,
        undefined,
        undefined,
        prepared,
        historyCount,
      );
      expect(resolveStepTrack(position, targets.nextTrackResume)).toBe('upNext');
      expect(stepCrossesIntoList(position, targets.nextTrackResume)).toBe(false);
      expect(countUpNextBeforeList(queue, current, SEARCH, prepared)).toBe(1);
    });

    it('agrees with the queue sheet: Up next is MacroDre, then from Search results is the list after Debaser', () => {
      const { queue, current, historyCount, line, upNextEntry } = setUp();
      // The sheet's Up next rows: every queue entry from the line on, after Now.
      const sheetUpNext = queue.slice(line);
      expect(sheetUpNext).toEqual([upNextEntry]);
      expect(resolveThenFromListItems(queue, current, SEARCH, { historyCount }).map((item) => item.climb.uuid)).toEqual(
        RESULTS.slice(13).map((resultClimb) => resultClimb.uuid),
      );
    });

    it('on MacroDre the top bar reads "Up next · 1 of 1 · then Search results", and Next picks the list up at 14', () => {
      const { queue, current, prepared, upNextEntry } = setUp();
      const walking = withPlaylistTrackResume(SEARCH, { climbUuid: DEBASER.uuid, queueItemUuid: current.uuid });
      const position = resolveTrackPosition(queue, upNextEntry, walking, prepared);
      expect(position).toMatchObject({ kind: 'upNext', resumeIndex: 12 });
      expect(resolveUpNextProgress(queue, upNextEntry, walking, prepared)).toEqual({ position: 1, total: 1 });
      expect(upNextHandsBackToList(position, walking)).toBe(true);

      const onward = selectNextQueueItemWithSuggestions(queue, upNextEntry, walking, undefined, undefined, prepared);
      expect(onward.item?.uuid).toBe(getPlaylistPeekQueueItemUuid('r14'));
      expect(onward.trackResume).toBeNull();

      // Previous retraces it back onto Debaser, on the list again.
      expect(selectPreviousQueueItemWithSuggestions(queue, upNextEntry, walking, prepared)).toEqual({
        item: current,
        trackResume: null,
      });
    });
  },
);

describe('the queue 2.7.0 left on the phone (#7247)', () => {
  // Play next already moved MacroDre's History entry, flag and all: the walk
  // passes it. Play next on it again drops the flag where it stands, so the
  // owner's own queue mends on the next tap.
  it('mends on the next Play next, in either mode', () => {
    for (const { historyCountOf } of MODES) {
      const { queue: before, current } = ownersQueue();
      const index = before.findIndex((item) => item.climb.uuid === MACRO_DRE.uuid);
      const stale = [...before];
      const [moved] = stale.splice(index, 1);
      stale.splice(stale.indexOf(current) + 1, 0, moved);
      expect(moved.suggested).toBe(true);

      const mended = playNextMacroDre(stale, current, historyCountOf(stale, current));
      const historyCount = historyCountOf(mended, current);
      expect(mended.map((item) => item.uuid)).toEqual(stale.map((item) => item.uuid));
      const selection = selectNextQueueItemWithSuggestions(
        mended,
        current,
        SEARCH,
        undefined,
        undefined,
        undefined,
        historyCount,
      );
      expect(selection.item?.uuid).toBe(moved.uuid);
      expect(selection.item?.suggested).toBeUndefined();
    }
  });
});
