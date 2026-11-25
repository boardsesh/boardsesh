// @vitest-environment jsdom
vi.mock('../../../src/components/AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../src/hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../../src/components/PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
vi.mock('../../../src/providers/queue-provider', () => ({
  useQueueActions: () => ({ clearSession: vi.fn(async () => {}) }),
}));
//
// #5654: the launch gate opens /boards?source=onboarding&firstBoard=1 for a new
// account with no board. This suite pins what the SCREEN does in that mode:
// the In range slot on top, then "Where do you climb?", location asked on the
// gym tap rather than on open, each answer wired to the flow behind it, and an
// onboarding bind that lands on Climbs. The block's own rendering has its own
// suite (FirstBoardChoice.test.tsx), so here it is a prop-capturing stub, and so
// is the In range slot (InRangeSection; its decisions are picker-top-view.test.ts).
//
// It also pins the two other ways into the same states: Climbs' "Find my
// board" (source=no_board), which gets the block only for an account with no
// boards and never tags the bind as onboarding, and the ordinary picker's Near
// you, which searches on open when location is already allowed and says what
// happened instead of going dead. Last, where each of the In range slot's ways
// forward for a board it can't name lands.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { renderWithNativeTextCheck as render } from '../../../test/native-text-contract';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { FirstBoardGymState } from '../../../src/lib/boards/first-board-gym-state';
import type { LocationPermission, LocationStatus } from '../../../src/lib/use-device-location';
import type { QuickstartRow } from '../../../src/components/board-discovery/quickstart-scan-rows';

type Children = { children?: ReactNode };
type CarouselItem = { key: string; title: string };
type ChoiceProps = {
  gymState: FirstBoardGymState;
  nearbyResults: ReactNode;
  onGym: () => void;
  onOwn: () => void;
  onAddSprayWall: () => void;
  onFindGymOnMap: () => void;
  onOpenSettings: () => void;
  onRetryNearby: () => void;
  nearbyBoardType?: string | null;
  onShowAllNearby?: () => void;
  wizardCopy?: boolean;
};
type UnnamedRow = Extract<QuickstartRow, { kind: 'moonboard' | 'bare_name' | 'unknown_setup' }>;
type InRangeProps = {
  view: { content: { kind: string }; unnamed: { key: string } | null; scanning: boolean };
  onStart: () => void;
  onOpenSettings: () => void;
  onRetryLookup: () => void;
  onPickBoard: (item: { key: string }) => void;
  onUseMyLocation: (row: UnnamedRow) => void;
  onSearchGyms: (row: UnnamedRow) => void;
  onOwnBoard: (row: UnnamedRow) => void;
};

const routerMock = vi.hoisted(() => ({ push: vi.fn(), dismissTo: vi.fn() }));
const navigationMock = vi.hoisted(() => ({ setOptions: vi.fn() }));
const setActiveBoardMock = vi.hoisted(() => vi.fn());
const requestLocationMock = vi.hoisted(() => vi.fn());
const requestLocationIfAllowedMock = vi.hoisted(() => vi.fn());
const refreshLocationMock = vi.hoisted(() => vi.fn());
const chooseFirstBoardPathMock = vi.hoisted(() => vi.fn());
const openAppSettingsMock = vi.hoisted(() => vi.fn());
const refetchNearbyMock = vi.hoisted(() => vi.fn());
const setPendingRecognitionMock = vi.hoisted(() => vi.fn());
const locationOptions = vi.hoisted(() => ({ last: undefined as { retryAfterDenial?: boolean } | undefined }));
const trackingCtrl = vi.hoisted(() => ({
  entryArgs: [] as Array<string | null>,
  nearbyCounts: [] as Array<number | null>,
}));
const trackMock = vi.hoisted(() => vi.fn());
const markOnboardingSeenMock = vi.hoisted(() => vi.fn());
const choiceProps = vi.hoisted(() => ({ last: null as ChoiceProps | null }));
const inRangeProps = vi.hoisted(() => ({ last: null as InRangeProps | null }));
type CarouselProps = {
  items: CarouselItem[];
  onSelect: (item: CarouselItem) => void;
  menuCapabilities?: unknown;
  onMenuAction?: unknown;
};
const carouselProps = vi.hoisted(() => ({
  last: null as CarouselProps | null,
  renderedKeys: [] as string[][],
  /** The last props of each carousel, keyed by its first item. */
  byFirstKey: new Map<string, CarouselProps>(),
}));
const nearbyArgs = vi.hoisted(() => ({ last: [] as unknown[] }));
// The In range slot's scan, driven by hand.
const scanCtrl = vi.hoisted(() => ({
  phase: 'needs_permission' as string,
  rows: [] as unknown[],
  start: vi.fn(),
  stop: vi.fn(),
  retryLookup: vi.fn(),
  /** Whether the scan behind the rows listened long enough for a one-box row (Fable F2). */
  listenedLongEnough: true,
  options: null as { focused: boolean; autoStart: boolean } | null,
}));

const state = vi.hoisted(() => ({
  params: { source: 'onboarding', firstBoard: '1' } as Record<string, string | undefined>,
  myBoards: [] as unknown[],
  nearbyBoards: [] as unknown[],
  nearbyLoading: false,
  // The query is showing the previous search's answer while a new one loads.
  nearbyPlaceholder: false,
  nearbyPaused: false,
  nearbyError: false,
  locationStatus: 'idle' as LocationStatus,
  /** Null reads it from the status: granted, refused for good after a denial, else askable. */
  locationPermission: null as LocationPermission | null,
  autoScanEnabled: true,
  /** `add-board-wizard`. */
  wizard: false,
  // False while a route pushed over the picker (the builder, the gym map) is on top.
  focused: true,
}));

const gymWall = {
  uuid: 'gym-wall',
  name: 'Crux Kilter 40',
  boardType: 'kilter',
  layoutId: 8,
  sizeId: 17,
  setIds: '20,21',
  angle: 40,
  ownerId: 'setter-1',
  isOwned: true,
  isFollowedByMe: false,
} as unknown as UserBoard;

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: Children) => createElement('div', { 'data-native-view': true }, children),
  ScrollView: ({ children }: Children) => createElement('div', null, children),
  Pressable: ({ children, onPress }: Children & { onPress?: () => void }) =>
    createElement('button', { onClick: onPress, type: 'button' }, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
}));

vi.mock('../../../src/lib/spray/use-spray-import-progress', () => ({
  useSprayImportProgress: (boards: unknown[]) => ({ boards, stale: false, unfinishedWallUuids: new Set<string>() }),
}));

vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
  useLocalSearchParams: () => state.params,
  useIsFocused: () => state.focused,
  useNavigation: () => navigationMock,
}));

// Link eligibility is covered in its own hook and activation tests. This picker
// suite only needs the ordinary no-offer path and must not load auth's native
// providers while rendering in jsdom.
vi.mock('../../../src/lib/onboarding/use-onboarding-link-offer', () => ({
  useOnboardingLinkOffer: () => () => false,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('expo-sqlite', () => ({ useSQLiteContext: () => ({}) }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: [] }) }));
vi.mock('@boardsesh/offline-sync', () => ({
  getDownloadedScopeKeys: vi.fn(async () => []),
  offlineBoardKeyForBoard: (input: { boardType: string; layoutId: number; sizeId: number }) =>
    `${input.boardType}:${input.layoutId}:${input.sizeId}`,
}));

