import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardCompatibilityTarget } from '@boardsesh/board-config';
import type { Climb, PlaylistSuggestionSource } from '@boardsesh/queue';
import { createBoardSuggestionCompatibilityCache } from '../board-suggestion-compatibility-cache';

const checks = vi.hoisted(() => ({ count: 0 }));
vi.mock('@boardsesh/board-config', () => ({
  canAddClimbToBoard: (climb: Climb, target: BoardCompatibilityTarget) => {
    checks.count++;
    return { ok: climb.boardType === target.board_name && climb.layoutId === target.layout_id };
  },
}));

function makeClimb(uuid: string, boardType = 'kilter', layoutId = 1): Climb {
  return { uuid, boardType, layoutId, frames: '' } as Climb;
}
function makeSource(
  climbs: Climb[],
  activatedClimbUuid = climbs[0]?.uuid ?? '',
  playlistUuid = 'climblist',
): PlaylistSuggestionSource {
  return { climbs, activatedClimbUuid, playlistUuid, boardKey: 'board' };
}
const target: BoardCompatibilityTarget = { board_name: 'kilter', layout_id: 1, size_id: 10 };

describe('provider-owned suggestion compatibility cache', () => {
  beforeEach(() => {
    checks.count = 0;
  });

  it('checks 20k rows once and preserves each cursor across 20k head changes', () => {
    const climbs = Array.from({ length: 20_000 }, (_, index) => makeClimb(`climb-${index}`));
    const cache = createBoardSuggestionCompatibilityCache();
    const first = cache.normalize(makeSource(climbs), target, 0);
    expect(first.climbs).toBe(climbs);
    expect(checks.count).toBe(20_000);
    for (const climb of climbs) {
      const next = makeSource(climbs, climb.uuid, `list:${climb.uuid}`);
      const normalized = cache.normalize(next, target, 0);
      expect(normalized).toBe(next);
      expect(normalized.activatedClimbUuid).toBe(climb.uuid);
      expect(checks.count).toBe(20_000);
    }
  });

  it('preserves duplicate ordering and source metadata while reusing a filtered sequence', () => {
    const compatible = makeClimb('compatible');
    const climbs = [makeClimb('foreign', 'tension'), compatible, { ...compatible, name: 'duplicate' }];
    const cache = createBoardSuggestionCompatibilityCache();
    const firstSource = makeSource(climbs, 'compatible', 'first-list');
    const first = cache.normalize(firstSource, target, 0);
    expect(first.climbs).toEqual(climbs.slice(1));
    expect(cache.normalize(firstSource, target, 0)).toBe(first);
    const secondSource = { ...firstSource, playlistUuid: 'second-list', activatedClimbUuid: 'another-anchor' };
    const second = cache.normalize(secondSource, target, 0);
    expect(second.climbs).toBe(first.climbs);
    expect(second).toMatchObject({
      playlistUuid: 'second-list',
      activatedClimbUuid: 'another-anchor',
      boardKey: 'board',
    });
    expect(checks.count).toBe(climbs.length);
  });

  it('applies the synthetic foreign-first exemption to each current source cursor', () => {
    const climbs = [makeClimb('foreign', 'tension'), makeClimb('compatible'), makeClimb('other-foreign', 'tension')];
    const cache = createBoardSuggestionCompatibilityCache();
    const anchored = cache.normalize(makeSource(climbs, 'foreign', 'board-feed'), target, 0);
    expect(anchored.climbs).toEqual(climbs.slice(0, 2));
    const moved = cache.normalize(makeSource(climbs, 'compatible', 'board-feed'), target, 0);
    expect(moved.climbs).toEqual([climbs[1]]);
    const ordinary = cache.normalize(makeSource(climbs, 'foreign', 'ordinary-list'), target, 0);
    expect(ordinary.climbs).toBe(moved.climbs);
    expect(checks.count).toBe(climbs.length);
  });

  it('preserves original source identity when the synthetic exemption retains every row', () => {
    const source = makeSource([makeClimb('foreign', 'tension'), makeClimb('compatible')], 'foreign', 'board-feed');
    expect(createBoardSuggestionCompatibilityCache().normalize(source, target, 0)).toBe(source);
  });

  it('invalidates exact sequence, compatibility target, credential scope and explicit clear', () => {
    const source = makeSource([makeClimb('compatible')]);
    const cache = createBoardSuggestionCompatibilityCache();
    cache.normalize(source, target, 0);
    expect(checks.count).toBe(1);
    cache.normalize({ ...source, climbs: [...source.climbs] }, target, 0);
    expect(checks.count).toBe(2);
    const changedTarget = { ...target, board_name: 'tension' as const };
    expect(cache.normalize(source, changedTarget, 0).climbs).toEqual([]);
    expect(checks.count).toBe(3);
    cache.normalize(source, changedTarget, 1);
    expect(checks.count).toBe(4);
    cache.clear();
    cache.normalize(source, changedTarget, 1);
    expect(checks.count).toBe(5);
  });

  it('keeps only one live sequence rather than retaining a history of lists or boards', () => {
    const first = makeSource([makeClimb('first')]);
    const second = makeSource([makeClimb('second')]);
    const cache = createBoardSuggestionCompatibilityCache();
    cache.normalize(first, target, 0);
    cache.normalize(second, target, 0);
    cache.normalize(first, target, 0);
    expect(checks.count).toBe(3);
  });

  it('does not invent an anchor or successor for an empty source', () => {
    const source = makeSource([], '', 'board-feed');
    expect(createBoardSuggestionCompatibilityCache().normalize(source, target, 0)).toBe(source);
    expect(checks.count).toBe(0);
  });
});
