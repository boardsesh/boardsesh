// Subtitles for every surface that lists boards (the Boards-tab carousels, My
// Boards, the gym directory, the Bluetooth quickstart sheet).
//
// The server sends `layoutName`, `sizeName`, `sizeDescription` and `setNames` as
// null on every UserBoard (see enrichBoard in
// packages/backend/src/graphql/resolvers/social/boards.ts), so a subtitle built
// from those fields always collapsed to the raw board type — two Kilter boards
// at two locations both read "kilter". Everything needed to tell them apart is
// already on the wire (gym, location, layout/size ids, angle, serial) and the
// layout/size name tables ship in @boardsesh/board-constants, so we resolve the
// names on the device instead. Works offline, no round-trip.

import { toBoardName } from '@boardsesh/board-config';
import { getLayoutName, getProductSize } from '@boardsesh/board-constants';
import { boardTypeLabel, cleanLayoutName, formatSizeDimensions } from './board-builder-labels';

/**
 * The board fields these labels read. Structural rather than `UserBoard` so a
 * partially-populated board (a BLE-resolved hit, an offline snapshot row) works
 * without casting.
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

/** Trimmed value, or null for null/undefined/blank. Blank strings come back from the API. */
function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Where the board is: the linked gym, else the free-text location. Matches the
 * ordering BoardDisambiguationSheet and the board-detail sheet already use.
 */
export function boardPlaceLabel(board: BoardLabelSource): string | null {
  return present(board.gymName) ?? present(board.locationName);
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
export function boardRowSubtitle(board: BoardLabelSource): string {
  return boardPlaceLabel(board) ?? boardConfigLabel(board) ?? boardTypeLabel(board.boardType);
}

/**
 * Facets tried, in order, when two boards in the same list land on the same
 * subtitle. Place first (a different wall in the same gym), then the physical
 * config, then how it is set up, then the serial as the last resort — two boards
 * can share everything else but never a serial.
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
export function disambiguateBoardSubtitles(boards: BoardLabelSource[]): string[] {
  const subtitles = boards.map(boardRowSubtitle);

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
