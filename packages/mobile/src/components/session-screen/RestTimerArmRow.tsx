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
import { SwitchRow } from '../SwitchRow';
import { useQueueSessionId } from '../../providers/queue-provider';
import { useRestTimerArmed } from '../../hooks/use-rest-timer';
import { getSetting } from '../../settings';
import { nowMs } from '../../lib/clock';
import { armRestTimer, disarmRestTimer } from '../../lib/rest-timer-store';
import {
  RestTimerAutoAdvanceRow,
  RestTimerCadenceSection,
  RestTimerLengthControl,
} from '../queue-control/RestTimerSheet';
import { spacing } from '../../theme/tokens';

/**
 * The arm switch plus, once armed, the controls a climber sets a session up
 * with: rest length, cadence and auto-advance. Cadence lives here as well as in
 * the sheet (#5664): this card is where a fixed-window block ("a boulder every
 * 3:00") gets set up, and without the choice here the timer could only ever run
 * "after each send", restarting on every attempt. Changing it re-arms the live
 * timer — the section itself handles that.
 */
export function RestTimerArmRow() {
  const { t } = useTranslation('session');
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
      {/* No clock above the switch. This card is where you TURN THE TIMER ON;
          the running count belongs to the pill that floats over every tab, and a
          second copy sitting above its own on/off switch just competed with it. */}
      <SwitchRow
        label={t('mobile.restTimer.armLabel')}
        description={t('mobile.restTimer.armDescription')}
        value={armed}
        onValueChange={handleArm}
      />
      {armed ? (
        <View style={styles.controls}>
          {/* `inset={false}`: the length control pulls back out through the
              card's own 16pt padding so its rail bleeds to the card edge, then
              re-applies the gutter to its header, chips and footnote. */}
          <RestTimerLengthControl inset={false} />
          <RestTimerCadenceSection inset={false} />
          <RestTimerAutoAdvanceRow />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  // No gap / top margin of its own: the length control's SectionHeader brings
  // the section's top rhythm and the SwitchRow its own vertical padding, so a
  // second spacing layer here just doubles both seams.
  controls: {
    marginTop: spacing[1],
  },
});
