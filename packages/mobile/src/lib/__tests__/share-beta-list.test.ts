import { describe, expect, it } from 'vitest';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import { buildShareBetaListItems, shareBetaListItemType, shareBetaListKey } from '../share-beta-list';

function makeAscent(uuid: string, climbUuid = `climb-${uuid}`): AscentFeedItem {
  return {
    uuid,
    climbUuid,
    climbName: `Climb ${uuid}`,
    setterUsername: null,
    boardType: 'kilter',
    boardId: null,
    boardDisplayName: null,
    layoutId: 1,
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 2,
    quality: null,
    difficulty: 20,
    difficultyName: 'V4',
    consensusDifficulty: 20,
    consensusDifficultyName: 'V4',
    boardseshDifficulty: null,
    boardseshConfidence: null,
    qualityAverage: null,
    isBenchmark: false,
    isNoMatch: false,
    comment: '',
    climbedAt: '2026-07-31T12:00:00.000Z',
    frames: 'p1r1',
  };
}

describe('buildShareBetaListItems', () => {
  it('keeps recent ascents in feed order with source-stable keys when there are no suggestions', () => {
    const first = makeAscent('tick-1');
    const second = makeAscent('tick-2');

    const rows = buildShareBetaListItems({ ascents: [first, second], suggestions: [], isSearching: false });

    expect(rows.map((row) => row.key)).toEqual(['other:tick-1', 'other:tick-2']);
    expect(rows.map((row) => row.kind)).toEqual(['ascent', 'ascent']);
  });

  it('puts suggestions first, adds typed headers, and removes every recent tick for a suggested climb', () => {
    const suggestion = makeAscent('suggested-tick', 'shared-climb');
    const sameClimbRecentTick = makeAscent('recent-same-climb', 'shared-climb');
    const other = makeAscent('other-tick', 'other-climb');

    const rows = buildShareBetaListItems({
      ascents: [sameClimbRecentTick, other],
      suggestions: [suggestion],
      isSearching: false,
    });

    expect(rows.map((row) => row.key)).toEqual([
      'section:suggested',
      'suggested:suggested-tick',
      'section:other',
      'other:other-tick',
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['section', 'ascent', 'section', 'ascent']);
  });

  it('deduplicates repeated page and suggestion UUIDs without collapsing distinct ticks of one climb', () => {
    const firstTick = makeAscent('tick-1', 'repeated-climb');
    const secondTick = makeAscent('tick-2', 'repeated-climb');
    const suggestion = makeAscent('suggested-tick');

    const rows = buildShareBetaListItems({
      ascents: [firstTick, firstTick, secondTick],
      suggestions: [suggestion, suggestion],
      isSearching: false,
    });

    expect(rows.map((row) => row.key)).toEqual([
      'section:suggested',
      'suggested:suggested-tick',
      'section:other',
      'other:tick-1',
      'other:tick-2',
    ]);
  });

  it('suppresses suggestions and headers while searching', () => {
    const recent = makeAscent('recent');
    const suggestion = makeAscent('suggestion');

    const rows = buildShareBetaListItems({ ascents: [recent], suggestions: [suggestion], isSearching: true });

    expect(rows.map((row) => row.key)).toEqual(['other:recent']);
  });

  it('omits the other header when caption matches are the only ascents', () => {
    const suggestion = makeAscent('suggestion');
    const rows = buildShareBetaListItems({ ascents: [], suggestions: [suggestion], isSearching: false });

    expect(rows.map((row) => row.key)).toEqual(['section:suggested', 'suggested:suggestion']);
  });

  it('returns an empty list when neither source has an ascent', () => {
    expect(buildShareBetaListItems({ ascents: [], suggestions: [], isSearching: false })).toEqual([]);
  });

  it('exposes hoisted key and item-type readers for FlashList recycling', () => {
    const item = buildShareBetaListItems({
      ascents: [makeAscent('tick-1')],
      suggestions: [],
      isSearching: false,
    })[0];

    expect(shareBetaListKey(item)).toBe('other:tick-1');
    expect(shareBetaListItemType(item)).toBe('ascent');
  });
});
