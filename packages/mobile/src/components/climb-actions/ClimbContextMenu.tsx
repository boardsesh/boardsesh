import { memo, useCallback, useMemo, useRef, type ReactElement } from 'react';
import { Platform, View } from 'react-native';
import { Link } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/shared-schema';
import { iconMap } from '../icon-map';
import { useActiveClimbUuid } from '../../providers/queue-provider';
import { useClimbModerationEnabled } from '../../providers/feature-flags-provider';
import { useSprayWallIsArchived } from '../../lib/spray/use-spray-wall-archive';
import { CLIMB_ACTION_ORDER, isOwnClimb, resolveClimbActionIds, type ClimbActionId } from './climb-action-gating';
import { CLIMB_ACTION_ICONS, climbActionTitle } from './climb-action-labels';
import { buildClimbContextMenu } from './climb-context-menu-model';
import { useClimbMenuViewer, withClimbActionIntent } from './climb-menu-intent';

// `Link` needs an href, and a long-press menu without `Link.Preview` never
// navigates to it: there is no preview to tap and no prefetch, and the trigger is
// a plain View, which never fires the onPress Link hands it. The climb has no
// route of its own to point at (opening a climb sets the queue, then presents
// `/play`), so this is the root route rather than a fake climb URL.
const MENU_HREF = '/';

// Joins the resolved titles into one memo key. Never appears in a translation.
const TITLE_SEPARATOR = '\u0000';

/** The surface's own board context, the same one it passes to `openClimbActions`. */
export type ClimbContextMenuBoard = {
  boardName: string;
  layoutId: number;
};

type ClimbContextMenuProps = {
  /** The climb the menu acts on. No menu without one. */
  climb: Climb | null;
  board: ClimbContextMenuBoard | null;
  /**
   * The surface's existing long-press callback, which calls `openClimbActions`
   * with its own options. A menu pick calls it with the picked action as the
   * intent, so the action runs with exactly the options the overlay would get.
   */
  onOpenActions: () => void;
  /** The surface passes `onEditEntry` to `openClimbActions` (the logbook). */
  hasEditEntry?: boolean;
  /** No menu, e.g. a climb the active board can't show. */
  disabled?: boolean;
  /** The surface's row. It becomes the menu's preview, lifted as it is. */
  children: ReactElement;
};

/**
 * Long-press a climb on iOS: the system context menu (UIContextMenuInteraction,
 * through expo-router's `Link.Menu`). The row lifts out of a blurred screen with
 * the system haptic, and a drag from the press slides onto an item — the HIG
 * context-menu interaction the custom overlay couldn't give.
 *
 * Android and web get the children unchanged: there the surface keeps its own
 * long-press, which opens the reaction overlay (an M3 menu-in-a-dialog; M3 has no
 * context menu with a lifted preview).
 */
export function ClimbContextMenu(props: ClimbContextMenuProps) {
  const { climb, board, disabled, children } = props;
  if (!NATIVE_CLIMB_MENU || disabled || !climb || !board) return children;
  return <NativeClimbContextMenu {...props} climb={climb} board={board} />;
}

/** Whether `ClimbContextMenu` owns the long-press on this platform. A surface
 *  drops its own long-press handler when it does, so the two never both fire. */
export const NATIVE_CLIMB_MENU = Platform.OS === 'ios';

type NativeClimbContextMenuProps = ClimbContextMenuProps & {
  climb: Climb;
  board: ClimbContextMenuBoard;
};

const NativeClimbContextMenu = memo(function NativeClimbContextMenu({
  climb,
  board,
  onOpenActions,
  hasEditEntry = false,
  children,
}: NativeClimbContextMenuProps) {
  const { t } = useTranslation('climbs');
  const { currentUserId, isAuthenticated } = useClimbMenuViewer();
  // Narrow selector context: changes only when the climb on the wall does.
  const activeClimbUuid = useActiveClimbUuid();
  const moderationEnabled = useClimbModerationEnabled();
  // Registry read, per-row safe (see use-spray-wall-archive).
  const wallArchived = useSprayWallIsArchived(board.boardName, board.layoutId);

  const offeredIds = resolveClimbActionIds({
    climb,
    boardName: board.boardName,
    currentUserId,
    isAuthenticated,
    moderationEnabled,
    wallArchived,
    activeClimbUuid,
    hasOpenQueue: false,
    hasEditEntry,
  });
  // Keyed on resolved strings, not on the id array or `t`, whose identities
  // change on renders where nothing the menu shows has. The memo below then
  // hands back the same elements, and React skips the menu subtree.
  const offeredKey = offeredIds.join(',');
  const ownClimb = isOwnClimb(climb, currentUserId);
  const titlesKey = CLIMB_ACTION_ORDER.map((id) => climbActionTitle(id, t, ownClimb)).join(TITLE_SEPARATOR);

  // Read through a ref so the items' handlers never change identity: a recycled
  // row then only updates the props that really changed.
  const onOpenActionsRef = useRef(onOpenActions);
  onOpenActionsRef.current = onOpenActions;
  const select = useCallback((actionId: ClimbActionId) => {
    withClimbActionIntent(actionId, () => onOpenActionsRef.current());
  }, []);

  const menu = useMemo(() => {
    const titles = titlesKey.split(TITLE_SEPARATOR);
    const titleOf = (id: ClimbActionId) => titles[CLIMB_ACTION_ORDER.indexOf(id)] ?? '';
    const offered = offeredKey ? (offeredKey.split(',') as ClimbActionId[]) : [];
    return (
      // One root menu: Link reads only its first Link.Menu child. Each section is
      // an inline submenu, which UIKit separates with a divider.
      <Link.Menu title="">
        {buildClimbContextMenu(offered).map((section) => (
          <Link.Menu key={section.key} title="" inline elementSize={section.compact ? 'small' : undefined}>
            {section.items.map((item) => (
              <Link.MenuAction
                key={item.id}
                icon={iconMap[CLIMB_ACTION_ICONS[item.id]].ios}
                hidden={item.hidden}
                destructive={item.destructive}
                onPress={() => select(item.id)}
              >
                {titleOf(item.id)}
              </Link.MenuAction>
            ))}
          </Link.Menu>
        ))}
      </Link.Menu>
    );
  }, [offeredKey, titlesKey, select]);

  return (
    <Link href={MENU_HREF} asChild>
      <Link.Trigger>
        {/* The view UIKit attaches the menu to and lifts as the preview. A plain
            View, so the onPress and `link` role Link hands its child do nothing:
            the row inside keeps its own press, role and accessibility actions. */}
        <View collapsable={false} role="none">
          {children}
        </View>
      </Link.Trigger>
      {menu}
    </Link>
  );
});
