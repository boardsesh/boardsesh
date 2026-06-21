// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode, type Ref } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

// The sheet is mounted always-on inside the Play Drawer and toggled via
// `visible`; it must present/dismiss on real visible transitions (the only way a
// BottomSheetModal stacks above the already-open drawer). The ModalSheet mock
// exposes the present/dismiss it would call through the forwarded ref.
const modal = vi.hoisted(() => ({ present: vi.fn(), dismiss: vi.fn() }));
const preview = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material', canUpdate: false }));
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn() }));
const urlBuilder = vi.hoisted(() => ({ buildReadableClimbViewPath: vi.fn(() => '/readable/view/x') }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('@gorhom/bottom-sheet', () => ({ BottomSheetModal: function BottomSheetModal() {} }));

vi.mock('../ModalSheet', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    ModalSheet: React.forwardRef(({ children }: { children?: ReactNode }, ref: Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({ present: modal.present, dismiss: modal.dismiss }));
      return React.createElement('div', { 'data-modal-sheet': 'true' }, children);
    }),
  };
});

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
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
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
  modal.present.mockClear();
  modal.dismiss.mockClear();
  clipboard.setStringAsync.mockClear();
  urlBuilder.buildReadableClimbViewPath.mockClear();
  preview.props = null;
  ctrl.variant = 'liquidGlass';
  ctrl.canUpdate = false;
});

describe('ClimbActionsSheet present-on-visible (always-mounted toggle)', () => {
  it('stays mounted while closed without presenting or dismissing', () => {
    render(<ClimbActionsSheet visible={false} {...baseProps} />);
    expect(modal.present).not.toHaveBeenCalled();
    expect(modal.dismiss).not.toHaveBeenCalled();
  });

  it('presents when visible flips true, dismisses when false, and re-presents on the next open', () => {
    const { rerender } = render(<ClimbActionsSheet visible={false} {...baseProps} />);
    expect(modal.present).not.toHaveBeenCalled();

    rerender(<ClimbActionsSheet visible={true} {...baseProps} />);
    expect(modal.present).toHaveBeenCalledTimes(1);
    expect(modal.dismiss).not.toHaveBeenCalled();

    rerender(<ClimbActionsSheet visible={false} {...baseProps} />);
    expect(modal.dismiss).toHaveBeenCalledTimes(1);

    rerender(<ClimbActionsSheet visible={true} {...baseProps} />);
    expect(modal.present).toHaveBeenCalledTimes(2);
  });

  it('never dismisses an instance that was never presented (no gorhom no-op trap)', () => {
    // Mounting straight to visible=false (drawer open, actions closed), then
    // clearing the climb, must not fire dismiss() — calling dismiss on a
    // not-presented modal leaves gorhom unable to present() it next time.
    const { rerender } = render(<ClimbActionsSheet {...baseProps} visible={false} />);
    rerender(<ClimbActionsSheet {...baseProps} visible={false} climb={null} />);
    expect(modal.present).not.toHaveBeenCalled();
    expect(modal.dismiss).not.toHaveBeenCalled();
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
