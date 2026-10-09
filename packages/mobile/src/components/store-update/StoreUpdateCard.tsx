import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { useStoreUpdateNudge } from '../../lib/store-update/use-store-update-nudge';

function StoreUpdateCardComponent({ enabled, style }: { enabled: boolean; style?: StyleProp<ViewStyle> }) {
  const nudge = useStoreUpdateNudge(enabled);
  const { t } = useTranslation('common');
  const { brandColors, systemColors } = useTheme();
  if (!nudge.stage || !nudge.release) return null;
  const title =
    nudge.stage === 'daily'
      ? t('mobile.storeUpdate.dailyTitle')
      : nudge.stage === 'frequent'
        ? t('mobile.storeUpdate.frequentTitle')
        : t('mobile.storeUpdate.weeklyTitle');
  const body =
    nudge.platform === 'ios'
      ? t('mobile.storeUpdate.iosBody', { version: nudge.release.latestVersion })
      : t('mobile.storeUpdate.androidBody', { version: nudge.release.latestVersion });
  return (
    <View
      testID="store-update-card"
      style={[
        styles.card,
        {
          backgroundColor: systemColors.secondaryBackground,
          borderColor: nudge.stage === 'weekly' ? systemColors.separator : brandColors.primary,
        },
        style,
      ]}
    >
      <View style={styles.header}>
        <Icon name="offline.download" size={22} color={brandColors.primary} />
        <Text variant="headline" accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
      </View>
      <Text variant="subheadline" color={systemColors.secondaryLabel}>
        {body}
      </Text>
      {nudge.openFailed ? (
        <Text variant="footnote" accessibilityRole="alert">
          {t('mobile.storeUpdate.openFailed')}
        </Text>
      ) : null}
      <Button
        title={t('mobile.storeUpdate.update')}
        variant="filled"
        loading={nudge.openingStore}
        disabled={nudge.openingStore}
        onPress={() => {
          void nudge.openStore();
        }}
        testID="store-update-open"
      />
      <Button
        title={t('mobile.storeUpdate.later')}
        variant="text"
        onPress={nudge.acknowledge}
        disabled={nudge.openingStore}
        testID="store-update-later"
      />
      <Button
        title={t('mobile.storeUpdate.stopReminders')}
        variant="text"
        onPress={nudge.turnOffReminders}
        disabled={nudge.openingStore}
        testID="store-update-stop-reminders"
      />
    </View>
  );
}

export const StoreUpdateCard = memo(StoreUpdateCardComponent);
const styles = StyleSheet.create({
  card: { borderRadius: borderRadius.lg, borderWidth: StyleSheet.hairlineWidth, padding: spacing[4], gap: spacing[2] },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  title: { flexShrink: 1 },
});