function nearbyBoardsResult() {
  return {
    data: { boards: state.nearbyBoards },
    isLoading: state.nearbyLoading,
    isFetching: state.nearbyLoading,
    isPlaceholderData: state.nearbyPlaceholder,
    fetchStatus: state.nearbyPaused ? 'paused' : state.nearbyLoading ? 'fetching' : 'idle',
    isError: state.nearbyError,
    refetch: refetchNearbyMock,
  };
}

vi.mock('../../../src/lib/graphql/hooks', () => ({
  useBoard: () => ({ data: undefined }),
  useGymBoards: () => ({ data: undefined }),
  useMyBoards: () => ({
    data: { boards: state.myBoards },
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  }),
  useNearbyBoards: (...args: unknown[]) => {
    nearbyArgs.last = args;
    return nearbyBoardsResult();
  },
  useProfile: () => ({ data: { id: 'user-new' } }),
  useDeleteBoard: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUnfollowBoard: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useLinkBoardToGym: () => ({ mutateAsync: vi.fn() }),
  useDetachBoardFromGym: () => ({ mutateAsync: vi.fn() }),
  usePinBoard: () => ({ mutate: vi.fn() }),
}));

vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  getActiveBoardWriteGeneration: () => 0,
  useActiveBoard: () => ({ data: null }),
  useSetActiveBoard: () => setActiveBoardMock,
  useClearActiveBoardIfCurrentGeneration: () => vi.fn(),
  useSetActiveBoardIfCurrentGeneration: () => vi.fn(),
}));
vi.mock('../../../src/hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: undefined, isLoading: false }),
}));
vi.mock('../../../src/lib/board-discovery/use-adopt-found-board', () => ({
  useAdoptFoundBoard: () => vi.fn().mockResolvedValue(undefined),
  useWillFollowFoundBoard: () => () => false,
}));
vi.mock('../../../src/lib/use-device-location', () => ({
  useDeviceLocation: (options?: { retryAfterDenial?: boolean }) => {
    locationOptions.last = options;
    return {
      status: state.locationStatus,
      permission:
        state.locationPermission ??
        (state.locationStatus === 'granted' ? 'granted' : state.locationStatus === 'denied' ? 'blocked' : 'ask'),
      permissionChecked: state.locationPermission !== 'unknown',
      coords: state.locationStatus === 'granted' ? { latitude: 1, longitude: 2 } : null,
      request: requestLocationMock,
      requestIfAllowed: requestLocationIfAllowedMock,
      refresh: refreshLocationMock,
    };
  },
}));
vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true, refreshAuthState: vi.fn() }),
}));
vi.mock('../../../src/providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../src/providers/dialog-provider', () => ({ useConfirm: () => vi.fn() }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({ brandColors: { primary: '#6D28D9' }, systemColors: { tertiaryLabel: '#999' } }),
}));
vi.mock('../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../src/lib/onboarding/onboarding-storage', () => ({
  markOnboardingSeen: markOnboardingSeenMock,
  setBoardRevealTipPending: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../src/lib/onboarding/use-first-board-picker-tracking', () => ({
  useFirstBoardPickerTracking: (entry: string | null, nearbyResultCount: number | null) => {
    trackingCtrl.entryArgs.push(entry);
    trackingCtrl.nearbyCounts.push(nearbyResultCount);
    return chooseFirstBoardPathMock;
  },
}));
vi.mock('../../../src/lib/open-app-settings', () => ({
  openAppSettings: openAppSettingsMock,
  canOpenAppSettings: () => true,
}));
vi.mock('../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../src/lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: false, reason: null }),
}));
vi.mock('../../../src/settings', () => ({
  useOfflineBoards: () => [],
  useSetting: () => [[], vi.fn()],
  forgetOfflineBoard: vi.fn(),
  offlineBoardKeyForBoard: (input: { boardType: string; layoutId: number; sizeId: number }) =>
    `${input.boardType}:${input.layoutId}:${input.sizeId}`,
}));
vi.mock('../../../src/components/offline/OfflineCatalogCta', () => ({ OfflineCatalogCta: () => null }));
vi.mock('../../../src/offline/use-confirm-board-download', () => ({
  useConfirmBoardDownload: () => ({ confirmAndDownload: vi.fn(async () => true) }),
}));
vi.mock('../../../src/providers/feature-flags-provider', () => ({
  useDirectoryReportsEnabled: () => false,
  useFeatureFlagsResolved: () => true,
  useOfflineDownloadsEnabled: () => true,
  usePickerAutoScanEnabled: () => state.autoScanEnabled,
  useAddBoardWizardEnabled: () => state.wizard,
}));
vi.mock('../../../src/offline/use-downloaded-scope-keys', () => ({ useDownloadedScopeKeys: () => ({ data: [] }) }));
vi.mock('../../../src/offline/use-offline-catalog-state', () => ({ useOfflineCatalogState: () => null }));
vi.mock('../../../src/offline/use-remember-downloaded-boards', () => ({ useRememberDownloadedBoards: vi.fn() }));
vi.mock('../../../src/theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 8: 32 },
}));
vi.mock('../../../src/theme/ios-colors', () => ({
  iosSystemColors: { systemGray: '#8e8e93', systemRed: '#f00' },
}));
vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: Children) => createElement('span', null, children),
}));
vi.mock('../../../src/components/Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));
vi.mock('../../../src/components/Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress, type: 'button' }, title),
}));
vi.mock('../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));
vi.mock('../../../src/components/board-discovery/use-picker-board-scan', () => ({
  usePickerBoardScan: (options: { focused: boolean; autoStart: boolean }) => {
    scanCtrl.options = options;
    return {
      phase: scanCtrl.phase,
      rows: scanCtrl.rows,
      lookup: 'none',
      listenedLongEnough: () => scanCtrl.listenedLongEnough,
      start: scanCtrl.start,
      stop: scanCtrl.stop,
      openSettings: vi.fn(),
      retryLookup: scanCtrl.retryLookup,
    };
  },
}));
vi.mock('../../../src/components/board-discovery/use-in-range-location-hint', () => ({
  useInRangeLocationHint: () => null,
}));
vi.mock('../../../src/components/board-discovery/InRangeSection', () => ({
  InRangeSection: (props: InRangeProps) => {
    inRangeProps.last = props;
    return createElement('div', { 'data-testid': 'in-range', 'data-kind': props.view.content.kind });
  },
}));
vi.mock('../../../src/components/board-discovery/AddBoardMenu', () => ({ AddBoardMenu: () => null }));
vi.mock('../../../src/components/board-discovery/NearbyReservedSlot', () => ({
  NearbyReservedSlot: ({ searching, children }: { searching: boolean; children?: ReactNode }) =>
    searching ? createElement('div', { 'data-testid': 'near-you-placeholder' }) : children,
}));
// The card's own copy, buttons, snooze and Settings trip are its own suite's;
// here, whether it shows, for which permission, and what it calls.
vi.mock('../../../src/components/location/LocationAskCard', () => ({
  LocationAskCard: ({
    surface,
    permission,
    onAllow,
    onRecheck,
  }: {
    surface: string;
    permission: string;
    onAllow: () => void;
    onRecheck: () => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'location-banner', 'data-permission': permission, 'data-surface': surface },
      createElement('button', { type: 'button', onClick: onAllow }, 'banner:allow'),
      createElement('button', { type: 'button', onClick: onRecheck }, 'banner:recheck'),
    ),
}));
vi.mock('../../../src/components/board-discovery/DiscoveryBoardArt', () => ({ DiscoveryBoardArt: () => null }));
const clearPendingRecognitionMock = vi.hoisted(() => vi.fn());
// The held box as the module keeps it, and what each bind remembered from it,
// so a test can say whether a pick named the box.
type HeldBox = { deviceId: string; boardType: string };
const recognitionHold = vi.hoisted(() => ({
  held: null as HeldBox | null,
  remembered: [] as Array<{ deviceId: string; boardUuid: string }>,
}));
vi.mock('../../../src/lib/boards/pending-board-recognition', () => ({
  setPendingBoardRecognition: (hold: HeldBox) => {
    recognitionHold.held = hold;
    setPendingRecognitionMock(hold);
  },
  clearPendingBoardRecognition: () => {
    recognitionHold.held = null;
    clearPendingRecognitionMock();
  },
  consumePendingBoardRecognition: async (board: { uuid: string; boardType: string }) => {
    const { held } = recognitionHold;
    if (!held || held.boardType !== board.boardType) return;
    recognitionHold.held = null;
    recognitionHold.remembered.push({ deviceId: held.deviceId, boardUuid: board.uuid });
  },
}));
vi.mock('../../../src/components/report-problem/use-report-problem', () => ({
  useReportProblemHost: () => ({ openReport: vi.fn(), sheet: null }),
}));
vi.mock('../../../src/components/report-problem/ReportReviewSheet', () => ({ ReportReviewSheet: () => null }));
vi.mock('../../../src/components/board-discovery/BoardDetailSheet', () => ({ BoardDetailSheet: () => null }));

// The Velvet shelf pieces, as plain markup: a section, its title, and its action
// as a button named for what it opens.
vi.mock('../../../src/components/ShelfHeader', async () => {
  const { createElement: h } = await import('react');
  type ShelfProps = {
    title: string;
    action?: { label: string; accessibilityLabel?: string; onPress: () => void };
    children?: ReactNode;
  };
  return {
    SHELF_SECTION_GAP: 28,
    ShelfSection: ({ title, action, children }: ShelfProps) =>
      h(
        'section',
        null,
        h('span', null, title),
        action
          ? h('button', { type: 'button', onClick: action.onPress }, action.accessibilityLabel ?? action.label)
          : null,
        children,
      ),
  };
});
vi.mock('../../../src/components/EmptyState', async () => {
  const { createElement: h } = await import('react');
  return {
    EmptyState: ({ title, body, actions }: { title: string; body?: string; actions?: ReactNode }) =>
      h('div', null, h('span', null, title), body ? h('span', null, body) : null, actions),
  };
});
vi.mock('../../../src/components/TextAction', async () => {
  const { createElement: h } = await import('react');
  return {
    TextAction: ({ label, onPress }: { label: string; onPress: () => void }) =>
      h('button', { type: 'button', onClick: onPress }, label),
    textActionOverhang: () => ({ top: 4, bottom: 20 }),
  };
});
// Your boards and the offline list are rows now; the suite drives them as it
// drives the carousels, through the same stand-in.
vi.mock('../../../src/components/board-discovery/BoardRowList', async () => {
  const { BoardCarousel } = await import('../../../src/components/board-discovery/BoardCarousel');
  return { BoardRowList: BoardCarousel };
});
vi.mock('../../../src/components/board-discovery/BoardCarousel', () => ({
  BoardCarousel: (props: CarouselProps) => {
    carouselProps.last = props;
    carouselProps.renderedKeys.push(props.items.map((item) => item.key));
    if (props.items[0]) carouselProps.byFirstKey.set(props.items[0].key, props);
    return createElement(
      'div',
      { 'data-testid': 'carousel' },
      props.items.map((item) => createElement('span', { key: item.key }, item.title)),
    );
  },
}));
vi.mock('../../../src/components/board-discovery/FirstBoardChoice', () => ({
  FirstBoardChoice: (props: ChoiceProps) => {
    choiceProps.last = props;
    return createElement('div', { 'data-testid': 'first-board-choice' }, props.nearbyResults);
  },
}));

const { default: BoardSelection } = await import('../index');

beforeEach(() => {
  vi.clearAllMocks();
  setActiveBoardMock.mockResolvedValue(undefined);
  markOnboardingSeenMock.mockResolvedValue(undefined);
  requestLocationIfAllowedMock.mockResolvedValue(undefined);
  trackingCtrl.entryArgs = [];
  trackingCtrl.nearbyCounts = [];
  choiceProps.last = null;
  inRangeProps.last = null;
  carouselProps.last = null;
  carouselProps.renderedKeys = [];
  carouselProps.byFirstKey.clear();
  nearbyArgs.last = [];
  scanCtrl.phase = 'needs_permission';
  scanCtrl.rows = [];
  scanCtrl.options = null;
  scanCtrl.listenedLongEnough = true;
  state.params = { source: 'onboarding', firstBoard: '1' };
  state.myBoards = [];
  state.nearbyBoards = [];
  state.nearbyLoading = false;
  state.nearbyPlaceholder = false;
  state.nearbyPaused = false;
  state.nearbyError = false;
  state.locationStatus = 'idle';
  state.locationPermission = null;
  state.autoScanEnabled = true;
  state.wizard = false;
  state.focused = true;
  recognitionHold.held = null;
  recognitionHold.remembered = [];
  refreshLocationMock.mockResolvedValue(false);
});

function choice(): ChoiceProps {
  if (!choiceProps.last) throw new Error('FirstBoardChoice did not render');
  return choiceProps.last;
}

function inRange(): InRangeProps {
  if (!inRangeProps.last) throw new Error('the In range slot did not render');
  return inRangeProps.last;
}

describe('the picker in first-board mode', () => {
  it('puts the In range slot first, then asks where they climb', () => {
    render(createElement(BoardSelection));

    const slot = screen.getByTestId('in-range');
    const block = screen.getByTestId('first-board-choice');
    expect(slot.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText('mobile.emptyTitle')).toBeNull();
    expect(screen.queryByText('mobile.onboardingPrompt')).toBeNull();
    // Near you belongs to "At a gym" here, not to the screen: no shelf, no banner.
    expect(screen.queryByText('mobile.discovery.nearbyTitle')).toBeNull();
    expect(screen.queryByTestId('location-banner')).toBeNull();
  });

  // "Where do you climb?" already carries the + menu's choices as its cards.
  it.each([
    { name: 'the launch gate', params: { source: 'onboarding', firstBoard: '1' }, plus: false },
    { name: 'Climbs with no boards', params: { source: 'no_board' }, plus: false },
    { name: 'the ordinary picker', params: {}, plus: true },
  ])('offers the + in the top bar from $name: $plus', ({ params, plus }) => {
    state.params = params;
    render(createElement(BoardSelection));
    const options = navigationMock.setOptions.mock.calls.at(-1)?.[0] as { headerRight?: unknown } | undefined;
    expect(typeof options?.headerRight === 'function').toBe(plus);
  });

  it('turns its choice tracking on, as the launch gate entry', () => {
    render(createElement(BoardSelection));
    expect(trackingCtrl.entryArgs.length).toBeGreaterThan(0);
    expect(trackingCtrl.entryArgs.every((entry) => entry === 'launch_gate')).toBe(true);
  });

  it('does not ask for location until "At a gym" is tapped', () => {
    render(createElement(BoardSelection));
    expect(requestLocationMock).not.toHaveBeenCalled();
    // Not even the silent read, nor one when the app comes back: the question
    // comes with its reason.
    expect(requestLocationIfAllowedMock).not.toHaveBeenCalled();
    expect(locationOptions.last).toEqual({ retryAfterDenial: true, rereadWhenActive: false });
    expect(choice().gymState).toBe('idle');

    act(() => {
      choice().onGym();
    });
    expect(requestLocationMock).toHaveBeenCalledTimes(1);
    expect(chooseFirstBoardPathMock).toHaveBeenCalledWith('gym');
    expect(choice().gymState).toBe('searching');
  });

  // `First Board Picker Skipped` reads this count: no search, no count.
  it('counts no boards near them until "At a gym" is tapped', () => {
    state.nearbyBoards = [gymWall];
    const { rerender } = render(createElement(BoardSelection));
    expect(trackingCtrl.nearbyCounts.every((count) => count === null)).toBe(true);

    act(() => {
      choice().onGym();
    });
    state.locationStatus = 'granted';
    rerender(createElement(BoardSelection));
    expect(trackingCtrl.nearbyCounts.at(-1)).toBe(1);
  });

  it('shows the boards near the gym once location answers', () => {
    const { rerender } = render(createElement(BoardSelection));
    act(() => {
      choice().onGym();
    });

    state.locationStatus = 'granted';
    state.nearbyBoards = [gymWall];
    rerender(createElement(BoardSelection));

    expect(choice().gymState).toBe('found');
    expect(carouselProps.last?.items.map((item) => item.key)).toEqual(['gym-wall']);
    // A first-run choice of board: plain cards, no ⋯ and no hold menu.
    expect(carouselProps.last?.menuCapabilities).toBeUndefined();
    expect(carouselProps.last?.onMenuAction).toBeUndefined();
  });

  it('says so when location is off', () => {
    const { rerender } = render(createElement(BoardSelection));
    act(() => {
      choice().onGym();
    });
    state.locationStatus = 'denied';
    rerender(createElement(BoardSelection));

    expect(choice().gymState).toBe('location_off');
    choice().onOpenSettings();
    expect(openAppSettingsMock).toHaveBeenCalledTimes(1);
    // Back from Settings, one more tap on "At a gym" has to be able to ask again.
    expect(locationOptions.last).toMatchObject({ retryAfterDenial: true });
  });

  // `preset` opens the builder with a layout and size chosen, so Save works at
  // once instead of after the climber finds the layout chip.
  it('opens the builder preset for a home wall, still as an onboarding pick', () => {
    render(createElement(BoardSelection));
    choice().onOwn();

    expect(chooseFirstBoardPathMock).toHaveBeenCalledWith('own');
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/create',
      params: { returnTo: '/(tabs)/climbs', source: 'onboarding', preset: '1' },
    });
    expect(trackMock).toHaveBeenCalledWith('Board Picker Add Selected', { kind: 'board', surface: 'first_run' });
  });

  // With the add-a-board wizard on, the three cards are its step 1 answered
  // inline: At home goes on to Which board? as step 2, and the gym carousel
  // stays right here.
  it("opens the wizard's Which board? as step 2 of the home path with the wizard on", () => {
    state.wizard = true;
    render(createElement(BoardSelection));
    expect(choice().wizardCopy).toBe(true);
    choice().onOwn();

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/add/board',
      params: {
        returnTo: '/(tabs)/climbs',
        source: 'onboarding',
        entry: 'first_run',
        trail: 'where',
        path: 'home',
      },
    });
    expect(trackMock).toHaveBeenCalledWith('Board Picker Add Selected', {
      kind: 'board',
      surface: 'first_run',
      boardKind: 'home',
    });
    expect(trackMock).toHaveBeenCalledWith('Board Kind Chosen', {
      kind: 'home',
      surface: 'first_run',
      preAnswered: true,
    });
  });

  // My Spraywall is always offered now: the wall wizard binds with the
  // onboarding source, so a first wall closes out first run like the builder.
  it('opens the wall wizard with the onboarding source', () => {
    render(createElement(BoardSelection));
    choice().onAddSprayWall();

    expect(chooseFirstBoardPathMock).toHaveBeenCalledWith('spray_wall');
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/spray/new',
      params: { returnTo: '/(tabs)/climbs', source: 'onboarding' },
    });
    expect(trackMock).toHaveBeenCalledWith('Board Picker Add Selected', {
      kind: 'spraywall',
      surface: 'first_run',
    });
  });

  // The only way forward from "Location is off" and "Nothing within 20 km". The
  // gym map binds through useActivateBoard, and `source` is what makes that bind
  // close out first-run (the activation event, the reveal banner, no download
  // dialog on Climbs).
  it('opens the gym map, still as an onboarding pick', () => {
    render(createElement(BoardSelection));
    choice().onFindGymOnMap();

    expect(chooseFirstBoardPathMock).toHaveBeenCalledWith('gym_map');
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/gyms',
      params: { returnTo: '/(tabs)/climbs', source: 'onboarding', from: 'picker' },
    });
  });

  it('says the lookup failed rather than that nothing is nearby, and retries it', () => {
    const { rerender } = render(createElement(BoardSelection));
    act(() => {
      choice().onGym();
    });
    state.locationStatus = 'granted';
    state.nearbyError = true;
    rerender(createElement(BoardSelection));

    expect(choice().gymState).toBe('nearby_error');
    choice().onRetryNearby();
    expect(refetchNearbyMock).toHaveBeenCalledTimes(1);
  });

  // The In range slot replaced the "Scan for the board in front of me" link,
  // and reports as its `scan` path.
  it('reports a tap on the In range slot as the scan path', () => {
    render(createElement(BoardSelection));
    act(() => {
      inRange().onStart();
    });
    expect(chooseFirstBoardPathMock).toHaveBeenCalledWith('scan');
    expect(scanCtrl.start).toHaveBeenCalledOnce();
  });

  it('lands on Climbs after a pick', async () => {
    const { rerender } = render(createElement(BoardSelection));
    act(() => {
      choice().onGym();
    });
    state.locationStatus = 'granted';
    state.nearbyBoards = [gymWall];
    rerender(createElement(BoardSelection));

    await act(async () => {
      carouselProps.last?.onSelect({ key: 'gym-wall', title: 'Crux Kilter 40' });
    });

    expect(setActiveBoardMock).toHaveBeenCalledWith(gymWall);
    expect(routerMock.dismissTo).toHaveBeenCalledWith('/(tabs)/climbs');
  });

  // A new account can already have boards (built on the web, or followed before
  // a sign-out cleared the active board). They stay one tap away.
  it('keeps Your boards when the account already has some', () => {
    state.myBoards = [gymWall];
    render(createElement(BoardSelection));
    expect(screen.getByText('mobile.discovery.yourBoardsTitle')).toBeTruthy();
  });
});

