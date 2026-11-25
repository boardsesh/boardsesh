// @vitest-environment jsdom
//
// A gym's wall list (#8151): every state the design names, and the two ways
// out (take a wall, or say yours isn't listed). The rule that matters most: a
// failed lookup never reads as "no boards", which would tell a climber
// standing in a gym to add a second copy of the wall in front of them.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ExistingWallCandidate, UserBoard } from '@boardsesh/shared-schema';

type Children = { children?: ReactNode };

const pushMock = vi.hoisted(() => vi.fn());
const dismissToMock = vi.hoisted(() => vi.fn());
const setOptionsMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const takeWallMock = vi.hoisted(() => vi.fn());
const reportOpenMock = vi.hoisted(() => vi.fn());
const refetchMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  signedIn: true,
  offline: false,
  gym: { uuid: 'gym-1', name: 'Boulder Space', latitude: 52.1, longitude: 4.3, canEdit: false } as Record<
    string,
    unknown
  > | null,
  gymError: false,
  gymBoards: [] as { uuid: string; boardType: string }[] | undefined,
  gymBoardsError: false,
  candidates: {
    data: undefined as { candidates: unknown[]; truncated: boolean } | undefined,
    isLoading: false,
    isError: false,
  },
  candidatesInput: null as unknown,
  canReport: true,
}));

