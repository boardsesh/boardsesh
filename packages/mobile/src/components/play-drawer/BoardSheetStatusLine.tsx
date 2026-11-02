import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { materialSurfaces } from '../../theme/colors';
import { Text } from '../Text';
import { spokenCaption } from './track-label-text';
import type { BoardSheetStatus } from './wall-control';
import { formatWindowClock, windowTimeValue } from './wall-control-text';
import { useWindowSecondsLeft } from './WallWindowClock';

/**
 * The player's board sheet's status line (spec B3), uncapped at every text
 * size: "Preview · not on the wall", "On the wall", "You are driving the wall
 * · Stops in 0:38" (Put on board's timed drive, its clock as the button draws
 * it, so a 5 minute drive reads 4:47 rather than 287 seconds), or the
 * open-ended drive's sentence. A leaf, so the timed drive's 1 Hz count re-renders only
 * this line while the sheet is open. It is the
 * full-size fallback for the capped wall button, so it takes Velvet's opaque
 * secondary label, as the top bar's preview line does, and a screen reader
 * hears the "·" as a pause. The timed drive's spoken form keeps the button's 10 s
 * step (spec B2.2): focus lands here when the sheet opens, and TalkBack
 * re-reads a focused node's changed label, so a 1 Hz label would talk over
 * the climber the whole time.
 */
function BoardSheetStatusLineComponent({ status }: { status: BoardSheetStatus }) {
  const { t } = useTranslation('session');
  const { colorScheme } = useTheme();
  const clock = useWindowSecondsLeft(1);
  const spokenClock = useWindowSecondsLeft(10);
  let line: string | null;
  let spoken: string | null = null;
  switch (status) {
    case 'preview':
      line = t('playView.wallControl.sheetStatusPreview');
      break;
    case 'on_wall':
      line = t('playView.wallControl.onWall');
      break;
    case 'window':
      // The button's two runs, its clock in m:ss. Before the clock's first read there is no count yet.
      line = clock
        ? `${t('playView.wallControl.youAreDriving')} · ${t('playView.wallControl.stopsInClock', { clock: formatWindowClock(clock.secondsLeft * 1000) })}`
        : null;
      spoken = spokenClock
        ? `${t('playView.wallControl.youAreDriving')}, ${windowTimeValue(spokenClock.secondsLeft * 1000, t)}`
        : null;
      break;
    case 'driving':
      line = t('playView.wallControl.sheetStatusDriving');
      break;
  }
  if (!line) return null;
  return (
    <Text
      variant="subheadline"
      // iOS's translucent secondaryLabel measures 3.44:1 on a white sheet.
      color={materialSurfaces[colorScheme].secondaryLabel}
      accessibilityLabel={spoken ?? spokenCaption(line)}
      testID="ble-control-status"
    >
      {line}
    </Text>
  );
}

export const BoardSheetStatusLine = memo(BoardSheetStatusLineComponent);
