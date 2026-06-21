// Human-readable labels for the board builder. Raw board-config data is verbose
// ("Kilter Board Original") and repeats dimensions across kits, so we clean
// layout names and fold the size's kit description ("Full Ride") into its label.
// Ports the display cleanup from the backend's formatDisplayName
// (packages/backend/src/graphql/resolvers/social/boards.ts) — minus the
// abbreviations, since a builder wants readable names, not compact ones.

// Trademark-correct board type names (CLAUDE.md).
const BOARD_LABELS: Record<string, string> = {
  kilter: 'Kilter',
  tension: 'Tension',
  moonboard: 'MoonBoard',
  decoy: 'Decoy',
  touchstone: 'Touchstone',
  grasshopper: 'Grasshopper',
  soill: 'So iLL',
};

export function boardTypeLabel(boardName: string): string {
  return BOARD_LABELS[boardName] ?? boardName.charAt(0).toUpperCase() + boardName.slice(1);
}

/**
 * "Kilter Board Original" → "Original", "Tension Board 2 Mirror" → "Mirror".
 * Strips the board-type prefix, "Board", "Layout", and a leading "2" (Tension
 * Board 2), keeping the distinctive part. Falls back to the raw name.
 */
export function cleanLayoutName(rawName: string, boardName: string): string {
  const label = boardTypeLabel(boardName);
  const cleaned = rawName
    .replace(new RegExp(`\\b${label}\\b`, 'gi'), '')
    .replace(/\bBoard\b/gi, '')
    .replace(/\bLayout\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^2\s+/, '');
  return cleaned || rawName;
}

function cleanDimensions(name: string): string {
  return name
    .replace(/\s*high\s*/gi, '')
    .replace(/\s*wide\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*x\s*/i, '×');
}

function cleanKitDescription(description: string | null | undefined): string {
  return (description ?? '').replace(/\s*LED Kit\s*/i, '').trim();
}

/**
 * Size chip label. The same dimensions repeat with different kits (Kilter
 * Homewall "10x12" is sold as Full Ride / Mainline / Auxiliary), so the kit
 * description must be surfaced to disambiguate: "10×12 · Full Ride". Sizes with
 * no kit description (Tension, Kilter Original) render just the dimensions.
 */
export function formatSizeLabel(size: { name: string; description?: string | null }): string {
  const dimensions = cleanDimensions(size.name);
  const kit = cleanKitDescription(size.description);
  return kit ? `${dimensions} · ${kit}` : dimensions;
}

/** Just the dimensions of a size, e.g. "12×12" — for use inside a board name. */
export function formatSizeDimensions(size: { name: string }): string {
  return cleanDimensions(size.name);
}

/**
 * A suggested board name from the owner + config, e.g. "Marco's Kilter Original
 * 12×12". Drops the possessive when there's no name. Used as the create-form
 * placeholder and the fallback when the user leaves the name blank.
 */
export function formatDefaultBoardName(params: {
  userName?: string | null;
  boardName: string;
  /** Raw layout name (cleaned internally). */
  layoutName: string;
  size?: { name: string } | null;
}): string {
  const { userName, boardName, layoutName, size } = params;
  const config = [
    boardTypeLabel(boardName),
    cleanLayoutName(layoutName, boardName),
    size ? formatSizeDimensions(size) : '',
  ]
    .filter(Boolean)
    .join(' ');
  const owner = userName?.trim();
  return owner ? `${owner}'s ${config}` : config;
}
