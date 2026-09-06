// @vitest-environment jsdom
// #5099 — the drawer draws the climb it is SHOWING, on the board that climb
// belongs to.
//
// Browse the Kilter Homewall (layout 8), switch the selected board to the
// Original 12x12 (layout 1), and the climb that carries over as
// `currentClimbQueueItem` is still a Homewall climb. Rendered against the
// 12x12's placements none of its hold ids exist, the renderer drops every hold
// and returns Ok, and the board comes out as a wash over bare art — no throw,
// nothing logged.
//
// The resolver is unit-tested next to itself (`lib/boards/__tests__`); this file
// exists because a sound resolver nobody calls leaves the bug exactly where it
// was. It renders the real PlayDrawer and asserts the joins: which board reaches
// DeferredBoard, whether the switch gate is up, which board "Switch board"
// targets, and that a neighbouring climb from another board is not peeked under
// the current art.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';

type Props = Record<string, unknown>;

const recorded = vi.hoisted(() => ({
  board: [] as Props[],
  headers: [] as Props[],
  switchOverlay: [] as Props[],
  actionBar: [] as Props[],
  deferredSections: [] as Props[],
  logAscent: [] as Props[],
  favoriteStatus: [] as Props[],
  playback: [] as Props[],
  angleSheet: [] as Props[],
}));
const queueState = vi.hoisted(() => ({
  queue: [] as unknown[],
  currentClimbQueueItem: null as unknown,
}));
const navigation = vi.hoisted(() => ({
  state: {
    nextItem: null as unknown,
    prevItem: null as unknown,
    canNext: false,
    canPrevious: false,
  },
}));

// --- Host platform -----------------------------------------------------------
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFillObject: {} },
  Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
}));
vi.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  return {
    createMMKV: () => ({
      getString: (key: string) => store.get(key),
      set: (key: string, value: string) => store.set(key, value),
      remove: (key: string) => store.delete(key),
      clearAll: () => store.clear(),
    }),
  };
});
vi.mock('react-native-gesture-handler', () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  useAnimatedStyle: () => ({}),
  useAnimatedReaction: () => undefined,
  useSharedValue: (initial: unknown) => ({ value: initial }),
  runOnJS: (fn: unknown) => fn,
}));
vi.mock('expo-router', () => ({ router: { dismiss: vi.fn() } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'random-uuid' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));

// --- Shared packages ---------------------------------------------------------
// Navigation is driven per-case so a peek can be aimed at another board.
// `@boardsesh/board-config` and `lib/board-details` stay REAL: the resolver
// reads real layouts, sizes and hold placements, which is the whole question.
vi.mock('@boardsesh/play-view', () => ({
  computeNavigationStateWithSuggestions: () => navigation.state,
  boardSupportsMirroring: () => true,
}));
vi.mock('@boardsesh/analytics', () => ({
  SHARED_EVENTS: {
    ClimbShared: 'Climb Shared',
    FavoriteToggle: 'Favorite Toggle',
    QuickTickOpened: 'Quick Tick Opened',
  },
}));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));

