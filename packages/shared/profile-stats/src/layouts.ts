import { MOONBOARD_LAYOUTS, formatBoardDisplayName, SUPPORTED_BOARDS as PICKER_BOARDS } from '@boardsesh/board-config';
import { getLayout, ORPHANED_KILTER_LAYOUT_DEFAULTS } from '@boardsesh/board-constants/product-sizes';
import { SUPPORTED_BOARDS, type BoardName } from '@boardsesh/shared-schema';
import type { LogbookEntry } from './types';

/**
 * Board types charted on the profile — the SCHEMA list, every board that can
 * carry a tick.
 *
 * Deliberately NOT `@boardsesh/board-config`'s display-filter `SUPPORTED_BOARDS`,
 * which this used to import. That list answers "may a board picker offer this?"
 * and is the wrong question here: the profile hooks (`useAllBoardsTicks` on
 * mobile, its web twin) issue one `userTicks` request per entry, so a board
 * missing from the list is a board whose ascents are never fetched and silently
 * vanish from the logbook, the charts and the totals.
 *
 * The MoonBoard flag is the case that makes the difference concrete: a climber's
 * MoonBoard ticks exist in the database whether or not the picker currently
 * offers MoonBoard, and turning the flag off must hide the picker entry, not
 * erase their history. Same for `spray`, which is excluded from the picker
 * permanently — a wall is created, not picked — while its ticks are ordinary
 * ticks that belong on the profile like any other.
 */
export const BOARD_TYPES: readonly BoardName[] = SUPPORTED_BOARDS;

/**
 * Board types the profile's board FILTER offers — a different question from
 * {@link BOARD_TYPES}.
 *
 * `BOARD_TYPES` is what we FETCH: every board that can carry a tick, so no
 * ascent is silently dropped. This is what we OFFER as a filter row, and a row
 * for a board the climber can never have is a dead control. `spray` is exactly
 * that today — a wall is created, not picked, and climb writes to the spray
 * partition are gated until SW-05 — so it is fetched and charted but not listed
 * here. SW-11 (#5444) gives the filter a real spray story.
 */
export const BOARD_FILTER_TYPES: readonly BoardName[] = PICKER_BOARDS;

/** Stable ordering for layout series/legends across charts. */
export const LAYOUT_ORDER = [
  'kilter-1',
  'kilter-8',
  'tension-9',
  'tension-10',
  'tension-11',
  'moonboard-1',
  'moonboard-2',
  'moonboard-3',
  'moonboard-4',
  'moonboard-5',
  'woods-1',
];

// Display name overrides for layouts whose constant name doesn't match the
// desired display style (e.g. "Original Layout" → "Tension Classic").
const LAYOUT_DISPLAY_OVERRIDES: Record<string, string> = {
  'tension-9': 'Tension Classic',
  'tension-10': 'Tension 2 Mirror',
  'tension-11': 'Tension 2 Spray',
  'moonboard-1': 'MoonBoard 2010',
  'moonboard-2': 'MoonBoard 2016',
  'moonboard-3': 'MoonBoard 2024',
  'moonboard-4': 'MoonBoard Masters 2017',
  'moonboard-5': 'MoonBoard Masters 2019',
  'decoy-2': 'Decoy Dungeon Trainer',
  'touchstone-1': 'Touchstone Winter 2020',
  'grasshopper-1': 'Grasshopper 2020',
  // Woods is code-driven: no rows in the Aurora layout tables for `getLayout` to
  // read, so without this the profile charts would label it "Woods (Layout 1)".
  'woods-1': 'Woods Board',
};

export const getLayoutKey = (boardType: string, layoutId: number | null | undefined): string => {
  if (layoutId === null || layoutId === undefined) {
    return `${boardType}-unknown`;
  }
  return `${boardType}-${layoutId}`;
};

/**
 * Chart label for a `(boardType, layoutId)` pair.
 *
 * `boardName` is the wall's own name when the caller has one — the tick's
 * `boardDisplayName` (`user_boards.name`), threaded through
 * {@link buildLayoutNameLookup}. It is used only for spray walls: their layout
 * row is created at runtime when the owner photographs the wall, so no
 * catalogue table can name it, and without this they fall through to
 * `Spray wall (Layout 941)` (#5487). A bare `Spray wall` is not the fix — two
 * walls would share a label while their keys stay distinct. Catalogue boards
 * ignore the name: an owner's "My Kilter" must never replace "Kilter Original"
 * on a chart.
 */