describe('the In range scan', () => {
  it('scans by itself on open, unless the kill switch says to wait for a tap', () => {
    render(createElement(BoardSelection));
    expect(scanCtrl.options).toMatchObject({ focused: true, autoStart: true });

    state.autoScanEnabled = false;
    render(createElement(BoardSelection));
    expect(scanCtrl.options).toMatchObject({ focused: true, autoStart: false });
  });

  // A pick from the hero binds the board as an onboarding pick, after the scan
  // has ended.
  it('binds the board in front of them, as an onboarding pick, after ending the scan', async () => {
    scanCtrl.phase = 'done';
    scanCtrl.rows = [{ kind: 'board', key: 'board:gym-wall', board: gymWall, rssi: -50, recognizedBy: 'serial' }];
    render(createElement(BoardSelection));
    expect(inRange().view.content.kind).toBe('hero');

    await act(async () => {
      inRange().onPickBoard({ key: 'gym-wall' });
    });

    expect(scanCtrl.stop).toHaveBeenCalledOnce();
    expect(setActiveBoardMock).toHaveBeenCalledWith(gymWall);
    expect(markOnboardingSeenMock).toHaveBeenCalled();
    expect(trackMock).toHaveBeenCalledWith(
      'Board Picker Selection Completed',
      expect.objectContaining({ pickSource: 'bluetooth', section: 'hero', position: 0 }),
    );
  });

  // A box held from an earlier tap on a row the phone couldn't name is not the
  // board the climber then picks by name.
  it('drops a held box before binding a board picked by name', async () => {
    scanCtrl.phase = 'done';
    scanCtrl.rows = [{ kind: 'board', key: 'board:gym-wall', board: gymWall, rssi: -50, recognizedBy: 'serial' }];
    render(createElement(BoardSelection));

    await act(async () => {
      inRange().onPickBoard({ key: 'gym-wall' });
    });

    expect(clearPendingRecognitionMock).toHaveBeenCalled();
    expect(clearPendingRecognitionMock.mock.invocationCallOrder[0]).toBeLessThan(
      setActiveBoardMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  // Fable F1: the hold belongs to one picker visit. The gym map and the builder
  // are pushed over the picker, so they use it before this; a switch after the
  // picker closed is about some other box.
  it('drops a held box when the picker closes', () => {
    const picker = render(createElement(BoardSelection));
    expect(clearPendingRecognitionMock).not.toHaveBeenCalled();
    picker.unmount();
    expect(clearPendingRecognitionMock).toHaveBeenCalledOnce();
  });

  it('retries a lookup with no signal through the scan', () => {
    render(createElement(BoardSelection));
    act(() => {
      inRange().onRetryLookup();
    });
    expect(scanCtrl.retryLookup).toHaveBeenCalledOnce();
  });
});

describe('the ordinary onboarding picker', () => {
  // Onboarding's handoff reads an earlier yes like every other opening, but
  // never shows the system prompt on open.
  it('shows the ordinary list and uses location only if already allowed', () => {
    state.params = { source: 'onboarding' };
    render(createElement(BoardSelection));

    expect(screen.queryByTestId('first-board-choice')).toBeNull();
    expect(screen.getByTestId('in-range')).toBeTruthy();
    expect(requestLocationMock).not.toHaveBeenCalled();
    expect(requestLocationIfAllowedMock).toHaveBeenCalledOnce();
    expect(trackingCtrl.entryArgs.every((entry) => entry === null)).toBe(true);
  });

  it('ignores a stray firstBoard param outside onboarding', () => {
    state.params = { firstBoard: '1' };
    render(createElement(BoardSelection));
    expect(screen.queryByTestId('first-board-choice')).toBeNull();
  });

  // Near you's Map forwards `source` too, so a gym-map pick from the ordinary
  // onboarding picker is the activation bind, like a pick from its own list (the
  // gym finder's side is pinned in app/gyms/__tests__/index.test.tsx).
  it('opens the gym map as an onboarding pick', () => {
    state.params = { source: 'onboarding' };
    state.locationPermission = 'granted';
    render(createElement(BoardSelection));

    fireEvent.click(screen.getByText('mobile.discovery.nearbyMap'));

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/gyms',
      params: { returnTo: '/(tabs)/climbs', source: 'onboarding', from: 'picker' },
    });
  });

  it('opens the gym map as an ordinary switch outside onboarding', () => {
    state.params = {};
    state.locationPermission = 'granted';
    render(createElement(BoardSelection));

    fireEvent.click(screen.getByText('mobile.discovery.nearbyMap'));

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/gyms',
      params: { returnTo: '/(tabs)/climbs', from: 'picker' },
    });
  });
});

