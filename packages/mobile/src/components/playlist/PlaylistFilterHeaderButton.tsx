import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassIconButton } from '../GlassIconButton';
import { useTheme } from '../../providers/theme-provider';

type PlaylistFilterHeaderButtonProps = {
  /** Filters in force: the badge, and part of the spoken label. */
  activeCount: number;
  onPress: () => void;
};

/**
 * The ≡ filter button in the playlist header. On Liquid Glass it joins the
 * header capsule once the hero (and the chip row under it) scrolls away; on
 * Material it sits in the app bar outside edit mode. Opens the same filter sheet
 * as the chip row's Filters capsule, and says the same thing.
 */
export const PlaylistFilterHeaderButton = memo(function PlaylistFilterHeaderButton({
  activeCount,
  onPress,
}: PlaylistFilterHeaderButtonProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  return (
    <GlassIconButton
      iconName="filter"
      iconColor={systemColors.label}
      onPress={onPress}
      badgeCount={activeCount}
      accessibilityLabel={
        activeCount > 0 ? t('mobile.search.filterCountAria', { count: activeCount }) : t('mobile.search.filters')
      }
      fallbackColor={systemColors.fill}
    />
  );
});
