import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { hapticLight } from '../../lib/haptics';
import { useShowcaseAnchor } from '../../lib/showcase-anchor';
import { spacing } from '../../theme/tokens';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Badge } from '../Badge';

type MaterialAppBarTitleProps = {
  /** The destination's name: "Discover", "Climbs", the climber's name on Profile. */
  title: string;
  /** The context the destination shows (the active board), on a second line. */
  subtitle?: string | null;
  /** Makes the whole title block a button, e.g. the board switcher. A subtitle then gets a down-caret. */
  onPress?: () => void;
  /** TalkBack hint for the button. */
  accessibilityHint?: string;
  /** Brand-coloured dot on the caret: the one-time onboarding cue. */
  badge?: boolean;
  /** Screenshot mode only: log this block's rect as the showcase video's `board-history-button`. */
  showcaseAnchor?: boolean;
};

/**
 * The Material app bar title, used by every root tab through `MaterialTopAppBar`
 * so the title starts at the same inset everywhere. The headline names the
 * screen; a subtitle carries what it is scoped to. When pressable, the whole
 * block is one target spanning the bar's height, read as "Discover, Kilter • M".
 * Takes the slot `Appbar.Content` would, `flex: 1`.
 */
export function MaterialAppBarTitle({
  title,
  subtitle,
  onPress,
  accessibilityHint,
  badge = false,
  showcaseAnchor = false,
}: MaterialAppBarTitleProps) {
  const { systemColors, brandColors } = useTheme();
  // PressableSurface takes onLayout but no ref; the anchor measures the event's target.
  const { onLayout: anchorOnLayout } = useShowcaseAnchor('board-history-button', showcaseAnchor);

  const handlePress = useCallback(() => {
    if (!onPress) return;
    hapticLight();
    onPress();
  }, [onPress]);

  const text = (
    <View style={styles.text}>
      <Text variant="title2" numberOfLines={1} ellipsizeMode="tail" color={systemColors.label}>
        {title}
      </Text>
      {subtitle ? (
        <View style={styles.subtitleRow}>
          <Text
            variant="subheadline"
            numberOfLines={1}
            ellipsizeMode="tail"
            color={systemColors.secondaryLabel}
            style={styles.subtitle}
          >
            {subtitle}
          </Text>
          {onPress ? (
            <View style={styles.caret}>
              <Icon name="chevron.down" size={16} color={systemColors.secondaryLabel as string} />
              {badge ? (
                // Rides the caret's top-right so it reads as "tap here". The Appbar
                // row doesn't clip, so the corner offset is safe.
                <View style={styles.badge} pointerEvents="none">
                  <Badge visible color={brandColors.primary} size="small" />
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  if (!onPress) {
    return (
      <View style={styles.block} accessible accessibilityRole="header">
        {text}
      </View>
    );
  }

  return (
    <PressableSurface
      onPress={handlePress}
      feedback="none"
      rippleColor={systemColors.fill as string}
      accessibilityRole="button"
      accessibilityLabel={[title, subtitle].filter(Boolean).join(', ')}
      accessibilityHint={accessibilityHint}
      style={styles.block}
      onLayout={anchorOnLayout}
    >
      {text}
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  // Fills the row left of the trailing actions; the text shrinks and truncates
  // so the actions are never pushed off-screen. alignSelf stretch overrides the
  // Appbar's alignItems:'center' so a pressable title spans the bar's height.
  // No start padding: the leading avatar's 48dp slot ends at the M3 56dp title
  // inset, the same on every tab.
  block: {
    flex: 1,
    alignSelf: 'stretch',
    justifyContent: 'center',
    paddingEnd: spacing[1],
    minWidth: 0,
  },
  text: {
    minWidth: 0,
  },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  subtitle: {
    flexShrink: 1,
  },
  // Anchors the onboarding badge to the caret, not the full-width row.
  caret: {
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
  },
});
