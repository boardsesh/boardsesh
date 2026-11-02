// Row-host tests keep the real row gestures and accessibility bridge while native
// menu primitives and the app-wide command controller are exercised separately.
import {
  createElement,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import type { AccessibilityActionEvent } from 'react-native';
import type { ClimbActionsTarget } from '../src/providers/drawer-host-provider';

type Row = { id: string; label: string; run: () => void };
const EMPTY_ROWS: Row[] = [];
const SHARE_ACTION = [{ name: 'share', label: 'Share' }];
const EMPTY_ACTIONS: { name: string; label: string }[] = [];

export const climbMenuTestState = {
  target: null as ClimbActionsTarget | null,
  commands: [] as { id: string; target: ClimbActionsTarget }[],
  openedRows: null as Row[] | null,
};

export function useClimbMenu(target: ClimbActionsTarget | null) {
  climbMenuTestState.target = target;
  const currentTarget = useRef(target);
  currentTarget.current = target;
  const rows = useMemo(
    () =>
      target
        ? [
            {
              id: 'share',
              label: 'Share',
              run: () => climbMenuTestState.commands.push({ id: 'share', target }),
            },
          ]
        : EMPTY_ROWS,
    [target],
  );
  const onAccessibilityAction = useCallback((event: AccessibilityActionEvent) => {
    if (currentTarget.current && event.nativeEvent.actionName === 'share') {
      climbMenuTestState.commands.push({ id: 'share', target: currentTarget.current });
    }
  }, []);
  return {
    rows,
    menuKey: target?.climb.uuid ?? 'none',
    accessibilityActions: target ? SHARE_ACTION : EMPTY_ACTIONS,
    onAccessibilityAction,
  };
}

export function ClimbMenu({
  rows,
  children,
  accessibilityLabel,
  menuRef,
}: {
  rows: Row[];
  children?: ReactElement;
  accessibilityLabel?: string;
  menuRef?: RefObject<{ open: () => void } | null>;
}) {
  const open = () => {
    if (rows.length > 0) climbMenuTestState.openedRows = rows;
  };
  // A ⋮ beside the row opens this same hold menu (Android and web).
  useImperativeHandle(menuRef, () => ({ open }));
  if (rows.length === 0) return children ?? null;
  return children
    ? createElement('div', { 'data-native-climb-menu': 'longPress', onContextMenu: open }, children)
    : createElement('button', {
        'data-native-climb-menu': 'icon',
        'aria-label': accessibilityLabel ?? 'mobile.climbRow.moreActions',
        onClick: open,
      });
}

/** Keeps the card body's tap and direct commands without loading native RNGH. */
export function ClimbActionsPressable({
  target,
  onPress,
  children,
  accessibilityLabel,
}: {
  target: ClimbActionsTarget | null;
  onPress: () => void;
  children: ReactNode;
  accessibilityLabel?: string;
}) {
  const menu = useClimbMenu(target);
  return createElement(
    ClimbMenu,
    { rows: menu.rows },
    createElement(
      'div',
      {
        'data-climb-actions-body': true,
        'data-testid': 'climb-actions-body',
        'data-action-label': menu.accessibilityActions.map((action) => action.label).join('|'),
        'aria-label': accessibilityLabel,
        onClick: onPress,
        onDoubleClick: () =>
          menu.onAccessibilityAction({ nativeEvent: { actionName: 'share' } } as AccessibilityActionEvent),
      },
      children,
    ),
  );
}
