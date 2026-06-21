import { describe, expect, it } from 'vite-plus/test';
import type { BoardDetails, Climb, SearchRequestPagination } from '@/app/lib/types';
import type { ClimbQueueItem, QueueState } from '../types';
import { queueReducer } from '../reducer';
import {
  createPlaylistSuggestionSource,
  getPlaylistPeekQueueItemUuid,
  getPlaylistSuggestedClimbs,
  insertQueueItemAfterCurrent,
  mergeUniquePlaylistClimbs,
  pruneSuggestedQueueItemsAfterCurrent,
} from '../playlist-suggestions';

const boardDetails: BoardDetails = {
  images_to_holds: {},
  holdsData: [
    { id: 1, mirroredHoldId: null, cx: 0, cy: 0, r: 10 },
    { id: 2, mirroredHoldId: null, cx: 0, cy: 0, r: 10 },
    { id: 3, mirroredHoldId: null, cx: 0, cy: 0, r: 10 },
  ],
  edge_left: 0,
  edge_right: 10,
  edge_bottom: 0,
  edge_top: 10,
  boardHeight: 10,
  boardWidth: 10,
  board_name: 'kilter',
  layout_id: 1,
  size_id: 12,
  set_ids: [1],
};

const mockSearchParams: SearchRequestPagination = {
  page: 1,
  pageSize: 20,
  gradeAccuracy: 1,
  maxGrade: 18,
  minAscents: 1,
  minGrade: 1,
  minRating: 1,
  sortBy: 'quality',
  sortOrder: 'desc',
  name: '',
  onlyClassics: false,
  onlyTallClimbs: false,
  onlyWideClimbs: false,
  onlyWithBetaVideos: false,
  settername: [],
  setternameSuggestion: '',
  holdsFilter: {},
  hideAttempted: false,
  hideCompleted: false,
  showOnlyAttempted: false,
  showOnlyCompleted: false,
  onlyDrafts: false,
  projectsOnly: false,
  boulders: true,
  routes: false,
  zoneBox: null,
  zoneMode: 'allHolds',
};

function makeClimb(uuid: string, frames = 'p1r12'): Climb {
  return {
    uuid,
    layoutId: 1,
    boardType: 'kilter',
    setter_username: 'setter',
    name: uuid,
    description: '',
    frames,
    angle: 40,
    ascensionist_count: 0,
    difficulty: '5',
    quality_average: '3',
    stars: 3,
    difficulty_error: '',
    benchmark_difficulty: null,
  };
}

function makeQueueItem(uuid: string, climb: Climb, suggested = false): ClimbQueueItem {
  return {
    uuid,
    climb,
    addedBy: 'user-1',
    suggested,
  };
}

function makeQueueState(playlistSuggestionSource: QueueState['playlistSuggestionSource']): QueueState {
  return {
    queue: [],
    currentClimbQueueItem: null,
    climbSearchParams: mockSearchParams,
    playlistSuggestionSource,
    hasDoneFirstFetch: false,
    initialQueueDataReceivedFromPeers: false,
    pendingCurrentClimbUpdates: [],
    lastReceivedSequence: null,
    lastReceivedStateHash: null,
    needsResync: false,
  };
}

