import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardConfigKey,
  planSharedFeedTickMoves,
  type OwnedBoard,
  type SharedFeedBoard,
} from './backfill-shared-feed-tick-boards-helpers.js';

const CONFIG = { boardType: 'moonboard', layoutId: 6, sizeId: 1, setIds: '24,25,26,27' };
const FEED: SharedFeedBoard = { id: 261536, ...CONFIG };
const CLIMBER = 'climber-1';

function ownedBoard(overrides: Partial<OwnedBoard> = {}): OwnedBoard {
  return { id: 770338, ownerId: CLIMBER, ...CONFIG, ...overrides };
}

function feedTick(
  uuid: string,
  overrides: { userId?: string; boardId?: number; sessionBoard?: SharedFeedBoard | null } = {},
) {
  return {
    uuid,
    userId: overrides.userId ?? CLIMBER,
    boardId: overrides.boardId ?? FEED.id,
    sessionBoard: overrides.sessionBoard ?? null,
  };
}

void test('moves a tick onto the one board its climber owns with that config', () => {
  const plan = planSharedFeedTickMoves({
    feeds: [FEED],
    ticks: [feedTick('tick-1')],
    ownedBoards: [ownedBoard()],
  });

  assert.deepEqual(plan.moves, [{ uuid: 'tick-1', oldBoardId: FEED.id, newBoardId: 770338 }]);
  assert.deepEqual([...plan.movedUserIds], [CLIMBER]);
  assert.equal(plan.ambiguous, 0);
  assert.equal(plan.noOwnedBoard, 0);
});

void test('matches a board whose set ids were stored in another order', () => {
  // `createBoard` persists the order it was handed, so this is the same wall.
  const plan = planSharedFeedTickMoves({
    feeds: [FEED],
    ticks: [feedTick('tick-1')],
    ownedBoards: [ownedBoard({ setIds: '27,24,26,25' })],
  });

  assert.equal(plan.moves.length, 1);
});

void test('leaves a tick alone when its climber owns two boards of that config', () => {
  // #4174's "same wall at home and at the gym" — the row says nothing about
  // which one the climber was standing at, so guessing would scatter history.
  const plan = planSharedFeedTickMoves({
    feeds: [FEED],
    ticks: [feedTick('tick-1')],
    ownedBoards: [ownedBoard({ id: 770338 }), ownedBoard({ id: 880001 })],
  });

  assert.deepEqual(plan.moves, []);
  assert.equal(plan.ambiguous, 1);
  assert.deepEqual([...plan.ambiguousUserIds], [CLIMBER]);
});

void test('leaves a tick on the feed when its climber owns no board of that config', () => {
  // The feed is where these belong, and the fixed code still files them there.
  const plan = planSharedFeedTickMoves({
    feeds: [FEED],
    ticks: [feedTick('tick-1')],
    ownedBoards: [ownedBoard({ layoutId: 3, setIds: '5,6,7,8,9,10' })],
  });

  assert.deepEqual(plan.moves, []);
  assert.equal(plan.noOwnedBoard, 1);
  assert.equal(plan.ambiguous, 0);
});

void test("never infers another climber's board from ownership alone", () => {
  const plan = planSharedFeedTickMoves({
    feeds: [FEED],
    ticks: [feedTick('tick-1', { userId: 'climber-2' })],
    ownedBoards: [ownedBoard()],
  });

  assert.deepEqual(plan.moves, []);
  assert.equal(plan.noOwnedBoard, 1);
});

void test('ignores a tick that is no longer on a feed', () => {
  // The feeds and the ticks are read separately; a tick re-filed by the fixed
  // code in between must not be moved again on a stale plan.
  const plan = planSharedFeedTickMoves({
    feeds: [FEED],
    ticks: [feedTick('tick-1', { boardId: 999999 })],
    ownedBoards: [ownedBoard()],
  });

  assert.deepEqual(plan.moves, []);
  assert.equal(plan.noOwnedBoard, 0);
  assert.equal(plan.ambiguous, 0);
});

void test('keeps configs that differ only by board type apart', () => {
  assert.notEqual(boardConfigKey({ ...CONFIG, boardType: 'kilter' }), boardConfigKey(CONFIG));
});

void test('keeps mixed climbers and feed configurations independent while accumulating counters', () => {
  const otherFeed: SharedFeedBoard = { ...FEED, id: 900, sizeId: 2 };
  const plan = planSharedFeedTickMoves({
    feeds: [FEED, otherFeed],
    ticks: [
      feedTick('move-a'),
      feedTick('move-b'),
      feedTick('ambiguous', { userId: 'climber-2' }),
      feedTick('no-board', { boardId: otherFeed.id }),
    ],
    ownedBoards: [
      ownedBoard(),
      ownedBoard({ id: 700, ownerId: 'climber-2' }),
      ownedBoard({ id: 701, ownerId: 'climber-2' }),
      ownedBoard({ id: 702, ownerId: 'climber-2', sizeId: 2 }),
    ],
  });
  assert.deepEqual(plan.moves, [
    { uuid: 'move-a', oldBoardId: FEED.id, newBoardId: 770338 },
    { uuid: 'move-b', oldBoardId: FEED.id, newBoardId: 770338 },
  ]);
  assert.deepEqual([...plan.movedUserIds], [CLIMBER]);
  assert.equal(plan.ambiguous, 1);
  assert.deepEqual([...plan.ambiguousUserIds], ['climber-2']);
  assert.equal(plan.noOwnedBoard, 1);
});

void test('session wall wins over the climber home wall and disambiguates multiple owned walls', () => {
  const sessionBoard = { id: 990001, ...CONFIG, setIds: '27,26,25,24' };
  for (const ownedBoards of [[], [ownedBoard()], [ownedBoard(), ownedBoard({ id: 770339 })]]) {
    const plan = planSharedFeedTickMoves({ feeds: [FEED], ticks: [feedTick('party', { sessionBoard })], ownedBoards });
    assert.deepEqual(plan.moves, [{ uuid: 'party', oldBoardId: FEED.id, newBoardId: sessionBoard.id }]);
    assert.equal(plan.ambiguous, 0);
    assert.equal(plan.noOwnedBoard, 0);
  }
});

void test('a matching session already on the feed remains there despite an owned wall', () => {
  const plan = planSharedFeedTickMoves({
    feeds: [FEED],
    ticks: [feedTick('feed-session', { sessionBoard: FEED })],
    ownedBoards: [ownedBoard()],
  });
  assert.deepEqual(plan.moves, []);
});

void test('missing or config-mismatched session walls retain the unique-owned fallback', () => {
  for (const sessionBoard of [null, { ...FEED, id: 990001, sizeId: 2 }, { ...FEED, id: 990001, setIds: '24,25' }]) {
    const plan = planSharedFeedTickMoves({
      feeds: [FEED],
      ticks: [feedTick('fallback', { sessionBoard })],
      ownedBoards: [ownedBoard()],
    });
    assert.deepEqual(plan.moves, [{ uuid: 'fallback', oldBoardId: FEED.id, newBoardId: 770338 }]);
  }
});
