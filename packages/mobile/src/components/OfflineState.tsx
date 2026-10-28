import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { Text } from './Text';
import { Button } from './Button';
import { useTheme } from '../providers/theme-provider';
import { selectEffectiveOffline, useConnectivityField } from '../lib/connectivity/use-connectivity';
import { spacing } from '../theme/tokens';
import type { OfflineQueryReason } from '../hooks/use-offline-query-state';

type OfflineStateProps = {
  /**
   * Who is at fault: `'offline'` the phone with no signal, `'offline_mode'` a
   * switch the climber flipped themselves, `'backend_unreachable'` us being
   * down, `'error'` a request that reached a reachable server and failed
   * anyway. Pass `useOfflineQueryState(...).reason`.
   */
  reason: OfflineQueryReason;
  /**
   * The `'error'` title naming what failed ("Couldn't load your sessions"), in
   * place of the generic "Couldn't load this". Pass a whole translated sentence,
   * not a noun to splice in: the verb agrees with the subject in es/fr/de.
   */
  errorTitle?: string;
  /**
   * Retry handler — usually the query's `refetch`. Rendered only when nothing
   * else owns the retry: for `'error'`, and for `'backend_unreachable'` while
   * the connectivity store has not declared an outage (a timeout or 5xx the
   * query saw first, so no banner is up yet). React Query refetches its own
   * paused queries on the reconnect edge, and the global connectivity banner
   * owns the retry once the store says we are offline.
   */
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
 * this screen with no signal need to know that. And it blames the right side:
 * telling a climber with four bars they have "no signal" while our own server is
 * the thing that is down sends them off rebooting their router (issue #4862).
 */
function OfflineStateComponent({ reason, errorTitle, onRetry, style }: OfflineStateProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const effectiveOffline = useConnectivityField(selectEffectiveOffline);
  const showRetry =
    onRetry !== undefined && (reason === 'error' || (reason === 'backend_unreachable' && !effectiveOffline));

  // One branch per reason, with literal `t()` keys — the i18n linter rejects a
  // computed key, and the icon travels with the copy because it carries half of
  // the same "whose fault is this" message.
  const placard = (() => {
    switch (reason) {
      case 'backend_unreachable':
        return {
          iconName: 'server.unreachable' as const,
          title: t('mobile.offlineState.serverTitle'),
          body: t('mobile.offlineState.serverBody'),
        };
      case 'offline_mode':
        return {
          iconName: 'offline.unavailable' as const,
          title: t('mobile.offlineState.offlineModeTitle'),
          body: t('mobile.offlineState.offlineModeBody'),
        };
      case 'error':
        return {
          iconName: 'warning' as const,
          title: errorTitle ?? t('mobile.offlineState.errorTitle'),
          body: t('mobile.offlineState.errorBody'),
        };
      default:
        return {
          iconName: 'offline.unavailable' as const,
          title: t('mobile.offlineState.title'),
          body: t('mobile.offlineState.body'),
        };
    }
  })();

  return (
    <View style={[styles.root, style]}>
      <Icon name={placard.iconName} size={44} color={systemColors.tertiaryLabel} />
      <Text variant="headline" color={systemColors.label} style={styles.title}>
        {placard.title}
      </Text>
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.body}>
        {placard.body}
      </Text>
      {showRetry ? (
        <View style={styles.cta}>
          {/* Filled: on a dead-end screen this is the only way forward. */}
          <Button title={t('mobile.offlineState.retry')} variant="filled" onPress={onRetry} />
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
