import { getBoardLayouts, getBoardSetsForLayoutAndSize, getBoardSizesForLayoutId } from './board-catalogue-cascade';
import { cleanLayoutName, formatSizeDimensions } from './board-labels';
import { formatBoardDisplayName, toBoardName } from './board-name';
import { parseSetIds } from './set-ids';

/**
 * A board's setup in words: the options of the "Set up wrong" fields
 * (`setup-selection.ts`) and a one-line summary of a setup for the places that
 * show one (a suggestion staff can use, the admin's before → after).
 *
 * The words come from the bundled catalogue, never from raw ids: an id the
 * catalogue doesn't know is left out rather than shown as a number. Layout,
 * size and hold-set names are catalogue data in English, like everywhere else
 * a board's config is named; only the brand is cleaned off the layout.
 */

/** A layout option: "Kilter Board Original" → "Original", "Tension Board 2 Mirror" → "Mirror". */
export function setupLayoutLabel(boardName: string, layout: { name: string }): string {
  return cleanLayoutName(layout.name, boardName);
}

/** "Full Ride LED Kit" → "Full Ride". The kit, without the words every kit shares. */
function cleanKitDescription(description: string | null | undefined): string {
  return (description ?? '').replace(/\s*LED Kit\s*/i, '').trim();
}

/**
 * A size option. The same dimensions come in several kits (a Kilter Homewall
 * "10x12" is Full Ride, Mainline or Auxiliary), so the kit is part of the
 * label: "10×12 · Full Ride". A size with no kit description reads as its
 * dimensions alone. The app's board builder re-exports it as `formatSizeLabel`.
 */
export function setupSizeLabel(size: { name: string; description?: string | null }): string {
  const dimensions = formatSizeDimensions(size);
  const kit = cleanKitDescription(size.description);
  return kit ? `${dimensions} · ${kit}` : dimensions;
}

/** An angle option: "40°". */
export function setupAngleLabel(angle: number): string {
  return `${angle}°`;
}

/** The setup a summary describes: `BoardSetup` / `BoardSetupInput`, or a board's own fields. */
export type BoardSetupLabelInput = {
  layoutId: number;
  sizeId: number;
  /** Comma-separated, as the API carries it, or already parsed. */
  setIds: string | number[];
  /** Only for a board that doesn't tilt; null or absent leaves it out. */
  angle?: number | null;
};

/** Each part of a setup in words, or null for a part the catalogue doesn't know. */
export type BoardSetupLabelParts = {
  layout: string | null;
  size: string | null;
  /** The hold sets in catalogue order, the unknown ones left out. */
  sets: string[];
  angle: string | null;
};

/** The parts of a setup in words. All null for a board type this build doesn't know. */
export function boardSetupLabelParts(boardType: string, setup: BoardSetupLabelInput): BoardSetupLabelParts {
  const angle = setup.angle == null ? null : setupAngleLabel(setup.angle);
  const boardName = toBoardName(boardType);
  if (boardName === null) return { layout: null, size: null, sets: [], angle };
  const layout = getBoardLayouts(boardName).find((candidate) => candidate.id === setup.layoutId) ?? null;
  const size = getBoardSizesForLayoutId(boardName, setup.layoutId).find((candidate) => candidate.id === setup.sizeId);
  const selectedSetIds = new Set(parseSetIds(setup.setIds));
  const sets = getBoardSetsForLayoutAndSize(boardName, setup.layoutId, setup.sizeId)
    .filter((set) => selectedSetIds.has(set.id))
    .map((set) => set.name.trim())
    .filter((name) => name.length > 0);
  return {
    layout: layout ? setupLayoutLabel(boardName, layout) : null,
    size: size ? setupSizeLabel(size) : null,
    sets,
    angle,
  };
}

/**
 * A setup on one line: "Original · 12×14 · Commercial · Bolt Ons, Screw Ons · 40°".
 * Falls back to the board type's name when the catalogue knows none of it.
 */
export function boardSetupSummary(boardType: string, setup: BoardSetupLabelInput): string {
  const parts = boardSetupLabelParts(boardType, setup);
  const words = [parts.layout, parts.size, parts.sets.length > 0 ? parts.sets.join(', ') : null, parts.angle].filter(
    (part): part is string => part !== null,
  );
  return words.length > 0 ? words.join(' · ') : formatBoardDisplayName(boardType);
}
