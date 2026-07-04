import { memo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { Button } from '../Button';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';

/**
 * The "On the Wall" tab's empty state — shown whenever no board is bound over
 * Bluetooth, which is the common case. Climber voice, a board-shaped bulb glyph
 * (no AI art), and a single CTA that opens the existing device picker via the
 * Bluetooth context's `connect()`. When no Bluetooth context is mounted the CTA
 * is hidden (nothing to connect to).
 */
function WallEmptyStateComponent() {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const bluetooth = useOptionalBluetoothContext();

  const handleConnect = useCallback(() => {
    hapticSelection();
    void bluetooth?.connect();
  }, [bluetooth]);

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing[10], paddingBottom: insets.bottom + spacing[8] }]}>
      <Icon name="lightbulb" size={48} color={systemColors.tertiaryLabel} />
      <Text variant="title2" color={systemColors.label} style={styles.title}>
        {t('mobile.boardPresence.wallEmptyTitle')}
      </Text>
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.body}>
        {t('mobile.boardPresence.wallEmptyBody')}
      </Text>
      {bluetooth ? (
        <View style={styles.cta}>
          <Button
            title={t('mobile.boardPresence.wallEmptyCta')}
            variant="filled"
            icon="lightbulb"
            onPress={handleConnect}
          />
        </View>
      ) : null}
    </View>
  );
}

export const WallEmptyState = memo(WallEmptyStateComponent);

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[8],
  },
  title: {
    textAlign: 'center',
  },
  body: {
    textAlign: 'center',
    maxWidth: 420,
  },
  cta: {
    marginTop: spacing[4],
  },
});
