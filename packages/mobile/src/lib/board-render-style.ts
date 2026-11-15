import type { BoardRenderSettings } from './board-render-settings';
import type { HoldColorOverrides, HoldShapeOverrides } from './hold-color-overrides';

/** All marker geometry and colours needed to draw a board without preference defaults. */
export type HoldMarkerStyle = {
  overrides: HoldColorOverrides;
  shapes: HoldShapeOverrides;
  brushThickness: number;
  shapeSize: number;
};
/** Read-only per-surface drawing. Keep stable so cached artwork can be reused. */
export type BoardRenderStyle = {
  settings: BoardRenderSettings;
  gridLabels?: boolean;
  holds: HoldMarkerStyle;
};
