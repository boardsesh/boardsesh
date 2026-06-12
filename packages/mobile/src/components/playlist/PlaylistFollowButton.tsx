import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { GlassSurface } from '../GlassSurface';
import { GlassIconButton } from '../GlassIconButton';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { useTheme } from '../../providers/theme-provider';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { shadows } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';

const PILL_HEIGHT = glassSize.standard;
const PILL_RADIUS = PILL_HEIGHT / 2;

type PlaylistFollowButtonProps = {
  isFollowing: boolean;
  onToggle: () => void;
  loading?: boolean;
  /** In the collapsed colour-header mode, render as an icon-only glass FAB to
   *  match the other action FABs; expanded, it's a glass pill with a label. */
  collapsed?: boolean;
};

/**
 * Follow / unfollow control for the public playlist detail. A Liquid Glass pill
 * — `+ Follow` → `✓ Following` — that collapses to an icon-only glass FAB once
 * the gradient hero scrolls into the colour header bar. The parent owns the
 * optimistic flip + follower-count update.
 */
export function PlaylistFollowButton({ isFollowing, onToggle, loading, collapsed }: PlaylistFollowButtonProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const nativeGlass = useNativeGlass();
  const iconName = isFollowing ? 'check.small' : 'person.badge.plus';
  const label = isFollowing ? t('follow.following') : t('follow.follow');

  if (collapsed) {
    return (
      <GlassIconButton
        iconName={iconName}
        iconColor={systemColors.label}
        onPress={onToggle}
        disabled={loading}
        accessibilityLabel={label}
        fallbackColor={systemColors.fill}
      />
    );
  }

  return (
    <PressableSurface
      onPress={onToggle}
      disabled={loading}
      feedback="scale"
      scaleTo={0.96}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityState={{ selected: isFollowing }}
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
        {loading ? <ActivityIndicator size="small" /> : <Icon name={iconName} size={18} color={systemColors.label} />}
        <Text variant="subheadline" color={systemColors.label} style={styles.label}>
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
