// @vitest-environment jsdom
// The one test that actually RENDERS PlayDrawer.
//
// Every anonymous rule in this component was previously pinned one hop away —
// `play-drawer-action-bar.test.tsx` renders the bar with a `viewer` handed
// straight in, `play-drawer-navigation.test.ts` calls `getSimilarClimbTapMode`
// as a pure function, `play-drawer-layout.test.ts` calls
// `initialDrawerPreviewItem` as a pure function. All three oracles are sound and
// none of them can see whether PlayDrawer *uses* them: hardcoding
// `viewer="member"` at the action-bar call site, or deleting the
// similar-climb guard outright, left the whole 6576-test mobile suite green.
//
// So this file renders the real component with its children recorded, and
// asserts the joins:
//
//   1. `viewer` and `onSignInPress` reach PlayDrawerActionBar.
//   2. A similar-climb tap writes nothing anonymously — no `addToQueue`, no
//      `setCurrentClimb` (which is what re-arms the BLE auto-sender) — and still
//      does both for a member.
//   3. No "Preview / Set active" banner anonymously. `Set active` calls
//      `setCurrentClimb`, so it is the same queue write and the same BLE re-arm
//      wearing a different button.
//   4. The favourite query is disarmed anonymously (`favorites` is
//      `requireAuthenticated`, so an armed one can only 401).
//   5. The pane never paints its "Pick a climb" placeholder when the open target
//      already carries the climb — not even on the first commit.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

type Props = Record<string, unknown>;

const recorded = vi.hoisted(() => ({
  actionBar: [] as Props[],
  previewBanner: [] as Props[],
  deferredSections: [] as Props[],
  favoriteStatus: [] as Props[],
  panePlaceholder: 0,
}));
const queueActions = vi.hoisted(() => ({
  setCurrentClimb: vi.fn(),
  nextClimb: vi.fn(),
  previousClimb: vi.fn(),
  addToQueue: vi.fn(async () => 'added'),
}));

