import { StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Badge as PaperBadge } from 'react-native-paper';
import { Text } from './Text';
import { iosSystemColors } from '../theme/ios-colors';
import { createVariantComponent } from '../theme/variants';

type BadgeProps = {
  count?: number;
  visible?: boolean;
  color?: string;
  size?: 'small' | 'medium';
};

/**
 * Badge routes to a Material 3 `Badge` on the Material variant, and to the
 * existing animated Liquid-Glass dot/count badge on the Liquid Glass variant.
 * The public prop API is identical for both, so call sites never change.
 */
export const Badge = createVariantComponent('Badge', { liquidGlass: BadgeGlass, material: BadgeMaterial });

function BadgeMaterial({ count, visible = true, color = iosSystemColors.systemRed, size = 'medium' }: BadgeProps) {
  const isDot = count === undefined || count === 0;
  const displayCount = count && count > 99 ? '99+' : String(count ?? '');

  // Paper renders a dot when it has no children; pass the count otherwise.
  // `size` is a numeric diameter in Paper — mirror the glass dot/count sizing.
  const badgeSize = size === 'small' ? 8 : isDot ? 10 : 18;

  return (
    <PaperBadge visible={visible} size={badgeSize} style={{ backgroundColor: color }}>
      {isDot ? undefined : displayCount}
    </PaperBadge>
  );
}

// Liquid Glass badge — the original animated implementation, unchanged.
function BadgeGlass({ count, visible = true, color = iosSystemColors.systemRed, size = 'medium' }: BadgeProps) {
  if (!visible) return null;

  const isDot = count === undefined || count === 0;
  const displayCount = count && count > 99 ? '99+' : String(count ?? '');

  const badgeSize = size === 'small' ? 8 : isDot ? 10 : 18;
  const minWidth = isDot ? badgeSize : Math.max(badgeSize, displayCount.length * 8 + 10);

  const accessibilityLabel = isDot ? undefined : `${displayCount}`;

  return (
    <Animated.View
      entering={FadeIn.springify().damping(15).stiffness(200)}
      exiting={FadeOut.duration(150)}
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.badge,
        {
          backgroundColor: color,
          height: badgeSize,
          minWidth,
          borderRadius: badgeSize / 2,
        },
      ]}
    >
      {!isDot && (
        <Text variant="caption2" color={iosSystemColors.white} style={styles.text}>
          {displayCount}
        </Text>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  text: {
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 13,
  },
});
