// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import type { DismissAndWaitResult } from '../../providers/sheet-presentation-provider';

// The sheet is mounted always-on inside the Play Drawer and toggled via the
// controlled `visible` prop (the ModalSheet coordinator drives present/dismiss).
// The mock captures the latest `visible` it was handed.
const sheet = vi.hoisted(() => ({
  visible: undefined as boolean | undefined,
  exposeHandle: true,
  dismissAndWait: vi.fn<() => Promise<DismissAndWaitResult>>(async () => ({ status: 'dismissed' })),
}));
const preview = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
const ctrl = vi.hoisted(() => ({
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  viewerCanEditWall: false,
  viewerCanEditClimbs: false,
}));
const nav = vi.hoisted(() => ({ push: vi.fn() }));
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn() }));
const urlBuilder = vi.hoisted(() => ({ buildReadableClimbViewPath: vi.fn(() => '/readable/view/x') }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Platform: { OS: 'ios' },
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({ BottomSheetModal: function BottomSheetModal() {} }));

vi.mock('../ModalSheet', () => ({
  ModalSheet: forwardRef(function MockModalSheet(
    { children, visible }: { children?: ReactNode; visible?: boolean },
    ref,
  ) {
    sheet.visible = visible;
    useImperativeHandle(ref, () => (sheet.exposeHandle ? { dismissAndWait: sheet.dismissAndWait } : (null as never)));
    return createElement('div', { 'data-modal-sheet': 'true', 'data-visible': String(visible) }, children);
  }),
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
  useRouter: () => ({ push: nav.push }),
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard.setStringAsync }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn() }));
vi.mock('@boardsesh/play-view/readable-url-utils', () => ({
  buildReadableClimbViewPath: urlBuilder.buildReadableClimbViewPath,
}));
// The REAL edit rule (`canEditClimb`): the gate is the thing under test. Only
// the wall's viewer flags are stubbed, since the registry behind them has its
// own tests.
vi.mock('../../lib/spray/use-spray-wall', () => ({
  useSprayWallViewerCanEdit: (boardName: string | null | undefined) => boardName === 'spray' && ctrl.viewerCanEditWall,
  useSprayWallViewerCanEditClimbs: (boardName: string | null | undefined) =>
    boardName === 'spray' && ctrl.viewerCanEditClimbs,
}));
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
vi.mock('../../lib/env', () => ({ CLIMB_SHARE_BASE_URL: 'https://boardsesh.test' }));
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

