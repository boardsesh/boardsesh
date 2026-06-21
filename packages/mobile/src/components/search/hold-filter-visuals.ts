import type { HoldFilterType } from '@boardsesh/shared-schema';
import {
  DEFAULT_HOLD_MARKER_SHAPE,
  getEffectiveHoldRoleShape,
  type HoldColorOverrideRole,
  type HoldMarkerShape,
  type HoldShapeOverrides,
} from '../../lib/hold-color-overrides';

function isHoldRoleFilterType(type: HoldFilterType): type is HoldColorOverrideRole {
  return type !== 'ANY';
}

export function getHoldFilterTypeShape(type: HoldFilterType, shapeOverrides: HoldShapeOverrides): HoldMarkerShape {
  return isHoldRoleFilterType(type) ? getEffectiveHoldRoleShape(type, shapeOverrides) : DEFAULT_HOLD_MARKER_SHAPE;
}
