// @vitest-environment jsdom
//
// One board in the picker's At {gym} and Your boards lists: what its subtitle
// says (and leaves out on the board you're on), when it has the ⋯ and the hold
// menu, and that the hold anchor wraps the row and never the ⋯.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import type { BoardCardMenu, DiscoveryBoardItem } from '../BoardDiscoveryCardView';

type Children = { children?: ReactNode };
type AccessibilityActionHandler = (event: { nativeEvent: { actionName: string } }) => void;
const ctrl = vi.hoisted(() => ({
  os: 'ios' as 'ios' | 'android',
  opened: 0,
  onAccessibilityAction: null as AccessibilityActionHandler | null,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return ctrl.os;
    },
  },
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: <T,>(styles: T): T => styles, hairlineWidth: 0.5 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { name?: string }) =>
      ({
        'mobile.discovery.onIt': 'On it',
        'mobile.discovery.cardActionsAria': `Actions for ${params?.name ?? ''}`,
        'mobile.discovery.ownedBadgeAria': 'Your board',
        'mobile.discovery.followingBadgeAria': 'Following',
        'mobile.discovery.pinnedBadgeAria': 'Pinned',
        'mobile.offline.available': 'Available offline',
        'sprayImport.ready': 'Ready to review',
      })[key] ?? key,
  }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#SECONDARY', secondaryBackground: '#CARD' },
    selection: { checkmark: '#CHECK', fill: '#WASH', text: '#LABEL' },
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, tone }: Children & { tone?: string }) =>
    createElement('span', { 'data-tone': tone ?? 'primary' }, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
// The ⋯ as a button, and the hold anchor as a wrapper that says what it holds.
vi.mock('../../AppMenu', () => ({
  AppMenu: (
    props: Children & {
      trigger?: string;
      accessibilityLabel?: string;
      actions: { label: string }[];
      onSelectIndex: (index: number) => void;
      liftPreview?: boolean;
      previewBackgroundColor?: string;
      previewOverlayColor?: string;
      menuRef?: { current: { open: () => void } | null };
    },
  ) => {
    if (props.trigger === 'longPress') {
      if (props.menuRef) props.menuRef.current = { open: () => (ctrl.opened += 1) };
      return createElement(
        'div',
        {
          'data-testid': 'hold-anchor',
          'data-rows': props.actions.map((action) => action.label).join('|'),
          'data-preview': `${props.previewBackgroundColor ?? ''}/${props.previewOverlayColor ?? ''}`,
        },
        props.children,
      );
    }
    return createElement(
      'button',
      { type: 'button', 'aria-label': props.accessibilityLabel, onClick: () => props.onSelectIndex(0) },
      '⋯',
    );
  },
}));
// ArtRow as its props: the target is a button, wrapped by `wrapTarget`; the accessory sits beside it.
vi.mock('../../StatusPill', () => ({
  StatusPill: ({ label, tone }: { label: string; tone?: string }) =>
    createElement('span', { 'data-testid': 'status-pill', 'data-tone': tone }, label),
}));
vi.mock('../../ArtRow', () => ({
  ArtRow: (props: {
    title: string;
    titleVariant?: string;
    subtitle?: ReactNode;
    accessory?: ReactElement | string;
    selected?: boolean;
    onPress?: () => void;
    onLongPress?: () => void;
    accessibilityLabel?: string;
    accessibilityActions?: readonly { name: string; label?: string }[];
    onAccessibilityAction?: AccessibilityActionHandler;
    wrapTarget?: (target: ReactElement) => ReactElement;
    art: ReactNode;
    status?: ReactNode;
  }) => {
    ctrl.onAccessibilityAction = props.onAccessibilityAction ?? null;
    const target = createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'row-target',
        'aria-label': props.accessibilityLabel,
        'aria-selected': props.selected === true,
        'data-actions': JSON.stringify(props.accessibilityActions ?? []),
        onClick: props.onPress,
        onContextMenu: props.onLongPress,
      },
      props.art,
      createElement('span', { 'data-title-variant': props.titleVariant ?? 'headline' }, props.title),
      createElement('span', { 'data-testid': 'subtitle' }, props.subtitle),
      props.status ?? null,
      props.accessory === 'checkmark' ? createElement('i', { 'data-icon': 'check.small' }) : null,
    );
    return createElement(
      'div',
      null,
      props.wrapTarget ? props.wrapTarget(target) : target,
      isValidElement(props.accessory) ? createElement('div', { 'data-testid': 'control' }, props.accessory) : null,
    );
  },
}));