vi.mock('react-native', () => ({
  View: ({ children, testID }: Children & { testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  ScrollView: ({ children, testID }: Children & { testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: pushMock, dismissTo: dismissToMock }),
  useNavigation: () => ({ setOptions: setOptionsMock }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));
vi.mock('@boardsesh/board-config', () => ({
  SUPPORTED_BOARDS: ['kilter', 'tension', 'moonboard'],
  toBoardName: (value: string) => (['kilter', 'tension', 'moonboard'].includes(value) ? value : null),
  boardSetupLabelParts: () => ({ layout: '2019', size: null, sets: ['Hold Set A'], angle: null }),
}));
vi.mock('../board-builder-labels', () => ({ boardTypeLabel: (boardName: string) => `label:${boardName}` }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useGym: () => ({ data: state.gym ?? undefined, isError: state.gymError, refetch: refetchMock }),
  useGymBoards: () => ({ data: state.gymBoards, isError: state.gymBoardsError }),
  useProfile: () => ({ data: state.signedIn ? { id: 'viewer' } : undefined }),
  useExistingWallCandidates: (input: unknown) => {
    state.candidatesInput = input;
    return { ...state.candidates, error: null, refetch: refetchMock };
  },
}));
vi.mock('../../../lib/graphql/extract-error-message', () => ({ isGraphqlRateLimitedError: () => false }));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  selectEffectiveOffline: () => false,
  useConnectivityField: () => state.offline,
}));
vi.mock('../../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: state.signedIn }) }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: { error: 'red' } }) }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 8: 32 }, borderRadius: { md: 8 } }));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../lib/boards/board-return-to', () => ({ resolveBoardReturnTo: () => '/(tabs)/climbs' }));
vi.mock('../../../lib/boards/use-take-existing-wall', () => ({ useTakeExistingWall: () => takeWallMock }));
vi.mock('../../gym-page/use-gym-report-action', () => ({
  useGymReportAction: () =>
    state.canReport ? { open: reportOpenMock, sheet: createElement('div', { key: 'report-sheet' }) } : null,
}));
vi.mock('../../ShelfHeader', () => ({
  SHELF_HEADER_CONTENT_GAP: 8,
  SHELF_SECTION_GAP: 28,
  ShelfHeader: ({
    title,
    action,
    testID,
  }: {
    title: string;
    testID?: string;
    action?: { label: string; onPress: () => void };
  }) =>
    createElement('section', { 'data-testid': testID }, [
      createElement('h2', { key: 'title' }, title),
      action ? createElement('button', { key: 'action', type: 'button', onClick: action.onPress }, action.label) : null,
    ]),
}));
// The list as its cells, in order, so what a climber would scroll through is on the page.
type FlashListMockProps = {
  data: { key: string }[];
  renderItem: (info: { item: unknown; index: number }) => ReactNode;
  keyExtractor: (item: never) => string;
  getItemType?: (item: never) => string;
  ListHeaderComponent?: ReactNode;
  ListFooterComponent?: ReactNode;
  testID?: string;
};
const flashList = vi.hoisted(() => ({ itemTypes: [] as string[] }));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    keyExtractor,
    getItemType,
    ListHeaderComponent,
    ListFooterComponent,
    testID,
  }: FlashListMockProps) => {
    flashList.itemTypes = getItemType ? data.map((item) => getItemType(item as never)) : [];
    return createElement('div', { 'data-testid': testID }, [
      createElement('div', { key: 'header' }, ListHeaderComponent),
      ...data.map((item, index) =>
        createElement('div', { key: keyExtractor(item as never), 'data-cell': true }, renderItem({ item, index })),
      ),
      createElement('div', { key: 'footer' }, ListFooterComponent),
    ]);
  },
}));
vi.mock('../../gym-page/InsetGroupedCell', () => ({
  InsetGroupedCell: ({ children, position }: Children & { position: string }) =>
    createElement('div', { 'data-position': position }, children),
}));
vi.mock('../../InsetGroupedList', () => ({ insetGroupedRowStyles: { row: {}, leading: {}, text: {} } }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, testID }: Children & { onPress: () => void; testID?: string }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-testid': testID }, children),
}));
vi.mock('../../EmptyState', () => ({
  EmptyState: ({ title, actions, testID }: { title: string; actions?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, [createElement('p', { key: 'title' }, title), actions]),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, testID }: { title: string; onPress: () => void; testID?: string }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-testid': testID }, title),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, testID }: Children & { testID?: string }) =>
    createElement('span', { 'data-testid': testID }, children),
}));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('span', null, 'spinner') }));
vi.mock('../BoardConfigChips', () => ({
  BoardConfigChips: ({
    options,
    onSelect,
  }: {
    options: { key: string; label: string; value: string; selected: boolean }[];
    onSelect: (value: string) => void;
  }) =>
    createElement(
      'div',
      null,
      options.map((option) =>
        createElement(
          'button',
          { key: option.key, type: 'button', 'aria-pressed': option.selected, onClick: () => onSelect(option.value) },
          option.label,
        ),
      ),
    ),
}));
vi.mock('../BoardRow', () => ({
  BoardRow: ({
    item,
    onPress,
  }: {
    item: { key: string; title: string; badge?: string | null };
    onPress: (item: unknown) => void;
  }) =>
    createElement('li', null, [
      createElement('button', { key: 'row', type: 'button', onClick: () => onPress(item) }, item.title),
      item.badge ? createElement('span', { key: 'badge' }, item.badge) : null,
    ]),
}));
vi.mock('../DiscoveryBoardArt', () => ({ DiscoveryBoardArt: () => null }));
vi.mock('../WallNotListedConfirmSheet', () => ({
  WallNotListedConfirmSheet: ({
    candidateCount,
    lookupFailed,
    onConfirm,
    onDismiss,
  }: {
    candidateCount: number;
    lookupFailed: boolean;
    onConfirm: () => void;
    onDismiss: () => void;
  }) =>
    createElement('div', { 'data-testid': 'confirm-sheet' }, [
      createElement('span', { key: 'body' }, lookupFailed ? 'lookup failed' : `separate from ${candidateCount}`),
      createElement('button', { key: 'confirm', type: 'button', onClick: onConfirm }, 'confirm'),
      createElement('button', { key: 'dismiss', type: 'button', onClick: onDismiss }, 'keep looking'),
    ]),
}));

const { GymWallList } = await import('../GymWallList');

function wall(uuid: string, overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid,
    name: `Wall ${uuid}`,
    boardType: 'moonboard',
    layoutId: 5,
    sizeId: 1,
    setIds: '17,18',
    angle: 40,
    ownerId: 'someone',
    isPublic: true,
    isUnlisted: false,
    isFollowedByMe: false,
    ...overrides,
  } as UserBoard;
}

function candidate(uuid: string, overrides: Partial<ExistingWallCandidate> = {}): ExistingWallCandidate {
  return {
    board: wall(uuid),
    matchKind: null,
    missingSetIds: [],
    extraSetIds: [],
    source: 'SELECTED_GYM',
    gymName: 'Boulder Space',
    gymDistanceMeters: null,
    ...overrides,
  };
}

/** The wizard step the list is: Boards at {gym}, step 3 of the gym path. */
const WIZARD = {
  stepLabel: 'Step 3 of 4',
  nextContext: {
    returnTo: '/(tabs)/climbs',
    source: 'no_board',
    entry: 'picker' as const,
    trail: ['where' as const, 'gym' as const, 'gym_boards' as const],
  },
};

