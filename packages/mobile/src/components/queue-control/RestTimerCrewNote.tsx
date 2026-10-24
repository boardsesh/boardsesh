// The line that tells a climber the rest timer is the crew's (#5382). In the
// sheet: "Your crew shares this rest timer. Changes here go to everyone in the
// session." On the Record tab's arm row: "Turns it on or off for everyone in
// this session." And, on either, when the crew's clock uses something this app
// cannot run, that it needs an update to follow it.
//
// Only in a crew: a lone climber's session clock is theirs alone, and saying
// "everyone" there would read as a warning about nobody.

import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useIsCrewSession } from '../../providers/queue-provider';
import { useCrewRestStatus } from '../../hooks/use-effective-rest-pacing';
import { TICK_GUTTER } from '../tick/tick-sheet-metrics';
import { spacing } from '../../theme/tokens';

export function RestTimerCrewNote({ placement }: { placement: 'sheet' | 'armRow' }) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const status = useCrewRestStatus();
  const isCrewSession = useIsCrewSession();

  const note =
    status === 'unsupported'
      ? t('mobile.restTimer.crew.unsupported')
      : !isCrewSession
        ? null
        : placement === 'armRow'
          ? t('mobile.restTimer.crew.armNote')
          : status === 'shared'
            ? t('mobile.restTimer.crew.sheetNote')
            : null;
  if (note === null) return null;

  return (
    <Text
      variant="footnote"
      color={systemColors.secondaryLabel}
      style={placement === 'sheet' ? styles.sheetNote : styles.armRowNote}
      testID="rest-timer-crew-note"
    >
      {note}
    </Text>
  );
}

const styles = StyleSheet.create({
  sheetNote: {
    paddingHorizontal: TICK_GUTTER,
    paddingTop: spacing[2],
    textAlign: 'center',
  },
  armRowNote: {
    paddingHorizontal: TICK_GUTTER,
    paddingBottom: spacing[2],
  },
});
