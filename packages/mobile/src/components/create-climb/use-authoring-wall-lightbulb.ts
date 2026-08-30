import { useMemo } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import { useSprayWallLedsEnabled } from '../../lib/spray/use-spray-wall-leds-enabled';
import { offersBoardLightbulb } from './spray-climb-rules';
import type { AuthoringWallControl } from './use-authoring-wall-control';

export type AuthoringLightbulb = Pick<
  AuthoringWallControl,
  'connected' | 'pending' | 'onPress' | 'accessibilityLabel' | 'drivingAccessibilityLabel'
>;

/** Surface eligibility belongs with transport policy, including configured wall LEDs. */
export function useAuthoringWallLightbulb(
  board: { boardName: BoardName; layoutId: number },
  control: AuthoringWallControl,
): AuthoringLightbulb | undefined {
  const sprayLedsEnabled = useSprayWallLedsEnabled(board.boardName, board.layoutId);
  const visible = control.available && offersBoardLightbulb(board.boardName, sprayLedsEnabled);
  return useMemo(
    () =>
      visible
        ? {
            connected: control.connected,
            pending: control.pending,
            onPress: control.onPress,
            accessibilityLabel: control.accessibilityLabel,
            drivingAccessibilityLabel: control.drivingAccessibilityLabel,
          }
        : undefined,
    [
      visible,
      control.connected,
      control.pending,
      control.onPress,
      control.accessibilityLabel,
      control.drivingAccessibilityLabel,
    ],
  );
}