function renderList(props: Partial<Parameters<typeof GymWallList>[0]> = {}) {
  return render(
    createElement(GymWallList, {
      gymUuid: 'gym-1',
      initialBoardType: 'moonboard',
      returnTo: '/(tabs)/climbs',
      source: 'no_board',
      entry: 'find_step',
      wizard: WIZARD,
      ...props,
    }),
  );
}

function events(name: string) {
  return trackMock.mock.calls.filter(([eventName]) => eventName === name).map(([, props]) => props);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.signedIn = true;
  state.offline = false;
  state.gym = { uuid: 'gym-1', name: 'Boulder Space', latitude: 52.1, longitude: 4.3, canEdit: false };
  state.gymError = false;
  state.gymBoards = [];
  state.gymBoardsError = false;
  state.candidates = { data: { candidates: [], truncated: false }, isLoading: false, isError: false };
  state.candidatesInput = null;
  state.canReport = true;
  takeWallMock.mockResolvedValue({ alreadyFollowed: false });
});

describe('GymWallList', () => {
  it('asks the server for the gym walls of the chosen type', () => {
    renderList();
    expect(state.candidatesInput).toEqual({ gymUuid: 'gym-1', boardType: 'moonboard', limit: 40 });
  });

  it('shows the walls at the gym and the listing nearby on their own shelves', () => {
    state.candidates.data = {
      candidates: [
        candidate('a'),
        candidate('b', { source: 'NEARBY_LISTING', gymName: 'Crag Hall', gymDistanceMeters: 90 }),
      ],
      truncated: false,
    };
    renderList();
    expect(screen.getByTestId('gym-walls-shelf-at_gym')).toBeTruthy();
    expect(screen.getByTestId('gym-walls-shelf-listed_nearby')).toBeTruthy();
    expect(screen.getByText('Wall a')).toBeTruthy();
    expect(events('Board Wall Candidates Shown')[0]).toMatchObject({
      boardType: 'moonboard',
      atGymCount: 1,
      nearbyCount: 1,
      lookup: 'ok',
      trigger: 'find_step',
    });
  });

  it('takes a wall on a tap, and reports how it matched', async () => {
    state.candidates.data = { candidates: [candidate('a')], truncated: false };
    renderList();
    fireEvent.click(screen.getByText('Wall a'));
    await waitFor(() => expect(takeWallMock).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'a' })));
    await waitFor(() =>
      expect(events('Board Wall Candidate Used')[0]).toMatchObject({
        match: 'at_gym',
        position: 0,
        alreadyFollowed: false,
      }),
    );
  });

  it('says so inline when taking a wall fails', async () => {
    takeWallMock.mockRejectedValueOnce(new Error('follow failed'));
    state.candidates.data = { candidates: [candidate('a')], truncated: false };
    renderList();
    fireEvent.click(screen.getByText('Wall a'));
    await waitFor(() => expect(screen.getByTestId('gym-walls-use-error')).toBeTruthy());
  });

  it('confirms before adding another, then opens the builder acknowledging nothing', () => {
    state.candidates.data = { candidates: [candidate('a'), candidate('b')], truncated: false };
    renderList();
    fireEvent.click(screen.getByText('mobile.findWall.boardNotListed'));
    expect(screen.getByText('separate from 2')).toBeTruthy();
    fireEvent.click(screen.getByText('confirm'));
    // The builder's first Save is checked against the real setup: the list has
    // none, so it hands over no acknowledged walls.
    expect(pushMock).toHaveBeenCalledWith({
      pathname: '/boards/create',
      params: {
        returnTo: '/(tabs)/climbs',
        source: 'no_board',
        entry: 'picker',
        trail: 'where,gym,gym_boards',
        path: 'gym',
        kind: 'gym',
        gymUuid: 'gym-1',
        boardType: 'moonboard',
      },
    });
    expect(events('Board Wall Not Listed Confirmed')[0]).toEqual({ candidateCount: 2, lookup: 'ok' });
  });

  it('keeps looking when the confirm is dismissed', () => {
    state.candidates.data = { candidates: [candidate('a')], truncated: false };
    renderList();
    fireEvent.click(screen.getByText('mobile.findWall.boardNotListed'));
    fireEvent.click(screen.getByText('keep looking'));
    expect(screen.queryByTestId('confirm-sheet')).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('offers to set up the first one, with no confirm, when the gym has none', () => {
    renderList();
    expect(screen.getByText(/mobile\.findWall\.emptyTitle/)).toBeTruthy();
    fireEvent.click(screen.getByText('mobile.findWall.setUpFirst'));
    expect(screen.queryByTestId('confirm-sheet')).toBeNull();
    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/boards/create',
        params: expect.not.objectContaining({ acknowledged: expect.anything() }),
      }),
    );
    expect(events('Board Wall Not Listed Confirmed')).toEqual([]);
  });

  it('never reads a failed lookup as an empty gym: Try again, and Add it anyway', () => {
    state.candidates = { data: undefined, isLoading: false, isError: true };
    renderList();
    expect(screen.getByTestId('gym-walls-failed')).toBeTruthy();
    expect(screen.queryByTestId('gym-walls-empty')).toBeNull();
    fireEvent.click(screen.getByText('mobile.findWall.retry'));
    expect(refetchMock).toHaveBeenCalled();
    fireEvent.click(screen.getByText('mobile.findWall.addAnyway'));
    expect(screen.getByText('lookup failed')).toBeTruthy();
    fireEvent.click(screen.getByText('confirm'));
    const [[route]] = pushMock.mock.calls as [[{ params: Record<string, string> }]];
    const { params } = route;
    expect(params.acknowledged).toBeUndefined();
    expect(events('Board Wall Not Listed Confirmed')[0]).toEqual({ candidateCount: 0, lookup: 'failed' });
    expect(events('Board Wall Lookup Failed')[0]).toMatchObject({ stage: 'gym_boards' });
  });

  it('hides the row while the walls load', () => {
    state.candidates = { data: undefined, isLoading: true, isError: false };
    renderList();
    expect(screen.getByText('spinner')).toBeTruthy();
    expect(screen.queryByTestId('gym-walls-not-listed')).toBeNull();
  });

  it('says it needs signal when offline with nothing loaded', () => {
    state.offline = true;
    state.candidates = { data: undefined, isLoading: false, isError: false };
    renderList();
    expect(screen.getByTestId('gym-walls-offline')).toBeTruthy();
    expect(screen.queryByTestId('gym-walls-not-listed')).toBeNull();
  });

  it('lets a signed-out climber browse, and sends them to sign in to add', () => {
    state.signedIn = false;
    state.candidates.data = { candidates: [candidate('a')], truncated: false };
    renderList();
    expect(screen.getByText('Wall a')).toBeTruthy();
    fireEvent.click(screen.getByText('mobile.findWall.signInToAdd'));
    // In place of the picker, never a second sheet on top of it.
    expect(dismissToMock).toHaveBeenCalledWith('/auth/login');
  });

  it('offers Report a problem instead for a gym with no coordinates', () => {
    state.gym = { uuid: 'gym-1', name: 'Boulder Space', latitude: null, longitude: null, canEdit: false };
    state.candidates.data = { candidates: [candidate('a')], truncated: false };
    renderList();
    expect(screen.queryByText('mobile.findWall.boardNotListed')).toBeNull();
    fireEvent.click(screen.getByText('mobile.gymPage.report'));
    expect(reportOpenMock).toHaveBeenCalled();
  });

  it('sends a signed-out climber to sign in from a wall row, following nothing', () => {
    state.signedIn = false;
    state.candidates.data = { candidates: [candidate('a')], truncated: false };
    renderList();
    fireEvent.click(screen.getByText('Wall a'));
    expect(dismissToMock).toHaveBeenCalledWith('/auth/login');
    expect(takeWallMock).not.toHaveBeenCalled();
  });

  it('says when the server held some walls back', () => {
    state.candidates.data = { candidates: [candidate('a')], truncated: true };
    renderList();
    expect(screen.getByTestId('gym-walls-truncated').textContent).toContain('mobile.findWall.truncated');
  });

  it('asks which board when the gym roster fails to load', () => {
    state.gymBoards = undefined;
    state.gymBoardsError = true;
    renderList({ initialBoardType: null });
    expect(screen.getByText('mobile.findWall.pickBoardType')).toBeTruthy();
  });

  it('lets the gym own staff add one even without coordinates', () => {
    state.gym = { uuid: 'gym-1', name: 'Boulder Space', latitude: null, longitude: null, canEdit: true };
    state.candidates.data = { candidates: [candidate('a')], truncated: false };
    renderList();
    expect(screen.getByText('mobile.findWall.boardNotListed')).toBeTruthy();
  });

  it('opens on the type the gym has most of when the entry did not say, and switches on a chip', () => {
    state.gymBoards = [
      { uuid: 'k', boardType: 'kilter' },
      { uuid: 'm1', boardType: 'moonboard' },
      { uuid: 'm2', boardType: 'moonboard' },
    ];
    renderList({ initialBoardType: null });
    expect(state.candidatesInput).toMatchObject({ boardType: 'moonboard' });
    fireEvent.click(screen.getByText('label:kilter'));
    expect(state.candidatesInput).toMatchObject({ boardType: 'kilter' });
  });

  it('asks which board when the gym has none to go on', () => {
    state.gymBoards = [];
    renderList({ initialBoardType: null });
    expect(state.candidatesInput).toBeNull();
    expect(screen.getByText('mobile.findWall.pickBoardType')).toBeTruthy();
    expect(screen.queryByTestId('gym-walls-not-listed')).toBeNull();
  });

  it('keeps the other types collapsed under Other boards here', () => {
    state.gymBoards = [{ ...wall('k', { boardType: 'kilter' }) }];
    state.candidates.data = { candidates: [candidate('a')], truncated: false };
    renderList();
    expect(screen.getByText(/mobile\.findWall\.otherBoardsHere {"n":1}/)).toBeTruthy();
    expect(screen.queryByText('Wall k')).toBeNull();
    fireEvent.click(screen.getByText('mobile.findWall.otherShow'));
    expect(screen.getByText('Wall k')).toBeTruthy();
  });

  // Every wall is its own list cell, so a long shelf is virtualized, not a
  // map inside a ScrollView.
  it('draws each wall as its own cell, five a shelf until Show all', () => {
    state.candidates.data = {
      candidates: Array.from({ length: 8 }, (_, index) => candidate(`w${index}`)),
      truncated: false,
    };
    renderList();
    expect(flashList.itemTypes).toEqual(['header', 'wall', 'wall', 'wall', 'wall', 'wall', 'showAll']);
    expect(screen.queryByText('Wall w5')).toBeNull();
    fireEvent.click(screen.getByTestId('gym-walls-show-all-at_gym'));
    expect(flashList.itemTypes.filter((type) => type === 'wall')).toHaveLength(8);
    expect(screen.getByText('Wall w7')).toBeTruthy();
  });

  it('reports a tapped wall by its place in its shelf', async () => {
    state.candidates.data = {
      candidates: [
        candidate('a'),
        candidate('b', { source: 'NEARBY_LISTING', gymName: 'Crag Hall', gymDistanceMeters: 90 }),
      ],
      truncated: false,
    };
    renderList();
    fireEvent.click(screen.getByText('Wall b'));
    await waitFor(() => expect(events('Board Wall Candidate Used')[0]).toMatchObject({ match: 'nearby', position: 0 }));
  });

  it('counts a gym page opening as a search', () => {
    renderList({ entry: 'gym_page' });
    expect(events('Board Wall Search Started')[0]).toEqual({
      method: 'gym_page',
      boardType: 'moonboard',
      queryLength: 0,
    });
  });

  it('shows Try again when the gym itself fails to load', () => {
    state.gym = null;
    state.gymError = true;
    renderList();
    expect(screen.getByTestId('gym-walls-gym-failed')).toBeTruthy();
  });
});

