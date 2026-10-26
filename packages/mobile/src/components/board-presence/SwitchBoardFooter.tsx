import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

type SwitchBoardFooterProps = {
  /** The board the climber is on now, under "Switch board". Omitted until known. */
  boardLabel?: string | null;
  onPress: () => void;
  /** Room under the row, so it clears the home indicator. */
  bottomPadding: number;
};

/**
 * The "Switch board" row at the foot of a column: the wall column's footer and
 * the landscape iPad player's side panel (where Music keeps AirPlay).
 */
export const SwitchBoardFooter = memo(function SwitchBoardFooter({
  boardLabel,
  onPress,
  bottomPadding,
}: SwitchBoardFooterProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('mobile.boardPresence.switchBoardAria')}
      style={[
        styles.footer,
        {
          borderTopColor: systemColors.separator,
          paddingBottom: bottomPadding,
          backgroundColor: systemColors.secondaryBackground,
        },
      ]}
    >
      <View style={[styles.footerIcon, { backgroundColor: systemColors.secondaryBackground }]}>
        <Icon name="transfer" size={20} color={systemColors.label} />
      </View>
      <View style={styles.footerText}>
        <Text variant="body" color={systemColors.label}>
          {/* Stays "Switch board": the gym's own boards live behind the wall
            column's header title, so this is the way out to every board anywhere. */}
          {t('mobile.boardPresence.switchBoard')}
        </Text>
        {boardLabel ? (
          <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
            {boardLabel}
          </Text>
        ) : null}
      </View>
      <Icon name="chevron.right" size={16} color={systemColors.secondaryLabel} />
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerText: {
    flex: 1,
    gap: 2,
  },
});
