import { useTranslation } from 'react-i18next';
import { GlassActionToolbar, GlassToolbarAction } from '../chrome';
import { Icon } from '../Icon';
import { iosSystemColors } from '../../theme/ios-colors';
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
 * The island floats over the colour hero, so every glyph is white — the single
 * vibrant tint Apple prescribes for glass controls over colour content. Pin
 * state is carried by the glyph (pin vs pin.fill), not a colour.
 */
export function PlaylistOwnerToolbar({ isPinned, onTogglePin, onEdit, onDelete }: PlaylistOwnerToolbarProps) {
  const { t } = useTranslation('playlists');

  return (
    <GlassActionToolbar actionCount={3}>
      <GlassToolbarAction
        onPress={() => {
          hapticSelection();
          onTogglePin();
        }}
        accessibilityLabel={isPinned ? t('library.pin.unpinAriaLabel') : t('library.pin.pinAriaLabel')}
      >
        <Icon name={isPinned ? 'pin.fill' : 'pin'} size={22} color={iosSystemColors.white} />
      </GlassToolbarAction>
      <GlassToolbarAction onPress={onEdit} accessibilityLabel={t('detail.menu.editClimbs')}>
        <Icon name="edit" size={22} color={iosSystemColors.white} />
      </GlassToolbarAction>
      <GlassToolbarAction onPress={onDelete} accessibilityLabel={t('detail.menu.delete')}>
        <Icon name="delete" size={22} color={iosSystemColors.white} />
      </GlassToolbarAction>
    </GlassActionToolbar>
  );
}