const publishedOwnerClimb = {
  ...ownerClimb,
  is_draft: false,
  published_at: new Date().toISOString(),
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
  sheet.exposeHandle = true;
  sheet.dismissAndWait.mockClear();
  clipboard.setStringAsync.mockClear();
  urlBuilder.buildReadableClimbViewPath.mockClear();
  preview.props = null;
  ctrl.variant = 'liquidGlass';
  ctrl.viewerCanEditWall = false;
  ctrl.viewerCanEditClimbs = false;
  nav.push.mockClear();
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
    const { container } = render(
      <ClimbActionsSheet
        visible={true}
        {...baseProps}
        climb={publishedOwnerClimb}
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
    const { container } = render(
      <ClimbActionsSheet
        visible={true}
        {...baseProps}
        climb={publishedOwnerClimb}
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

  it('offers Fork and Edit on Woods now that authoring is supported', () => {
    const { container } = render(
      <ClimbActionsSheet visible={true} {...baseProps} climb={ownerClimb} boardName="woods" currentUserId="user-1" />,
    );

    expect(container.querySelector('[data-row="mobile.climbActions.fork"]')).not.toBeNull();
    expect(container.querySelector('[data-row="mobile.climbActions.edit"]')).not.toBeNull();
  });

  it('offers Copy link on a published climb but not on a draft (#5960)', () => {
    const published = { ...ownerClimb, is_draft: false } as unknown as Climb;
    const copyRow = (container: HTMLElement) => container.querySelector('[data-row="mobile.climbActions.copyLink"]');

    const first = render(<ClimbActionsSheet visible={true} {...baseProps} climb={published} />);
    expect(copyRow(first.container)).not.toBeNull();
    first.unmount();

    const second = render(<ClimbActionsSheet visible={true} {...baseProps} climb={ownerClimb} />);
    expect(copyRow(second.container)).toBeNull();
  });

  it('keeps Fork and Edit on a board that can', () => {
    const { container } = render(
      <ClimbActionsSheet visible={true} {...baseProps} climb={ownerClimb} currentUserId="user-1" />,
    );

    expect(container.querySelector('[data-row="mobile.climbActions.fork"]')).not.toBeNull();
    expect(container.querySelector('[data-row="mobile.climbActions.edit"]')).not.toBeNull();
  });

  describe('who is offered Edit (#5955)', () => {
    const published = {
      ...climb,
      userId: 'setter-1',
      is_draft: false,
      published_at: '2020-01-01T00:00:00.000Z',
    } as unknown as Climb;
    const draft = { ...published, is_draft: true, published_at: null } as unknown as Climb;
    const sprayProps = { ...baseProps, boardName: 'spray' as const, layoutId: 4200, sizeId: 4200, setIds: '1' };
    const editRow = (container: HTMLElement) => container.querySelector('[data-row="mobile.climbActions.edit"]');

    it('offers a wall editor Edit on a published spray climb they did not set', () => {
      ctrl.viewerCanEditWall = true;
      // What the backend actually sends a wall editor: `computeCanEditClimbs`
      // returns true whenever `viewerCanEdit` is, whatever the policy.
      ctrl.viewerCanEditClimbs = true;
      const { container } = render(
        <ClimbActionsSheet visible={true} {...sprayProps} climb={published} currentUserId="wall-owner" />,
      );
      expect(editRow(container)).not.toBeNull();
    });

    it('offers a collaborator Edit when viewerCanEditClimbs is true but viewerCanEditWall is false (#6025)', () => {
      ctrl.viewerCanEditWall = false;
      ctrl.viewerCanEditClimbs = true;
      const { container } = render(
        <ClimbActionsSheet visible={true} {...sprayProps} climb={published} currentUserId="collaborator-1" />,
      );
      expect(editRow(container)).not.toBeNull();
    });

    it('keeps Edit for the setter of a spray climb long after publishing', () => {
      const { container } = render(
        <ClimbActionsSheet visible={true} {...sprayProps} climb={published} currentUserId="setter-1" />,
      );
      expect(editRow(container)).not.toBeNull();
    });

    it("does not offer a wall editor Edit on somebody else's draft", () => {
      ctrl.viewerCanEditWall = true;
      // What the backend actually sends a wall editor: `computeCanEditClimbs`
      // returns true whenever `viewerCanEdit` is, whatever the policy.
      ctrl.viewerCanEditClimbs = true;
      const { container } = render(
        <ClimbActionsSheet visible={true} {...sprayProps} climb={draft} currentUserId="wall-owner" />,
      );
      expect(editRow(container)).toBeNull();
    });

    it('does not offer Edit on a spray climb to someone who cannot edit the wall', () => {
      const { container } = render(
        <ClimbActionsSheet visible={true} {...sprayProps} climb={published} currentUserId="stranger" />,
      );
      expect(editRow(container)).toBeNull();
    });

    it('does not offer a wall editor Edit on a climb from Kilter or from another wall', () => {
      ctrl.viewerCanEditWall = true;
      // What the backend actually sends a wall editor: `computeCanEditClimbs`
      // returns true whenever `viewerCanEdit` is, whatever the policy.
      ctrl.viewerCanEditClimbs = true;
      for (const elsewhere of [
        { boardType: 'kilter', layoutId: 1 },
        { boardType: 'spray', layoutId: 4201 },
      ]) {
        const { container, unmount } = render(
          <ClimbActionsSheet
            visible={true}
            {...sprayProps}
            climb={{ ...published, ...elsewhere } as unknown as Climb}
            currentUserId="wall-owner"
          />,
        );
        expect(editRow(container)).toBeNull();
        unmount();
      }
    });

    it('does not offer a non-setter Edit on Kilter, whatever the wall flag says', () => {
      ctrl.viewerCanEditWall = true;
      // What the backend actually sends a wall editor: `computeCanEditClimbs`
      // returns true whenever `viewerCanEdit` is, whatever the policy.
      ctrl.viewerCanEditClimbs = true;
      const { container } = render(
        <ClimbActionsSheet visible={true} {...baseProps} climb={published} currentUserId="wall-owner" />,
      );
      expect(editRow(container)).toBeNull();
    });

    it('stops offering the setter Edit on Kilter 24 hours after publishing', () => {
      const { container } = render(
        <ClimbActionsSheet visible={true} {...baseProps} climb={published} currentUserId="setter-1" />,
      );
      expect(editRow(container)).toBeNull();
    });
  });

  it('shows add to playlist, and no report row unless the host wires one', () => {
    render(<ClimbActionsSheet visible={true} {...baseProps} onOpenPlaylist={vi.fn()} />);

    expect(screen.getByText('actions.playlist.popover.title')).toBeTruthy();
    // The host gates this on auth + the moderation kill switch, so an unwired
    // sheet must not offer it.
    expect(screen.queryByText('mobile.climbActions.report')).toBeNull();
  });

  it('renders the report row last and fires onReportClimb then onClose', () => {
    const onReportClimb = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <ClimbActionsSheet visible={true} {...baseProps} onClose={onClose} onReportClimb={onReportClimb} />,
    );

    // Below every action a climber came here to do.
    const rows = Array.from(container.querySelectorAll('[data-row]')).map((row) => row.getAttribute('data-row'));
    expect(rows[rows.length - 1]).toBe('mobile.climbActions.report');
    expect(container.querySelector('[data-icon="flag"]')).not.toBeNull();

    fireEvent.click(screen.getByText('mobile.climbActions.report'));

    expect(onReportClimb).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
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

  // #5654: while the connect-step pill has the second row's right end, the play
  // drawer moves share and the queue in here.
  it('shows the queue and share rows only when the host wires them', () => {
    render(<ClimbActionsSheet visible={true} {...baseProps} />);
    expect(screen.queryByText('mobile.climbActions.openQueue')).toBeNull();
    expect(screen.queryByText('share.actionLabel')).toBeNull();
  });

  it('opens the queue only once this sheet has gone', async () => {
    const order: string[] = [];
    sheet.dismissAndWait.mockImplementationOnce(async () => {
      order.push('sheet dismissed');
      return { status: 'dismissed' };
    });
    const onClose = vi.fn(() => order.push('closed'));
    const onOpenQueue = vi.fn(() => order.push('queue opened'));
    render(<ClimbActionsSheet visible={true} {...baseProps} onClose={onClose} onOpenQueue={onOpenQueue} />);

    fireEvent.click(screen.getByText('mobile.climbActions.openQueue'));

    await waitFor(() => expect(onOpenQueue).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['sheet dismissed', 'closed', 'queue opened']);
  });

  it('shares from the share row and closes', () => {
    const onShare = vi.fn();
    const onClose = vi.fn();
    render(<ClimbActionsSheet visible={true} {...baseProps} onClose={onClose} onShare={onShare} />);

    fireEvent.click(screen.getByText('share.actionLabel'));

    expect(onShare).toHaveBeenCalledTimes(1);
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
  it('claims the action, closes the sheet, then awaits the injected player dismissal before pushing', async () => {
    const onClose = vi.fn();
    const dismissPlayerAndWait = vi.fn(async () => ({ status: 'dismissed' as const }));
    render(
      <ClimbActionsSheet visible={true} {...baseProps} onClose={onClose} dismissPlayerAndWait={dismissPlayerAndWait} />,
    );

    fireEvent.click(screen.getByText('mobile.climbActions.fork'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sheet.dismissAndWait).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(dismissPlayerAndWait).toHaveBeenCalledTimes(1));
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(dismissPlayerAndWait.mock.invocationCallOrder[0]);
    await waitFor(() => expect(nav.push).toHaveBeenCalledTimes(1));
    expect(nav.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/climbs/create',
      params: {
        forkFrames: 'p1r12',
        forkName: 'Test Climb',
        forkDescription: '',
        // The parent's grade rides along so a remix on a board that publishes
        // with the setter's own grade (a spray wall) opens at it (#5443).
        forkDifficulty: 'V4',
        boardName: 'kilter',
        layoutId: '1',
        sizeId: '10',
        setIds: '1,2',
        angle: '40',
      },
    });
  });

  it('pushes create in edit mode from the owner-only Edit row', async () => {
    const dismissPlayerAndWait = vi.fn(async () => ({ status: 'dismissed' as const }));
    render(
      <ClimbActionsSheet
        visible={true}
        {...baseProps}
        climb={ownerClimb}
        currentUserId="user-1"
        dismissPlayerAndWait={dismissPlayerAndWait}
      />,
    );

    fireEvent.click(screen.getByText('mobile.climbActions.edit'));

    await waitFor(() => expect(nav.push).toHaveBeenCalledTimes(1));
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
  it('does not dismiss a player route when the player is an inline pane', async () => {
    render(<ClimbActionsSheet visible={true} {...baseProps} />);

    fireEvent.click(screen.getByText('mobile.climbActions.fork'));

    await waitFor(() => expect(nav.push).toHaveBeenCalledTimes(1));
  });

  it('continues when the source sheet handle is already absent', async () => {
    sheet.exposeHandle = false;
    render(<ClimbActionsSheet visible={true} {...baseProps} />);

    fireEvent.click(screen.getByText('mobile.climbActions.fork'));

    expect(sheet.dismissAndWait).not.toHaveBeenCalled();
    await waitFor(() => expect(nav.push).toHaveBeenCalledTimes(1));
  });

  it('stops the handoff when the source sheet disappears during dismissal', async () => {
    sheet.dismissAndWait.mockResolvedValueOnce({ status: 'aborted' });
    const dismissPlayerAndWait = vi.fn(async () => ({ status: 'dismissed' as const }));
    render(<ClimbActionsSheet visible={true} {...baseProps} dismissPlayerAndWait={dismissPlayerAndWait} />);

    fireEvent.click(screen.getByText('mobile.climbActions.fork'));

    await waitFor(() => expect(sheet.dismissAndWait).toHaveBeenCalledTimes(1));
    expect(dismissPlayerAndWait).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });
});
