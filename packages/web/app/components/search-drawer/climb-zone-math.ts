/**
 * The zone-rectangle geometry now lives in the shared `@boardsesh/climb-filters`
 * package so web and mobile share one implementation. This module re-exports it
 * so existing relative imports (`../climb-zone-math`) keep working.
 *
 * The shared functions are typed against {@link import('@boardsesh/shared-schema').ZoneBoxInput},
 * which is structurally identical to the web `ZoneBox` alias, so call sites that
 * pass a `ZoneBox` continue to type-check.
 */
export {
  buildDefaultZone,
  clampZoneBox,
  applyDrag,
  gridToSvg,
  svgToGrid,
  computeHandleRadius,
  isHoldInsideZone,
  pruneHoldsToZone,
  type BoardEdges,
  type DragMode,
  type BoardDimensions,
  type HoldPositionLookup,
} from '@boardsesh/climb-filters';