// --- Children ----------------------------------------------------------------
vi.mock('../DeferredBoard', () => ({
  DeferredBoard: (props: Props) => {
    recorded.board.push(props);
    return createElement('div', { 'data-testid': 'board' });
  },
}));
vi.mock('../SwitchBoardOverlay', () => ({
  SwitchBoardOverlay: (props: Props) => {
    recorded.switchOverlay.push(props);
    return createElement('div', { 'data-testid': 'switch-board-overlay' });
  },
}));
vi.mock('../PlayDrawerActionBar', () => ({
  PlayDrawerActionBar: (props: Props) => {
    recorded.actionBar.push(props);
    return createElement('div', { 'data-testid': 'action-bar' });
  },
}));
vi.mock('../DeferredSections', () => ({
  DeferredSections: (props: Props) => {
    recorded.deferredSections.push(props);
    return createElement('div', { 'data-testid': 'deferred-sections' });
  },
}));
vi.mock('../../LogAscentSheet', () => ({
  LogAscentSheet: (props: Props) => {
    recorded.logAscent.push(props);
    return createElement('div', { 'data-testid': 'log-ascent' });
  },
}));
vi.mock('../WallStatePill', () => ({ WallStatePill: () => null }));
vi.mock('../WallStateCallout', () => ({ WallStateCallout: () => null }));
vi.mock('../BrowseFrameOverlay', () => ({ BrowseFrameOverlay: () => null }));
vi.mock('../PanePlaceholder', () => ({ PanePlaceholder: () => null }));
vi.mock('../BoardRenderUnavailable', () => ({ BoardRenderUnavailable: () => null }));
vi.mock('../../playback/PlaybackControls', () => ({ PlaybackControls: () => null }));
vi.mock('../PlayDrawerHeader', () => ({
  LivePlayDrawerHeader: (props: Props) => {
    recorded.headers.push(props);
    return null;
  },
}));
vi.mock('../SwipeableHeader', () => ({
  SwipeableHeader: ({ current, peek }: { current?: ReactNode; peek?: ReactNode }) =>
    createElement('div', null, current, peek),
}));
vi.mock('../AngleSelectorSheet', () => ({
  AngleSelectorSheet: (props: Props) => {
    recorded.angleSheet.push(props);
    return null;
  },
}));
vi.mock('../../ClimbActionsSheet', () => ({ ClimbActionsSheet: () => null }));
vi.mock('../../AddBetaVideoSheet', () => ({ AddBetaVideoSheet: () => null }));
vi.mock('../../ble/BleControlSheetHost', () => ({ BleControlSheetHost: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));

// --- Hooks / providers -------------------------------------------------------
vi.mock('../../../providers/queue-provider', () => ({
  useQueueData: () => queueState,
  useQueueActions: () => ({
    setCurrentClimb: vi.fn(),
    nextClimb: vi.fn(),
    previousClimb: vi.fn(),
    addToQueue: vi.fn(async () => 'added'),
    noteClimbViewed: vi.fn(),
  }),
  useQueueSessionId: () => ({ sessionId: null }),
  usePlaylistSuggestionSource: () => null,
}));
vi.mock('../../../providers/bluetooth-provider', () => ({ useOptionalBluetoothContext: () => null }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useToggleFavorite: () => ({ mutate: vi.fn() }),
  useFavoriteStatus: (boardName: string, uuid: string | null, angle: number) => {
    recorded.favoriteStatus.push({ boardName, uuid, angle });
    return { data: undefined };
  },
}));
vi.mock('../../../hooks/use-display-grade', () => ({ useDisplayGrade: () => ({ boardseshActive: false }) }));
vi.mock('../../../hooks/use-share-climb', () => ({ useShareClimb: () => vi.fn() }));
vi.mock('../../../hooks/use-mounted-on-first-open', () => ({ useMountedOnFirstOpen: (open: boolean) => open }));
vi.mock('../use-mobile-playback', () => ({
  useMobilePlayback: (args: Props) => {
    recorded.playback.push(args);
    return { isAnimatable: false };
  },
}));
vi.mock('../use-below-fold-content-request', () => ({
  useBelowFoldContentRequest: () => ({ requested: false, request: vi.fn(), requestFromScrollOffset: vi.fn() }),
}));
vi.mock('../use-drawer-dismiss-gesture', () => ({
  useDrawerDismissGesture: () => ({ gesture: { enabled: () => ({}) }, translateY: { value: 0 } }),
}));
vi.mock('../use-play-drawer-wake-lock', () => ({ usePlayDrawerWakeLock: () => undefined }));
vi.mock('../../ble/use-lightbulb-control', () => ({
  useLightbulbControl: () => ({ lit: false, localConnected: false, pending: false, onPress: vi.fn() }),
}));
vi.mock('../copy-climb-name', () => ({ copyClimbName: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSuccess: vi.fn() }));

const { PlayDrawer } = await import('../PlayDrawer');

// The Original 12x12 the climber switched TO.
const TWELVE_BY_TWELVE = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };

function climbOn(boardType: string, layoutId: number, angle: number, uuid: string): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: 'p1145r15',
    difficulty: '7A',
    boardType,
    layoutId,
    angle,
  } as unknown as Climb;
}

function queueItem(climb: Climb, uuid: string): ClimbQueueItem {
  return { uuid, climb } as unknown as ClimbQueueItem;
}

// A smaller wall on the SAME Kilter layout, so a climb set on the 12x12 needs
// an upsize rather than another board.
const SMALL_TWELVE_LAYOUT = { boardName: 'kilter', layoutId: 1, sizeId: 14, setIds: '1,20', angle: 40 };