describe('the picker opened from Climbs with no board', () => {
  beforeEach(() => {
    state.params = { source: 'no_board' };
  });

  it('asks where they climb when the account has no boards', () => {
    render(createElement(BoardSelection));

    expect(screen.getByTestId('first-board-choice')).toBeTruthy();
    expect(trackingCtrl.entryArgs.at(-1)).toBe('no_board');
    // No location prompt on open here either: it comes with "At a gym".
    expect(requestLocationMock).not.toHaveBeenCalled();
  });

  it('opens their list instead when they already have boards', () => {
    state.myBoards = [gymWall];
    render(createElement(BoardSelection));

    expect(screen.queryByTestId('first-board-choice')).toBeNull();
    expect(screen.getByText('mobile.discovery.yourBoardsTitle')).toBeTruthy();
    expect(trackingCtrl.entryArgs.every((entry) => entry === null)).toBe(true);
  });

  // A pick from the block follows or creates a board, and that refetch lands
  // while the modal is still dismissing. The screen must not swap under it.
  it('keeps the block once shown, even after the board list gains a board', () => {
    const { rerender } = render(createElement(BoardSelection));
    state.myBoards = [gymWall];
    rerender(createElement(BoardSelection));

    expect(screen.getByTestId('first-board-choice')).toBeTruthy();
    expect(trackingCtrl.entryArgs.at(-1)).toBe('no_board');
  });

  it('forwards its own source to the builder, preset', () => {
    render(createElement(BoardSelection));
    choice().onOwn();

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/create',
      params: { returnTo: '/(tabs)/climbs', source: 'no_board', preset: '1' },
    });
  });

  it('forwards its own source to the wall wizard', () => {
    render(createElement(BoardSelection));
    choice().onAddSprayWall();

    expect(chooseFirstBoardPathMock).toHaveBeenCalledWith('spray_wall');
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/spray/new',
      params: { returnTo: '/(tabs)/climbs', source: 'no_board' },
    });
  });

  // The empty state shows for anyone with no board bound, at any account age,
  // so a bind from it is an ordinary switch: no activation event, no first-run
  // close-out, and its own source on the picker events.
  it('binds as an ordinary pick, not as onboarding', async () => {
    const { rerender } = render(createElement(BoardSelection));
    act(() => {
      choice().onGym();
    });
    state.locationStatus = 'granted';
    state.nearbyBoards = [gymWall];
    rerender(createElement(BoardSelection));
    // "Where do you climb?" draws plain cards here too, though it is not onboarding.
    expect(carouselProps.last?.menuCapabilities).toBeUndefined();
    expect(carouselProps.last?.onMenuAction).toBeUndefined();

    await act(async () => {
      carouselProps.last?.onSelect({ key: 'gym-wall', title: 'Crux Kilter 40' });
    });

    expect(setActiveBoardMock).toHaveBeenCalledWith(gymWall);
    expect(routerMock.dismissTo).toHaveBeenCalledWith('/(tabs)/climbs');
    expect(markOnboardingSeenMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalledWith('Onboarding Board Activated', expect.anything());
    expect(trackMock).toHaveBeenCalledWith('Board Picker Opened', expect.objectContaining({ source: 'no_board' }));
  });
});

