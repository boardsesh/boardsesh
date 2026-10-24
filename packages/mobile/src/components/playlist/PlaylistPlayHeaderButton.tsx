import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassIconButton } from '../GlassIconButton';
import { useTheme } from '../../providers/theme-provider';

type PlaylistPlayHeaderButtonProps = {
  onPress: () => void;
};

/**
 * The Play button in the Liquid Glass playlist header: plays the list from its
 * first row, the same as Material's app-bar play action (#6667). Sits in the
 * header capsule next to ≡ and the playlist's own controls.
 */
export const PlaylistPlayHeaderButton = memo(function PlaylistPlayHeaderButton({
  onPress,
}: PlaylistPlayHeaderButtonProps) {
  const { t } = useTranslation('playlists');
  const { systemColors } = useTheme();
  return (
    <GlassIconButton
      iconName="play.fill"
      iconColor={systemColors.label}
      onPress={onPress}
      accessibilityLabel={t('detail.activateAll')}
      fallbackColor={systemColors.fill}
    />
  );
});
