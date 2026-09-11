// Where a climber turns the rest timer on (#5378). Mounted TWICE on the Record
// tab — once before a session starts, once during one — because that is where
// the decision is made: "turn it on for the session I'm in, or the one I'm about
// to start".
//
// A pre-session arm carries into the session on its own: `armRestTimer` accepts
// a null session id and `RestTimerSessionSync` binds it when the session appears.
// So this never has to wait for a session to exist.

import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Card } from '../Card';
import { Text } from '../Text';
import { SwitchRow } from '../SwitchRow';
import { useTheme } from '../../providers/theme-provider';
import { useQueueSessionId } from '../../providers/queue-provider';
import { useRestTimerArmed } from '../../hooks/use-rest-timer';
import { getSetting } from '../../settings';
import { nowMs } from '../../lib/clock';
import { armRestTimer, disarmRestTimer } from '../../lib/rest-timer-store';
import { RestTimerClock } from '../queue-control/RestTimerPill';
import { RestTimerAutoAdvanceRow, RestTimerLengthControl } from '../queue-control/RestTimerSheet';
import { spacing } from '../../theme/tokens';

/**
 * The arm switch plus, once armed, the two controls a climber actually changes
 * mid-session (rest length, auto-advance) and the live clock — so the Record tab
 * is not the one screen that cannot see its own timer. Cadence stays in the
 * sheet: it is a set-once choice, and changing it re-arms.
 */
export function RestTimerArmRow() {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const armed = useRestTimerArmed();
  const { sessionId } = useQueueSessionId();

  const handleArm = useCallback(
    (next: boolean) => {
      if (!next) {
        disarmRestTimer();
        return;
      }
      // `getSetting` rather than `useSetting`: the cadence is read once, at the
      // moment of arming, and subscribing here would re-render the Record tab's
      // list header for a preference this row does not display.
      armRestTimer(getSetting('restTimerMode'), nowMs(), sessionId);
    },
    [sessionId],
  );

  return (
    <Card>
      <View style={styles.headerRow}>
        <Text variant="headline" color={systemColors.label} style={styles.title}>
          {t('mobile.restTimer.title')}
        </Text>
        {/* Its own leaf, so the 1 Hz tick never re-renders this card or the list
            header that holds it. */}
        <RestTimerClock variant="headline" />
      </View>
      <SwitchRow
        label={t('mobile.restTimer.armLabel')}
        description={t('mobile.restTimer.armDescription')}
        value={armed}
        onValueChange={handleArm}
      />
      {armed ? (
        <View style={styles.controls}>
          <RestTimerLengthControl inset={false} />
          <RestTimerAutoAdvanceRow />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[2],
    marginBottom: spacing[1],
  },
  title: {
    flexShrink: 1,
  },
  controls: {
    gap: spacing[3],
    marginTop: spacing[2],
  },
});
