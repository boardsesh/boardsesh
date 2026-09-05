// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Captures the history list's reserved bottom padding so the test can assert the
// in-session list clears the bottom chrome without an End action bar.
const list = vi.hoisted(() => ({
  contentContainerStyle: null as Record<string, unknown> | null,
  hasGestureScrollComponent: false,
  nestedScrollEnabled: false,
}));

// Captures the device-local export handoff fired after a confirmed session end.
const integrations = vi.hoisted(() => ({
  runSessionEndExports: vi.fn(),
}));

const bottomChrome = vi.hoisted(() => ({
  metrics: {
    fixedFooterBottom: 88,
    jsQueueReserve: 0,
    tabBarBottom: 50,
    // The Material-vs-glass arbitration now lives in computeBottomChromeMetrics
    // (unit-tested there); InSessionView just wires this resolved field.
    inSessionListBottom: 130,
  },
}));

const theme = vi.hoisted(() => ({
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
}));

// Controllable endSession + a captured view of the EndSessionSheet props, so the
// error path (endSession rejects) can assert the spinner clears.
const queue = vi.hoisted(() => ({ endSession: vi.fn(), setCurrentClimb: vi.fn() }));
// Session-history ticks fed to the list, so a tap on one can be asserted.
const detail = vi.hoisted(() => ({ ticks: [] as Record<string, unknown>[] }));
const sheet = vi.hoisted(() => ({ isEnding: false as boolean, onConfirm: null as (() => void) | null }));
const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('react-native', () => ({
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', testID ? { 'data-testid': testID } : null, children),
}));

