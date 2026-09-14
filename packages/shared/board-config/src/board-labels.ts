// Subtitles for every surface that lists boards (the Boards-tab carousels, My
// Boards, the gym directory, the Bluetooth quickstart sheet, the www gym page).
//
// The server sends `layoutName`, `sizeName`, `sizeDescription` and `setNames` as
// null on every UserBoard (see enrichBoard in
// packages/backend/src/graphql/resolvers/social/boards.ts), so a subtitle built
// from those fields always collapsed to the raw board type — two Kilter boards
// at two locations both read "kilter". Everything needed to tell them apart is
// already on the wire (gym, location, layout/size ids, angle, serial) and the
// layout/size name tables ship in @boardsesh/board-constants, so we resolve the
// names on the device instead. Works offline, no round-trip.
//
// Lives here rather than in the mobile app because www's gym page renders the
// same list off the same fields and hits the same collision (issue #5272).

import { getLayoutName, getProductSize } from '@boardsesh/board-constants';
import { formatBoardDisplayName, toBoardName } from './board-name';

/**
 * The board fields these labels read. Structural rather than `UserBoard` so a
 * partially-populated board (a BLE-resolved hit, an offline snapshot row, the
 * narrower field set www's `gymBoards` query asks for) works without casting.
 */
export type BoardLabelSource = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  gymName?: string | null;
  locationName?: string | null;
  angle?: number | null;
  serialNumber?: string | null;
};

/**
 * Which list the labels are being written for.
 *
 * - `global` — a list that can hold boards from anywhere (My Boards, Near you,
 *   a Bluetooth scan). The gym is the most useful thing to lead with.
 * - `within-gym` — one gym's own board list, where a heading already names the
 *   gym. Leading with the gym there would put the same words on every row and
 *   collide every board before disambiguation even starts, so the wall label
 *   (`locationName`, e.g. "Main wall") leads instead and the gym name is
 *   dropped entirely.
 */
export type BoardLabelScope = 'global' | 'within-gym';

export type BoardLabelOptions = {
  /** Defaults to `global`. */
  scope?: BoardLabelScope;
};

/** Trimmed value, or null for null/undefined/blank. Blank strings come back from the API. */
function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Where the board is: the linked gym, else the free-text location. Matches the
 * ordering BoardDisambiguationSheet and the board-detail sheet already use.
 *
 * Within one gym's list there is no place worth leading with. Both candidates
 * are gym-level, not wall-level: `gymName` is shared by every row by
 * definition, and `locationName` is written by the wall crawl as
 * "<city>, <country>" for every wall at the gym
 * (`formatLocationName` in packages/aurora-sync/src/sync/locations-sync.ts),
 * while user-created boards prompt for "Home, gym name, or city". Leading with
 * either puts the same words on every row and collides them all before
 * disambiguation starts — the failure this scope exists to prevent. So that
 * scope has no place label at all and leads with what the board IS; the wall's
 * own label lives in `name`, which `stripGymNamePrefix` surfaces.
 */
export function boardPlaceLabel(board: BoardLabelSource, options?: BoardLabelOptions): string | null {
  if (options?.scope === 'within-gym') return null;
  return present(board.gymName) ?? present(board.locationName);
}

// "Kilter Board Original" → "Original", "Tension Board 2 Mirror" → "Mirror".
// Mirrors the builder's cleanLayoutName
// (packages/mobile/src/components/board-discovery/board-builder-labels.ts);
// that file keeps its own copy until the rest of the builder labels move here.
function cleanLayoutName(rawName: string, boardName: string): string {
  const brand = formatBoardDisplayName(boardName);
  const cleaned = rawName
    .replace(new RegExp(`\\b${brand}\\b`, 'gi'), '')
    .replace(/\bBoard\b/gi, '')
    .replace(/\bLayout\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^2\s+/, '');
  return cleaned || rawName;
}

/** "12 x 14" → "12×14". Same cleanup the builder's formatSizeDimensions does. */
function formatSizeDimensions(size: { name: string }): string {
  return size.name
    .replace(/\s*high\s*/gi, '')
    .replace(/\s*wide\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*x\s*/i, '×');
}

/** The board's cleaned layout name ("Kilter Board Original" → "Original"), or null. */
function layoutFacet(board: BoardLabelSource): string | null {
  const boardName = toBoardName(board.boardType);
  if (boardName === null) return null;
  const rawName = present(getLayoutName(boardName, board.layoutId));
  return rawName === null ? null : present(cleanLayoutName(rawName, boardName));
}

/** The board's size dimensions ("12 x 14" → "12×14"), or null. */
function sizeFacet(board: BoardLabelSource): string | null {
  const boardName = toBoardName(board.boardType);
  if (boardName === null) return null;
  const size = getProductSize(boardName, board.sizeId);
  return size === null ? null : present(formatSizeDimensions(size));
}

