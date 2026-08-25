import { memo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { Button } from '../Button';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { hapticSelection } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';

/**
 * The "On the Wall" tab's empty state — a FALLBACK only. Board presence binds for
 * every climber with an active board, so `WallScreen`'s `isWallLive` gate is
 * normally already satisfied and the kiosk renders instead; this shows when the
 * board's render data can't be resolved or presence isn't bound.
 *
 * Climber voice, a board-shaped bulb glyph (no AI art), and a single CTA. On a
 * wall WITH lights it opens the device picker via the Bluetooth context's
 * `connect()` (hidden when no context is mounted — nothing to connect to). On a
 * wall flagged as having no light kit there is nothing to connect to at all, so
 * the CTA takes the wall instead; that branch reads `hasLeds` straight off the
 * active board so it doesn't depend on the BLE provider being mounted.
 */
function WallEmptyStateComponent() {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const bluetooth = useOptionalBluetoothContext();
  // Optional-field contract: only an explicit `hasLeds: false` is ledless, so a
  // missing/stale flag keeps the Bluetooth connect CTA.
  const { data: activeBoard } = useActiveBoard();
  const ledless = activeBoard?.hasLeds === false;
  const takeVirtualWall = bluetooth?.takeVirtualWall;

  const handleConnect = useCallback(() => {
    hapticSelection();
    void bluetooth?.connect();
  }, [bluetooth]);

  // No hapticSelection here: taking the wall is a state change, and
  // `takeVirtualWall` fires its own hapticLight with the "You've got the wall"
  // toast. A second buzz on the same tap reads as a stutter.
  const handleTakeWall = useCallback(() => {
    takeVirtualWall?.();
  }, [takeVirtualWall]);

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing[10], paddingBottom: insets.bottom + spacing[8] }]}>
      <Icon name="lightbulb" size={48} color={systemColors.tertiaryLabel} />
      <Text variant="title2" color={systemColors.label} style={styles.title}>
        {t('mobile.boardPresence.wallEmptyTitle')}
      </Text>
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.body}>
        {ledless ? t('mobile.boardPresence.wallEmptyBodyNoLeds') : t('mobile.boardPresence.wallEmptyBody')}
      </Text>
      {/* `ledless` comes from the stored board rather than the Bluetooth context,
          so the COPY is right even before the provider mounts. The button still
          needs something to call, though — rendering one that silently does
          nothing is worse than rendering none. */}
      {ledless && takeVirtualWall ? (
        <View style={styles.cta}>
          <Button
            title={t('mobile.boardPresence.wallEmptyCtaNoLeds')}
            variant="filled"
            icon="pin"
            onPress={handleTakeWall}
            // The handler stays silent so `takeVirtualWall`'s own hapticLight is
            // the single buzz for this tap.
            haptic={false}
          />
        </View>
      ) : null}
      {!ledless && bluetooth ? (
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
