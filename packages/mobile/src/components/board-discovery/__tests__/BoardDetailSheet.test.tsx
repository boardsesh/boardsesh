// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { BoardDetailSheet } from '../BoardDetailSheet';
const relistMutate = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const focusEffects = vi.hoisted(() => ({ latest: null as (() => void) | null }));
const state = vi.hoisted(() => ({
  directoryReports: true,
  canReport: true,
  profileId: 'viewer-1' as string | undefined,
  viewerUserId: 'viewer-1' as string | null,
  audience: undefined as string | undefined,
  privacyResourceIds: [] as (string | undefined)[],
  // undefined: not loaded yet; null: the gym no longer resolves.
  relistGym: undefined as { uuid: string; name: string } | null | undefined,
  gymArgs: [] as (string | null)[],
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
  // The picker regaining focus after the gym page pops; the test calls it by hand.
  useFocusEffect: (effect: () => void) => {
    focusEffects.latest = effect;
  },
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  Platform: { OS: 'android' },
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: unknown) => styles,
    hairlineWidth: 1,
  },
}));
vi.mock('../../Sheet', () => ({
  Sheet: ({ children, header, visible }: { children: ReactNode; header?: ReactNode; visible: boolean }) =>
    visible ? createElement('div', null, header, children) : null,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Avatar', () => ({ Avatar: () => null }));
vi.mock('../../SheetTopBar', async () => (await import('../../../test/sheet-top-bar-stub')).sheetTopBarModule);
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({ systemColors: {} }),
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
vi.mock('../../../lib/spray/use-spray-moderation', () => ({
  useSprayModerationAccess: () => ({ canReport: state.canReport }),
}));
vi.mock('../board-detail-fields', () => ({
  getBoardDetailFields: () => ({ setNames: '', subLocation: undefined, sizeText: undefined }),
  isActiveBoard: () => false,
}));
vi.mock('../../spray-wall/ReportSprayWallSheet', () => ({
  ReportSprayWallSheet: ({ wallUuid, wallName }: { wallUuid: string; wallName: string }) =>
    createElement('div', { 'data-testid': 'report-target' }, `${wallUuid}:${wallName}`),
}));
vi.mock('../BoardShareSheet', () => ({
  BoardShareSheet: ({ wallName }: { wallName: string }) =>
    createElement('div', { 'data-testid': 'share-target' }, wallName),
}));
vi.mock('../HomeBoardShareSheet', () => ({
  HomeBoardShareSheet: ({ target, boardName }: { target: { kind: string }; boardName: string }) =>
    createElement('div', { 'data-testid': 'home-share-target' }, `${target.kind}:${boardName}`),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: state.profileId ? { id: state.profileId } : undefined }),
  useGym: (gymUuid: string | null) => {
    state.gymArgs.push(gymUuid);
    return { data: gymUuid ? state.relistGym : undefined };
  },
}));
vi.mock('../../../hooks/use-viewer-user-id', () => ({ useViewerUserId: () => state.viewerUserId }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../lib/graphql/hooks/use-resource-privacy', () => ({
  useResourcePrivacy: (_kind: string, resourceId?: string) => {
    state.privacyResourceIds.push(resourceId);
    return { data: resourceId && state.audience ? { audience: state.audience } : undefined };
  },
}));
vi.mock('../../../lib/env', () => ({ WEB_BASE_URL: 'https://www.boardsesh.com' }));
// The real useReportProblem and its host, so the displacement test below runs
// the hook that decides whether the report sheet stays mounted. Only the sheets
// themselves are stand-ins.
vi.mock('../../report-problem/ReportDirectorySheet', () => ({
  ReportDirectorySheet: ({ target, onClose }: { target: { board: UserBoard }; onClose: () => void }) =>
    createElement(
      'div',
      { 'data-testid': 'report-sheet' },
      `${target.board.uuid}:${target.board.name}`,
      createElement('button', { type: 'button', onClick: onClose }, 'close report'),
    ),
}));
vi.mock('../../gym-directory/ClaimGymSheet', () => ({ ClaimGymSheet: () => null }));
vi.mock('../../../lib/graphql/hooks/use-directory-reports', () => ({
  useReportBoard: () => ({ mutate: relistMutate }),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useDirectoryReportsEnabled: () => state.directoryReports,
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));
const wall = {
  uuid: 'wall-a',
  name: 'Crew wall',
  slug: 'crew-wall',
  angle: 40,
  boardType: 'spray',
  canEdit: false,
  isPublic: true,
  isUnlisted: false,
  totalAscents: 0,
  uniqueClimbers: 0,
  followerCount: 0,
} as unknown as UserBoard;
beforeEach(() => {
  state.directoryReports = true;
  relistMutate.mockReset();
  showToast.mockReset();
  routerPush.mockClear();
  focusEffects.latest = null;
  state.canReport = true;
  state.profileId = 'viewer-1';
  state.viewerUserId = 'viewer-1';
  state.audience = undefined;
  state.privacyResourceIds = [];
  state.relistGym = undefined;
  state.gymArgs = [];
});
describe('BoardDetailSheet moderation handoff', () => {
  it('offers reporting to a signed-in non-editor and retains target after detail displacement', () => {
    const props = { onClose: vi.fn(), onSetActive: vi.fn() };
    const screen = render(<BoardDetailSheet board={wall} visible {...props} />);
    fireEvent.click(screen.getByLabelText('sprayModeration.reportTitle'));
    screen.rerender(<BoardDetailSheet board={null} visible={false} {...props} />);
    expect(screen.getByTestId('report-target').textContent).toBe('wall-a:Crew wall');
  });
  it('retains share target after the same coordinator displacement', () => {
    const props = { onClose: vi.fn(), onSetActive: vi.fn() };
    const screen = render(<BoardDetailSheet board={wall} visible {...props} />);
    fireEvent.click(screen.getByLabelText('mobile.boardDetail.spray.shareLink'));
    screen.rerender(<BoardDetailSheet board={null} visible={false} {...props} />);
    expect(screen.getByTestId('share-target').textContent).toBe('Crew wall');
  });
  it('hides reporting when authorization is missing and on catalogue boards', () => {
    state.canReport = false;
    const props = { onClose: vi.fn(), onSetActive: vi.fn() };
    const screen = render(<BoardDetailSheet board={wall} visible {...props} />);
    expect(screen.queryByLabelText('sprayModeration.reportTitle')).toBeNull();
    state.canReport = true;
    screen.rerender(<BoardDetailSheet board={{ ...wall, boardType: 'kilter' }} visible {...props} />);
    expect(screen.queryByLabelText('sprayModeration.reportTitle')).toBeNull();
  });
});

describe('BoardDetailSheet Report a problem', () => {
  const catalogue = {
    ...wall,
    uuid: 'kilter-a',
    name: 'Crux Kilter',
    boardType: 'kilter',
    ownerId: 'someone-else',
  } as UserBoard;
  const props = { onClose: vi.fn(), onSetActive: vi.fn() };

  it('ends every catalogue board with Report a problem, and hosts its sheet', () => {
    const screen = render(<BoardDetailSheet board={catalogue} visible {...props} />);
    expect(screen.queryByTestId('report-sheet')).toBeNull();
    fireEvent.click(screen.getByLabelText('report.actionAria'));
    expect(screen.getByTestId('report-sheet').textContent).toContain('kilter-a:Crux Kilter');
  });

  // Presenting the report sheet displaces the detail sheet (one presenter
  // group), whose onClose clears the host's board. The report sheet must
  // survive that, as the Spraywall report and share rows above do.
  it('keeps the report sheet up after the detail sheet is displaced, until it closes', () => {
    const screen = render(<BoardDetailSheet board={catalogue} visible {...props} />);
    fireEvent.click(screen.getByLabelText('report.actionAria'));
    screen.rerender(<BoardDetailSheet board={null} visible={false} {...props} />);
    expect(screen.getByTestId('report-sheet').textContent).toContain('kilter-a:Crux Kilter');
    fireEvent.click(screen.getByText('close report'));
    expect(screen.queryByTestId('report-sheet')).toBeNull();
  });

  it('keeps a Spraywall on its own report, and says Reported once the climber reported', () => {
    const wallScreen = render(<BoardDetailSheet board={wall} visible {...props} />);
    expect(wallScreen.queryByLabelText('report.actionAria')).toBeNull();
    wallScreen.unmount();
    const screen = render(<BoardDetailSheet board={{ ...catalogue, viewerHasOpenReport: true }} visible {...props} />);
    expect(screen.queryByLabelText('report.actionAria')).toBeNull();
    expect(screen.getByText('report.reported')).toBeTruthy();
  });

  it('offers nothing when the viewer can fix the board or the flag is off', () => {
    const own = render(<BoardDetailSheet board={{ ...catalogue, ownerId: 'viewer-1' }} visible {...props} />);
    expect(own.queryByLabelText('report.actionAria')).toBeNull();
    own.unmount();
    const staff = render(<BoardDetailSheet board={{ ...catalogue, canRemoveFromGym: true }} visible {...props} />);
    expect(staff.queryByLabelText('report.actionAria')).toBeNull();
    staff.unmount();
    state.directoryReports = false;
    const screen = render(<BoardDetailSheet board={catalogue} visible {...props} />);
    expect(screen.queryByLabelText('report.actionAria')).toBeNull();
    expect(screen.queryByText('report.reported')).toBeNull();
  });

  it('opens the review for the creator or staff while a report waits on them', () => {
    const onReviewReports = vi.fn();
    const reported = { ...catalogue, openReportCount: 2 } as UserBoard;
    const screen = render(<BoardDetailSheet board={reported} visible {...props} onReviewReports={onReviewReports} />);
    fireEvent.click(screen.getByLabelText('reportReview.open'));
    expect(onReviewReports).toHaveBeenCalledWith(reported);
  });
});

describe('BoardDetailSheet Ask {{gym}} to list it again', () => {
  const props = { onClose: vi.fn(), onSetActive: vi.fn() };
  // The creator's own board, off every gym since the staff removal.
  const removed = {
    ...wall,
    uuid: 'kilter-a',
    name: 'Crux Kilter',
    boardType: 'kilter',
    ownerId: 'viewer-1',
    gymUuid: null,
  } as unknown as UserBoard;
  const relistGym = { uuid: 'gym-crux', name: 'Crux' };

  it('asks the gym to list the board again, naming the gym as it is now', () => {
    state.relistGym = { uuid: 'gym-crux', name: 'Crux Climbing' };
    const screen = render(<BoardDetailSheet board={removed} visible {...props} relistGym={relistGym} />);
    expect(state.gymArgs).toContain('gym-crux');
    fireEvent.click(screen.getByLabelText('report.relistAsk'));
    expect(relistMutate).toHaveBeenCalledWith(
      { boardUuid: 'kilter-a', reason: 'relist_request' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    act(() => {
      relistMutate.mock.calls[0][1].onSuccess({ status: 'created' });
      relistMutate.mock.calls[0][1].onSettled();
    });
    expect(showToast).toHaveBeenCalledWith('report.relistSent', 'success');
  });

  it('sends once: the row stops taking taps while the ask is in flight and after it went through', () => {
    const screen = render(<BoardDetailSheet board={removed} visible {...props} relistGym={relistGym} />);
    const row = screen.getByLabelText('report.relistAsk');
    fireEvent.click(row);
    fireEvent.click(row);
    expect(relistMutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('report.relistAsk')).toBeNull();
    act(() => {
      relistMutate.mock.calls[0][1].onSuccess({ status: 'created' });
      relistMutate.mock.calls[0][1].onSettled();
    });
    expect(screen.queryByLabelText('report.relistAsk')).toBeNull();
    expect(screen.getByText('report.relistSent')).toBeTruthy();
    expect(relistMutate).toHaveBeenCalledTimes(1);
  });

  it('lets the climber try again after a failed ask', () => {
    const screen = render(<BoardDetailSheet board={removed} visible {...props} relistGym={relistGym} />);
    fireEvent.click(screen.getByLabelText('report.relistAsk'));
    act(() => {
      relistMutate.mock.calls[0][1].onError(new Error('offline'));
      relistMutate.mock.calls[0][1].onSettled();
    });
    expect(showToast).toHaveBeenCalledWith('report.error', 'error');
    fireEvent.click(screen.getByLabelText('report.relistAsk'));
    expect(relistMutate).toHaveBeenCalledTimes(2);
  });

  it("offers it only to the board's creator", () => {
    state.viewerUserId = 'staff-member';
    const screen = render(<BoardDetailSheet board={removed} visible {...props} relistGym={relistGym} />);
    expect(screen.queryByLabelText('report.relistAsk')).toBeNull();
    state.viewerUserId = null;
    screen.rerender(<BoardDetailSheet board={{ ...removed }} visible {...props} relistGym={relistGym} />);
    expect(screen.queryByLabelText('report.relistAsk')).toBeNull();
  });

  it('offers nothing for a gym that no longer resolves, a board back on a gym, or the flag off', () => {
    state.relistGym = null;
    const gone = render(<BoardDetailSheet board={removed} visible {...props} relistGym={relistGym} />);
    expect(gone.queryByLabelText('report.relistAsk')).toBeNull();
    gone.unmount();
    state.relistGym = undefined;
    const back = render(
      <BoardDetailSheet board={{ ...removed, gymUuid: 'gym-crux' }} visible {...props} relistGym={relistGym} />,
    );
    expect(back.queryByLabelText('report.relistAsk')).toBeNull();
    back.unmount();
    state.directoryReports = false;
    const off = render(<BoardDetailSheet board={removed} visible {...props} relistGym={relistGym} />);
    expect(off.queryByLabelText('report.relistAsk')).toBeNull();
  });
});

const homeBoard = {
  uuid: 'home-a',
  name: 'Garage board',
  slug: 'garage-board',
  angle: 40,
  boardType: 'kilter',
  ownerId: 'viewer-1',
  isPublic: false,
  isUnlisted: false,
  totalAscents: 0,
  uniqueClimbers: 0,
  followerCount: 0,
} as unknown as UserBoard;

describe('BoardDetailSheet home board share row', () => {
  const props = { onClose: vi.fn(), onSetActive: vi.fn() };

  it("offers the owner an Invite-only board's invite link", () => {
    state.audience = 'invite_only';
    const screen = render(<BoardDetailSheet board={homeBoard} visible {...props} />);
    fireEvent.click(screen.getByLabelText('mobile.boardDetail.share.shareLink'));
    expect(screen.getByTestId('home-share-target').textContent).toBe('invite:Garage board');
  });

  it('offers no row for an Only-me board', () => {
    state.audience = 'only_me';
    const screen = render(<BoardDetailSheet board={homeBoard} visible {...props} />);
    expect(screen.queryByLabelText('mobile.boardDetail.share.shareLink')).toBeNull();
  });

  it("never asks for someone else's board audience, and offers them no row on a private board", () => {
    state.profileId = 'stranger';
    state.audience = 'followers';
    const screen = render(<BoardDetailSheet board={homeBoard} visible {...props} />);
    expect(screen.queryByLabelText('mobile.boardDetail.share.shareLink')).toBeNull();
    expect(state.privacyResourceIds.every((resourceId) => resourceId === undefined)).toBe(true);
  });

  it("offers anyone a Public board's plain link", () => {
    state.profileId = 'stranger';
    const screen = render(<BoardDetailSheet board={{ ...homeBoard, isPublic: true }} visible {...props} />);
    fireEvent.click(screen.getByLabelText('mobile.boardDetail.share.shareLink'));
    expect(screen.getByTestId('home-share-target').textContent).toBe('plain:Garage board');
  });
});

describe('BoardDetailSheet At {gym} row', () => {
  const gymBoard = {
    ...homeBoard,
    uuid: 'gym-board',
    ownerId: 'someone',
    isPublic: true,
    gymUuid: 'gym-uuid-1',
    gymName: 'Crux',
  } as unknown as UserBoard;

  it('opens the gym page in the picker stack, then brings the sheet back on return', () => {
    const onClose = vi.fn();
    const screen = render(
      <BoardDetailSheet board={gymBoard} visible onClose={onClose} onSetActive={vi.fn()} returnTo="/(tabs)/discover" />,
    );
    fireEvent.click(screen.getByLabelText('mobile.boardDetail.atGym'));
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/boards/gym/[gym]',
      params: { gym: 'gym-uuid-1', returnTo: '/(tabs)/discover' },
    });
    // Suspended: the sheet is closed, but its board is kept and nobody was told it closed.
    expect(screen.queryByLabelText('mobile.boardDetail.atGym')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    act(() => focusEffects.latest?.());
    expect(screen.getByLabelText('mobile.boardDetail.atGym')).toBeTruthy();
  });

  it('draws no row for a board with no gym the viewer can see', () => {
    const screen = render(
      <BoardDetailSheet board={{ ...gymBoard, gymName: null }} visible onClose={vi.fn()} onSetActive={vi.fn()} />,
    );
    expect(screen.queryByLabelText('mobile.boardDetail.atGym')).toBeNull();
  });
});
