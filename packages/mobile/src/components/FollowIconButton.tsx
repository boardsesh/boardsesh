import { useTranslation } from 'react-i18next';
import { GlassIconButton } from './GlassIconButton';
import { useTheme } from '../providers/theme-provider';

type FollowIconButtonProps = {
  isFollowing: boolean;
  onToggle: () => void;
  disabled?: boolean;
};

/**
 * Follow / unfollow as a single header icon, for the playlist and setter
 * screens. The caller owns the state, and flips it as soon as the tap lands:
 * this circle has no room for a spinner.
 */
export function FollowIconButton({ isFollowing, onToggle, disabled = false }: FollowIconButtonProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();

  return (
    <GlassIconButton
      iconName={isFollowing ? 'person.check' : 'person.badge.plus'}
      iconColor={systemColors.label}
      onPress={onToggle}
      disabled={disabled}
      accessibilityLabel={isFollowing ? t('follow.following') : t('follow.follow')}
      accessibilityState={{ selected: isFollowing, disabled }}
      fallbackColor={systemColors.fill}
    />
  );
}