vi.mock('react-native-gesture-handler', () => ({
  Gesture: {
    Pan: () => ({
      activeOffsetY: () => ({
        onStart: () => ({
          onUpdate: () => ({
            onEnd: () => ({}),
          }),
        }),
      }),
    }),
  },
  GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-native-reanimated', () => ({
  useSharedValue: (value: number) => ({ value }),
  withSpring: (value: number) => value,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 130, left: 0, right: 0 }),
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    ListHeaderComponent,
    ListFooterComponent,
    contentContainerStyle,
    renderScrollComponent,
    nestedScrollEnabled,
    data,
    renderItem,
  }: {
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    contentContainerStyle?: Record<string, unknown>;
    renderScrollComponent?: unknown;
    nestedScrollEnabled?: boolean;
    data?: unknown[];
    renderItem?: (info: { item: unknown; index: number }) => ReactNode;
  }) => {
    list.contentContainerStyle = contentContainerStyle ?? null;
    list.hasGestureScrollComponent = renderScrollComponent != null;
    list.nestedScrollEnabled = nestedScrollEnabled ?? false;
    const rows = (data ?? []).map((item, index) =>
      createElement('div', { key: index }, renderItem?.({ item, index }) ?? null),
    );
    return createElement('div', null, ListHeaderComponent, ...rows, ListFooterComponent);
  },
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@boardsesh/play-view', () => ({ formatGrade: (grade: string) => grade, getGradeTextColor: () => '#fff' }));
vi.mock('../../../Button', () => ({ Button: () => createElement('button') }));
vi.mock('../../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../GlassSurface', () => ({ GlassSurface: () => null }));
vi.mock('../../../ListRow', () => ({ ListRow: () => null }));
vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('div', { onClick: onPress, 'data-testid': onPress ? 'pressable' : undefined }, children),
}));
vi.mock('../../../SectionHeader', () => ({ SectionHeader: () => null }));
vi.mock('../../RecordTopChrome', () => ({ RecordTopChrome: () => null }));
vi.mock('../../SessionTitleSheet', () => ({ SessionTitleSheet: () => null }));
vi.mock('../../../ClimbListItemContent', () => ({ ClimbListItemContent: () => null }));
vi.mock('../../../EndSessionSheet', () => ({
  EndSessionSheet: ({ isEnding, onConfirm }: { isEnding?: boolean; onConfirm?: () => void }) => {
    sheet.isEnding = isEnding ?? false;
    sheet.onConfirm = onConfirm ?? null;
    return null;
  },
}));
vi.mock('../../../../lib/error-reporting', () => ({ reportError: vi.fn(), reportHandledError: vi.fn() }));
vi.mock('../../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: theme.variant,
    systemColors: {
      background: '#000',
      secondaryBackground: '#111',
      secondaryLabel: '#999',
      separator: '#222',
    },
    brandColors: { success: '#0f0', warning: '#ff0', primary: '#00f', error: '#f00' },
    features: { inBodyLargeTitle: false },
  }),
}));
vi.mock('../../../../providers/queue-provider', () => ({
  useQueueActions: () => ({
    endSession: queue.endSession,
    clearSession: vi.fn(),
    setCurrentClimb: queue.setCurrentClimb,
  }),
  useQueueLiveStats: () => ({ liveStats: null, sessionUsers: [] }),
  useQueueSessionControls: () => ({
    participantId: 'participant-1',
    sessionId: 'session-1',
  }),
}));
vi.mock('../../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../../lib/analytics', () => ({ track: vi.fn() }));
// The exit capability itself is covered by in-session-view-exit.test.tsx, which
// drives the real hook. This file only cares about list padding, so pin the
// capability to the pre-#3502 shape and keep the assertions here about layout.
vi.mock('../../use-session-exit-options', () => ({
  useSessionExitOptions: () => ({ canEnd: true, startedOnThisDevice: true, defaultMode: 'end' }),
}));
vi.mock('../../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ openPlayDrawer: vi.fn() }) }));
vi.mock('../../../../lib/graphql/hooks', () => ({
  useSessionDetail: () => ({
    data: {
      totalSends: 0,
      totalFlashes: 0,
      gradeDistribution: [],
      participants: [],
      hardestGrade: null,
      ticks: detail.ticks,
    },
  }),
  useSessionSummary: () => ({ data: { startedAt: '2026-01-01T00:00:00.000Z' } }),
  useSessionPreview: () => ({ data: null }),
}));
vi.mock('../../../../lib/store-review', () => ({
  SESSION_STORE_REVIEW_CANDIDATE_PARAM: '1',
  isSessionStoreReviewEligible: (summary: { totalSends: number }) => summary.totalSends >= 3,
}));
vi.mock('../../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
vi.mock('../../../../lib/integrations', () => ({
  runSessionEndExports: integrations.runSessionEndExports,
}));
vi.mock('../../../../lib/climb-to-queue-item', () => ({
  climbToQueueItem: (climb: { uuid: string }, options?: { uuid?: string }) => ({
    uuid: options?.uuid ?? 'queue-item',
    climb,
  }),
}));
vi.mock('../../../../lib/playlists/board-details-for-playlist', () => ({
  getBoardConfigForPlaylist: () => null,
  renderBoardToPlaylistConfig: () => null,
}));
vi.mock('../../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: vi.fn() }));
vi.mock('../../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade: string | null) => grade, formatGradeByDifficultyId: () => null }),
}));
vi.mock('../../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => bottomChrome.metrics,
}));
vi.mock('../../../../hooks/use-native-glass', () => ({ useNativeGlass: () => false }));
vi.mock('../../../../theme/colors', () => ({ withAlpha: (color: string) => color }));
vi.mock('../../../../theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#999' } }));
vi.mock('../../../../theme/animations', () => ({ springs: { gentle: {} } }));
vi.mock('../../../../theme/tokens', () => ({ borderRadius: { lg: 16 }, spacing: { 2: 8, 3: 12, 4: 16, 5: 20 } }));
vi.mock('../../../you/profile-chart-colors', () => ({ gradeBadgeColor: () => '#fff' }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn(), hapticMedium: vi.fn() }));
vi.mock('../SessionAnalytics', () => ({ SessionAnalytics: () => null }));
vi.mock('../SessionLeaderboard', () => ({ SessionLeaderboard: () => null }));
vi.mock('../SessionPresenceRow', () => ({ SessionPresenceRow: () => null }));

import { InSessionView } from '../InSessionView';

