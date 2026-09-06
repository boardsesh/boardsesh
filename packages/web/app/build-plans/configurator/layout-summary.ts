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

export type CncLayoutSummary = {
  wallWidthMm: number | null;
  wallHeightMm: number | null;
  kickerHeightMm: number | null;
  panelCount: number | null;
  sheets: number | null;
  tnutCount: number | null;
  ledCount: number | null;
  skippedSeamLeds: number | null;
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
    sheets: readNumber(bom, 'sheets'),
    tnutCount: readNumber(bom, 'tnut_count'),
    ledCount: readNumber(bom, 'led_count'),
    skippedSeamLeds: readNumber(bom, 'skipped_seam_leds'),
    warnings: Array.isArray(warnings) ? warnings.filter((entry): entry is string => typeof entry === 'string') : [],
  };
}
