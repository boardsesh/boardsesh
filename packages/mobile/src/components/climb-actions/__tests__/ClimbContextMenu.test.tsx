// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

// HIG context menus: on iOS a climb's long-press is the system context menu
// (expo-router Link.Menu), the row itself lifted as the preview. These pin the
// preview (the row, untouched), the item mapping (titles, SF Symbols, hidden,
// destructive), the hand-off of a pick to the surface's own callback, and the
// Android passthrough.

const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));
const ctrl = vi.hoisted(() => ({
  activeClimbUuid: null as string | null,
  moderationEnabled: true,
  wallArchived: false,
}));
const menu = vi.hoisted(() => ({
  linkProps: [] as Record<string, unknown>[],
  actions: new Map<string, Record<string, unknown>>(),
  sections: [] as Record<string, unknown>[],
}));

vi.mock('react-native', () => ({
  Platform: platform,
  View: ({ children, role, collapsable }: { children?: ReactNode; role?: string; collapsable?: boolean }) =>
    createElement(
      'div',
      { 'data-trigger-view': 'true', 'data-role': role, 'data-collapsable': String(collapsable) },
      children,
    ),
}));

vi.mock('expo-router', () => {
  const textOf = (children: ReactNode) => (typeof children === 'string' ? children : '');
  const Link = ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
    menu.linkProps.push(props);
    return createElement('div', { 'data-link': 'true' }, children);
  };
  Link.Trigger = ({ children }: { children?: ReactNode }) => createElement('div', { 'data-trigger': 'true' }, children);
  Link.Menu = ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
    menu.sections.push(props);
    return createElement('div', { 'data-menu': String(props.inline ?? 'root') }, children);
  };
  Link.MenuAction = ({
    children,
    onPress,
    ...props
  }: { children?: ReactNode; onPress?: () => void } & Record<string, unknown>) => {
    const title = textOf(children);
    menu.actions.set(title, { ...props, onPress, title });
    return props.hidden ? null : createElement('button', { 'data-action': title, onClick: onPress }, title);
  };
  return { Link };
});

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/queue-provider', () => ({ useActiveClimbUuid: () => ctrl.activeClimbUuid }));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useClimbModerationEnabled: () => ctrl.moderationEnabled,
}));
vi.mock('../../../lib/spray/use-spray-wall-archive', () => ({
  useSprayWallIsArchived: () => ctrl.wallArchived,
}));

const climb = { uuid: 'climb-1', name: 'Big Move', frames: 'p1r12' } as unknown as Climb;
const kilter = { boardName: 'kilter', layoutId: 1 };

type MenuModule = typeof import('../ClimbContextMenu') & typeof import('../climb-menu-intent');

// NATIVE_CLIMB_MENU is read from Platform at module load, so each platform gets a
// fresh module graph. The intent module comes from the same graph, so the
// viewer context and the intent are the ones the menu itself uses.
async function loadMenu(os: 'ios' | 'android'): Promise<MenuModule> {
  platform.OS = os;
  vi.resetModules();
  const intent = await import('../climb-menu-intent');
  const component = await import('../ClimbContextMenu');
  return { ...intent, ...component };
}

function renderMenu(
  { ClimbContextMenu, ClimbMenuViewerContext }: MenuModule,
  props: Partial<Parameters<MenuModule['ClimbContextMenu']>[0]> = {},
  viewer = { currentUserId: null as string | null, isAuthenticated: false },
) {
  const onOpenActions = props.onOpenActions ?? vi.fn();
  const element = (overrides: Partial<Parameters<MenuModule['ClimbContextMenu']>[0]> = {}) =>
    createElement(
      ClimbMenuViewerContext.Provider,
      { value: viewer },
      createElement(
        ClimbContextMenu,
        {
          climb,
          board: kilter,
          onOpenActions,
          ...props,
          ...overrides,
          children: createElement('div', { 'data-row': 'true' }, 'row'),
        },
        createElement('div', { 'data-row': 'true' }, 'row'),
      ),
    );
  const result = render(element());
  return {
    ...result,
    onOpenActions,
    rerenderWith: (overrides: Parameters<typeof element>[0]) => result.rerender(element(overrides)),
  };
}

beforeEach(() => {
  ctrl.activeClimbUuid = null;
  ctrl.moderationEnabled = true;
  ctrl.wallArchived = false;
  menu.linkProps = [];
  menu.actions.clear();
  menu.sections = [];
});