describe('playlist suggestions', () => {
  it('keeps playlist order and suggests only climbable items after the activated climb', () => {
    const earlier = makeClimb('earlier');
    const activated = makeClimb('activated');
    const afterOne = makeClimb('after-one');
    const incompatible = makeClimb('incompatible', 'p99r12');
    const afterTwo = makeClimb('after-two', 'p2r12');

    const source = createPlaylistSuggestionSource({
      playlistUuid: 'playlist-1',
      activatedClimb: activated,
      climbs: [earlier, activated, afterOne, incompatible, afterTwo],
      boardDetails,
    });

    expect(source.climbs.map((climb) => climb.uuid)).toEqual(['earlier', 'activated', 'after-one', 'after-two']);
    expect(getPlaylistSuggestedClimbs(source, []).map((climb) => climb.uuid)).toEqual(['after-one', 'after-two']);
  });

  it('does not fall back to the beginning when the activated climb position is unknown', () => {
    const earlier = makeClimb('earlier');
    const after = makeClimb('after');
    const activated = makeClimb('activated');

    const source = createPlaylistSuggestionSource({
      playlistUuid: 'playlist-1',
      activatedClimb: activated,
      climbs: [earlier, after],
      boardDetails,
    });

    expect(mergeUniquePlaylistClimbs(activated, [earlier, after]).map((climb) => climb.uuid)).toEqual([
      'earlier',
      'after',
      'activated',
    ]);
    expect(getPlaylistSuggestedClimbs(source, []).map((climb) => climb.uuid)).toEqual([]);
  });

  it('skips playlist suggestions that are already queued', () => {
    const activated = makeClimb('activated');
    const afterOne = makeClimb('after-one');
    const afterTwo = makeClimb('after-two');
    const source = createPlaylistSuggestionSource({
      playlistUuid: 'playlist-1',
      activatedClimb: activated,
      climbs: [activated, afterOne, afterTwo],
      boardDetails,
    });
    const queuedAfterOne = makeQueueItem('queued-after-one', afterOne);

    expect(getPlaylistSuggestedClimbs(source, [queuedAfterOne]).map((climb) => climb.uuid)).toEqual(['after-two']);
  });

  it('replaces only future suggested items and leaves queue history intact', () => {
    const history = makeQueueItem('history', makeClimb('history'));
    const previousCurrent = makeQueueItem('previous-current', makeClimb('previous-current'));
    const activated = makeQueueItem('activated', makeClimb('activated'));
    const oldSuggested = makeQueueItem('old-suggested', makeClimb('old-suggested'), true);
    const manualFuture = makeQueueItem('manual-future', makeClimb('manual-future'));
    const secondOldSuggested = makeQueueItem('second-old-suggested', makeClimb('second-old-suggested'), true);

    const prunedQueue = pruneSuggestedQueueItemsAfterCurrent(
      [history, previousCurrent, activated, oldSuggested, manualFuture, secondOldSuggested],
      activated,
    );

    expect(prunedQueue.map((item) => item.uuid)).toEqual(['history', 'previous-current', 'activated', 'manual-future']);
  });

  it('keeps the queue unchanged when the current item is missing during pruning', () => {
    const historySuggested = makeQueueItem('history-suggested', makeClimb('history-suggested'), true);
    const current = makeQueueItem('current', makeClimb('current'));
    const futureSuggested = makeQueueItem('future-suggested', makeClimb('future-suggested'), true);
    const queue = [historySuggested, current, futureSuggested];
    const missingCurrent = makeQueueItem('missing-current', makeClimb('missing-current'));

    const prunedQueue = pruneSuggestedQueueItemsAfterCurrent(queue, missingCurrent);

    expect(prunedQueue).toBe(queue);
    expect(prunedQueue.map((item) => item.uuid)).toEqual(['history-suggested', 'current', 'future-suggested']);
  });

  it('inserts activated playlist climbs after the current item before pruning suggestions', () => {
    const current = makeQueueItem('current', makeClimb('current'));
    const manualFuture = makeQueueItem('manual-future', makeClimb('manual-future'));
    const oldSuggested = makeQueueItem('old-suggested', makeClimb('old-suggested'), true);
    const activated = makeQueueItem('activated', makeClimb('activated'));

    const queueWithActivated = insertQueueItemAfterCurrent([current, manualFuture, oldSuggested], current, activated);
    const prunedQueue = pruneSuggestedQueueItemsAfterCurrent(queueWithActivated, activated);

    expect(prunedQueue.map((item) => item.uuid)).toEqual(['current', 'activated', 'manual-future']);
  });

  it('drops stale playlist suggestion refreshes for a different activated climb', () => {
    const activated = makeClimb('activated');
    const staleActivated = makeClimb('stale-activated');
    const currentSource = createPlaylistSuggestionSource({
      playlistUuid: 'playlist-1',
      activatedClimb: activated,
      climbs: [activated],
      boardDetails,
    });
    const staleSource = createPlaylistSuggestionSource({
      playlistUuid: 'playlist-1',
      activatedClimb: staleActivated,
      climbs: [staleActivated],
      boardDetails,
    });
    const state = makeQueueState(currentSource);

    const result = queueReducer(state, {
      type: 'REFRESH_PLAYLIST_SUGGESTION_SOURCE',
      payload: staleSource,
    });

    expect(result).toBe(state);
    expect(result.playlistSuggestionSource).toEqual(currentSource);
  });

  it('uses a deterministic playlist peek queue item id for repeated next peeks', () => {
    expect(getPlaylistPeekQueueItemUuid('climb-1')).toBe('playlist-peek:climb-1');
  });

  it('keeps the active playlist source when current climb updates omit an override', () => {
    const activated = makeClimb('activated');
    const promotedSuggestion = makeQueueItem('promoted-suggestion', makeClimb('promoted-suggestion'));
    const source = createPlaylistSuggestionSource({
      playlistUuid: 'playlist-1',
      activatedClimb: activated,
      climbs: [activated, promotedSuggestion.climb],
      boardDetails,
    });
    const state = makeQueueState(source);

    const result = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: {
        item: promotedSuggestion,
        shouldAddToQueue: true,
        insertAfterCurrent: true,
      },
    });

    expect(result.playlistSuggestionSource).toEqual(source);
  });

  it('clears the playlist source when initial queue data replaces local queue state', () => {
    const activated = makeClimb('activated');
    const source = createPlaylistSuggestionSource({
      playlistUuid: 'playlist-1',
      activatedClimb: activated,
      climbs: [activated],
      boardDetails,
    });
    const state = makeQueueState(source);

    const result = queueReducer(state, {
      type: 'INITIAL_QUEUE_DATA',
      payload: { queue: [], currentClimbQueueItem: null },
    });

    expect(result.playlistSuggestionSource).toBeNull();
  });

  it('clears the playlist source when queue updates replace local queue state', () => {
    const activated = makeClimb('activated');
    const source = createPlaylistSuggestionSource({
      playlistUuid: 'playlist-1',
      activatedClimb: activated,
      climbs: [activated],
      boardDetails,
    });
    const state = makeQueueState(source);

    const result = queueReducer(state, {
      type: 'UPDATE_QUEUE',
      payload: { queue: [], currentClimbQueueItem: null },
    });

    expect(result.playlistSuggestionSource).toBeNull();
  });
});
