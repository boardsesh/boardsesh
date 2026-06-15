import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { formatActiveBoardLabel } from '../../lib/boards/active-board-label';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { hapticLight } from '../../lib/haptics';
import { glassSize } from '../../theme/layout';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { Icon } from '../Icon';

const CAPSULE_RADIUS = glassSize.capsule / 2;

type BoardPillProps = {
  /** What a tap does — open the board switcher. */
  onPress: () => void;
  /** Optional VoiceOver hint (e.g. "Opens the board switcher" on Discover). */
  accessibilityHint?: string;
};

/**
 * The centered glass capsule naming the active board ("Kilter • M • 45°", or
 * "Garage Wall • 40°" for a named board). Reads the active board itself and
 * renders nothing when none is set. Shared by the Climbs and Discover chromes —
 * the caller injects what a tap does, the haptic fires here.
 */
export function BoardPill({ onPress, accessibilityHint }: BoardPillProps) {
  const { systemColors } = useTheme();
  const nativeGlass = useNativeGlass();
  const { data: activeBoard } = useActiveBoard();

  const boardLabel = useMemo(() => {
    return formatActiveBoardLabel(activeBoard);
  }, [activeBoard]);

  const handlePress = useCallback(() => {
    hapticLight();
    onPress();
  }, [onPress]);

  if (!boardLabel) return null;

  return (
    <PressableSurface
      onPress={handlePress}
      feedback="scale"
      scaleTo={0.96}
      accessibilityRole="button"
      accessibilityLabel={boardLabel}
      accessibilityHint={accessibilityHint}
      style={styles.press}
    >
      <View
        style={[
          styles.capsule,
          !nativeGlass && { borderWidth: StyleSheet.hairlineWidth, borderColor: systemColors.separator },
        ]}
      >
        <GlassSurface
          glassEffectStyle="regular"
          fallbackColor={systemColors.elevatedSurface}
          borderRadius={CAPSULE_RADIUS}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <Icon name="boards" size={14} color={systemColors.secondaryLabel} />
        <Text
          variant="caption1"
          numberOfLines={1}
          ellipsizeMode="tail"
          color={systemColors.secondaryLabel}
          style={styles.text}
        >
          {boardLabel}
        </Text>
      </View>
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  press: {
    height: glassSize.capsule,
    maxWidth: 180,
    alignItems: 'center',
    justifyContent: 'center',
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    height: glassSize.capsule,
    borderRadius: CAPSULE_RADIUS,
    paddingHorizontal: 14,
    gap: 6,
  },
  text: {
    fontWeight: '500',
    flexShrink: 1,
  },
});
