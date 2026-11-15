import { useCallback } from 'react';
import { useUnreadNotificationCount } from '../../lib/graphql/hooks/use-notifications';
import { hapticLight } from '../../lib/haptics';
import { NotificationsToolbarActionView } from './NotificationsToolbarActionView';
export function NotificationsToolbarAction({
  variant,
  onPress,
}: {
  variant: 'glass' | 'material';
  onPress: () => void;
}) {
  const unreadCount = useUnreadNotificationCount();
  const handlePress = useCallback(() => {
    hapticLight();
    onPress();
  }, [onPress]);
  return <NotificationsToolbarActionView variant={variant} onPress={handlePress} unreadCount={unreadCount} />;
}