const { BoardRow } = await import('../BoardRow');

const GARAGE: DiscoveryBoardItem = {
  key: 'garage',
  boardName: 'kilter',
  layoutId: 8,
  sizeId: 17,
  setIds: '26,27',
  title: 'Garage Board',
  subtitle: 'Kilter Homewall · 7 x 10',
  isViewerOwner: true,
  isPinned: true,
  offlineState: 'downloaded',
};
const MENU: BoardCardMenu = {
  capabilities: { canPin: true, canDownload: true, canOpenDetails: true, canManage: true, canReport: false },
  labels: {
    climbHere: 'Climb here',
    pin: 'Pin',
    unpin: 'Unpin',
    download: 'Download',
    details: 'Details',
    edit: 'Edit board',
    editWall: 'Edit wall',
    removeFromGym: 'Remove from gym',
    removeFromNamedGym: (gymName) => `Remove from ${gymName}`,
    unfollow: 'Remove from your boards',
    delete: 'Delete',
    reviewReports: 'See reports',
    report: 'Report a problem',
    reported: 'Reported',
  },
  onAction: vi.fn(),
};

function BoardArt({ item }: { item: DiscoveryBoardItem }) {
  return createElement('div', { 'data-art': item.key });
}

function renderRow(item: DiscoveryBoardItem, menu?: BoardCardMenu, onPress = vi.fn()) {
  return render(createElement(BoardRow, { item, onPress, menu, BoardArt }));
}

function subtitleParts(): string[] {
  const subtitle = screen.getByTestId('subtitle');
  return Array.from(subtitle.querySelectorAll('i, span')).map(
    (part) => part.getAttribute('data-icon') ?? part.textContent ?? '',
  );
}

afterEach(() => {
  cleanup();
  ctrl.os = 'ios';
  ctrl.opened = 0;
  ctrl.onAccessibilityAction = null;
  vi.mocked(MENU.onAction).mockClear();
});

