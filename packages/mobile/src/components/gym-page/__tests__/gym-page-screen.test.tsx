// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactElement, type ReactNode } from 'react';
import type { Gym, UserBoard } from '@boardsesh/shared-schema';

// An orchestration test: the blocks themselves are stubs that expose their
// props, so this pins which blocks the page draws, in what order, and where
// their actions lead. The decisions behind the order are covered by
// gym-page-view-model.test.ts.

type Children = { children?: ReactNode };
type ButtonProps = { title: string; onPress: () => void };
type ListItem = { kind: string; key: string };
type Actions = {
  onClaim: () => void;
  onSignIn: () => void;
  onStaffTool: (tool: string) => void;
  onStartRow: (row: string) => void;
};

const routerMock = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), setParams: vi.fn() }));
const trackMock = vi.hoisted(() => vi.fn());
const openUrlMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const scrollToIndex = vi.hoisted(() => vi.fn());
const headerCapture = vi.hoisted(() => ({ accessory: null as ReactElement | null }));
const screenOptions = vi.hoisted(() => ({ title: undefined as string | undefined }));

const state = vi.hoisted(() => ({
  params: { gym: 'gym-uuid-1' } as Record<string, string | undefined>,
  isAuthenticated: true,
  authLoading: false,
  profileId: 'climber-1' as string | undefined,
  gymQuery: {
    data: undefined as Gym | null | undefined,
    status: 'success' as 'pending' | 'error' | 'success',
    fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
    error: null as unknown,
    isPending: false,
    refetch: vi.fn(),
  },
  boards: {
    data: [] as UserBoard[] | undefined,
    isPending: false,
    isError: false,
    refetch: vi.fn().mockResolvedValue(undefined),
  },
  offline: { isOffline: false, isBlocked: false, reason: null as string | null },
  reportAction: null as { open: () => void; sheet: ReactNode } | null,
  boardSheets: null as ReactNode,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children, testID }: Children & { testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('expo-router', () => ({
  Stack: {
    Screen: ({ options }: { options: { title?: string } }) => {
      screenOptions.title = options.title;
      return null;
    },
  },
  useRouter: () => routerMock,
  useLocalSearchParams: () => state.params,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data: ListItem[];
    renderItem: (info: { item: ListItem }) => ReactNode;
    ref?: { current: unknown };
  }) => {
    if (props.ref) props.ref.current = { scrollToIndex };
    return createElement(
      'div',
      { 'data-testid': 'list' },
      props.data.map((item) => createElement('div', { key: item.key }, props.renderItem({ item }))),
    );
  },
}));

vi.mock('../../../hooks/use-stack-screen-options', () => ({ useStackScreenOptions: () => ({}) }));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../hooks/use-header-actions', () => ({
  useHeaderActions: ({ trailingAccessory }: { trailingAccessory?: ReactElement | null }) => {
    headerCapture.accessory = trailingAccessory ?? null;
  },
}));
vi.mock('../../../hooks/use-offline-query-state', () => ({ useOfflineQueryState: () => state.offline }));
vi.mock('../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: undefined, isLoading: false }),
}));
vi.mock('../../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  useConnectivityField: () => false,
  selectEffectiveOffline: () => false,
}));
vi.mock('../../../lib/env', () => ({ WEB_BASE_URL: 'https://www.boardsesh.com' }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: state.profileId ? { id: state.profileId } : undefined }),
}));
vi.mock('../../../lib/graphql/hooks/use-gym-boards', () => ({ useGymBoards: () => state.boards }));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/open-external-link', () => ({ openValidatedUrl: openUrlMock }));
vi.mock('../../../lib/spray/use-spray-label-options', () => ({ useSprayLabelOptions: () => ({}) }));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: state.isAuthenticated, isLoading: state.authLoading }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#fff', secondaryLabel: '#666' } }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 8: 32 } }));

vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: ButtonProps) => createElement('button', { onClick: onPress, type: 'button' }, title),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i') }));
vi.mock('../../OfflineState', () => ({
  OfflineState: ({ reason }: { reason: string }) => createElement('div', { 'data-testid': `offline-${reason}` }),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../gym-directory/ClaimGymSheet', () => ({
  ClaimGymSheet: () => createElement('div', { 'data-testid': 'claim-sheet' }),
}));

vi.mock('../GymBoardRow', () => ({
  GymBoardRow: ({ item, position }: { item: { key: string; title: string }; position: string }) =>
    createElement('div', { 'data-testid': `board-${item.key}`, 'data-position': position }, item.title),
}));
vi.mock('../GymPageHeaderActions', () => ({ GymPageHeaderActions: () => null }));
vi.mock('../GymPageSections', () => {
  const block = (name: string) => () => createElement('div', { 'data-testid': `block-${name}` });
  return {
    GymPageTopBlock: ({ actions }: { actions: Actions }) =>
      createElement('div', { 'data-testid': 'block-top' }, [
        createElement('button', { key: 'claim', onClick: actions.onClaim, type: 'button' }, 'claim-inline'),
        createElement('button', { key: 'signin', onClick: actions.onSignIn, type: 'button' }, 'sign-in'),
      ]),
    GymStartHereSection: ({ rows, actions }: { rows: string[]; actions: Actions }) =>
      createElement(
        'div',
        { 'data-testid': 'block-start' },
        rows.map((row) =>
          createElement('button', { key: row, onClick: () => actions.onStartRow(row), type: 'button' }, `start-${row}`),
        ),
      ),
    GymStaffToolsSection: ({ tools, actions }: { tools: string[]; actions: Actions }) =>
      createElement(
        'div',
        { 'data-testid': 'block-staff' },
        tools.map((tool) =>
          createElement(
            'button',
            { key: tool, onClick: () => actions.onStaffTool(tool), type: 'button' },
            `tool-${tool}`,
          ),
        ),
      ),
    GymBoardsHeader: ({ count }: { count: number | null }) =>
      createElement('div', { 'data-testid': 'block-boards-header' }, String(count)),
    GymBoardsLoading: block('boards-loading'),
    GymBoardsError: block('boards-error'),
    GymBoardsEmpty: block('boards-empty'),
    GymInfoSection: block('info'),
    GymClaimCardBlock: ({ card }: { card: string }) => createElement('div', { 'data-testid': `block-claim-${card}` }),
    GymReportSection: block('report'),
  };
});
vi.mock('../use-gym-page-data', () => ({
  useGymPageGym: () => state.gymQuery,
  useGymPendingClaim: () => ({ data: null, refetch: vi.fn().mockResolvedValue(undefined) }),
  gymPendingClaimQueryKey: (slug: string | null) => ['gymPendingClaim', slug],
}));
vi.mock('../use-gym-board-menu', () => ({
  useGymBoardMenu: () => ({ menu: {}, onPressBoard: vi.fn(), sheets: state.boardSheets }),
}));
vi.mock('../use-gym-report-action', () => ({ useGymReportAction: () => state.reportAction }));

import GymPageScreen from '../GymPageScreen';

function makeGym(overrides: Partial<Gym> = {}): Gym {
  return {
    uuid: 'gym-uuid-1',
    slug: 'crux',
    ownerId: 'owner-1',
    ownerDisplayName: 'Sam',
    name: 'Crux',
    address: '1 Crag St',
    isPublic: true,
    isFollowedByMe: false,
    myRole: null,
    canEdit: false,
    canClaim: true,
    listingState: 'CLIMBER_LISTED',
    hours: null,
    website: null,
    contactPhone: null,
    contactEmail: null,
    ...overrides,
  } as unknown as Gym;
}

function makeBoard(uuid: string, name: string): UserBoard {
  return {
    uuid,
    name,
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    angle: 40,
    ownerId: 'someone',
    gymName: 'Crux',
  } as unknown as UserBoard;
}