describe('ClimbContextMenu on iOS', () => {
  it('lifts the row itself as the preview, inside a plain trigger view', async () => {
    const { container } = renderMenu(await loadMenu('ios'));
    const row = container.querySelector('[data-trigger] [data-trigger-view] [data-row]');
    expect(row).not.toBeNull();
    // The trigger view takes Link's `link` role and onPress; a `none` role keeps
    // VoiceOver on the row inside, and it must stay a real view for UIKit.
    const triggerView = container.querySelector('[data-trigger-view]');
    expect(triggerView?.getAttribute('data-role')).toBe('none');
    expect(triggerView?.getAttribute('data-collapsable')).toBe('false');
    expect(menu.linkProps.at(-1)).toMatchObject({ asChild: true });
  });

  it('opens with a compact quick row, then one inline section per group', async () => {
    renderMenu(await loadMenu('ios'));
    const [root, ...sections] = menu.sections;
    expect(root.inline).toBeUndefined();
    expect(sections.map((section) => section.inline)).toEqual([true, true, true, true, true]);
    expect(sections[0].elementSize).toBe('small');
    expect(sections.slice(1).every((section) => section.elementSize === undefined)).toBe(true);
  });

  it('maps the signed-out actions to titled SF Symbol items and hides the rest', async () => {
    const { container } = renderMenu(await loadMenu('ios'));
    const shown = [...container.querySelectorAll('[data-action]')].map((node) => node.getAttribute('data-action'));
    expect(shown).toEqual([
      'mobile.climbActions.tick',
      'actions.playlist.popover.title',
      'share.actionLabel',
      'mobile.climbActions.preview',
      'mobile.climbRow.addToQueue',
      'mobile.climbActions.playNext',
      'mobile.climbRow.toggleFavorite',
      'mobile.climbActions.fork',
    ]);
    expect(menu.actions.get('mobile.climbActions.tick')).toMatchObject({
      icon: 'checkmark.circle.fill',
      hidden: false,
    });
    expect(menu.actions.get('share.actionLabel')).toMatchObject({ icon: 'square.and.arrow.up' });
    // Signed out: no beta video and no report, hidden rather than unmounted.
    expect(menu.actions.get('mobile.climbActions.addBetaVideo')).toMatchObject({ hidden: true });
    expect(menu.actions.get('mobile.climbActions.report')).toMatchObject({ hidden: true });
  });

  it('shows the setter "Change grade" and a destructive delete on their own spray climb', async () => {
    const own = {
      ...climb,
      userId: 'user-1',
      is_draft: false,
      published_at: new Date().toISOString(),
    } as unknown as Climb;
    renderMenu(
      await loadMenu('ios'),
      { climb: own, board: { boardName: 'spray', layoutId: 4200 } },
      { currentUserId: 'user-1', isAuthenticated: true },
    );
    expect(menu.actions.get('mobile.climbActions.changeGrade')).toMatchObject({ hidden: false, icon: 'flag' });
    expect(menu.actions.get('mobile.climbActions.deleteClimb.row')).toMatchObject({
      hidden: false,
      destructive: true,
      icon: 'trash',
    });
  });

  it('hides "Play next" on the climb on the wall', async () => {
    ctrl.activeClimbUuid = 'climb-1';
    renderMenu(await loadMenu('ios'));
    expect(menu.actions.get('mobile.climbActions.playNext')).toMatchObject({ hidden: true });
  });

  it('shows "Edit entry" only where the surface hosts it', async () => {
    const module = await loadMenu('ios');
    renderMenu(module);
    expect(menu.actions.get('mobile.climbActions.editEntry')).toMatchObject({ hidden: true });
    renderMenu(module, { hasEditEntry: true });
    expect(menu.actions.get('mobile.climbActions.editEntry')).toMatchObject({ hidden: false });
  });

  it('hands a pick to the surface callback with the picked action as the intent', async () => {
    const module = await loadMenu('ios');
    const seen: Array<string | null> = [];
    const onOpenActions = vi.fn(() => {
      seen.push(module.takeClimbActionIntent());
    });
    const { container } = renderMenu(module, { onOpenActions });

    act(() => fireEvent.click(container.querySelector('[data-action="mobile.climbActions.tick"]') as Element));
    expect(onOpenActions).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['tick']);
    // Gone once the call returns, so a later plain long-press opens the overlay.
    expect(module.takeClimbActionIntent()).toBeNull();
  });

  it('keeps the item handlers when a recycled row shows a climb with the same actions', async () => {
    const { rerenderWith } = renderMenu(await loadMenu('ios'));
    const before = menu.actions.get('mobile.climbActions.tick')?.onPress;
    rerenderWith({ climb: { ...climb, uuid: 'climb-2', name: 'Other' } as unknown as Climb });
    expect(menu.actions.get('mobile.climbActions.tick')?.onPress).toBe(before);
  });

  it('passes the row through with no menu when disabled or without a climb', async () => {
    const module = await loadMenu('ios');
    const disabled = renderMenu(module, { disabled: true });
    expect(disabled.container.querySelector('[data-link]')).toBeNull();
    expect(disabled.container.querySelector('[data-row]')).not.toBeNull();
    disabled.unmount();

    const noClimb = renderMenu(module, { climb: null });
    expect(noClimb.container.querySelector('[data-link]')).toBeNull();
    expect(noClimb.container.querySelector('[data-row]')).not.toBeNull();
  });
});

describe('ClimbContextMenu on Android', () => {
  it('renders the row unchanged, leaving the long-press to the surface', async () => {
    const module = await loadMenu('android');
    expect(module.NATIVE_CLIMB_MENU).toBe(false);
    const { container } = renderMenu(module);
    expect(container.querySelector('[data-link]')).toBeNull();
    expect(container.querySelector('[data-row]')).not.toBeNull();
    expect(menu.actions.size).toBe(0);
  });
});
