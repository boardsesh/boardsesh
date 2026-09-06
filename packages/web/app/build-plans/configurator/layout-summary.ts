/**
 * Reading the generator's layout response without pretending to model it.
 *
 * `cncLayout` returns opaque JSON on purpose (see the note on `GET_CNC_LAYOUT`
 * in `@boardsesh/graphql`): the shape is the pack generator's own
 * `LayoutResponse`, it is snake_case Python, and it grows as the generator
 * learns to build more walls. Mirroring it field by field would make every
 * generator change a coordinated four-package deploy.
 *
 * So this module narrows only the handful of numbers the summary card shows,
 * and treats every one of them as optional. A generator that adds a field is
 * invisible here; a generator that renames one costs a missing row in a
 * summary, not a crashed configurator.
 */

/**
 * One cut panel, as much of it as the placement form needs.
 *
 * `index` is what a placement names, so it is the only field that must be
 * right; the rest is what turns "panel 3" into a label a person can point at on
 * their own wall. Every field the generator might rename is optional — see the
 * module note.
 */
export type CncLayoutPanel = {
  index: number;
  /** The generator's own id, e.g. "R1C2". Null when it did not send one. */
  id: string | null;
  /** `main` or `kicker`. Null when the generator did not say. */
  role: string | null;
  widthMm: number | null;
  heightMm: number | null;
};

export type CncLayoutSummary = {
  wallWidthMm: number | null;
  wallHeightMm: number | null;
  kickerHeightMm: number | null;
  panelCount: number | null;
  sheets: number | null;
  tnutCount: number | null;
  ledCount: number | null;
  skippedSeamLeds: number | null;
  /** Every panel, in the generator's own order. Empty when the response had none. */
  panels: CncLayoutPanel[];
  warnings: string[];
};

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNumber(source: Record<string, unknown> | null, key: string): number | null {
  if (!source) return null;
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  if (!source) return null;
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Narrow the panel list.
 *
 * A panel with no numeric `index` is dropped: the index is what a placement
 * points at, and an item routed onto a panel we cannot name is worse than one
 * the buyer never got to place.
 */
function readPanels(panels: unknown): CncLayoutPanel[] {
  if (!Array.isArray(panels)) return [];
  const parsed: CncLayoutPanel[] = [];
  for (const entry of panels) {
    const panel = readRecord(entry);
    const index = readNumber(panel, 'index');
    if (index === null) continue;
    parsed.push({
      index,
      id: readString(panel, 'id'),
      role: readString(panel, 'role'),
      widthMm: readNumber(panel, 'width_mm'),
      heightMm: readNumber(panel, 'height_mm'),
    });
  }
  return parsed;
}

/**
 * Pull the summary numbers out of a layout response.
 *
 * Returns a summary with every field null rather than throwing on a payload it
 * does not recognise: the card renders the rows it has and stays quiet about
 * the rest, which is the right behaviour for a preview that exists to build
 * confidence before a purchase.
 */
export function readLayoutSummary(layout: unknown): CncLayoutSummary {
  const root = readRecord(layout);
  const wall = readRecord(root?.wall);
  const bom = readRecord(root?.bom_preview);
  const panels = root?.panels;
  const warnings = root?.warnings;

  return {
    wallWidthMm: readNumber(wall, 'width_mm'),
    wallHeightMm: readNumber(wall, 'height_mm'),
    kickerHeightMm: readNumber(wall, 'kicker_height_mm'),
    panelCount: Array.isArray(panels) ? panels.length : null,
    panels: readPanels(panels),
    sheets: readNumber(bom, 'sheets'),
    tnutCount: readNumber(bom, 'tnut_count'),
    ledCount: readNumber(bom, 'led_count'),
    skippedSeamLeds: readNumber(bom, 'skipped_seam_leds'),
    warnings: Array.isArray(warnings) ? warnings.filter((entry): entry is string => typeof entry === 'string') : [],
  };
}