function angleFacet(board: BoardLabelSource): string | null {
  return board.angle == null ? null : `${board.angle}°`;
}

/** Enough of the serial to separate two otherwise identical boards, never the whole thing. */
function serialFacet(board: BoardLabelSource): string | null {
  const serial = present(board.serialNumber);
  return serial === null ? null : serial.slice(-4);
}

/**
 * What the board is: "Original 12×14". Resolved from the bundled layout/size
 * tables, never from the (always-null) server fields. Null when neither the
 * layout nor the size is known to the bundled tables — we show no config rather
 * than a raw id.
 */
export function boardConfigLabel(board: BoardLabelSource): string | null {
  const parts = [layoutFacet(board), sizeFacet(board)].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * The one-line subtitle under a board's name: where it is, else what it is,
 * else the brand. Never the raw lowercase board type (CLAUDE.md trademark rule).
 */
export function boardRowSubtitle(board: BoardLabelSource, options?: BoardLabelOptions): string {
  return boardPlaceLabel(board, options) ?? boardConfigLabel(board) ?? formatBoardDisplayName(board.boardType);
}

/**
 * Facets tried, in order, when two boards in the same list land on the same
 * subtitle: the physical config, then how it is set up, then the serial as the
 * last resort — two boards can share everything else but never a serial.
 *
 * The gym is deliberately absent: it is either already the base subtitle
 * (`global`) or dropped as redundant (`within-gym`), so it can never be the
 * thing that tells two rows apart.
 */
const DISAMBIGUATION_FACETS: ((board: BoardLabelSource) => string | null)[] = [
  sizeFacet,
  layoutFacet,
  angleFacet,
  serialFacet,
];

/**
 * Subtitles for one rendered list, with same-subtitle boards pulled apart.
 *
 * Returns one subtitle per input board, in order. Boards that collide on their
 * base subtitle get ` · <facet>` appended — so two Kilter boards run by the same
 * gym separate on their size, angle or serial instead of both reading "Bergen
 * Klatresenter". Facets are tried in order and the first one that leaves every
 * member of the group reading differently wins; if none does (a gym with three
 * boards where two share a size), we fall back to the first facet that at least
 * splits the group. A group whose members are identical on every facet is left
 * alone; we never invent a distinction.
 *
 * Runs once per list (call it from the list's `useMemo`, never from a row) and
 * is O(boards × facets).
 */
export function disambiguateBoardSubtitles(boards: BoardLabelSource[], options?: BoardLabelOptions): string[] {
  const subtitles = boards.map((board) => boardRowSubtitle(board, options));

  const indicesBySubtitle = new Map<string, number[]>();
  subtitles.forEach((subtitle, index) => {
    const group = indicesBySubtitle.get(subtitle);
    if (group) group.push(index);
    else indicesBySubtitle.set(subtitle, [index]);
  });

  for (const group of indicesBySubtitle.values()) {
    if (group.length < 2) continue;
    const base = subtitles[group[0]];
    // The best labelling found so far — splits the group, but not completely.
    let bestLabelling: string[] | null = null;
    for (const facet of DISAMBIGUATION_FACETS) {
      // A member with no value for this facet keeps the bare subtitle rather
      // than being labelled with a fact we don't have — it still reads
      // differently from the members that do carry one.
      const labelling = group.map((index) => {
        const value = facet(boards[index]);
        return value === null ? base : `${base} · ${value}`;
      });
      const distinct = new Set(labelling).size;
      if (distinct === group.length) {
        bestLabelling = labelling;
        break;
      }
      // A facet every member shares (or none of them has) separates nothing.
      if (distinct > 1 && bestLabelling === null) bestLabelling = labelling;
    }
    if (bestLabelling === null) continue;
    const chosen = bestLabelling;
    group.forEach((index, position) => {
      subtitles[index] = chosen[position];
    });
  }

  return subtitles;
}

/** Escapes a gym name so it can be matched literally — "Klatring (Bergen)" has metacharacters. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The board's name with a redundant "<gym> - " prefix removed: setters often
 * name a board "Bergen Klatresenter - Kilter", which reads as pure repetition
 * under a heading that already says Bergen Klatresenter. Pairs with the
 * `within-gym` scope above — the name loses the gym, the subtitle leads with the
 * wall.
 *
 * Accepts a hyphen, en dash or em dash as the separator, and leaves the name
 * untouched when the prefix is absent or stripping it would leave nothing.
 */
export function stripGymNamePrefix(boardName: string, gymName: string | null | undefined): string {
  const gym = present(gymName);
  if (gym === null) return boardName;
  const stripped = boardName.replace(new RegExp(`^\\s*${escapeForRegExp(gym)}\\s*[-–—]\\s*`, 'i'), '').trim();
  return stripped || boardName;
}
