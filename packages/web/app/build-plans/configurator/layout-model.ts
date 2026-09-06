import { readNumber, readPanels, readRecord, readString, type CncLayoutPanel } from './layout-summary';
import type { HoleMm, PanelRectMm, SeamLineMm } from './placement-editor/geometry';

/**
 * The rest of the layout response: the parts the placement editor draws.
 *
 * `layout-summary.ts` narrows the handful of numbers a summary card shows; this
 * narrows the geometry an editor needs — panels with corners, seams, the hole
 * grid and the clearances around it. Same rule as over there, and it matters
 * more here: every field is optional, a payload we do not recognise gives empty
 * arrays rather than an exception, and the editor renders what it got.
 *
 * An empty hole list is a normal state, not a failure. The hole-bearing layout
 * query is authenticated and rate-limited, so a signed-out buyer places their
 * label against panels and seams alone and gets the drill pattern the moment
 * they sign in. Drawing no holes is honest about that; inventing some would not
 * be.
 */

/** The clearances the generator enforces, so the editor can draw and check the same ones. */
export type CncLayoutKeepout = {
  panelEdgeMarginMm: number;
  /** How much more room a cut-through item needs around a hole. */
  cutThroughMultiplier: number;
};

/** Overall wall dimensions, in wall millimetres. */
export type CncLayoutWall = {
  widthMm: number;
  heightMm: number;
  /** Height of the kicker row, which hangs below `y = 0`. Zero when there is no kicker. */
  kickerHeightMm: number;
};

/** What the editor needs out of a layout response, all of it already checked. */
export type CncLayoutModel = {
  wall: CncLayoutWall | null;
  panels: CncLayoutPanel[];
  /** Panels complete enough to place artwork on, in the layout's own order. */
  panelRects: PanelRectMm[];
  holes: HoleMm[];
  /** Every hole with the panel it belongs to, so the editor can show one panel's grid. */
  holePanelIndex: number[];
  seams: SeamLineMm[];
  keepout: CncLayoutKeepout;
};

/**
 * Clearances used when the generator did not publish its own.
 *
 * Restated from `PANEL_EDGE_MARGIN_MM` and `CUT_THROUGH_KEEPOUT_MULTIPLIER` in
 * the generator's `layout/models.py`. Only ever reached by a response missing
 * the block; the generator re-checks every placement at checkout either way, so
 * a drift here costs a redundant nudge rather than an unroutable pack.
 */
export const CNC_FALLBACK_KEEPOUT: CncLayoutKeepout = {
  panelEdgeMarginMm: 15,
  cutThroughMultiplier: 1.5,
};

/** Panels that carry a full rectangle. A panel with no corner cannot be placed on. */
function readPanelRects(panels: readonly CncLayoutPanel[]): PanelRectMm[] {
  const rects: PanelRectMm[] = [];
  for (const panel of panels) {
    if (panel.xMm === null || panel.yMm === null || panel.widthMm === null || panel.heightMm === null) continue;
    rects.push({
      index: panel.index,
      xMm: panel.xMm,
      yMm: panel.yMm,
      widthMm: panel.widthMm,
      heightMm: panel.heightMm,
    });
  }
  return rects;
}

/**
 * The hole list.
 *
 * Holes come back without ids — the generator will not tell the browser which
 * hold is which — so each one is named by its position in the list. That is
 * enough for what the id is for here: keying a circle and pointing at the ones
 * a label has landed on.
 */
function readHoles(raw: unknown): { holes: HoleMm[]; holePanelIndex: number[] } {
  if (!Array.isArray(raw)) return { holes: [], holePanelIndex: [] };
  const holes: HoleMm[] = [];
  const holePanelIndex: number[] = [];
  raw.forEach((entry, position) => {
    const hole = readRecord(entry);
    const xMm = readNumber(hole, 'x_mm');
    const yMm = readNumber(hole, 'y_mm');
    const keepoutRadiusMm = readNumber(hole, 'keepout_radius_mm');
    const panelIndex = readNumber(hole, 'panel_index');
    if (xMm === null || yMm === null || keepoutRadiusMm === null || panelIndex === null) return;
    holes.push({
      id: `${readString(hole, 'kind') ?? 'hole'}-${String(position)}`,
      xMm,
      yMm,
      keepoutRadiusMm,
    });
    holePanelIndex.push(panelIndex);
  });
  return { holes, holePanelIndex };
}

/** Seams, dropped unless they carry both a position and an extent. */
function readSeams(raw: unknown): SeamLineMm[] {
  if (!Array.isArray(raw)) return [];
  const seams: SeamLineMm[] = [];
  for (const entry of raw) {
    const seam = readRecord(entry);
    const kind = readString(seam, 'kind');
    if (kind !== 'vertical' && kind !== 'horizontal') continue;
    const valueMm = readNumber(seam, kind === 'vertical' ? 'x_mm' : 'y_mm');
    const extent = seam?.extent;
    if (valueMm === null || !Array.isArray(extent) || extent.length < 2) continue;
    const [start, end] = extent;
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    seams.push({ kind, valueMm, extent: [start, end] });
  }
  return seams;
}

function readKeepout(raw: unknown): CncLayoutKeepout {
  const keepout = readRecord(raw);
  return {
    panelEdgeMarginMm: readNumber(keepout, 'panel_edge_margin_mm') ?? CNC_FALLBACK_KEEPOUT.panelEdgeMarginMm,
    cutThroughMultiplier: readNumber(keepout, 'cut_through_multiplier') ?? CNC_FALLBACK_KEEPOUT.cutThroughMultiplier,
  };
}

function readWall(raw: unknown): CncLayoutWall | null {
  const wall = readRecord(raw);
  const widthMm = readNumber(wall, 'width_mm');
  const heightMm = readNumber(wall, 'height_mm');
  if (widthMm === null || heightMm === null) return null;
  return { widthMm, heightMm, kickerHeightMm: readNumber(wall, 'kicker_height_mm') ?? 0 };
}

/** Narrow a layout response down to what the editor draws. Never throws. */
export function readLayoutModel(layout: unknown): CncLayoutModel {
  const root = readRecord(layout);
  const panels = readPanels(root?.panels);
  const { holes, holePanelIndex } = readHoles(root?.holes);
  return {
    wall: readWall(root?.wall),
    panels,
    panelRects: readPanelRects(panels),
    holes,
    holePanelIndex,
    seams: readSeams(root?.seams),
    keepout: readKeepout(root?.keepout),
  };
}
