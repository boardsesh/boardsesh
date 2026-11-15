import { selectByVariant } from '../../theme/variants';
import { useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { useNativeRootBarItems } from '../../hooks/use-native-root-bar-items';
import { useTheme } from '../../providers/theme-provider';
import { GlassActionToolbar } from '../chrome';
import { NativeRootHeader } from '../chrome/NativeRootHeader';
import { NotificationsToolbarAction } from '../chrome/NotificationsToolbarAction';
import { barItemsFactory, symbolBarItem } from '../chrome/root-bar-items';
import { useAccountRailItem, useBarItemsOnRail, useNotificationsBarItem } from '../chrome/use-root-bar-items';
import { iconMap } from '../icon-map';
import { UserAvatarToolbarAction } from '../user-drawer/UserAvatarToolbarAction';
import { HomeTopChromeView, type HomeTopChromeViewProps } from './HomeTopChromeView';
export { TOP_ISLAND_BAND } from './HomeTopChromeView';
export type HomeTopChromeProps = Omit<HomeTopChromeViewProps, 'avatar' | 'notifications' | 'nativeRailHeader'>;
export function HomeTopChrome(props: HomeTopChromeProps) {
  const { variant } = useTheme();
  const router = useRouter();
  const nativeBarItems = useNativeRootBarItems();
  const onOpenNotifications = useCallback(() => router.push('/(tabs)/home/notifications'), [router]);
  const appearance = selectByVariant(variant, { material: 'material', liquidGlass: 'glass' } as const);
  return (
    <HomeTopChromeView
      {...props}
      avatar={<UserAvatarToolbarAction variant={appearance} />}
      notifications={<NotificationsToolbarAction variant={appearance} onPress={onOpenNotifications} />}
      nativeRailHeader={
        nativeBarItems ? (
          <HomeNativeBarHeader
            onOpenNotifications={onOpenNotifications}
            onOpenSearch={props.onOpenSearch}
            searchAccessibilityLabel={props.searchAccessibilityLabel}
            onHeightChange={props.onHeightChange}
          />
        ) : undefined
      }
    />
  );
}
function HomeNativeBarHeader({
  onOpenNotifications,
  onOpenSearch,
  searchAccessibilityLabel,
  onHeightChange,
}: {
  onOpenNotifications: () => void;
  onOpenSearch: () => void;
  searchAccessibilityLabel: string;
  onHeightChange: (height: number) => void;
}) {
  const onRail = useBarItemsOnRail();
  const accountItem = useAccountRailItem();
  const notificationsItem = useNotificationsBarItem(onOpenNotifications);
  const leftItems = useMemo(() => (onRail ? barItemsFactory([accountItem]) : undefined), [onRail, accountItem]);
  const rightItems = useMemo(
    () =>
      barItemsFactory([
        notificationsItem,
        symbolBarItem({
          label: searchAccessibilityLabel,
          symbol: iconMap['person.badge.plus'].ios,
          onPress: onOpenSearch,
          identifier: 'root.findClimbers',
        }),
      ]),
    [notificationsItem, searchAccessibilityLabel, onOpenSearch],
  );
  return (
    <NativeRootHeader
      onHeightChange={onHeightChange}
      leftItems={leftItems}
      leftActionsStandalone
      leftActions={
        <GlassActionToolbar actionCount={1}>
          <UserAvatarToolbarAction variant="glass" />
        </GlassActionToolbar>
      }
      rightItems={rightItems}
    />
  );
}