// A Kilter Homewall climb (layout 8) — the board the climber was browsing.
const HOMEWALL_CLIMB = climbOn('kilter', 8, 30, 'HOMEWALL00000000000000000000AAAA');
// A climb that genuinely belongs to the selected 12x12.
const TWELVE_CLIMB = climbOn('kilter', 1, 40, 'TWELVE0000000000000000000000BBBB');

function renderDrawer(onSwitchBoard?: (boardConfig?: unknown) => void) {
  return render(
    createElement(PlayDrawer, {
      presentation: 'pane' as const,
      boardConfig: TWELVE_BY_TWELVE,
      openTarget: null,
      onOpenQueue: vi.fn(),
      onSwitchBoard,
    }),
  );
}

function lastBoardProps(): Props {
  const props = recorded.board.at(-1);
  if (!props) throw new Error('DeferredBoard never rendered');
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  recorded.board = [];
  recorded.headers = [];
  recorded.switchOverlay = [];
  recorded.actionBar = [];
  recorded.deferredSections = [];
  recorded.logAscent = [];
  recorded.favoriteStatus = [];
  recorded.playback = [];
  recorded.angleSheet = [];
  queueState.queue = [];
  queueState.currentClimbQueueItem = null;
  navigation.state = { nextItem: null, prevItem: null, canNext: false, canPrevious: false };
});

