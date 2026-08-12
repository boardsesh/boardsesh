import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { Text } from './Text';
import { Button } from './Button';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import type { OfflineQueryReason } from '../hooks/use-offline-query-state';

type OfflineStateProps = {
  /**
   * `'offline'` says the device has no signal; `'error'` says the request
   * reached the network and failed. Pass `useOfflineQueryState(...).reason`.
   */
  reason: OfflineQueryReason;
  /** Retry handler — usually the query's `refetch`. Omit to hide the button. */
  onRetry?: () => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * The placard a network-only screen shows instead of a spinner that never
 * resolves or an empty list that claims the climber has nothing. Paired with
 * `useOfflineQueryState`: when it reports `isBlocked`, render this.
 *
 * Deliberately says what still works offline rather than only what does not —
 * downloaded boards keep browsing, searching and logging, and people who hit
 * this screen with no signal need to know that.
 */
function OfflineStateComponent({ reason, onRetry, style }: OfflineStateProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();

  const isOffline = reason === 'offline';

  return (
    <View style={[styles.root, style]}>
      <Icon name={isOffline ? 'offline.unavailable' : 'warning'} size={44} color={systemColors.tertiaryLabel} />
      <Text variant="headline" color={systemColors.label} style={styles.title}>
        {t(isOffline ? 'mobile.offlineState.title' : 'mobile.offlineState.errorTitle')}
      </Text>
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.body}>
        {t(isOffline ? 'mobile.offlineState.body' : 'mobile.offlineState.errorBody')}
      </Text>
      {onRetry ? (
        <View style={styles.cta}>
          <Button title={t('mobile.offlineState.retry')} variant="tonal" onPress={onRetry} />
        </View>
      ) : null}
    </View>
  );
}

export const OfflineState = memo(OfflineStateComponent);

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    paddingVertical: spacing[10],
    paddingHorizontal: spacing[8],
  },
  title: { textAlign: 'center', marginTop: spacing[2] },
  body: { textAlign: 'center', maxWidth: 420 },
  cta: { marginTop: spacing[3] },
});