describe('BoardRow', () => {
  it('leads the subtitle with its pin and download glyphs, all in secondary label', () => {
    renderRow(GARAGE);
    expect(subtitleParts()).toEqual(['pin.fill', 'offline.downloaded', 'Kilter Homewall · 7 x 10']);
    expect(screen.getByText('Kilter Homewall · 7 x 10').getAttribute('data-tone')).toBe('secondary');
  });

  // The glyphs would push the size off the line beside "On it".
  it('says "On it" on the board you are on, without the glyphs', () => {
    renderRow({ ...GARAGE, isActive: true });
    expect(subtitleParts()).toEqual(['On it · Kilter Homewall · 7 x 10']);
    expect(screen.getByTestId('row-target').getAttribute('aria-selected')).toBe('true');
  });

  it('says where a spray wall import is, behind a dot, instead of the subtitle', () => {
    renderRow({
      ...GARAGE,
      boardName: 'spray',
      subtitle: 'Spraywall',
      isPinned: false,
      offlineState: undefined,
      sprayImport: { stage: 'ready' } as unknown as DiscoveryBoardItem['sprayImport'],
    });
    expect(subtitleParts()).toEqual(['Ready to review']);
  });

  it('shows a warning Reported pill beside the title while a report waits on the viewer', () => {
    renderRow({ ...GARAGE, openReportCount: 2 });
    const pill = screen.getByTestId('status-pill');
    expect(pill.textContent).toBe('reportReview.statusPill');
    expect(pill.getAttribute('data-tone')).toBe('warning');
    cleanup();
    renderRow({ ...GARAGE, openReportCount: null });
    expect(screen.queryByTestId('status-pill')).toBeNull();
  });

  // A gym's wall list (#8151) has to tell walls apart: every set, the counts,
  // who added it, and a neutral pill for the climber's own or followed wall.
  it('draws detail lines under the subtitle and a neutral badge, and reads both aloud', () => {
    renderRow({
      ...GARAGE,
      isPinned: false,
      offlineState: undefined,
      badge: 'Following',
      detailLines: ['Hold Set A, Hold Set B', '12 climbers · 340 sends'],
    });
    expect(screen.getByText('Hold Set A, Hold Set B')).toBeTruthy();
    expect(screen.getByText('12 climbers · 340 sends')).toBeTruthy();
    const pill = screen.getByTestId('status-pill');
    expect(pill.textContent).toBe('Following');
    expect(pill.getAttribute('data-tone')).toBeNull();
    const label = screen.getByTestId('row-target').getAttribute('aria-label') ?? '';
    expect(label).toContain('Following');
    expect(label).toContain('12 climbers · 340 sends');
  });

  it('keeps the Reported pill over a badge', () => {
    renderRow({ ...GARAGE, openReportCount: 1, badge: 'Your board' });
    expect(screen.getByTestId('status-pill').textContent).toBe('reportReview.statusPill');
  });

  it('draws the art in the regular slot', () => {
    const { container } = renderRow(GARAGE);
    expect(container.querySelector('[data-art="garage"]')).not.toBeNull();
  });

  // A list to choose from: body titles, not a shelf's headline.
  it('sets its title as a list row does', () => {
    renderRow(GARAGE);
    expect(screen.getByText('Garage Board').getAttribute('data-title-variant')).toBe('body');
  });

  it('picks the board on a tap', () => {
    const onPress = vi.fn();
    renderRow(GARAGE, MENU, onPress);
    fireEvent.click(screen.getByTestId('row-target'));
    expect(onPress).toHaveBeenCalledExactlyOnceWith(GARAGE);
  });

  it('has the ⋯ beside the row and the same rows behind a hold on it', () => {
    renderRow(GARAGE, MENU);
    const anchor = screen.getByTestId('hold-anchor');
    const menuButton = screen.getByRole('button', { name: 'Actions for Garage Board' });
    expect(anchor.contains(screen.getByTestId('row-target'))).toBe(true);
    expect(anchor.contains(menuButton)).toBe(false);
    expect(anchor.getAttribute('data-rows')).toBe('Climb here|Unpin|Details|Edit board|Delete');
    fireEvent.click(menuButton);
    expect(MENU.onAction).toHaveBeenCalledExactlyOnceWith(GARAGE, 'climb_here', 'menu_button');
  });

  it('keeps the checkmark beside the ⋯ on the board you are on, and lifts it on its wash', () => {
    renderRow({ ...GARAGE, isActive: true }, MENU);
    expect(screen.getByTestId('control').querySelector('[data-icon="check.small"]')).not.toBeNull();
    expect(screen.getByTestId('hold-anchor').getAttribute('data-preview')).toBe('#CARD/#WASH');
  });

  it('is a plain row without a menu, the checkmark inside it when selected', () => {
    renderRow({ ...GARAGE, isActive: true });
    expect(screen.queryByTestId('hold-anchor')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    expect(screen.getByTestId('row-target').querySelector('[data-icon="check.small"]')).not.toBeNull();
  });

  // Android: the row's own pressable wins the touch and hands the hold over.
  it('opens the menu from a hold on Android', () => {
    ctrl.os = 'android';
    renderRow(GARAGE, MENU);
    fireEvent.contextMenu(screen.getByTestId('row-target'));
    expect(ctrl.opened).toBe(1);
  });

  // VoiceOver focuses the row as one element: its menu rows are actions on it,
  // as on a Near you card. Climb here is the row's own activation.
  it('publishes the menu rows as labelled screen-reader actions that run them', () => {
    renderRow(GARAGE, MENU);
    const actions = JSON.parse(screen.getByTestId('row-target').getAttribute('data-actions') ?? '[]') as {
      name: string;
      label?: string;
    }[];
    expect(actions).toEqual([
      { name: 'unpin', label: 'Unpin' },
      { name: 'details', label: 'Details' },
      { name: 'edit', label: 'Edit board' },
      { name: 'delete', label: 'Delete' },
    ]);
    act(() => ctrl.onAccessibilityAction?.({ nativeEvent: { actionName: 'details' } }));
    expect(MENU.onAction).toHaveBeenCalledExactlyOnceWith(GARAGE, 'details', 'accessibility');
  });

  // Android routes a screen reader's double tap through `activate` once a row
  // has actions (rowAccessibilityActionsWith adds it there).
  it('picks the board on the activate action', () => {
    const onPress = vi.fn();
    renderRow(GARAGE, MENU, onPress);
    act(() => ctrl.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } }));
    expect(onPress).toHaveBeenCalledExactlyOnceWith(GARAGE);
  });

  it('publishes no actions on a row without a menu', () => {
    renderRow(GARAGE);
    expect(screen.getByTestId('row-target').getAttribute('data-actions')).toBe('[]');
  });

  it('reads its state aloud: on it, ownership, pin and download', () => {
    renderRow({ ...GARAGE, isActive: true }, MENU);
    expect(screen.getByTestId('row-target').getAttribute('aria-label')).toBe(
      'Garage Board, On it, Kilter Homewall · 7 x 10, Your board, Pinned, Available offline',
    );
  });
});
