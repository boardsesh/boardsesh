// Live data for the root headers' native bar items (`root-bar-items.ts`). Each
// hook mirrors one custom glass action: the same label, tap, haptic and badge,
// built as a UIKit item that iPhone Duo can move onto its side rail. Mounted
// only where `useNativeRootBarItems()` holds.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';
import { Image, PixelRatio, type ImageURISource } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { useProfile } from '../../lib/graphql/hooks';
import { useUnreadNotificationCount } from '../../lib/graphql/hooks/use-notifications';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { formatActiveBoardLabel } from '../../lib/boards/active-board-label';
import { canAdjustBoardAngle } from '../../lib/boards/can-adjust-board-angle';
import { hapticLight } from '../../lib/haptics';
import { useVerticalTabBar } from '../../hooks/use-vertical-tab-bar';
import { sizedAvatarUri } from '../Avatar';
import { iconMap } from '../icon-map';
import { useUserDrawer } from '../user-drawer/UserDrawerProvider';
import { BoardAnglePicker } from './BoardAnglePicker';
import { useToolbarLightbulb } from './LightbulbToolbarAction';
import {
  AVATAR_BAR_PHOTO_SIZE,
  ONBOARDING_BADGE_VALUE,
  avatarBarItem,
  avatarPhotoSource,
  menuBarItem,
  symbolBarItem,
  titleBarItem,
  unreadBadgeValue,
  type RootBarButtonItem,
  type RootBarItem,
} from './root-bar-items';

/**
 * Whether UIKit lays the bar items out on iPhone Duo's vertical rail: the tab
 * bar is a rail there, and the bar items move with it. Exported from here so a
 * chrome reads the rail through the same module as its items.
 */
export function useBarItemsOnRail(): boolean {
  return useVerticalTabBar();
}

/**
 * The account avatar. Opens the user drawer, like the glass avatar.
 *
 * In the horizontal bar it shows the person's photo once it has loaded; until
 * then, and when there is none or it fails, the outline symbol. Loading it once
 * here first keeps a dead URL from leaving the item with no image at all, since
 * UIKit cannot report the failure back. It loads through `Image.getSize`: the
 * board-art network check bans the image prefetch API in app code.
 *
 * On the rail it is always the outline symbol. With the photo, the closed iPhone
 * Duo kept the avatar in a horizontal bar above the content while every symbol
 * item beside it moved to the rail. react-native-screens loads a URL image
 * after it creates the item, so UIKit first sees an item with a title and no
 * icon, which Apple never presents vertically; the photo is also an
 * original-colour image rather than a template. Either keeps it off the rail,
 * and neither is fixable from JavaScript. A symbol is there when the item is made.
 *
 * `enabled: false` for a chrome that calls this unconditionally but draws the
 * glass avatar instead: nothing is loaded for an item nobody shows.
 */
export function useAvatarBarItem({ enabled = true }: { enabled?: boolean } = {}): RootBarButtonItem {
  const { t } = useTranslation('common');
  const { openUserDrawer } = useUserDrawer();
  const onRail = useVerticalTabBar();
  const avatarUrl = useProfile().data?.avatarUrl ?? null;
  const photo = useLoadedBarPhoto(enabled && !onRail ? avatarUrl : null);
  const label = t('ariaLabels.userMenu');
  return useMemo(() => avatarBarItem({ label, onPress: openUserDrawer, photo }), [label, openUserDrawer, photo]);
}

