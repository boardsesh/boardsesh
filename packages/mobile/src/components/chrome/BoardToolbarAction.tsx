import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { formatActiveBoardLabel } from '../../lib/boards/active-board-label';
import { hapticLight } from '../../lib/haptics';
import { Icon } from '../Icon';
import { Badge } from '../Badge';
import { GlassToolbarAction } from './GlassActionToolbar';

type BoardToolbarActionProps = {
  /** What a tap does — open the board switcher. */
  onPress: () => void;
  /** Optional VoiceOver hint (e.g. "Opens the board switcher"). */
  accessibilityHint?: string;
  /** Show a brand-coloured dot at the top-right — the one-time onboarding cue
   *  pointing a new user at this control. */
  badge?: boolean;
};

/**
 * The board glyph toolbar button — the one glass board control, docked in the
 * right toolbar beside the lightbulb. Reads the active board itself and renders
 * nothing when none is set. The full board label ("Kilter • M • 45°") is the
 * VoiceOver label so the glyph stays self-describing; tapping opens the board
 * switcher (the caller injects what that does, the haptic fires here). Replaces
 * the old centred board pill, so the board never shows in a large centred form.
 */
export function BoardToolbarAction({ onPress, accessibilityHint, badge = false }: BoardToolbarActionProps) {
  const { systemColors, brandColors } = useTheme();
  const { data: activeBoard } = useActiveBoard();

  const boardLabel = useMemo(() => formatActiveBoardLabel(activeBoard), [activeBoard]);

  const handlePress = useCallback(() => {
    hapticLight();
    onPress();
  }, [onPress]);

  if (!boardLabel) return null;

  return (
    <GlassToolbarAction onPress={handlePress} accessibilityLabel={boardLabel} accessibilityHint={accessibilityHint}>
      <Icon name="boards" size={23} color={systemColors.label} />
      {badge ? (
        // Unclipped overlay so the parent toolbar's rounded corner can't crop the
        // dot. The enclosing GlassActionToolbar clips (overflow:hidden), so the
        // corner badge nudges inward (top/right 2) to stay fully visible.
        <View style={styles.badge} pointerEvents="none">
          <Badge visible color={brandColors.primary} size="small" />
        </View>
      ) : null}
    </GlassToolbarAction>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: 2,
    right: 2,
  },
});
