import { memo, useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Avatar } from './Avatar';
import { PressableSurface } from './PressableSurface';
import { hapticLight } from '../lib/haptics';

type PressableAvatarProps = {
  /**
   * Boardsesh user id to open. When omitted (e.g. a comment author with no
   * linked user), the avatar renders as a plain, non-interactive Avatar.
   */
  userId?: string | null;
  uri?: string | null;
  name?: string | null;
  size?: number;
  /**
   * Overrides the default "View {name}'s profile" press label — e.g. to add the
   * driver context the avatar replaces. Also labels the non-interactive avatar
   * when there's no `userId`, so the meaning survives an anonymous holder.
   */
  accessibilityLabel?: string;
};

/**
 * An Avatar that opens a climber's public profile (`/users/[userId]`) on tap.
 * Small avatars (28–36dp) get a full 44pt touch target via hitSlop without
 * resizing the art, an opacity dim on iOS, and a borderless ripple on Android.
 *
 * It's a dumb navigation wrapper: the self-profile and not-found cases are
 * handled by the route itself, so call sites only need to pass the row's userId.
 */
export const PressableAvatar = memo(function PressableAvatar({
  userId,
  uri,
  name,
  size = 40,
  accessibilityLabel,
}: PressableAvatarProps) {
  const router = useRouter();
  const { t } = useTranslation('common');

  const handlePress = useCallback(() => {
    if (!userId) return;
    hapticLight();
    router.push({ pathname: '/users/[userId]', params: { userId } });
  }, [router, userId]);

  if (!userId) {
    return <Avatar uri={uri} name={name} size={size} accessibilityLabel={accessibilityLabel} />;
  }

  // Pad small avatars up to a 44pt target without enlarging the visible art.
  const hitSlop = Math.max(0, Math.round((44 - size) / 2));

  return (
    <PressableSurface
      onPress={handlePress}
      feedback="opacity"
      rippleBorderless
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={
        accessibilityLabel ?? t('mobile.avatar.viewProfile', { name: name ?? t('mobile.avatar.thisClimber') })
      }
    >
      <Avatar uri={uri} name={name} size={size} />
    </PressableSurface>
  );
});