function useLoadedBarPhoto(avatarUrl: string | null): ImageURISource | null {
  const sizedUri = avatarUrl ? sizedAvatarUri(avatarUrl, AVATAR_BAR_PHOTO_SIZE) : null;
  const [loadedUri, setLoadedUri] = useState<string | null>(null);
  useEffect(() => {
    if (!sizedUri) return;
    let cancelled = false;
    Image.getSize(sizedUri).then(
      () => {
        if (!cancelled) setLoadedUri(sizedUri);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [sizedUri]);
  return useMemo(
    () => (sizedUri != null && loadedUri === sizedUri ? avatarPhotoSource(sizedUri, PixelRatio.get()) : null),
    [sizedUri, loadedUri],
  );
}

/** The bell, with the unread count as its badge. High priority: badged status stays visible longest. */
export function useNotificationsBarItem(onOpenNotifications: () => void): RootBarButtonItem {
  const { t } = useTranslation('common');
  const { brandColors } = useTheme();
  const unreadCount = useUnreadNotificationCount();
  const handlePress = useCallback(() => {
    hapticLight();
    onOpenNotifications();
  }, [onOpenNotifications]);
  const label = t('ariaLabels.notifications');
  const badgeColor = brandColors.primary;
  return useMemo(
    () =>
      symbolBarItem({
        label,
        symbol: iconMap.notification.ios,
        onPress: handlePress,
        accessibilityLabel: unreadCount > 0 ? `${label} (${unreadCount})` : label,
        badge: unreadBadgeValue(unreadCount),
        badgeColor,
        visibilityPriority: 'high',
        identifier: 'root.notifications',
      }),
    [label, handlePress, unreadCount, badgeColor],
  );
}

/** The board glyph (Discover): opens the board switcher, named by the full board label. */
export function useBoardSwitcherBarItem({
  onPress,
  accessibilityHint,
  badge,
}: {
  onPress: () => void;
  accessibilityHint?: string;
  badge: boolean;
}): RootBarButtonItem | null {
  const { brandColors } = useTheme();
  const { data: activeBoard } = useActiveBoard();
  const boardLabel = formatActiveBoardLabel(activeBoard);
  const handlePress = useCallback(() => {
    hapticLight();
    onPress();
  }, [onPress]);
  const badgeColor = brandColors.primary;
  return useMemo(
    () =>
      boardLabel
        ? symbolBarItem({
            label: boardLabel,
            symbol: iconMap.boards.ios,
            onPress: handlePress,
            accessibilityHint,
            badge: badge ? ONBOARDING_BADGE_VALUE : null,
            badgeColor,
            identifier: 'root.boardSwitcher',
          })
        : null,
    [boardLabel, handlePress, accessibilityHint, badge, badgeColor],
  );
}

/**
 * The one-tap angle ("40°") and its picker. The picker sheet still mounts in
 * the screen: render `picker` beside the header. `item` is `null` for a
 * fixed-angle board or none.
 */
export function useAngleBarItem(): { item: RootBarButtonItem | null; picker: ReactElement } {
  const { t } = useTranslation('session');
  const { data: activeBoard } = useActiveBoard();
  const openPickerRef = useRef<(() => void) | null>(null);
  const openPicker = useCallback(() => openPickerRef.current?.(), []);
  const picker = useMemo(
    () => <BoardAnglePicker>{(open) => <AnglePickerOpener open={open} openRef={openPickerRef} />}</BoardAnglePicker>,
    [],
  );
  const angle = canAdjustBoardAngle(activeBoard) ? activeBoard.angle : null;
  const item = useMemo(
    () =>
      angle == null
        ? null
        : titleBarItem({
            label: `${angle}°`,
            onPress: openPicker,
            accessibilityLabel: t('mobile.angleSelector.buttonAria', { angle }),
            identifier: 'root.angle',
          }),
    [angle, openPicker, t],
  );
  return { item, picker };
}

/** Hands the picker's `open` to the native item, which lives outside the React tree. */
function AnglePickerOpener({ open, openRef }: { open: () => void; openRef: RefObject<(() => void) | null> }) {
  useLayoutEffect(() => {
    openRef.current = open;
    return () => {
      if (openRef.current === open) openRef.current = null;
    };
  }, [open, openRef]);
  return null;
}

/**
 * The board-light bulb (Discover) as a native item: same label, fill and tap as
 * the glass bulb, but no long press. react-native-screens 4.30 has no item with
 * both a tap action and a menu: it gives only `button` items a tap id and routes
 * menu picks only for `menu` items. So the chrome uses this item only on the
 * rail, and keeps the glass bulb (with its long press to Board controls) as a
 * custom view in a horizontal bar.
 */
export function useLightbulbBarItem(): RootBarButtonItem | null {
  const { brandColors } = useTheme();
  const { available, lit, handlePress, accessibilityLabel } = useToolbarLightbulb();
  const litColor = brandColors.warning;
  return useMemo(
    () =>
      available
        ? symbolBarItem({
            label: accessibilityLabel,
            symbol: lit ? iconMap['lightbulb.fill'].ios : iconMap.lightbulb.ios,
            onPress: handlePress,
            ...(lit ? { tintColor: litColor } : {}),
            identifier: 'root.lightbulb',
          })
        : null,
    [available, lit, handlePress, accessibilityLabel, litColor],
  );
}

/**
 * The Climbs list's trailing actions after the angle: board history (with the
 * onboarding cue) and the list's ⋯ menu (View options, Switch board).
 */
export function useClimbListBarItems({
  onOpenHistory,
  badge,
}: {
  onOpenHistory: () => void;
  badge: boolean;
}): RootBarItem[] {
  const { t } = useTranslation('climbs');
  const { t: tSession } = useTranslation('session');
  const { brandColors } = useTheme();
  const { data: activeBoard } = useActiveBoard();
  const router = useRouter();
  const boardLabel = formatActiveBoardLabel(activeBoard);
  const handleOpenHistory = useCallback(() => {
    hapticLight();
    onOpenHistory();
  }, [onOpenHistory]);
  const openViewOptions = useCallback(() => router.push('/(tabs)/climbs/settings/climb-list'), [router]);
  const openBoards = useCallback(() => router.push('/boards'), [router]);
  const badgeColor = brandColors.primary;
  return useMemo(() => {
    const items: RootBarItem[] = [];
    if (boardLabel) {
      items.push(
        symbolBarItem({
          label: t('mobile.listOptions.historyTitle'),
          symbol: iconMap.history.ios,
          onPress: handleOpenHistory,
          accessibilityLabel: t('mobile.listOptions.history', { board: boardLabel }),
          accessibilityHint: t('mobile.listOptions.historyHint'),
          badge: badge ? ONBOARDING_BADGE_VALUE : null,
          badgeColor,
          visibilityPriority: 'standard',
          identifier: 'root.boardHistory',
        }),
      );
    }
    items.push(
      menuBarItem({
        label: t('mobile.listOptions.title'),
        symbol: iconMap.more.ios,
        identifier: 'root.climbListMenu',
        rows: [
          { label: t('mobile.listOptions.viewOptions'), symbol: iconMap['view.options'].ios, onPress: openViewOptions },
          {
            label: tSession('mobile.boardPresence.switchBoard'),
            symbol: 'arrow.left.arrow.right',
            onPress: openBoards,
          },
        ],
      }),
    );
    return items;
  }, [boardLabel, t, tSession, handleOpenHistory, badge, badgeColor, openViewOptions, openBoards]);
}