// The add-a-board wizard's "Boards at {gym}": the gym is named in the body,
// under the step counter, and "Set up the first one" goes to the wizard's Set
// up with the gym locked and the type chosen here.
describe('GymWallList as the wizard step', () => {
  const wizard = {
    stepLabel: 'Step 3 of 4',
    nextContext: {
      returnTo: '/(tabs)/climbs',
      source: 'no_board',
      entry: 'picker' as const,
      trail: ['where' as const, 'gym' as const, 'gym_boards' as const],
    },
  };

  it('names the gym in the body, not the bar', () => {
    renderList({ wizard });
    expect(setOptionsMock).not.toHaveBeenCalled();
    expect(screen.getByText('Step 3 of 4')).toBeTruthy();
    expect(screen.getByText(/mobile\.addWizard\.gymBoardsTitle/)).toBeTruthy();
  });

  it("goes on to the wizard's Set up with the gym and the type", () => {
    renderList({ wizard });
    fireEvent.click(screen.getByText('mobile.findWall.setUpFirst'));
    expect(pushMock).toHaveBeenCalledWith({
      pathname: '/boards/create',
      params: {
        returnTo: '/(tabs)/climbs',
        source: 'no_board',
        entry: 'picker',
        trail: 'where,gym,gym_boards',
        path: 'gym',
        kind: 'gym',
        boardType: 'moonboard',
        gymUuid: 'gym-1',
      },
    });
  });
});
