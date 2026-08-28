import { describe, expect, it } from 'vitest';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import {
  buildShareBetaListItems,
  shareBetaListItemType,
  shareBetaListKey,
  type ShareBetaListItem,
} from '../share-beta-list';

function makeAscent(uuid: string, climbUuid: string): AscentFeedItem {
  return {
    uuid,
    climbUuid,
    climbName: `Climb ${climbUuid}`,
    setterUsername: null,
    boardType: 'kilter',
    boardId: null,
    boardDisplayName: null,
    layoutId: 8,
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 1,
    quality: null,
    difficulty: 21,
    difficultyName: 'V5',
    consensusDifficulty: null,
    consensusDifficultyName: null,
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

function ascentKeys(items: ShareBetaListItem[]): string[] {
  return items.filter((item) => item.kind === 'ascent').map((item) => item.key);
}

describe('buildShareBetaListItems', () => {
  it('returns a flat ascent list with no headers when nothing matched the caption', () => {
    const items = buildShareBetaListItems({
      ascents: [makeAscent('tick-1', 'climb-1'), makeAscent('tick-2', 'climb-2')],
      suggestions: [],
      isSearching: false,
    });

    expect(items.map((item) => item.kind)).toEqual(['ascent', 'ascent']);
    expect(ascentKeys(items)).toEqual(['other:tick-1', 'other:tick-2']);
  });

  it('puts every suggestion inside the list data rather than a header block', () => {
    const items = buildShareBetaListItems({
      ascents: [makeAscent('tick-2', 'climb-2')],
      suggestions: [makeAscent('tick-1', 'climb-1')],
      isSearching: false,
    });

    expect(items.map((item) => item.key)).toEqual([
      'section:suggested',
      'suggested:tick-1',
      'section:other',
      'other:tick-2',
    ]);
  });

  it('drops every tick of a suggested climb from the browse section', () => {
    const items = buildShareBetaListItems({
      // Two ticks of climb-1 — the matched one plus a repeat further down the feed.
      ascents: [makeAscent('tick-9', 'climb-1'), makeAscent('tick-2', 'climb-2')],
      suggestions: [makeAscent('tick-1', 'climb-1')],
      isSearching: false,
    });

    expect(ascentKeys(items)).toEqual(['suggested:tick-1', 'other:tick-2']);
  });

  it('omits the "other" header when every ascent was suggested', () => {
    const items = buildShareBetaListItems({
      ascents: [makeAscent('tick-9', 'climb-1')],
      suggestions: [makeAscent('tick-1', 'climb-1')],
      isSearching: false,
    });

    expect(items.map((item) => item.key)).toEqual(['section:suggested', 'suggested:tick-1']);
  });

  it('suppresses the suggestions while a search is committed', () => {
    const items = buildShareBetaListItems({
      ascents: [makeAscent('tick-2', 'climb-2')],
      suggestions: [makeAscent('tick-1', 'climb-1')],
      isSearching: true,
    });

    expect(items.map((item) => item.key)).toEqual(['other:tick-2']);
  });

  it('de-duplicates repeated uuids so FlashList never sees a duplicate key', () => {
    const items = buildShareBetaListItems({
      ascents: [makeAscent('tick-1', 'climb-1'), makeAscent('tick-1', 'climb-1')],
      suggestions: [],
      isSearching: false,
    });

    expect(ascentKeys(items)).toEqual(['other:tick-1']);
  });

  it('gives headers and rows distinct keys and recycler types', () => {
    const items = buildShareBetaListItems({
      ascents: [makeAscent('tick-2', 'climb-2')],
      suggestions: [makeAscent('tick-1', 'climb-1')],
      isSearching: false,
    });

    expect(new Set(items.map(shareBetaListKey)).size).toBe(items.length);
    expect(items.map(shareBetaListItemType)).toEqual(['section', 'ascent', 'section', 'ascent']);
  });
});
