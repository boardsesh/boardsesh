import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { formatActiveBoardLabel } from '../../lib/boards/active-board-label';
import { hapticLight } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Badge } from '../Badge';

type BoardSwitcherButtonProps = {
  /** What a tap does — open the board switcher (the `/boards` modal). */
  onPress: () => void;
  /** VoiceOver / TalkBack hint, e.g. "Opens the board switcher". */
  accessibilityHint?: string;
  /** Show a brand-coloured dot near the trailing caret — the one-time onboarding
   *  cue pointing a new user at this control. */
  badge?: boolean;
};

/**
 * The Material variant's board switcher: the active board label ("Kilter • M •
 * 45°", or "Garage Wall • 40°" for a named board) shown as the app-bar title
 * with a trailing down-caret affordance, so it reads as a tappable context
 * switcher rather than the static subtitle it replaces. It is the flat M3
 * counterpart of the liquid-glass `BoardToolbarAction` — reads the active board
 * itself, renders nothing when none is set, and fires the haptic here while the
 * caller injects what a tap does. Lives where `Appbar.Content` did, `flex: 1`.
 */
export function BoardSwitcherButton({ onPress, accessibilityHint, badge = false }: BoardSwitcherButtonProps) {
  const { systemColors, brandColors } = useTheme();
  const { data: activeBoard } = useActiveBoard();

  const boardLabel = useMemo(() => formatActiveBoardLabel(activeBoard), [activeBoard]);

  const handlePress = useCallback(() => {
    hapticLight();
    onPress();
  }, [onPress]);

  if (!boardLabel) return null;

  return (
    <PressableSurface
      onPress={handlePress}
      feedback="none"
      rippleColor={systemColors.fill as string}
      accessibilityRole="button"
      accessibilityLabel={boardLabel}
      accessibilityHint={accessibilityHint}
      style={styles.press}
    >
      <Text variant="title3" numberOfLines={1} ellipsizeMode="tail" color={systemColors.label} style={styles.label}>
        {boardLabel}
      </Text>
      <View style={styles.caret}>
        <Icon name="chevron.down" size={18} color={systemColors.secondaryLabel as string} />
        {badge ? (
          // The dot rides the top-right of the trailing caret so it reads as "tap
          // here". The Appbar row doesn't clip, so the corner offset is safe.
          <View style={styles.badge} pointerEvents="none">
            <Badge visible color={brandColors.primary} size="small" />
          </View>
        ) : null}
      </View>
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  // Fills the row left of the trailing actions (where Appbar.Content sat); the
  // label flex-shrinks and truncates so the caret stays visible and the actions
  // are never pushed off-screen. alignSelf stretch overrides the Appbar's
  // alignItems:'center' so the tap target spans the full app-bar height, not just
  // the label line. paddingLeft lands the title near the M3 16dp margin (the
  // Appbar adds its own ~4dp), aligning it with the search row below.
  press: {
    flex: 1,
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    paddingLeft: spacing[3],
    paddingRight: spacing[1],
  },
  label: {
    flexShrink: 1,
  },
  // Anchors the onboarding badge to the trailing caret (not the full-width row),
  // so the dot sits over the affordance the climber taps.
  caret: {
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
  },
});
