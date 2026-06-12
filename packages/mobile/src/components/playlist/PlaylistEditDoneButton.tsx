import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { GlassSurface } from '../GlassSurface';
import { GlassIconButton } from '../GlassIconButton';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { shadows } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';

const PILL_HEIGHT = glassSize.standard;
const PILL_RADIUS = PILL_HEIGHT / 2;

type PlaylistEditDoneButtonProps = {
  onPress: () => void;
  /** In the collapsed colour-header mode (and on Material's app bar) render as an
   *  icon-only glass FAB to match the other action FABs; expanded, a glass pill
   *  with the "Done" label. */
  collapsed?: boolean;
};

/**
 * Exit-edit-mode control for the owned playlist detail. A Liquid Glass pill —
 * `✓ Done` — that collapses to an icon-only glass FAB once the gradient hero
 * scrolls into the colour header bar (and on the Material app bar). Mirrors
 * `PlaylistFollowButton` so the two share the same chrome.
 */
export function PlaylistEditDoneButton({ onPress, collapsed }: PlaylistEditDoneButtonProps) {
  const { t } = useTranslation('playlists');
  const { systemColors, brandColors, variant } = useTheme();
  const nativeGlass = useNativeGlass();
  const label = t('editClimbs.done');
  const actionColor = variant === 'liquidGlass' ? systemColors.label : brandColors.primary;

  if (collapsed) {
    return (
      <GlassIconButton
        iconName="check.small"
        iconColor={actionColor}
        onPress={onPress}
        accessibilityLabel={label}
        fallbackColor={systemColors.fill}
      />
    );
  }

  return (
    <PressableSurface
      onPress={onPress}
      feedback="scale"
      scaleTo={0.96}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.press}
    >
      <View
        style={[
          styles.pill,
          !nativeGlass && shadows.sm,
          !nativeGlass && { borderWidth: StyleSheet.hairlineWidth, borderColor: systemColors.separator },
        ]}
      >
        <GlassSurface
          glassEffectStyle="regular"
          fallbackColor={systemColors.fill}
          borderRadius={PILL_RADIUS}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <Icon name="check.small" size={18} color={actionColor} />
        <Text variant="subheadline" color={actionColor} style={styles.label}>
          {label}
        </Text>
      </View>
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  press: {
    height: PILL_HEIGHT,
    justifyContent: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    height: PILL_HEIGHT,
    borderRadius: PILL_RADIUS,
    paddingHorizontal: 16,
    gap: 6,
  },
  label: {
    fontWeight: '600',
  },
});
