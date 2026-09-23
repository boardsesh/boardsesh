import { memo, useCallback } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { useTheme } from '../../providers/theme-provider';
import { hapticMedium } from '../../lib/haptics';
import { androidRipple, spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { glassSize } from '../../theme/layout';

const PILL_ICON_SIZE = 18;
/** German and French run long here; shrink a little before the label truncates. */
const PILL_MIN_FONT_SCALE = 0.8;

type FirstConnectPillProps = {
  /** A connect is in flight: the bulb swaps for a spinner and taps are ignored. */
  pending: boolean;
  /** The bulb's own tap: `useLightbulbControl().onPress`, the one connect path. */
  onPress: () => void;
};

/**
 * The connect-step pill (#5654, PR 7, treatment only): the play view's bulb
 * with a label on it, "Light it on the board". It takes the second row's right
 * end, where share and queue sat (both move into ⋯), and runs exactly the tap
 * the bulb runs. Filled, but the tick in the row above stays the hero: this row
 * is smaller and sits below it. The label's font scale is capped like the other
 * chrome labels, so large text grows it without pushing the row apart.
 */
function FirstConnectPillComponent({ pending, onPress }: FirstConnectPillProps) {
  const { t } = useTranslation('boards');
  const { brandColors } = useTheme();
  const label = t('mobile.firstConnect.pill');

  const handlePress = useCallback(() => {
    if (pending) return;
    hapticMedium();
    onPress();
  }, [pending, onPress]);

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: pending }}
      android_ripple={androidRipple(brandColors.onPrimary)}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: brandColors.primaryFill },
        pressed && styles.pillPressed,
      ]}
    >
      {pending ? (
        <ActivityIndicator size="small" color={brandColors.onPrimary} />
      ) : (
        <Icon name="lightbulb" size={PILL_ICON_SIZE} color={brandColors.onPrimary} />
      )}
      <Text
        variant="subheadline"
        color={brandColors.onPrimary}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={PILL_MIN_FONT_SCALE}
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.label}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export const FirstConnectPill = memo(FirstConnectPillComponent);

const styles = StyleSheet.create({
  pill: {
    height: glassSize.inline,
    borderRadius: glassSize.inline / 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    flexShrink: 1,
    overflow: 'hidden',
  },
  pillPressed: {
    opacity: 0.6,
    transform: [{ scale: 0.96 }],
  },
  label: {
    fontWeight: '600',
    flexShrink: 1,
  },
});
