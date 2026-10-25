import type { Gym, UserBoard } from '@boardsesh/shared-schema';
import type { GymBoardFilter } from '@boardsesh/gym-filters';

// One flat, heterogeneous row list for the gym panel's FlashList. The old screen
// mapped every gym AND every board inside a ScrollView, which can't recycle. Here
// the gyms and the standalone-boards section are flattened into one virtualized
// array; a gym carries its own (tiny, ≤~5) board list so an expanded gym renders
// as one cohesive rounded card — only ever one gym is expanded at a time, so this
// is not a virtualization concern. `kind` drives FlashList's getItemType.

export type GymListRow =
  | { kind: 'sectionHeader'; key: string; label: string }
  | { kind: 'loading'; key: string }
  | { kind: 'empty'; key: string; label: string }
  | {
      kind: 'gym';
      key: string;
      gym: Gym;
      subtitle: string;
      expanded: boolean;
      selected: boolean;
      boards: UserBoard[];
      /** The expanded gym's roster has not settled (loading or failed): don't claim "no boards". */
      boardsPending: boolean;
    }
  | { kind: 'standalone'; key: string; board: UserBoard; subtitle: string; selected: boolean };

export type GymListLabels = {
  gymsSection: string;
  otherBoards: string;
  empty: string;
  /** Renders the "<n> boards" subtitle a gym falls back to when it has no address. */
  boardCount: (count: number) => string;
};

type BuildGymListRowsArgs = {
  gyms: Gym[];
  /** Pre-built O(1) index of a gym's boards (never filter per row). */
  boardsByGym: Map<string, UserBoard[]>;
  standaloneBoards: UserBoard[];
  expandedGymUuid: string | null;
  /**
   * The expanded gym's own linked boards (already narrowed by the chip filters).
   * The nearby-boards search only sees boards with a visible pin close to the
   * map centre, so it can miss boards the gym itself lists.
   */
  expandedGymRoster?: readonly UserBoard[];
  /** True while the roster query is loading or has failed with nothing to show. */
  expandedGymRosterPending?: boolean;
  /** The selected gym/board (mirrors the map pin) — drives the row accent. */
  selectedId: string | null;
  gymsLoading: boolean;
  labels: GymListLabels;
};

/**
 * The gym's own roster first (server order), then any nearby-search board the
 * roster doesn't have, deduped by uuid. A union so a nearby board is never lost
 * while the roster loads or when the server answers an empty list.
 */
export function mergeGymBoards(roster: readonly UserBoard[], nearby: readonly UserBoard[]): UserBoard[] {
  const seen = new Set(roster.map((board) => board.uuid));
  const merged = [...roster];
  for (const board of nearby) {
    if (seen.has(board.uuid)) continue;
    seen.add(board.uuid);
    merged.push(board);
  }
  return merged;
}

/**
 * Applies the board-type / layout / size chips to a gym's roster, as the server
 * does for the nearby search. Angles are deliberately not filtered (this screen
 * never sends them). The name filter is skipped on purpose: it matched
 * the gym, and a gym's boards need not share its name.
 */
export function filterBoardsByChips(boards: readonly UserBoard[], filter: GymBoardFilter): UserBoard[] {
  const { boardTypes, layoutIds, sizeIds } = filter;
  return boards.filter(
    (board) =>
      (!boardTypes?.length || (boardTypes as string[]).includes(board.boardType)) &&
      (!layoutIds?.length || layoutIds.includes(board.layoutId)) &&
      (!sizeIds?.length || sizeIds.includes(board.sizeId)),
  );
}

export function buildGymListRows({
  gyms,
  boardsByGym,
  standaloneBoards,
  expandedGymUuid,
  expandedGymRoster,
  expandedGymRosterPending = false,
  selectedId,
  gymsLoading,
  labels,
}: BuildGymListRowsArgs): GymListRow[] {
  const rows: GymListRow[] = [{ kind: 'sectionHeader', key: 'sh:gyms', label: labels.gymsSection }];

  if (gymsLoading && gyms.length === 0) {
    rows.push({ kind: 'loading', key: 'loading' });
  } else if (gyms.length === 0) {
    rows.push({ kind: 'empty', key: 'empty', label: labels.empty });
  }

  for (const gym of gyms) {
    rows.push({
      kind: 'gym',
      key: `gym:${gym.uuid}`,
      gym,
      subtitle: gym.address ?? labels.boardCount(gym.boardCount ?? boardsByGym.get(gym.uuid)?.length ?? 0),
      expanded: expandedGymUuid === gym.uuid,
      selected: selectedId === gym.uuid,
      boards:
        expandedGymUuid === gym.uuid
          ? mergeGymBoards(expandedGymRoster ?? [], boardsByGym.get(gym.uuid) ?? [])
          : (boardsByGym.get(gym.uuid) ?? []),
      boardsPending: expandedGymUuid === gym.uuid && expandedGymRosterPending,
    });
  }

  if (standaloneBoards.length > 0) {
    rows.push({ kind: 'sectionHeader', key: 'sh:other', label: labels.otherBoards });
    for (const board of standaloneBoards) {
      rows.push({
        kind: 'standalone',
        key: `std:${board.uuid}`,
        board,
        subtitle: board.locationName ?? board.boardType,
        selected: selectedId === board.uuid,
      });
    }
  }

  return rows;
}

/** Index of the row carrying a given key (for scrollToIndex on a marker tap). O(n) once per tap. */
export function findRowIndex(rows: GymListRow[], key: string): number {
  return rows.findIndex((row) => row.key === key);
}
