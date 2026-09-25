import { useTranslation } from 'react-i18next';
import { GlassActionToolbar, GlassToolbarAction } from '../chrome';
import { Icon } from '../Icon';
import { iosSystemColors } from '../../theme/ios-colors';
import { useTheme } from '../../providers/theme-provider';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { hapticSelection } from '../../lib/haptics';

type PlaylistOwnerToolbarProps = {
  isPinned: boolean;
  onTogglePin: () => void;
  /** Enter the climbs edit mode (reorder + remove). */
  onEdit: () => void;
  onDelete: () => void;
};

/**
 * Owner action island for the expanded playlist hero: pin · edit · delete, in a
 * single floating glass toolbar (the same vocabulary the Climbs / Discover
 * chromes use). Collapses to a single overflow ⋯ once the hero scrolls away —
 * the caller swaps this out for that icon at the collapsed breakpoint.
 *
 * Only on real iOS 26 Liquid Glass (`useNativeGlass()`) does the island float as
 * clear glass over the colour hero, where white is the single vibrant tint Apple
 * prescribes for glass controls over colour content. Every other surface mode —
 * the solid fallback (Reduce Transparency, or Android) and the iOS < 26 blur — is
 * an opaque/near-opaque pill, so white glyphs vanish; those paths use
 * `systemColors.label`, same as every other `GlassActionToolbar` icon. Pin state
 * is carried by the glyph (pin vs pin.fill), not a colour.
 */
export function PlaylistOwnerToolbar({ isPinned, onTogglePin, onEdit, onDelete }: PlaylistOwnerToolbarProps) {
  const { t } = useTranslation('playlists');
  const { systemColors } = useTheme();
  const nativeGlass = useNativeGlass();
  const iconColor = nativeGlass ? iosSystemColors.white : systemColors.label;

  return (
    <GlassActionToolbar actionCount={3}>
      <GlassToolbarAction
        onPress={() => {
          hapticSelection();
          onTogglePin();
        }}
        accessibilityLabel={isPinned ? t('library.pin.unpinAriaLabel') : t('library.pin.pinAriaLabel')}
      >
        <Icon name={isPinned ? 'pin.fill' : 'pin'} size={22} color={iconColor} />
      </GlassToolbarAction>
      <GlassToolbarAction onPress={onEdit} accessibilityLabel={t('detail.menu.editClimbs')}>
        <Icon name="edit" size={22} color={iconColor} />
      </GlassToolbarAction>
      <GlassToolbarAction onPress={onDelete} accessibilityLabel={t('detail.menu.delete')}>
        <Icon name="delete" size={22} color={iconColor} />
      </GlassToolbarAction>
    </GlassActionToolbar>
  );
}
