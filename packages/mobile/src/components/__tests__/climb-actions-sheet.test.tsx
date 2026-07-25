// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

// The sheet is mounted always-on inside the Play Drawer and toggled via the
// controlled `visible` prop (the ModalSheet coordinator drives present/dismiss).
// The mock captures the latest `visible` it was handed.
const sheet = vi.hoisted(() => ({ visible: undefined as boolean | undefined }));
const preview = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
// `segments` drives the real `useCreateClimbNavigation` (deliberately NOT mocked, so the
// Remix/Edit rows are covered end-to-end through the hook that owns the player dismiss).
const ctrl = vi.hoisted(() => ({
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  canUpdate: false,
  segments: ['play'] as readonly string[],
}));
const nav = vi.hoisted(() => ({ push: vi.fn(), dismiss: vi.fn() }));
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn() }));
const urlBuilder = vi.hoisted(() => ({ buildReadableClimbViewPath: vi.fn(() => '/readable/view/x') }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({ BottomSheetModal: function BottomSheetModal() {} }));

vi.mock('../ModalSheet', () => ({
  ModalSheet: ({ children, visible }: { children?: ReactNode; visible?: boolean }) => {
    sheet.visible = visible;
    return createElement('div', { 'data-modal-sheet': 'true', 'data-visible': String(visible) }, children);
  },
}));

vi.mock('../ClimbPreviewCard', () => ({
  ClimbPreviewCard: (props: Record<string, unknown>) => {
    preview.props = props;
    return createElement('div', { 'data-testid': 'climb-preview' });
  },
}));

vi.mock('../ListRow', () => ({
  ListRow: ({ title, leading, onPress }: { title: string; leading?: ReactNode; onPress?: () => void }) =>
    createElement('button', { 'data-row': title, onClick: onPress }, leading, title),
}));
vi.mock('../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: unknown }) =>
    createElement('span', { 'data-icon': name, 'data-color': typeof color === 'string' ? color : '' }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: nav.push, dismiss: nav.dismiss }),
  useSegments: () => ctrl.segments,
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard.setStringAsync }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn() }));
vi.mock('@boardsesh/play-view/readable-url-utils', () => ({
  buildReadableClimbViewPath: urlBuilder.buildReadableClimbViewPath,
}));
vi.mock('@boardsesh/create-climb-react', () => ({ computeCanUpdate: () => ctrl.canUpdate }));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: {} }));
vi.mock('../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => {
    const label = '#fff';
    return {
      variant: ctrl.variant,
      brandColors: { success: '#0a0' },
      systemColors: { accent: '#00f', label },
      // Resolved action-icon colours: monochrome on Liquid Glass, semantic on Material.
      actionColors:
        ctrl.variant === 'material'
          ? { neutral: label, success: '#0a0', favorite: '#f00', accent: '#00f', pin: '#6D28D9' }
          : { neutral: label, success: label, favorite: label, accent: label, pin: label },
    };
  },
}));
vi.mock('../../theme/ios-colors', () => ({ iosSystemColors: { systemRed: '#f00', systemOrange: '#f80' } }));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8 } }));
vi.mock('../../lib/env', () => ({ WEB_BASE_URL: 'https://boardsesh.test' }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

import { ClimbActionsSheet } from '../ClimbActionsSheet';

const climb = {
  uuid: 'climb-1',
  name: 'Test Climb',
  frames: 'p1r12',
  difficulty: 'V4',
  quality_average: '3.0',
} as unknown as Climb;

const ownerClimb = {
  ...climb,
  userId: 'user-1',
  is_draft: true,
} as unknown as Climb;

const baseProps = {
  climb,
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 40,
  onClose: () => {},
};

beforeEach(() => {
  sheet.visible = undefined;
  clipboard.setStringAsync.mockClear();
  urlBuilder.buildReadableClimbViewPath.mockClear();
  preview.props = null;
  ctrl.variant = 'liquidGlass';
  ctrl.canUpdate = false;
  // This sheet only ever renders inside the play drawer, so /play is the realistic default.
  ctrl.segments = ['play'];
  nav.push.mockClear();
  nav.dismiss.mockClear();
});

describe('ClimbActionsSheet controlled visible (always-mounted toggle)', () => {
  it('hands the sheet visible=false while closed', () => {
    render(<ClimbActionsSheet visible={false} {...baseProps} />);
    expect(sheet.visible).toBe(false);
  });

  it('drives the coordinator open on visible+climb and closed otherwise', () => {
    const { rerender } = render(<ClimbActionsSheet visible={false} {...baseProps} />);
    expect(sheet.visible).toBe(false);

    rerender(<ClimbActionsSheet visible={true} {...baseProps} />);
    expect(sheet.visible).toBe(true);

    rerender(<ClimbActionsSheet visible={false} {...baseProps} />);
    expect(sheet.visible).toBe(false);

    rerender(<ClimbActionsSheet visible={true} {...baseProps} />);
    expect(sheet.visible).toBe(true);
  });

  it('stays closed when visible is true but the climb is null', () => {
    // The coordinator only presents on a real climb; a null climb keeps it closed
    // (the wrapper reconciles the controlled prop, so there is no gorhom no-op trap).
    const { rerender } = render(<ClimbActionsSheet {...baseProps} visible={false} />);
    expect(sheet.visible).toBe(false);
    rerender(<ClimbActionsSheet {...baseProps} visible={true} climb={null} />);
    expect(sheet.visible).toBe(false);
  });

  it('renders the climb preview with the climb + board config when open', () => {
    render(<ClimbActionsSheet visible={true} {...baseProps} />);
    expect(preview.props).toMatchObject({
      climb,
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
    });
  });

  it('uses neutral adaptive icons for ordinary Liquid Glass action rows', () => {
    ctrl.canUpdate = true;
    const { container } = render(
      <ClimbActionsSheet
        visible={true}
        {...baseProps}
        climb={ownerClimb}
        boardName="tension"
        currentUserId="user-1"
        onAddToQueue={vi.fn()}
        onOpenPlaylist={vi.fn()}
        onToggleFavorite={vi.fn()}
        onTick={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-icon="add"]')?.getAttribute('data-color')).toBe('#fff');
    expect(container.querySelector('[data-icon="playlist"]')?.getAttribute('data-color')).toBe('#fff');
    expect(container.querySelector('[data-icon="favorite"]')?.getAttribute('data-color')).toBe('#fff');
    expect(container.querySelector('[data-icon="tick"]')?.getAttribute('data-color')).toBe('#fff');
    expect(container.querySelector('[data-icon="branch"]')?.getAttribute('data-color')).toBe('#fff');
    expect(container.querySelector('[data-icon="copy"]')?.getAttribute('data-color')).toBe('#fff');
    expect(container.querySelector('[data-icon="edit"]')?.getAttribute('data-color')).toBe('#fff');
    expect(container.querySelector('[data-icon="open.external"]')?.getAttribute('data-color')).toBe('#fff');
  });

  it('keeps Material action rows on their semantic/action colors', () => {
    ctrl.variant = 'material';
    ctrl.canUpdate = true;
    const { container } = render(
      <ClimbActionsSheet
        visible={true}
        {...baseProps}
        climb={ownerClimb}
        boardName="tension"
        currentUserId="user-1"
        onAddToQueue={vi.fn()}
        onOpenPlaylist={vi.fn()}
        onToggleFavorite={vi.fn()}
        onTick={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-icon="add"]')?.getAttribute('data-color')).toBe('#0a0');
    expect(container.querySelector('[data-icon="playlist"]')?.getAttribute('data-color')).toBe('#00f');
    expect(container.querySelector('[data-icon="favorite"]')?.getAttribute('data-color')).toBe('#f00');
    expect(container.querySelector('[data-icon="tick"]')?.getAttribute('data-color')).toBe('#0a0');
    expect(container.querySelector('[data-icon="branch"]')?.getAttribute('data-color')).toBe('#00f');
    expect(container.querySelector('[data-icon="copy"]')?.getAttribute('data-color')).toBe('#00f');
    expect(container.querySelector('[data-icon="edit"]')?.getAttribute('data-color')).toBe('#00f');
    expect(container.querySelector('[data-icon="open.external"]')?.getAttribute('data-color')).toBe('#00f');
  });

  it('shows add to playlist and removes report from the action list', () => {
    render(<ClimbActionsSheet visible={true} {...baseProps} onOpenPlaylist={vi.fn()} />);

    expect(screen.getByText('actions.playlist.popover.title')).toBeTruthy();
    expect(screen.queryByText('mobile.climbActions.report')).toBeNull();
  });

  it('opens the playlist sheet callback from the add-to-playlist row', () => {
    const onOpenPlaylist = vi.fn();
    render(<ClimbActionsSheet visible={true} {...baseProps} onOpenPlaylist={onOpenPlaylist} />);

    fireEvent.click(screen.getByText('actions.playlist.popover.title'));

    expect(onOpenPlaylist).toHaveBeenCalledTimes(1);
  });

  it('copies a readable climb URL', async () => {
    const onClose = vi.fn();
    render(<ClimbActionsSheet visible={true} {...baseProps} onClose={onClose} />);

    fireEvent.click(screen.getByText('mobile.climbActions.copyLink'));

    await waitFor(() => {
      expect(clipboard.setStringAsync).toHaveBeenCalledWith('https://boardsesh.test/readable/view/x');
    });
    expect(urlBuilder.buildReadableClimbViewPath).toHaveBeenCalledWith({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
      climbUuid: 'climb-1',
      climbName: 'Test Climb',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides the Edit entry row unless onEditEntry is provided', () => {
    render(<ClimbActionsSheet visible={true} {...baseProps} />);
    expect(screen.queryByText('mobile.climbActions.editEntry')).toBeNull();
  });

  it('fires onEditEntry then onClose from the Edit entry row (logbook context)', () => {
    const onEditEntry = vi.fn();
    const onClose = vi.fn();
    render(<ClimbActionsSheet visible={true} {...baseProps} onClose={onClose} onEditEntry={onEditEntry} />);

    fireEvent.click(screen.getByText('mobile.climbActions.editEntry'));

    expect(onEditEntry).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ClimbActionsSheet create-climb navigation (Remix / Edit)', () => {
  // Both /play and /(tabs)/climbs/create are transparentModals, but in different
  // navigators — create lives under the player, so it must not be pushed while the
  // player is still up.
  it('closes the sheet, dismisses the player, then pushes create with the fork params', () => {
    const onClose = vi.fn();
    render(<ClimbActionsSheet visible={true} {...baseProps} onClose={onClose} />);

    fireEvent.click(screen.getByText('mobile.climbActions.fork'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(nav.dismiss).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/create',
      params: {
        forkFrames: 'p1r12',
        forkName: 'Test Climb',
        forkDescription: '',
        boardName: 'kilter',
        layoutId: '1',
        sizeId: '10',
        setIds: '1,2',
        angle: '40',
      },
    });
  });

  it('pushes create in edit mode from the owner-only Edit row', () => {
    ctrl.canUpdate = true;
    render(<ClimbActionsSheet visible={true} {...baseProps} climb={ownerClimb} currentUserId="user-1" />);

    fireEvent.click(screen.getByText('mobile.climbActions.edit'));

    expect(nav.dismiss).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/create',
      params: {
        editClimbUuid: 'climb-1',
        boardName: 'kilter',
        layoutId: '1',
        sizeId: '10',
        setIds: '1,2',
        angle: '40',
      },
    });
  });

  // On an iPad regular-width layout the player renders in the detail PANE, not the
  // /play route — there is no modal to dismiss, and popping one would take the wrong
  // screen with it.
  it('does not dismiss when the player is a pane rather than the /play route', () => {
    ctrl.segments = ['(tabs)', 'climbs'];
    render(<ClimbActionsSheet visible={true} {...baseProps} />);

    fireEvent.click(screen.getByText('mobile.climbActions.fork'));

    expect(nav.dismiss).not.toHaveBeenCalled();
    expect(nav.push).toHaveBeenCalledTimes(1);
  });
});