describe("the ordinary picker's Near you", () => {
  beforeEach(() => {
    state.params = {};
    state.myBoards = [gymWall];
  });

  // A climber who already allowed location gets their gyms on open, with no
  // prompt; everyone else gets the banner, which asks.
  it('searches on open only when location is already allowed', () => {
    render(createElement(BoardSelection));
    expect(requestLocationIfAllowedMock).toHaveBeenCalledOnce();
    expect(requestLocationMock).not.toHaveBeenCalled();
  });

  it('reads location again when the app comes back, so a grant in Settings shows Near you', () => {
    render(createElement(BoardSelection));
    expect(locationOptions.last).toEqual({ retryAfterDenial: true, rereadWhenActive: true });
  });

  // Never asked: no Near you; the banner at the foot asks, and its tap is the prompt.
  it('puts Allow location at the foot instead of Near you, before location was ever asked', () => {
    render(createElement(BoardSelection));

    expect(screen.queryByText('mobile.discovery.nearbyTitle')).toBeNull();
    // Location off: Near you holds no space at all.
    expect(screen.queryByTestId('near-you-placeholder')).toBeNull();
    const banner = screen.getByTestId('location-banner');
    expect(banner.getAttribute('data-permission')).toBe('ask');
    expect(banner.getAttribute('data-surface')).toBe('board_picker');
    const yourBoards = screen.getByText('mobile.discovery.yourBoardsTitle');
    expect(yourBoards.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByText('banner:allow'));
    expect(requestLocationMock).toHaveBeenCalledTimes(1);
  });

  // Android after one refusal: the prompt can still ask.
  it('keeps asking from the banner while the prompt can still ask after a denial', () => {
    state.locationStatus = 'denied';
    state.locationPermission = 'ask';
    render(createElement(BoardSelection));
    expect(screen.getByTestId('location-banner').getAttribute('data-permission')).toBe('ask');
  });

  // Refused for good: only Settings can turn it on. The card opens Settings
  // itself and, on the way back, reads the permission without asking.
  it('hands the card the blocked state and a read without asking, once location is refused for good', () => {
    state.locationStatus = 'denied';
    render(createElement(BoardSelection));

    expect(screen.queryByText('mobile.discovery.nearbyTitle')).toBeNull();
    expect(screen.getByTestId('location-banner').getAttribute('data-permission')).toBe('blocked');
    expect(screen.queryByTestId('near-you-placeholder')).toBeNull();
    requestLocationIfAllowedMock.mockClear();
    fireEvent.click(screen.getByText('banner:recheck'));
    expect(requestLocationIfAllowedMock).toHaveBeenCalledOnce();
    expect(requestLocationMock).not.toHaveBeenCalled();
  });

  // Before the permission is read there is nothing to say either way.
  it('shows neither Near you nor the banner before the permission is read', () => {
    state.locationPermission = 'unknown';
    render(createElement(BoardSelection));
    expect(screen.queryByText('mobile.discovery.nearbyTitle')).toBeNull();
    expect(screen.queryByTestId('location-banner')).toBeNull();
  });

  // Allowed, with the fix still on its way: looking, never a row that asks.
  // Your boards sits right under Near you: placeholder cards hold the space.
  it("holds Near you's space with placeholder cards once location is allowed, before the fix lands", () => {
    state.locationPermission = 'granted';
    render(createElement(BoardSelection));
    expect(screen.getByTestId('near-you-placeholder')).toBeTruthy();
    expect(screen.queryByTestId('location-banner')).toBeNull();
  });

  // Allowed, but no fix (Location Services off for the whole phone).
  it('reads a failed fix as location off, inside Near you, and offers Settings', () => {
    state.locationStatus = 'unavailable';
    state.locationPermission = 'granted';
    render(createElement(BoardSelection));
    expect(screen.getByText('mobile.discovery.nearbyTitle')).toBeTruthy();
    expect(screen.getByText('mobile.firstBoard.locationOff')).toBeTruthy();
    fireEvent.click(screen.getByText('mobile.firstBoard.openSettings'));
    expect(openAppSettingsMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('location-banner')).toBeNull();
  });

  // One quiet line; the shelf's header keeps Map, so there is no second map link.
  it('says when nothing is within 20 km, with Map still in the header', () => {
    state.locationStatus = 'granted';
    render(createElement(BoardSelection));

    expect(screen.getByText('mobile.firstBoard.nearbyEmpty')).toBeTruthy();
    expect(screen.queryByText('mobile.firstBoard.findGymOnMap')).toBeNull();
    fireEvent.click(screen.getByText('mobile.discovery.nearbyMap'));
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/gyms',
      params: { returnTo: '/(tabs)/climbs', from: 'picker' },
    });
  });

  it('says the lookup failed and retries it', () => {
    state.locationStatus = 'granted';
    state.nearbyError = true;
    render(createElement(BoardSelection));

    expect(screen.getByText('mobile.firstBoard.nearbyError')).toBeTruthy();
    expect(screen.queryByText('mobile.firstBoard.nearbyEmpty')).toBeNull();
    fireEvent.click(screen.getByText('mobile.errorRetry'));
    expect(refetchNearbyMock).toHaveBeenCalledTimes(1);
  });

  it('holds the space while location and the list load', () => {
    state.locationStatus = 'loading';
    state.locationPermission = 'granted';
    render(createElement(BoardSelection));
    expect(screen.getByTestId('near-you-placeholder')).toBeTruthy();
    expect(screen.getByText('mobile.discovery.nearbyTitle')).toBeTruthy();
  });

  it('shows the boards it found, with the map beside the title', () => {
    state.locationStatus = 'granted';
    state.nearbyBoards = [{ ...gymWall, uuid: 'near-wall' }];
    render(createElement(BoardSelection));

    expect(screen.getByText('mobile.discovery.nearbyTitle')).toBeTruthy();
    expect(screen.getByText('mobile.discovery.nearbyMap')).toBeTruthy();
    expect(carouselProps.renderedKeys).toContainEqual(['near-wall']);
    expect(screen.queryByText('mobile.firstBoard.nearbyEmpty')).toBeNull();
    // Outside onboarding and the first-board choice, Near you cards get a menu.
    expect(carouselProps.byFirstKey.get('near-wall')?.menuCapabilities).toBeDefined();
    expect(carouselProps.byFirstKey.get('near-wall')?.onMenuAction).toBeTypeOf('function');
  });

  // With location allowed, Near you sits above Your boards, and no banner.
  it('lists Near you before Your boards once location is allowed', () => {
    state.locationStatus = 'granted';
    render(createElement(BoardSelection));
    const yourBoards = screen.getByText('mobile.discovery.yourBoardsTitle');
    const nearYou = screen.getByText('mobile.discovery.nearbyTitle');
    expect(nearYou.compareDocumentPosition(yourBoards) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('location-banner')).toBeNull();
  });
});