describe('InSessionView footer', () => {
  beforeEach(() => {
    list.contentContainerStyle = null;
    list.hasGestureScrollComponent = false;
    list.nestedScrollEnabled = false;
    bottomChrome.metrics = { fixedFooterBottom: 88, jsQueueReserve: 0, tabBarBottom: 50, inSessionListBottom: 130 };
    theme.variant = 'liquidGlass';
    queue.endSession.mockReset();
    queue.endSession.mockResolvedValue(null);
    router.push.mockClear();
    sheet.isEnding = false;
    sheet.onConfirm = null;
    integrations.runSessionEndExports.mockReset();
    queue.setCurrentClimb.mockReset();
    detail.ticks = [];
  });

  it('reserves only the bottom-chrome offset now that End moved to the top chrome', () => {
    render(createElement(InSessionView));

    // End no longer renders a bottom action bar, so the list reserves just the
    // safe-area inset (the native tab bar + climb accessory are already in it on the
    // Liquid Glass path) — no extra footer height.
    expect(list.contentContainerStyle?.paddingBottom).toBe(130);
  });

  it('adds the JS queue capsule reserve on Liquid Glass fallback devices', () => {
    bottomChrome.metrics = { fixedFooterBottom: 196, jsQueueReserve: 66, tabBarBottom: 50, inSessionListBottom: 196 };

    render(createElement(InSessionView));

    // NativeTabs has already expanded the safe-area inset for the tab bar; the
    // fallback JS current-climb capsule is the only extra chrome to reserve.
    expect(list.contentContainerStyle?.paddingBottom).toBe(196);
  });

  it('uses the fixed-footer reserve for the Material active-context bar', () => {
    theme.variant = 'material';
    bottomChrome.metrics = { fixedFooterBottom: 88, jsQueueReserve: 48, tabBarBottom: 50, inSessionListBottom: 88 };

    render(createElement(InSessionView));

    expect(list.contentContainerStyle?.paddingBottom).toBe(88);
  });

  it('renders no in-session bottom action bar', () => {
    const { queryByTestId } = render(createElement(InSessionView));
    expect(queryByTestId('in-session-footer')).toBeNull();
  });

  it('uses a RNGH scroll host so Android can arbitrate the scroll against the RecordTopChrome Material container', () => {
    render(createElement(InSessionView, { showChrome: true }));
    expect(list.hasGestureScrollComponent).toBe(true);
    expect(list.nestedScrollEnabled).toBe(true);
  });

  it('keeps the native scroll host in overlay mode so pull-to-dismiss is not blocked', () => {
    const translateY = { value: 0 };
    render(createElement(InSessionView, { showChrome: false, translateY: translateY as never, screenHeight: 844 }));
    expect(list.hasGestureScrollComponent).toBe(false);
    expect(list.nestedScrollEnabled).toBe(false);
  });

  it('clears the ending spinner even when endSession rejects', async () => {
    queue.endSession.mockRejectedValueOnce(new Error('boom'));
    render(createElement(InSessionView));
    expect(sheet.onConfirm).not.toBeNull();

    await act(async () => {
      sheet.onConfirm?.();
      // Let the rejected endSession + catch + finally settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queue.endSession).toHaveBeenCalledTimes(1);
    // The finally always clears isEnding, so the confirm spinner doesn't hang.
    expect(sheet.isEnding).toBe(false);
  });

  it('hands the ended session to the integrations exporter on confirm', async () => {
    const summary = {
      sessionId: 'session-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T01:00:00.000Z',
      totalSends: 3,
      totalAttempts: 5,
    };
    queue.endSession.mockResolvedValueOnce(summary);

    render(createElement(InSessionView));
    expect(sheet.onConfirm).not.toBeNull();

    await act(async () => {
      sheet.onConfirm?.();
      // handleConfirmEnd awaits endSession before exporting; flush it.
      await Promise.resolve();
    });

    expect(integrations.runSessionEndExports).toHaveBeenCalledWith(summary, {});
  });

  it('marks the summary route as a store-review candidate after 3 ascents', async () => {
    queue.endSession.mockResolvedValueOnce({
      sessionId: 'session-1',
      totalSends: 3,
      totalAttempts: 0,
    });

    render(createElement(InSessionView));

    await act(async () => {
      sheet.onConfirm?.();
      await Promise.resolve();
    });

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/record/summary',
      params: { sessionId: 'session-1', reviewCandidate: '1' },
    });
  });

  it('does not mark the summary route as a store-review candidate after 2 ascents', async () => {
    queue.endSession.mockResolvedValueOnce({
      sessionId: 'session-1',
      totalSends: 2,
      totalAttempts: 0,
    });

    render(createElement(InSessionView));

    await act(async () => {
      sheet.onConfirm?.();
      await Promise.resolve();
    });

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/record/summary',
      params: { sessionId: 'session-1' },
    });
  });
  it('drops the list source when a history tick is tapped so swipes walk the queue (#4829)', () => {
    detail.ticks = [
      {
        uuid: 'tick-1',
        climbUuid: 'climb-1',
        climbName: 'Race Route',
        frames: 'p1r15',
        angle: 40,
        status: 'send',
        userId: 'user-1',
        climbedAt: '2026-01-01T00:10:00.000Z',
        boardType: 'woods',
        layoutId: 1,
        isMirror: false,
        isNoMatch: false,
      },
    ];
    const { getAllByTestId } = render(createElement(InSessionView));

    act(() => {
      getAllByTestId('pressable')[0].click();
    });

    expect(queue.setCurrentClimb).toHaveBeenCalledTimes(1);
    expect(queue.setCurrentClimb).toHaveBeenCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: 'climb-1' }) }),
      { playlistSuggestionSource: null },
    );
  });
});