function kinds(): string[] {
  return Array.from(screen.getByTestId('list').querySelectorAll('[data-testid]')).map(
    (node) => node.getAttribute('data-testid') ?? '',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.params = { gym: 'gym-uuid-1' };
  state.isAuthenticated = true;
  state.authLoading = false;
  state.profileId = 'climber-1';
  state.gymQuery = { ...state.gymQuery, data: makeGym(), status: 'success', isPending: false };
  state.boards = { ...state.boards, data: [makeBoard('b1', 'Crux - Kilter'), makeBoard('b2', 'Crux - Tension')] };
  state.offline = { isOffline: false, isBlocked: false, reason: null };
  state.reportAction = null;
  state.boardSheets = null;
  headerCapture.accessory = null;
});

describe('GymPageScreen', () => {
  it('shows the honest placard when the gym cannot be read, never a spinner', () => {
    state.gymQuery = { ...state.gymQuery, data: undefined, status: 'pending', fetchStatus: 'paused', isPending: true };
    state.offline = { isOffline: true, isBlocked: true, reason: 'offline' };
    render(<GymPageScreen />);
    expect(screen.getByTestId('offline-offline')).toBeTruthy();
    expect(screen.queryByTestId('spinner')).toBeNull();
  });

  it('says the gym is gone, with a way back', () => {
    state.gymQuery = { ...state.gymQuery, data: null };
    render(<GymPageScreen />);
    expect(screen.getByText('mobile.gymPage.notFound')).toBeTruthy();
    fireEvent.click(screen.getByText('mobile.gymEdit.back'));
    expect(routerMock.back).toHaveBeenCalled();
  });

  it("draws a climber's page: who runs it, the boards without the gym's name, then the claim card", () => {
    render(<GymPageScreen />);
    expect(screenOptions.title).toBe('Crux');
    expect(kinds()).toEqual(['block-top', 'block-boards-header', 'board-b1', 'board-b2', 'block-claim-claim']);
    expect(screen.getByTestId('board-b1').textContent).toBe('Kilter');
    expect(screen.getByTestId('board-b1').getAttribute('data-position')).toBe('first');
    expect(screen.getByTestId('block-boards-header').textContent).toBe('2');
    expect(headerCapture.accessory).not.toBeNull();
  });

  it('counts one Gym Page Viewed per gym, with the listing state and the viewer role', () => {
    const { rerender } = render(<GymPageScreen />);
    rerender(<GymPageScreen />);
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('Gym Page Viewed', {
      surface: 'app',
      listingState: 'CLIMBER_LISTED',
      viewerRole: 'climber',
    });
  });

  it('waits for the signed-in viewer to resolve before counting the view', () => {
    state.profileId = undefined;
    render(<GymPageScreen />);
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('holds the view and the log-in card while auth is still restoring', () => {
    state.isAuthenticated = false;
    state.authLoading = true;
    render(<GymPageScreen />);
    expect(trackMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('block-claim-signIn')).toBeNull();
  });

  it('moves a slug-opened page onto the uuid read once the gym resolves', () => {
    state.params = { gym: 'crux-gym' };
    render(<GymPageScreen />);
    expect(routerMock.setParams).toHaveBeenCalledWith({ gym: makeGym().uuid });
  });

  it('opens the claim sheet in this route', () => {
    render(<GymPageScreen />);
    expect(screen.queryByTestId('claim-sheet')).toBeNull();
    fireEvent.click(screen.getByText('claim-inline'));
    expect(screen.getByTestId('claim-sheet')).toBeTruthy();
  });

  it('sends a signed-out visitor to log in before a claim', () => {
    state.isAuthenticated = false;
    render(<GymPageScreen />);
    expect(screen.getByTestId('block-claim-signIn')).toBeTruthy();
    fireEvent.click(screen.getByText('sign-in'));
    expect(routerMock.push).toHaveBeenCalledWith('/auth/login');
  });

  it("gives staff Start here and their tools, and sends the website's jobs to the website", async () => {
    state.gymQuery = {
      ...state.gymQuery,
      data: makeGym({ myRole: 'admin', canEdit: true, canClaim: false, listingState: 'RUN_BY_GYM' }),
    };
    render(<GymPageScreen />);
    expect(kinds()).toEqual(['block-top', 'block-start', 'block-boards-header', 'board-b1', 'board-b2', 'block-staff']);

    fireEvent.click(screen.getByText('tool-editDetails'));
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/gyms/edit', params: { gymUuid: 'gym-uuid-1' } });

    fireEvent.click(screen.getByText('tool-kiosks'));
    await Promise.resolve();
    expect(openUrlMock).toHaveBeenCalledWith(
      'https://www.boardsesh.com/gym/crux/manage?tab=kiosks',
      expect.any(Function),
    );

    fireEvent.click(screen.getByText('tool-nearbyBoards'));
    expect(openUrlMock).toHaveBeenLastCalledWith(
      'https://www.boardsesh.com/gym/crux/manage?tab=boards',
      expect.any(Function),
    );

    fireEvent.click(screen.getByText('start-boards'));
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 2, animated: true });
  });

  it('offers Report a problem on the gym in the header and at the foot, with the sheet in this route', () => {
    const open = vi.fn();
    state.reportAction = { open, sheet: <div data-testid="gym-report-sheet" /> };
    render(<GymPageScreen />);
    expect(kinds()).toEqual([
      'block-top',
      'block-boards-header',
      'board-b1',
      'board-b2',
      'block-claim-claim',
      'block-report',
    ]);
    expect(screen.getByTestId('gym-report-sheet')).toBeTruthy();
    expect((headerCapture.accessory?.props as { onReport?: () => void }).onReport).toBe(open);
  });

  it('gives staff Edit gym details, never Report a problem, in the header', () => {
    state.reportAction = { open: vi.fn(), sheet: null };
    state.gymQuery = {
      ...state.gymQuery,
      data: makeGym({ myRole: 'admin', canEdit: true, canClaim: false, listingState: 'RUN_BY_GYM' }),
    };
    render(<GymPageScreen />);
    expect((headerCapture.accessory?.props as { onReport?: () => void }).onReport).toBeUndefined();
  });

  it("mounts the board rows' report and review sheets in this route", () => {
    state.boardSheets = <div data-testid="board-report-sheets" />;
    render(<GymPageScreen />);
    expect(screen.getByTestId('board-report-sheets')).toBeTruthy();
  });

  it('puts boards with a waiting report first for staff, and keeps the order for a climber', () => {
    state.boards = {
      ...state.boards,
      data: [makeBoard('b1', 'Crux - Kilter'), { ...makeBoard('b2', 'Crux - Tension'), openReportCount: 1 }],
    };
    const { unmount } = render(<GymPageScreen />);
    expect(kinds().filter((kind) => kind.startsWith('board-'))).toEqual(['board-b1', 'board-b2']);
    unmount();

    state.gymQuery = {
      ...state.gymQuery,
      data: makeGym({ myRole: 'editor', canEdit: true, canClaim: false, listingState: 'RUN_BY_GYM' }),
    };
    render(<GymPageScreen />);
    expect(kinds().filter((kind) => kind.startsWith('board-'))).toEqual(['board-b2', 'board-b1']);
  });

  it('shows a placeholder while the boards load and the empty state when there are none', () => {
    state.boards = { ...state.boards, data: undefined, isPending: true };
    const { unmount } = render(<GymPageScreen />);
    expect(kinds()).toContain('block-boards-loading');
    unmount();

    state.boards = { ...state.boards, data: [], isPending: false };
    render(<GymPageScreen />);
    expect(kinds()).toContain('block-boards-empty');
  });
});
