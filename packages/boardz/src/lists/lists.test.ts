import { describe, expect, it } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import {
  FAVOURITES_ID,
  PROJECTS_ID,
  addList,
  climbsForBoard,
  deleteList,
  isClimbLists,
  isOnList,
  listKey,
  listsByClimb,
  renameList,
  toggleClimb,
  withDefaultLists,
  type SavedClimb,
} from './lists';

const NOW = '2026-09-30T10:00:00.000Z';

function saved(uuid: string, layoutId = 1): SavedClimb {
  const climb = { uuid, name: `Climb ${uuid}`, frames: 'p1r12', difficulty: '6c/V5', angle: 40 } as Climb;
  return { climb, boardName: 'moonboard', layoutId, savedAt: NOW };
}

describe('withDefaultLists', () => {
  it('always starts with Favourites and Projects', () => {
    const lists = withDefaultLists([], NOW);
    expect(lists.map((list) => list.name)).toEqual(['Favourites', 'Projects']);
  });

  it('keeps what was stored in them, and the climber’s own lists after', () => {
    const stored = toggleClimb(addList(withDefaultLists([], NOW), 'warm', 'Warm-ups', NOW), PROJECTS_ID, saved('a'));
    const lists = withDefaultLists(stored, NOW);
    expect(lists.map((list) => list.id)).toEqual([FAVOURITES_ID, PROJECTS_ID, 'warm']);
    expect(lists[1].climbs).toHaveLength(1);
  });
});

describe('toggleClimb', () => {
  it('saves a climb, newest first, and a second toggle takes it off', () => {
    let lists = withDefaultLists([], NOW);
    lists = toggleClimb(lists, FAVOURITES_ID, saved('a'));
    lists = toggleClimb(lists, FAVOURITES_ID, saved('b'));
    expect(lists[0].climbs.map((entry) => entry.climb.uuid)).toEqual(['b', 'a']);
    lists = toggleClimb(lists, FAVOURITES_ID, saved('a'));
    expect(isOnList(lists[0], 'moonboard', 'a')).toBe(false);
    expect(isOnList(lists[0], 'moonboard', 'b')).toBe(true);
  });
});

describe('custom lists', () => {
  it('renames and deletes the climber’s lists but never the built-in ones', () => {
    let lists = addList(withDefaultLists([], NOW), 'warm', '  Warm-ups ', NOW);
    expect(lists[2].name).toBe('Warm-ups');
    lists = renameList(renameList(lists, 'warm', 'Comp prep'), FAVOURITES_ID, 'Nope');
    expect(lists.map((list) => list.name)).toEqual(['Favourites', 'Projects', 'Comp prep']);
    lists = deleteList(deleteList(lists, 'warm'), PROJECTS_ID);
    expect(lists.map((list) => list.id)).toEqual([FAVOURITES_ID, PROJECTS_ID]);
  });
});

describe('listsByClimb', () => {
  it('indexes which lists each climb is on', () => {
    let lists = withDefaultLists([], NOW);
    lists = toggleClimb(toggleClimb(lists, FAVOURITES_ID, saved('a')), PROJECTS_ID, saved('a'));
    expect(listsByClimb(lists).get(listKey('moonboard', 'a'))).toEqual(new Set([FAVOURITES_ID, PROJECTS_ID]));
  });
});

describe('climbsForBoard', () => {
  it('keeps only climbs from the same board layout', () => {
    const lists = toggleClimb(
      toggleClimb(withDefaultLists([], NOW), PROJECTS_ID, saved('a', 1)),
      PROJECTS_ID,
      saved('b', 2),
    );
    const onBoard = climbsForBoard(lists[1], { boardName: 'moonboard', layoutId: 2 });
    expect(onBoard.map((entry) => entry.climb.uuid)).toEqual(['b']);
  });
});

describe('isClimbLists', () => {
  it('accepts stored lists and rejects anything malformed', () => {
    const lists = toggleClimb(withDefaultLists([], NOW), FAVOURITES_ID, saved('a'));
    expect(isClimbLists(JSON.parse(JSON.stringify(lists)))).toBe(true);
    expect(isClimbLists([{ id: 'x', name: 'X', kind: 'custom', createdAt: NOW, climbs: [{ climb: {} }] }])).toBe(false);
    expect(isClimbLists({})).toBe(false);
  });
});