// --- Host platform -----------------------------------------------------------
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFillObject: {} },
  Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
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
vi.mock('@boardsesh/play-view', () => ({
  computeNavigationStateWithSuggestions: () => ({
    nextItem: null,
    prevItem: null,
    canNext: false,
    canPrevious: false,
  }),
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
// Recorded rather than stubbed: these three carry the props under test.
vi.mock('../PlayDrawerActionBar', () => ({
  PlayDrawerActionBar: (props: Props) => {
    recorded.actionBar.push(props);
    return createElement('div', { 'data-testid': 'action-bar' });
  },
}));
vi.mock('../PlayDrawerPreviewBanner', () => ({
  PlayDrawerPreviewBanner: (props: Props) => {
    recorded.previewBanner.push(props);
    return createElement('div', { 'data-testid': 'preview-banner' });
  },
}));
vi.mock('../DeferredSections', () => ({
  DeferredSections: (props: Props) => {
    recorded.deferredSections.push(props);
    return createElement('div', { 'data-testid': 'deferred-sections' });
  },
}));
vi.mock('../PanePlaceholder', () => ({
  PanePlaceholder: () => {
    recorded.panePlaceholder += 1;
    return createElement('div', { 'data-testid': 'pane-placeholder' });
  },
}));
vi.mock('../DeferredBoard', () => ({ DeferredBoard: () => createElement('div', { 'data-testid': 'board' }) }));
vi.mock('../BoardRenderUnavailable', () => ({ BoardRenderUnavailable: () => null }));
vi.mock('../PlaybackControls', () => ({ PlaybackControls: () => null }));
vi.mock('../PlayDrawerHeader', () => ({ LivePlayDrawerHeader: () => createElement('div', null) }));
vi.mock('../SwipeableHeader', () => ({
  SwipeableHeader: ({ current }: { current?: ReactNode }) => createElement('div', null, current),
}));
vi.mock('../PlayDrawerOnWallBanner', () => ({ PlayDrawerOnWallBanner: () => null }));
vi.mock('../SwitchBoardOverlay', () => ({ SwitchBoardOverlay: () => null }));
vi.mock('../AngleSelectorSheet', () => ({ AngleSelectorSheet: () => null }));
vi.mock('../../LogAscentSheet', () => ({ LogAscentSheet: () => null }));
vi.mock('../../ClimbActionsSheet', () => ({ ClimbActionsSheet: () => null }));
vi.mock('../../AddBetaVideoSheet', () => ({ AddBetaVideoSheet: () => null }));
vi.mock('../../ble/BleControlSheetHost', () => ({ BleControlSheetHost: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));

// --- Hooks / providers -------------------------------------------------------
vi.mock('../../../providers/queue-provider', () => ({
  useQueueData: () => ({ queue: [], currentClimbQueueItem: null }),
  useQueueActions: () => queueActions,
  useQueueSessionId: () => ({ sessionId: null }),
  usePlaylistSuggestionSource: () => null,
}));
vi.mock('../../../providers/bluetooth-provider', () => ({ useOptionalBluetoothContext: () => null }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: false }) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useToggleFavorite: () => ({ mutate: vi.fn() }),
  useFavoriteStatus: (_boardName: string, _uuid: string | null, _angle: number, options?: Props) => {
    recorded.favoriteStatus.push(options ?? {});
    return { data: undefined };
  },
}));
vi.mock('../../../hooks/use-display-grade', () => ({ useDisplayGrade: () => ({ boardseshActive: false }) }));
vi.mock('../../../hooks/use-share-climb', () => ({ useShareClimb: () => vi.fn() }));
vi.mock('../../../hooks/use-mounted-on-first-open', () => ({ useMountedOnFirstOpen: (open: boolean) => open }));
vi.mock('../use-mobile-playback', () => ({ useMobilePlayback: () => ({ isAnimatable: false }) }));
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
vi.mock('../../../lib/board-details', () => ({
  getBoardRenderData: () => ({ boardWidth: 100, boardHeight: 100, holdsData: [], imagesToHolds: {} }),
}));

// `play-drawer-navigation`, `play-drawer-layout`, `boardsesh-grade-display` and
// `favorite-rollback` stay REAL — the wiring of those helpers into the render is
// exactly what this file exists to measure.

const { PlayDrawer } = await import('../PlayDrawer');

const BOARD_CONFIG = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
const CLIMB = {
  uuid: '0A1B2C3D4E5F60718293A4B5C6D7E8F9',
  name: 'Crimpy Thing',
  frames: 'p1145r15',
  difficulty: '7A',
} as unknown as Climb;
const SIMILAR_CLIMB = {
  uuid: 'FFEE0011223344556677889900AABBCC',
  name: 'Neighbour',
  frames: 'p1200r15',
} as unknown as Climb;

function openTargetFor(climb: Climb) {
  return { climb, options: { previewQueueItem: { uuid: 'queue-item-uuid', climb } }, nonce: 1 };
}

function renderDrawer(viewer: 'member' | 'anonymous', onSignIn?: () => void) {
  return render(
    createElement(PlayDrawer, {
      presentation: 'pane' as const,
      viewer,
      boardConfig: BOARD_CONFIG,
      openTarget: openTargetFor(CLIMB),
      onOpenQueue: vi.fn(),
      onSignIn,
    }),
  );
}

function lastActionBarProps(): Props {
  const props = recorded.actionBar.at(-1);
  if (!props) throw new Error('PlayDrawerActionBar never rendered');
  return props;
}

function lastSimilarClimbHandler(): (climb: Climb) => Promise<void> {
  const props = recorded.deferredSections.at(-1);
  if (!props) throw new Error('DeferredSections never rendered');
  return props.onSimilarClimbPress as (climb: Climb) => Promise<void>;
}

beforeEach(() => {
  vi.clearAllMocks();
  recorded.actionBar = [];
  recorded.previewBanner = [];
  recorded.deferredSections = [];
  recorded.favoriteStatus = [];
  recorded.panePlaceholder = 0;
  queueActions.addToQueue.mockResolvedValue('added');
});

describe('PlayDrawer — the anonymous joins', () => {
  it('hands its own viewer and sign-in prompt to the action bar', () => {
    const onSignIn = vi.fn();
    renderDrawer('anonymous', onSignIn);

    const props = lastActionBarProps();
    // Hardcoding `viewer="member"` here is invisible to every action-bar test,
    // which passes `viewer` in directly: it would restore the queue button, the
    // heart, the lightbulb, the ellipsis and the tick sheet for a signed-out
    // reader with the whole suite green.
    expect(props.viewer).toBe('anonymous');
    // The tick is the only conversion prompt on the surface. With the prop
    // dropped in the middle, the bar calls `onSignInPress?.()` on undefined and
    // the tap silently does nothing.
    expect(typeof props.onSignInPress).toBe('function');
    (props.onSignInPress as () => void)();
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it('passes the member viewer through unchanged', () => {
    renderDrawer('member');
    expect(lastActionBarProps().viewer).toBe('member');
  });

  it('writes nothing when a signed-out reader taps a similar climb', async () => {
    renderDrawer('anonymous');
    const onSimilarClimbPress = lastSimilarClimbHandler();

    await act(async () => {
      await onSimilarClimbPress(SIMILAR_CLIMB);
    });

    // Both halves matter. `addToQueue` is a queue a signed-out visitor cannot
    // carry anywhere; `setCurrentClimb` re-arms the BLE auto-sender, and the
    // browser export is the one surface where Web Bluetooth is mounted.
    expect(queueActions.addToQueue).not.toHaveBeenCalled();
    expect(queueActions.setCurrentClimb).not.toHaveBeenCalled();
    // It still swaps what the drawer shows — Similar Climbs is the best reason
    // a visitor has to keep looking, so a dead tap would be its own regression.
    expect((recorded.deferredSections.at(-1)?.climb as Climb).uuid).toBe(SIMILAR_CLIMB.uuid);
  });

  it('still queues and activates a similar climb for a member', async () => {
    renderDrawer('member');
    const onSimilarClimbPress = lastSimilarClimbHandler();

    await act(async () => {
      await onSimilarClimbPress(SIMILAR_CLIMB);
    });

    expect(queueActions.addToQueue).toHaveBeenCalledTimes(1);
    expect(queueActions.setCurrentClimb).toHaveBeenCalledTimes(1);
  });

  it('offers no "Set active" banner to a signed-out reader', () => {
    renderDrawer('anonymous');
    // The anonymous drawer is ALWAYS a preview (that is what keeps the queue
    // untouched), so an ungated banner renders an orange PREVIEW chip plus a
    // live "Set active" button whose press is `setCurrentClimb` — the same
    // queue write and BLE re-arm the similar-climb guard above blocks.
    expect(recorded.previewBanner).toHaveLength(0);
  });

  it('still offers it to a member previewing a climb', () => {
    renderDrawer('member');
    expect(recorded.previewBanner.length).toBeGreaterThan(0);
    expect(recorded.previewBanner.at(-1)?.showSetActive).toBe(true);
  });

  it('disarms the favourite query for a signed-out reader', () => {
    renderDrawer('anonymous');
    // `favorites` is `requireAuthenticated` server-side, so an armed query has
    // exactly one possible outcome on every anonymous open.
    expect(recorded.favoriteStatus.at(-1)?.enabled).toBe(false);
  });

  it('arms it for a member', () => {
    renderDrawer('member');
    expect(recorded.favoriteStatus.at(-1)?.enabled).toBe(true);
  });

  it('never paints the "Pick a climb" placeholder when the target already carries one', () => {
    renderDrawer('anonymous');
    // Counted across every commit, not just the last: the open target is applied
    // by an effect that runs after the first commit, so a pane seeded only there
    // shows the placeholder for one frame — a lie on a surface the visitor
    // reached by following a link to one specific climb.
    expect(recorded.panePlaceholder).toBe(0);
  });
});
