import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';

export type LostHoldsBannerProps = {
  /** `Climb.missingHoldCount`. The banner is not rendered below 1. */
  count: number;
  /** Start a remix onto the holds that are on the wall now. Omitted where a remix cannot start (an archived wall). */
  onRemix?: () => void;
};

/**
 * "This climb lost a hold." A spray climb whose wall lost a hold it used stays
 * listed, playable and loggable: it still holds its ticks and its grade
 * history. Nothing else on this screen would say why the board draws fewer holds
 * than the setter painted, which reads as a short climb rather than a changed
 * one. So the banner says so, quietly, and offers the one fix: Remix, through
 * the same route as the climb actions' Remix.
 *
 * Not a warning strip and not a blocker: it sits above the board and gets out
 * of the way.
 */
export const LostHoldsBanner = React.memo(function LostHoldsBanner({ count, onRemix }: LostHoldsBannerProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();

  if (!(count > 0)) return null;

  return (
    <View
      style={[styles.banner, { backgroundColor: systemColors.secondaryBackground }]}
      accessibilityRole="summary"
      testID="lost-holds-banner"
    >
      <Icon name="frame.remove" size={16} color={systemColors.secondaryLabel} />
      <Text variant="footnote" style={styles.copy}>
        {t('mobile.lostHolds.banner')}
      </Text>
      {onRemix ? <Button title={t('mobile.lostHolds.remix')} variant="tonal" size="small" onPress={onRemix} /> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    marginHorizontal: spacing[4],
    marginTop: spacing[1],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.lg,
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
});