// The In range slot's three ways forward for a board it heard but couldn't name
// (a MoonBoard, a box with no serial, a serial nobody saved). Each ends the scan
// and holds the box for the next bind (pending-board-recognition.ts).
describe("the In range slot's ways forward for a board it can't name", () => {
  const moonboardWall = { ...gymWall, uuid: 'moon-wall', name: 'Crux MoonBoard', boardType: 'moonboard' } as UserBoard;
  const MOONBOARD_ROW: UnnamedRow = {
    kind: 'moonboard',
    key: 'moonboard:moonboard',
    boardType: 'moonboard',
    rssi: -55,
    deviceId: 'MOON-BOX',
  };

  beforeEach(() => {
    scanCtrl.phase = 'done';
    scanCtrl.rows = [MOONBOARD_ROW];
  });

  function useMyLocation() {
    act(() => {
      inRange().onUseMyLocation(MOONBOARD_ROW);
    });
  }

  it('ends the scan, holds the box, and shows the gyms near them, only that type', () => {
    const { rerender } = render(createElement(BoardSelection));
    expect(inRange().view.unnamed?.key).toBe('moonboard:moonboard');

    useMyLocation();
    expect(scanCtrl.stop).toHaveBeenCalledOnce();
    expect(setPendingRecognitionMock).toHaveBeenCalledExactlyOnceWith({ deviceId: 'MOON-BOX', boardType: 'moonboard' });
    expect(requestLocationMock).toHaveBeenCalledTimes(1);
    expect(choice().gymState).toBe('searching');
    expect(choice().nearbyBoardType).toBe('moonboard');
    // The climber chose the slot; the gym list is where it led, not a new path.
    expect(chooseFirstBoardPathMock).toHaveBeenCalledWith('scan');
    expect(chooseFirstBoardPathMock).not.toHaveBeenCalledWith('gym');

    state.locationStatus = 'granted';
    // The server filters the search to the type...
    state.nearbyBoards = [moonboardWall, gymWall];
    rerender(createElement(BoardSelection));
    expect(nearbyArgs.last[4]).toEqual(['moonboard']);
    // ...and so does the list, while a previous unfiltered answer still shows.
    expect(choice().gymState).toBe('found');
    expect(carouselProps.last?.items.map((item) => item.key)).toEqual(['moon-wall']);
    // The list says which type it holds, and offers the rest.
    expect(screen.getByText('mobile.discovery.nearbyTitleMoonboard')).toBeTruthy();
    expect(screen.queryByText('mobile.discovery.nearbyTitle')).toBeNull();
  });

  // Fable F2: "one box" is only trusted after 5 s of listening or a scan that
  // ran to its end; a tap 2 s in may not have heard the second MoonBoard yet.
  it('holds nothing from a scan that listened too briefly to trust one box', () => {
    scanCtrl.listenedLongEnough = false;
    render(createElement(BoardSelection));
    useMyLocation();
    expect(setPendingRecognitionMock).not.toHaveBeenCalled();
    expect(scanCtrl.stop).toHaveBeenCalledOnce();
    expect(choice().nearbyBoardType).toBe('moonboard');
  });

  // With two MoonBoards in range the row carries no id: which one the climber
  // is at is unknowable, so nothing is held.
  it('holds nothing for a row with no single box behind it', () => {
    render(createElement(BoardSelection));
    act(() => {
      inRange().onUseMyLocation({ ...MOONBOARD_ROW, deviceId: null });
    });
    expect(setPendingRecognitionMock).not.toHaveBeenCalled();
    expect(scanCtrl.stop).toHaveBeenCalledOnce();
  });

  it('goes back to every board on Show all', () => {
    const { rerender } = render(createElement(BoardSelection));
    useMyLocation();
    state.locationStatus = 'granted';
    state.nearbyBoards = [moonboardWall, gymWall];
    rerender(createElement(BoardSelection));

    fireEvent.click(screen.getByText('mobile.discovery.nearbyShowAll'));

    expect(nearbyArgs.last[4]).toBeUndefined();
    expect(choice().nearbyBoardType).toBeNull();
    expect(carouselProps.last?.items.map((item) => item.key)).toEqual(['moon-wall', 'gym-wall']);
    expect(screen.getByText('mobile.discovery.nearbyTitle')).toBeTruthy();
    expect(screen.queryByText('mobile.discovery.nearbyShowAll')).toBeNull();
  });

  // The empty line names the type and offers Show all; the choice block renders
  // it, so here it only has to receive the filter and the way out.
  it('hands the choice block the type and a way back to every board when none is near', () => {
    const { rerender } = render(createElement(BoardSelection));
    useMyLocation();
    state.locationStatus = 'granted';
    state.nearbyBoards = [gymWall];
    rerender(createElement(BoardSelection));

    expect(choice().gymState).toBe('none_nearby');
    expect(choice().nearbyBoardType).toBe('moonboard');
    act(() => {
      choice().onShowAllNearby?.();
    });
    expect(choice().nearbyBoardType).toBeNull();
    expect(choice().gymState).toBe('found');
  });

  it('binds a gym board found that way as an onboarding pick', async () => {
    const { rerender } = render(createElement(BoardSelection));
    useMyLocation();
    state.locationStatus = 'granted';
    state.nearbyBoards = [moonboardWall];
    rerender(createElement(BoardSelection));

    await act(async () => {
      carouselProps.last?.onSelect({ key: 'moon-wall', title: 'Crux MoonBoard' });
    });

    expect(setActiveBoardMock).toHaveBeenCalledWith(moonboardWall);
    expect(markOnboardingSeenMock).toHaveBeenCalled();
    expect(routerMock.dismissTo).toHaveBeenCalledWith('/(tabs)/climbs');
  });

  it('goes back to every type when they tap "At a gym" themselves', () => {
    const { rerender } = render(createElement(BoardSelection));
    useMyLocation();

    act(() => {
      choice().onGym();
    });
    state.locationStatus = 'granted';
    state.nearbyBoards = [moonboardWall, gymWall];
    rerender(createElement(BoardSelection));

    expect(nearbyArgs.last[4]).toBeUndefined();
    expect(carouselProps.last?.items.map((item) => item.key)).toEqual(['moon-wall', 'gym-wall']);
  });

  // The filter is screen state: a fresh picker never starts narrowed.
  it('starts unfiltered every time the picker opens', () => {
    const first = render(createElement(BoardSelection));
    useMyLocation();
    first.unmount();

    render(createElement(BoardSelection));
    expect(nearbyArgs.last[4]).toBeUndefined();
    expect(choice().nearbyBoardType).toBeNull();
  });

  // The box is named only by the pick it was held for: a board of its type from
  // the Near you list "Use my location" filtered. Any other pick, or a trip off
  // the picker that came back without a bind, drops it, so MoonBoard B is never
  // remembered as the climber's own MoonBoard A.
  describe('naming the held box', () => {
    const homeMoonboard = { ...moonboardWall, uuid: 'home-moon', name: 'Home MoonBoard' } as UserBoard;

    function renderOrdinaryPicker() {
      state.params = {};
      state.myBoards = [homeMoonboard];
      return render(createElement(BoardSelection));
    }

    async function pickFromCarousel(key: string, title: string) {
      await act(async () => {
        carouselProps.byFirstKey.get(key)?.onSelect({ key, title });
      });
    }

    it('names nothing after backing out of the builder and picking from Your boards', async () => {
      const { rerender } = renderOrdinaryPicker();
      act(() => {
        inRange().onOwnBoard(MOONBOARD_ROW);
      });
      expect(recognitionHold.held).toEqual({ deviceId: 'MOON-BOX', boardType: 'moonboard' });

      // The builder covers the picker; the climber backs out without saving.
      state.focused = false;
      rerender(createElement(BoardSelection));
      state.focused = true;
      rerender(createElement(BoardSelection));
      expect(recognitionHold.held).toBeNull();

      await pickFromCarousel('home-moon', 'Home MoonBoard');
      expect(setActiveBoardMock).toHaveBeenCalledWith(homeMoonboard);
      expect(recognitionHold.remembered).toEqual([]);
    });

    it('names nothing when Search gyms comes back unused', () => {
      const { rerender } = renderOrdinaryPicker();
      act(() => {
        inRange().onSearchGyms(MOONBOARD_ROW);
      });
      state.focused = false;
      rerender(createElement(BoardSelection));
      state.focused = true;
      rerender(createElement(BoardSelection));
      expect(recognitionHold.held).toBeNull();
    });

    it('names nothing when the climber picks from Your boards after Use my location', async () => {
      const { rerender } = renderOrdinaryPicker();
      useMyLocation();
      state.locationStatus = 'granted';
      state.nearbyBoards = [moonboardWall];
      rerender(createElement(BoardSelection));

      await pickFromCarousel('home-moon', 'Home MoonBoard');
      expect(setActiveBoardMock).toHaveBeenCalledWith(homeMoonboard);
      expect(recognitionHold.remembered).toEqual([]);
    });

    it('names the box after the board picked from the list Use my location filtered', async () => {
      const { rerender } = renderOrdinaryPicker();
      useMyLocation();
      state.locationStatus = 'granted';
      state.nearbyBoards = [moonboardWall];
      rerender(createElement(BoardSelection));

      await pickFromCarousel('moon-wall', 'Crux MoonBoard');
      expect(setActiveBoardMock).toHaveBeenCalledWith(moonboardWall);
      expect(recognitionHold.remembered).toEqual([{ deviceId: 'MOON-BOX', boardUuid: 'moon-wall' }]);
    });

    it('names nothing once Show all has taken the filter off', async () => {
      const { rerender } = renderOrdinaryPicker();
      useMyLocation();
      state.locationStatus = 'granted';
      state.nearbyBoards = [moonboardWall, gymWall];
      rerender(createElement(BoardSelection));
      fireEvent.click(screen.getByText('mobile.discovery.nearbyShowAll'));
      // The hold itself goes, not just the pick path: a bind from the builder or
      // the gym map pushed over the picker after Show all must not name the box.
      expect(recognitionHold.held).toBeNull();

      await pickFromCarousel('moon-wall', 'Crux MoonBoard');
      expect(setActiveBoardMock).toHaveBeenCalledWith(moonboardWall);
      expect(recognitionHold.remembered).toEqual([]);
    });
  });

  it('opens the gym map filtered to that type from Search gyms', () => {
    render(createElement(BoardSelection));
    act(() => {
      inRange().onSearchGyms(MOONBOARD_ROW);
    });

    expect(scanCtrl.stop).toHaveBeenCalledOnce();
    expect(setPendingRecognitionMock).toHaveBeenCalledExactlyOnceWith({ deviceId: 'MOON-BOX', boardType: 'moonboard' });
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/gyms',
      params: { returnTo: '/(tabs)/climbs', source: 'onboarding', from: 'picker', boardType: 'moonboard' },
    });
  });

  it('opens the builder on that board type, preset, still as an onboarding pick', () => {
    render(createElement(BoardSelection));
    act(() => {
      inRange().onOwnBoard(MOONBOARD_ROW);
    });

    expect(scanCtrl.stop).toHaveBeenCalledOnce();
    expect(setPendingRecognitionMock).toHaveBeenCalledExactlyOnceWith({ deviceId: 'MOON-BOX', boardType: 'moonboard' });
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/create',
      params: { returnTo: '/(tabs)/climbs', source: 'onboarding', preset: '1', presetBoardType: 'moonboard' },
    });
  });

  it("lands in the ordinary picker's Near you too, filtered and labelled", () => {
    state.params = {};
    state.myBoards = [gymWall];
    const { rerender } = render(createElement(BoardSelection));
    useMyLocation();
    expect(requestLocationMock).toHaveBeenCalledTimes(1);

    state.locationStatus = 'granted';
    state.nearbyBoards = [moonboardWall, gymWall];
    carouselProps.renderedKeys = [];
    rerender(createElement(BoardSelection));

    expect(nearbyArgs.last[4]).toEqual(['moonboard']);
    expect(screen.getByText('mobile.discovery.nearbyTitleMoonboard')).toBeTruthy();
    // Near you holds the MoonBoard alone; Your boards keeps the climber's own.
    expect(carouselProps.renderedKeys).toContainEqual(['moon-wall']);
    expect(carouselProps.renderedKeys).not.toContainEqual(['moon-wall', 'gym-wall']);
  });

  // "Nothing within 20 km" would be false in a gym full of other boards.
  it("names the type in the ordinary picker's empty line and offers every board", () => {
    state.params = {};
    state.myBoards = [gymWall];
    const { rerender } = render(createElement(BoardSelection));
    useMyLocation();
    state.locationStatus = 'granted';
    state.nearbyBoards = [];
    rerender(createElement(BoardSelection));

    expect(screen.getByText('mobile.firstBoard.nearbyEmptyMoonboard')).toBeTruthy();
    expect(screen.queryByText('mobile.firstBoard.nearbyEmpty')).toBeNull();
    fireEvent.click(screen.getAllByText('mobile.discovery.nearbyShowAll')[0]);
    expect(nearbyArgs.last[4]).toBeUndefined();
    expect(screen.getByText('mobile.firstBoard.nearbyEmpty')).toBeTruthy();
  });

  // Until the narrowed search answers, the list holds the previous, unfiltered
  // one. Read through the filter it holds no MoonBoard, which must not flash
  // "No MoonBoards within 20 km" before the real answer lands.
  it('keeps searching, not empty, while the narrowed search has not answered', () => {
    const { rerender } = render(createElement(BoardSelection));
    useMyLocation();
    state.locationStatus = 'granted';
    state.nearbyBoards = [gymWall];
    state.nearbyPlaceholder = true;
    rerender(createElement(BoardSelection));
    expect(choice().gymState).toBe('searching');

    state.nearbyPlaceholder = false;
    state.nearbyBoards = [];
    rerender(createElement(BoardSelection));
    expect(choice().gymState).toBe('none_nearby');
  });

  // Offline, the narrowed search pauses and never answers. Holding "searching"
  // there would spin forever, so a paused search reads as done.
  it('stops searching when the narrowed search is paused offline', () => {
    const { rerender } = render(createElement(BoardSelection));
    useMyLocation();
    state.locationStatus = 'granted';
    state.nearbyBoards = [gymWall];
    state.nearbyPlaceholder = true;
    state.nearbyPaused = true;
    rerender(createElement(BoardSelection));
    expect(choice().gymState).not.toBe('searching');
  });

  it('shows no empty line in the ordinary picker before the narrowed search answers', () => {
    state.params = {};
    state.myBoards = [gymWall];
    const { rerender } = render(createElement(BoardSelection));
    useMyLocation();
    state.locationStatus = 'granted';
    state.nearbyBoards = [gymWall];
    state.nearbyPlaceholder = true;
    rerender(createElement(BoardSelection));

    expect(screen.queryByText('mobile.firstBoard.nearbyEmptyMoonboard')).toBeNull();
    expect(screen.getByTestId('near-you-placeholder')).toBeTruthy();
  });
});
