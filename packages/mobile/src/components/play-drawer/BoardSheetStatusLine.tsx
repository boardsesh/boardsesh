import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { Text } from '../Text';
import type { BoardSheetStatus } from './wall-control';
import { useWindowSecondsLeft } from './WallWindowClock';

/**
 * The player's board sheet's status line (spec B3), uncapped at every text
 * size: "Preview · not on the wall", "On the wall", "Each pick lights · 38
 * seconds left", or the open-ended drive's sentence. A leaf, so the window's
 * 1 Hz count re-renders only this line while the sheet is open.
 */
function BoardSheetStatusLineComponent({ status }: { status: BoardSheetStatus }) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const clock = useWindowSecondsLeft(1);
  let line: string | null;
  switch (status) {
    case 'preview':
      line = t('playView.wallControl.sheetStatusPreview');
      break;
    case 'on_wall':
      line = t('playView.wallControl.onWall');
      break;
    case 'window':
      // The button's two runs, the clock in words. Before the clock's first read there is no count yet.
      line = clock
        ? `${t('playView.wallControl.eachPickLights')} · ${t('playView.wallControl.secondsLeft', { count: clock.secondsLeft })}`
        : null;
      break;
    case 'driving':
      line = t('playView.wallControl.sheetStatusDriving');
      break;
  }
  if (!line) return null;
  return (
    <Text variant="subheadline" color={systemColors.secondaryLabel} testID="ble-control-status">
      {line}
    </Text>
  );
}

export const BoardSheetStatusLine = memo(BoardSheetStatusLineComponent);
