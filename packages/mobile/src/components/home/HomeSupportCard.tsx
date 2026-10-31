// The monthly support card at the top of Home (donations plan, initiative 5).
//
// Every rule for when it shows lives in `planSupportCard` (lib/support-asks.ts):
// US iPhones only, days 1 to 7 of each month, on every Home visit until closed,
// hidden for the rest of the month after a close or a tap on either Give
// button, never during a session or with a board connected, and never with
// "Show support asks" off. It sits in Home's list header, above the sections,
// so it can never cover board art (#7000).
//
// Never in the Expo browser app, although the Account row shows there: a
// browser climber already gets the boardsesh.com `/` banner on the same days.
//
// Self-contained on purpose: it subscribes to its own inputs, so mounting it in
// Home's memoised header adds nothing to that header's dependencies.

import { useCallback } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { Card } from '../Card';
import { ChromeIconButton } from '../ChromeIconButton';
import { Text } from '../Text';
import { useToday } from '../../hooks/use-today';
import { trackSupportLinkTapped } from '../../lib/analytics-support-link';
import { useBluetoothConnectedStatus } from '../../lib/ble/bluetooth-status-store';
import { supportUrlFor, type SupportCadence } from '../../lib/donation-links';
import { openExternalUrl } from '../../lib/open-url';
import { useSupportAsksAllowed, useSupportCard } from '../../lib/support-asks';
import { useQueueSessionId } from '../../providers/queue-provider';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

export function HomeSupportCard() {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const asksAllowed = useSupportAsksAllowed() && Platform.OS !== 'web';
  const { sessionId } = useQueueSessionId();
  const boardConnected = useBluetoothConnectedStatus();
  const today = useToday();
  const { visible, close } = useSupportCard({
    asksAllowed,
    today,
    sessionActive: sessionId !== null,
    boardConnected,
  });

  const give = useCallback(
    (cadence: SupportCadence) => {
      trackSupportLinkTapped('home-card', cadence);
      // A tap counts like a close: the app cannot see whether the climber gave,
      // so the card stays away until next month.
      close();
      void openExternalUrl(supportUrlFor('home-card', cadence), 'home-support-card');
    },
    [close],
  );
  const giveMonthly = useCallback(() => give('monthly'), [give]);
  const giveOnce = useCallback(() => give('once'), [give]);

  if (!visible) return null;

  return (
    <View style={styles.frame} testID="home-support-card">
      <Card>
        <View style={styles.titleRow}>
          <Text variant="headline" style={styles.title}>
            {t('mobile.supportAsks.cardTitle')}
          </Text>
          <ChromeIconButton
            icon="close"
            appearance="bare"
            onPress={close}
            accessibilityLabel={t('mobile.supportAsks.hideCard')}
            testID="home-support-card-close"
          />
        </View>
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.body}>
          {t('mobile.supportAsks.cardBody')}
        </Text>
        <View style={styles.actions}>
          <Button
            testID="home-support-card-once"
            title={t('mobile.supportAsks.giveOnce')}
            onPress={giveOnce}
            variant="text"
            size="small"
          />
          <Button
            testID="home-support-card-monthly"
            title={t('mobile.supportAsks.giveMonthly')}
            onPress={giveMonthly}
            variant="filled"
            size="small"
          />
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[5],
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  title: {
    flex: 1,
  },
  body: {
    marginTop: spacing[1],
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing[2],
    marginTop: spacing[3],
  },
});
