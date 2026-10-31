// The December support card at the top of Home (donations plan, initiative 5).
//
// Every rule for when it shows lives in `planSupportCard` (lib/support-asks.ts):
// US iPhones only, 1–7 and 29–31 Dec 2026, two days on
// screen at most, gone after a tap or a close, never during a session or with a
// board connected, and never with "Show support asks" off. It sits in Home's
// list header, above the sections, so it can never cover board art (#7000).
//
// Never in the Expo browser app, although the Account row shows there. The plan
// names the card for US iPhones only, and its two-day cap counts the card and
// the boardsesh.com `/` banner together: a browser climber already gets that
// banner, and the card's per-device count could not see it.
//
// Self-contained on purpose: it subscribes to its own inputs, so mounting it in
// Home's memoised header adds nothing to that header's dependencies.

import { useCallback } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
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
  const focused = useIsFocused();
  const { visible, close } = useSupportCard({
    asksAllowed,
    today,
    sessionActive: sessionId !== null,
    boardConnected,
    focused,
  });

  const give = useCallback(
    (cadence: SupportCadence) => {
      trackSupportLinkTapped('home-card', cadence);
      // A tap is an answer: the card does not come back after the browser closes.
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
