import React, { useCallback } from 'react';
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
  /** Start a remix onto the holds that are there now. Omitted where remix cannot be reached. */
  onRemix?: () => void;
};

/**
 * "Two holds on this climb are gone" (epic #5346, SW-13).
 *
 * A climb that lost holds in a reset stays FINDABLE and stays PLAYABLE — it is
 * still someone's problem, it still holds its ticks and its grade history, and
 * the wall it was set on is the wall in front of you minus a couple of holds.
 * What it is not is climbable as written, and nothing else on this screen would
 * say so: the board simply draws fewer painted holds than the setter chose, which
 * reads as a short climb rather than a broken one.
 *
 * So the banner states the number and offers the one thing that fixes it. It is
 * not a warning strip and not a blocker — it sits above the board, states a fact,
 * and gets out of the way.
 */
export const LostHoldsBanner = React.memo(function LostHoldsBanner({ count, onRemix }: LostHoldsBannerProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();

  const handleRemix = useCallback(() => onRemix?.(), [onRemix]);

  if (!(count > 0)) return null;

  return (
    <View
      style={[styles.banner, { backgroundColor: systemColors.secondaryBackground }]}
      accessibilityRole="summary"
      testID="lost-holds-banner"
    >
      <Icon name="frame.remove" size={16} color={systemColors.secondaryLabel} />
      <View style={styles.copy}>
        <Text variant="footnote">{t('mobile.lostHolds.banner', { count })}</Text>
        {onRemix ? (
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('mobile.lostHolds.bannerBody')}
          </Text>
        ) : null}
      </View>
      {onRemix ? (
        <Button title={t('mobile.lostHolds.remix')} variant="tonal" size="small" onPress={handleRemix} />
      ) : null}
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
    gap: 1,
  },
});
