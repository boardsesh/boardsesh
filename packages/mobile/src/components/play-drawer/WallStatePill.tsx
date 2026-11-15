import { memo } from 'react';
import { useWallDriver } from './use-wall-driver';
import { WallStatePillView, type WallStatePillProps } from './WallStatePillView';
export {
  BACK_CHIP_WIDTH_WITH_FACE,
  BACK_CHIP_WIDTH_ARROW_ONLY,
  useWallStatePillAccessibility,
} from './WallStatePillView';
export type { WallStatePillState } from './WallStatePillView';
export const WallStatePill = memo(function WallStatePill(props: WallStatePillProps) {
  const { driver, name } = useWallDriver();
  return <WallStatePillView {...props} driver={driver} driverName={name} />;
});
