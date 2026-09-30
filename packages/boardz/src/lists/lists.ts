import type { BoardName, Climb } from '@boardsesh/shared-schema';

/** Favourites and Projects come with the app and can't be renamed or deleted. */
export type ListKind = 'favourites' | 'projects' | 'custom';

/** A climb on a list, with everything needed to show it again without searching. */
export type SavedClimb = {
  climb: Climb;
  boardName: BoardName;
  layoutId: number;
  savedAt: string;
};

export type ClimbList = {
  id: string;
  name: string;
  kind: ListKind;
  createdAt: string;
  /** Most recently saved first. */
  climbs: SavedClimb[];
};

export const FAVOURITES_ID = 'favourites';
export const PROJECTS_ID = 'projects';

/** Where a board's climbs belong: holds only line up within one layout. */
export type BoardLayout = { boardName: BoardName; layoutId: number };

const sameClimb = (saved: SavedClimb, boardName: BoardName, uuid: string) =>
  saved.boardName === boardName && saved.climb.uuid === uuid;

/** The stored lists with Favourites and Projects always there, first. */
export function withDefaultLists(stored: readonly ClimbList[], now: string): ClimbList[] {
  const builtIn = (id: string, name: string, kind: ListKind): ClimbList =>
    stored.find((list) => list.id === id) ?? { id, name, kind, createdAt: now, climbs: [] };
  return [
    builtIn(FAVOURITES_ID, 'Favourites', 'favourites'),
    builtIn(PROJECTS_ID, 'Projects', 'projects'),
    ...stored.filter((list) => list.kind === 'custom'),
  ];
}

export function isOnList(list: ClimbList, boardName: BoardName, uuid: string): boolean {
  return list.climbs.some((saved) => sameClimb(saved, boardName, uuid));
}

/** Puts the climb on the list, or takes it off if it's there. */
export function toggleClimb(lists: readonly ClimbList[], listId: string, saved: SavedClimb): ClimbList[] {
  return lists.map((list) => {
    if (list.id !== listId) return list;
    const { boardName, climb } = saved;
    return isOnList(list, boardName, climb.uuid)
      ? { ...list, climbs: list.climbs.filter((entry) => !sameClimb(entry, boardName, climb.uuid)) }
      : { ...list, climbs: [saved, ...list.climbs] };
  });
}

export function removeClimb(
  lists: readonly ClimbList[],
  listId: string,
  boardName: BoardName,
  uuid: string,
): ClimbList[] {
  return lists.map((list) =>
    list.id === listId ? { ...list, climbs: list.climbs.filter((saved) => !sameClimb(saved, boardName, uuid)) } : list,
  );
}

export function addList(lists: readonly ClimbList[], id: string, name: string, now: string): ClimbList[] {
  return [...lists, { id, name: name.trim(), kind: 'custom', createdAt: now, climbs: [] }];
}

/** Renames one of the climber's own lists; the built-in ones keep their names. */
export function renameList(lists: readonly ClimbList[], id: string, name: string): ClimbList[] {
  return lists.map((list) => (list.id === id && list.kind === 'custom' ? { ...list, name: name.trim() } : list));
}

/** Deletes one of the climber's own lists; the built-in ones stay. */
export function deleteList(lists: readonly ClimbList[], id: string): ClimbList[] {
  return lists.filter((list) => list.id !== id || list.kind !== 'custom');
}

/** The ids of the lists each climb is on, keyed by `listKey`. */
export function listsByClimb(lists: readonly ClimbList[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const list of lists) {
    for (const saved of list.climbs) {
      const key = listKey(saved.boardName, saved.climb.uuid);
      const ids = index.get(key) ?? new Set<string>();
      ids.add(list.id);
      index.set(key, ids);
    }
  }
  return index;
}

export function listKey(boardName: BoardName, uuid: string): string {
  return `${boardName}:${uuid}`;
}

/** The list's climbs that fit a board. Climbs saved on another board or layout can't be shown on it. */
export function climbsForBoard(list: ClimbList, board: BoardLayout): SavedClimb[] {
  return list.climbs.filter((saved) => saved.boardName === board.boardName && saved.layoutId === board.layoutId);
}

function isSavedClimb(value: unknown): value is SavedClimb {
  if (typeof value !== 'object' || value === null) return false;
  const saved = value as Record<string, unknown>;
  const climb = saved.climb as Record<string, unknown> | null;
  return (
    typeof saved.boardName === 'string' &&
    typeof saved.layoutId === 'number' &&
    typeof saved.savedAt === 'string' &&
    typeof climb === 'object' &&
    climb !== null &&
    typeof climb.uuid === 'string' &&
    typeof climb.name === 'string' &&
    typeof climb.frames === 'string' &&
    typeof climb.difficulty === 'string'
  );
}

function isClimbList(value: unknown): value is ClimbList {
  if (typeof value !== 'object' || value === null) return false;
  const list = value as Record<string, unknown>;
  return (
    typeof list.id === 'string' &&
    typeof list.name === 'string' &&
    (list.kind === 'favourites' || list.kind === 'projects' || list.kind === 'custom') &&
    typeof list.createdAt === 'string' &&
    Array.isArray(list.climbs) &&
    list.climbs.every(isSavedClimb)
  );
}

export function isClimbLists(value: unknown): value is ClimbList[] {
  return Array.isArray(value) && value.every(isClimbList);
}