export const getLayoutDisplayName = (
  boardType: string,
  layoutId: number | null | undefined,
  boardName?: string | null,
): string => {
  if (layoutId === null || layoutId === undefined) {
    return `${formatBoardDisplayName(boardType)} (Unknown Layout)`;
  }

  const key = getLayoutKey(boardType, layoutId);

  // Check display overrides first
  if (LAYOUT_DISPLAY_OVERRIDES[key]) return LAYOUT_DISPLAY_OVERRIDES[key];

  // MoonBoard layouts are defined separately from Aurora layouts
  if (boardType === 'moonboard') {
    const entry = Object.values(MOONBOARD_LAYOUTS).find((layout) => layout.id === layoutId);
    if (entry) return entry.name;
  } else {
    // Aurora layouts from board-constants
    const layout = getLayout(boardType as BoardName, layoutId);
    if (layout) {
      // Strip " Board " from names like "Kilter Board Original" → "Kilter Original"
      return layout.name.replace(' Board ', ' ');
    }

    // Orphaned Kilter layouts not in the main LAYOUTS config
    if (boardType === 'kilter') {
      const orphaned = ORPHANED_KILTER_LAYOUT_DEFAULTS[layoutId];
      if (orphaned) return orphaned.name;
    }
  }

  // A spray wall the viewer can see arrives here with its owner's wall name:
  // label it the way the epic asks (`Spray wall · <name>`), leading with WHAT
  // it is, matching `boardRowSubtitle` in @boardsesh/board-config. The "Spray
  // wall" kind is deliberately untranslated, so composing it here keeps the
  // package i18n-free.
  if (boardType === 'spray' && boardName) {
    return `${formatBoardDisplayName(boardType)} · ${boardName}`;
  }

  return `${formatBoardDisplayName(boardType)} (Layout ${layoutId})`;
};

/**
 * Map from layoutKey to the wall's own name, taken from ticks that carry a
 * `boardDisplayName` (first non-null per layout). Chart builders use it to
 * label runtime-created walls; every layoutKey the ticks produce is a key in
 * this map only when some tick on it knew its wall's name.
 */
export const buildLayoutNameLookup = (allBoardsTicks: Record<string, LogbookEntry[]>): Map<string, string> => {
  const names = new Map<string, string>();
  for (const [boardType, entries] of Object.entries(allBoardsTicks)) {
    for (const entry of entries) {
      if (entry.boardDisplayName == null || entry.boardDisplayName === '') continue;
      const key = getLayoutKey(boardType, entry.layoutId);
      if (!names.has(key)) names.set(key, entry.boardDisplayName);
    }
  }
  return names;
};

/** Parse a `${boardType}-${layoutId}` key back into its parts. */
export const parseLayoutKey = (layoutKey: string): { boardType: string; layoutId: number | null } => {
  // Split on the *last* hyphen, not the first: the key is
  // `${boardType}-${layoutId}` where the trailing segment is always numeric or
  // 'unknown' (never hyphenated), so this stays correct even if a future board
  // type contains a hyphen in its name.
  const separatorIndex = layoutKey.lastIndexOf('-');
  const boardType = separatorIndex === -1 ? layoutKey : layoutKey.slice(0, separatorIndex);
  const layoutIdStr = separatorIndex === -1 ? '' : layoutKey.slice(separatorIndex + 1);
  const layoutId = layoutIdStr === 'unknown' ? null : parseInt(layoutIdStr, 10);
  return { boardType, layoutId };
};

/** Sort layoutKeys by `LAYOUT_ORDER`, falling back to alphabetical. */
export const sortLayoutKeys = (layoutKeys: string[]): string[] => {
  return [...layoutKeys].sort((a, b) => {
    const indexA = LAYOUT_ORDER.indexOf(a);
    const indexB = LAYOUT_ORDER.indexOf(b);
    if (indexA !== -1 && indexB !== -1) return indexA - indexB;
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;
    return a.localeCompare(b);
  });
};