describe('PlayDrawer draws the climb on its own board (#5099)', () => {
  it('renders a carried-over Homewall climb on the Homewall, not on the selected 12x12', () => {
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    renderDrawer(vi.fn());

    const board = lastBoardProps();
    // Layout 8 is the Homewall. Rendering it under layout 1's placements is the
    // bug: every hold id is dropped and the board comes out as a plain wash.
    expect(board.layoutId).toBe(8);
    expect(board.boardName).toBe('kilter');
    expect(board.sizeId).not.toBe(TWELVE_BY_TWELVE.sizeId);
    expect(board.currentFrames).toBe(HOMEWALL_CLIMB.frames);
  });

  it('raises the switch-board gate for a carried-over climb, with no override in play', () => {
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    // `boardMismatch` is NOT passed: nobody set a board override — the drawer has
    // to notice the disagreement from the climb itself.
    renderDrawer(vi.fn());

    expect(recorded.switchOverlay).not.toHaveLength(0);
    // Not the bare brand: "Switch to Kilter" reads as a no-op on a Kilter board,
    // and Homewall vs Original is the whole of #5099.
    expect(recorded.switchOverlay.at(-1)?.boardLabel).toBe('Kilter Board Homewall');
  });

  it('sends "Switch board" to the CLIMB board, so the host has something to switch to', () => {
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    const onSwitchBoard = vi.fn();
    renderDrawer(onSwitchBoard);

    act(() => {
      (recorded.switchOverlay.at(-1)?.onSwitchBoard as () => void)();
    });

    // Without the board, the host reads its (empty) override, returns early, and
    // the only button on the scrim does nothing.
    expect(onSwitchBoard).toHaveBeenCalledTimes(1);
    expect(onSwitchBoard.mock.calls[0][0]).toMatchObject({ boardName: 'kilter', layoutId: 8, angle: 30 });
  });

  it('leaves a climb from the selected board completely alone', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer(vi.fn());

    const board = lastBoardProps();
    expect(board.boardName).toBe(TWELVE_BY_TWELVE.boardName);
    expect(board.layoutId).toBe(TWELVE_BY_TWELVE.layoutId);
    expect(board.sizeId).toBe(TWELVE_BY_TWELVE.sizeId);
    expect(board.setIds).toBe(TWELVE_BY_TWELVE.setIds);
    // Nothing to switch to — the controls stay live.
    expect(recorded.switchOverlay).toHaveLength(0);
  });

  it('draws a climb that needs a bigger wall on the bigger wall, with no switch prompt', () => {
    // Same board name and layout, one size up. There is no other board to
    // switch TO — the host matches owned boards by name + layout, so a prompt
    // here would "switch" to the board the climber is already on and never
    // clear. Playlist rows already render these without a prompt.
    queueState.currentClimbQueueItem = queueItem(
      { ...TWELVE_CLIMB, compatibleSizeIds: [10] } as unknown as Climb,
      'queue-upsized',
    );
    render(
      createElement(PlayDrawer, {
        presentation: 'pane' as const,
        boardConfig: SMALL_TWELVE_LAYOUT,
        openTarget: null,
        onOpenQueue: vi.fn(),
        onSwitchBoard: vi.fn(),
      }),
    );

    const board = lastBoardProps();
    expect(board.layoutId).toBe(1);
    expect(board.sizeId).toBe(10);
    expect(recorded.switchOverlay).toHaveLength(0);
    // Same board, so the wall can still be driven.
    expect(recorded.playback.at(-1)?.suppressWallWrites).toBe(false);
  });

  it('uses the incoming Woods board for the swipe header while Kilter stays current', () => {
    const woods = {
      ...TWELVE_CLIMB,
      uuid: 'woods-peek',
      boardType: 'woods',
      layoutId: 1,
      frames: 'p0r4p1r3',
      compatibleSizeIds: [1],
      characteristics: [],
    };
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    navigation.state = { nextItem: queueItem(woods, 'queue-woods'), prevItem: null, canNext: true, canPrevious: false };
    renderDrawer(vi.fn());
    const header = recorded.headers.find((props) => (props.climb as Climb).uuid === 'woods-peek');
    expect(header).toMatchObject({ boardName: 'woods', layoutId: 1 });
  });

  it('withholds a peek whose climb lives on another board', () => {
    // Swiping from a 12x12 climb toward a Homewall neighbour: the peek is drawn
    // over the 12x12 art, where the neighbour has no holds.
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    navigation.state = {
      nextItem: queueItem(HOMEWALL_CLIMB, 'queue-homewall'),
      prevItem: queueItem(TWELVE_CLIMB, 'queue-twelve-prev'),
      canNext: true,
      canPrevious: true,
    };
    renderDrawer(vi.fn());

    const board = lastBoardProps();
    expect(board.nextFrames).toBeNull();
    // The same-board neighbour still peeks — this must not blanket-disable peeks.
    expect(board.prevFrames).toBe(TWELVE_CLIMB.frames);
  });

  it('keeps the below-fold sections and the tick sheet on the climb board', () => {
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    renderDrawer(vi.fn());

    // Logbook / beta / similar climbs are all per-board reads.
    expect(recorded.deferredSections.at(-1)?.layoutId).toBe(8);
    // The favourite heart is keyed on (board, climb, angle); keyed on the wrong
    // board it reads and writes another board's favourite.
    expect(recorded.favoriteStatus.at(-1)?.angle).toBe(30);

    act(() => {
      (recorded.actionBar.at(-1)?.onTickPress as () => void)();
    });

    expect(recorded.logAscent.at(-1)?.layoutId).toBe(8);
    expect(recorded.logAscent.at(-1)?.angle).toBe(30);
  });

  it('never lets a wrong-board climb reach the wall', () => {
    // Its hold ids address a different wall. The scrim hides the play button,
    // but a party peer's playback event starts the engine with no local tap —
    // so the suppression flag, not the UI, is what keeps the board dark.
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    renderDrawer(vi.fn());

    expect(recorded.playback.at(-1)?.suppressWallWrites).toBe(true);
  });

  it('leaves wall writes armed for a climb that belongs to this board', () => {
    queueState.currentClimbQueueItem = queueItem(TWELVE_CLIMB, 'queue-twelve');
    renderDrawer(vi.fn());

    expect(recorded.playback.at(-1)?.suppressWallWrites).toBe(false);
  });

  it('asks the angle sheet for no per-climb stats on a wrong-board climb', () => {
    // The sheet reads by-angle stats against the SELECTED board, where this
    // climb does not exist.
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    renderDrawer(vi.fn());

    act(() => {
      (recorded.actionBar.at(-1)?.onOpenAngleSelector as () => void)();
    });

    expect(recorded.angleSheet.at(-1)?.climbUuid).toBeUndefined();
    // Still the selected board's angles — that is the wall the pill moves.
    expect(recorded.angleSheet.at(-1)?.currentAngle).toBe(TWELVE_BY_TWELVE.angle);
  });

  it('still shows the angle pill for the board the climber is standing at', () => {
    queueState.currentClimbQueueItem = queueItem(HOMEWALL_CLIMB, 'queue-homewall');
    renderDrawer(vi.fn());

    // The pill changes the SELECTED board's angle — it must not offer to move a
    // wall the climber is not on.
    expect(recorded.actionBar.at(-1)?.currentAngle).toBe(TWELVE_BY_TWELVE.angle);
  });
});
