// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Captures the history list's reserved bottom padding so the test can assert the
// in-session list clears the bottom chrome without an End action bar.
const list = vi.hoisted(() => ({
  contentContainerStyle: null as Record<string, unknown> | null,
}));

// Captures the device-local export handoff fired after a confirmed session end.
const integrations = vi.hoisted(() => ({
  runSessionEndExports: vi.fn(),
}));

const bottomChrome = vi.hoisted(() => ({
  metrics: {
    fixedFooterBottom: 88,
    jsQueueReserve: 0,
    nativeAccessoryVisible: false,
    repTimerReserve: 0,
    tabBarBottom: 50,
  },
}));

const theme = vi.hoisted(() => ({
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
}));

// Controllable endSession + a captured view of the EndSessionSheet props, so the
// error path (endSession rejects) can assert the spinner clears.
const queue = vi.hoisted(() => ({ endSession: vi.fn() }));
const sheet = vi.hoisted(() => ({ isEnding: false as boolean, onConfirm: null as (() => void) | null }));
const sessionSettingsSheet = vi.hoisted(() => ({ visible: false }));

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
  }: {
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    contentContainerStyle?: Record<string, unknown>;
  }) => {
    list.contentContainerStyle = contentContainerStyle ?? null;
    return createElement('div', null, ListHeaderComponent, ListFooterComponent);
  },
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@boardsesh/queue-runtime', () => ({ deriveIsDriver: () => true }));
vi.mock('@boardsesh/play-view', () => ({ formatGrade: (grade: string) => grade, getGradeTextColor: () => '#fff' }));
vi.mock('../../../Button', () => ({ Button: () => createElement('button') }));
vi.mock('../../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../GlassSurface', () => ({ GlassSurface: () => null }));
vi.mock('../../../ListRow', () => ({ ListRow: () => null }));
vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../SectionHeader', () => ({ SectionHeader: () => null }));
vi.mock('../../RecordTopChrome', () => ({
  RecordTopChrome: ({ onOpenSettings }: { onOpenSettings?: () => void }) =>
    onOpenSettings
      ? createElement('button', { 'data-testid': 'open-session-settings', onClick: onOpenSettings })
      : null,
}));
vi.mock('../../../ClimbListItemContent', () => ({ ClimbListItemContent: () => null }));
vi.mock('../../../EndSessionSheet', () => ({
  EndSessionSheet: ({ isEnding, onConfirm }: { isEnding?: boolean; onConfirm?: () => void }) => {
    sheet.isEnding = isEnding ?? false;
    sheet.onConfirm = onConfirm ?? null;
    return null;
  },
}));
vi.mock('../../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
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
    brandColors: { success: '#0f0', warning: '#ff0' },
  }),
}));
vi.mock('../../../../providers/queue-provider', () => ({
  useQueueActions: () => ({ endSession: queue.endSession, setCurrentClimb: vi.fn() }),
  useQueueLiveStats: () => ({ liveStats: null, sessionUsers: [] }),
  useQueueSessionControls: () => ({
    driverParticipantId: null,
    participantId: 'participant-1',
    sessionId: 'session-1',
  }),
  useIsPartyPreviewOnly: () => false,
}));
vi.mock('../../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ openPlayDrawer: vi.fn() }) }));
vi.mock('../../../../lib/graphql/hooks', () => ({
  useSessionDetail: () => ({
    data: { totalSends: 0, totalFlashes: 0, gradeDistribution: [], participants: [], hardestGrade: null, ticks: [] },
  }),
  useSessionSummary: () => ({ data: { startedAt: '2026-01-01T00:00:00.000Z' } }),
}));
vi.mock('../../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
vi.mock('../../../../lib/integrations', () => ({
  runSessionEndExports: integrations.runSessionEndExports,
}));
vi.mock('../../../../lib/climb-to-queue-item', () => ({ climbToQueueItem: vi.fn() }));
vi.mock('../../../../lib/playlists/board-details-for-playlist', () => ({ getBoardConfigForPlaylist: () => null }));
vi.mock('../../../../lib/session-tick-mapping', () => ({ navigateToSessionClimb: vi.fn() }));
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
vi.mock('../../../../theme/tokens', () => ({ borderRadius: { lg: 16 }, spacing: { 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../../you/profile-chart-colors', () => ({ gradeBadgeColor: () => '#fff' }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../SessionAnalytics', () => ({ SessionAnalytics: () => null }));
vi.mock('../SessionLeaderboard', () => ({ SessionLeaderboard: () => null }));
vi.mock('../SessionPresenceRow', () => ({ SessionPresenceRow: () => null }));
vi.mock('../SessionSettingsSheet', () => ({
  SessionSettingsSheet: ({ visible }: { visible: boolean }) => {
    sessionSettingsSheet.visible = visible;
    return visible
      ? createElement(
          'div',
          { 'data-testid': 'session-settings-sheet' },
          createElement('div', { 'data-testid': 'rep-timer-settings-card' }),
        )
      : null;
  },
}));

import { InSessionView } from '../InSessionView';

describe('InSessionView footer', () => {
  beforeEach(() => {
    list.contentContainerStyle = null;
    bottomChrome.metrics = {
      fixedFooterBottom: 88,
      jsQueueReserve: 0,
      nativeAccessoryVisible: false,
      repTimerReserve: 0,
      tabBarBottom: 50,
    };
    theme.variant = 'liquidGlass';
    queue.endSession.mockReset();
    queue.endSession.mockResolvedValue(null);
    sheet.isEnding = false;
    sheet.onConfirm = null;
    sessionSettingsSheet.visible = false;
    integrations.runSessionEndExports.mockReset();
  });

  it('reserves only the bottom-chrome offset now that End moved to the top chrome', () => {
    render(createElement(InSessionView));

    // End no longer renders a bottom action bar, so the list reserves just the
    // safe-area inset (the native tab bar + climb accessory are already in it on the
    // Liquid Glass path) — no extra footer height.
    expect(list.contentContainerStyle?.paddingBottom).toBe(130);
  });

  it('adds the JS queue capsule reserve on Liquid Glass fallback devices', () => {
    bottomChrome.metrics = {
      fixedFooterBottom: 196,
      jsQueueReserve: 66,
      nativeAccessoryVisible: false,
      repTimerReserve: 0,
      tabBarBottom: 50,
    };

    render(createElement(InSessionView));

    // NativeTabs has already expanded the safe-area inset for the tab bar; the
    // fallback JS current-climb capsule is the only extra chrome to reserve.
    expect(list.contentContainerStyle?.paddingBottom).toBe(196);
  });

  it('adds the JS rep timer reserve above the native accessory on Liquid Glass', () => {
    bottomChrome.metrics = {
      fixedFooterBottom: 220,
      jsQueueReserve: 0,
      nativeAccessoryVisible: true,
      repTimerReserve: 60,
      tabBarBottom: 50,
    };

    render(createElement(InSessionView));

    expect(list.contentContainerStyle?.paddingBottom).toBe(190);
  });

  it('uses the fixed-footer reserve for the Material active-context bar', () => {
    theme.variant = 'material';
    bottomChrome.metrics = {
      fixedFooterBottom: 88,
      jsQueueReserve: 48,
      nativeAccessoryVisible: false,
      repTimerReserve: 0,
      tabBarBottom: 50,
    };

    render(createElement(InSessionView));

    expect(list.contentContainerStyle?.paddingBottom).toBe(88);
  });

  it('renders no in-session bottom action bar', () => {
    const { queryByTestId } = render(createElement(InSessionView));
    expect(queryByTestId('in-session-footer')).toBeNull();
  });

  it('opens rep timer settings from the active session settings sheet', () => {
    const overlay = render(createElement(InSessionView));
    expect(overlay.queryByTestId('open-session-settings')).toBeNull();
    expect(overlay.queryByTestId('rep-timer-settings-card')).toBeNull();
    overlay.unmount();

    const tab = render(createElement(InSessionView, { showChrome: true }));
    expect(tab.queryByTestId('rep-timer-settings-card')).toBeNull();

    fireEvent.click(tab.getByTestId('open-session-settings'));

    expect(sessionSettingsSheet.visible).toBe(true);
    expect(tab.queryByTestId('session-settings-sheet')).not.toBeNull();
    expect(tab.queryByTestId('rep-timer-settings-card')).not.toBeNull();
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
});
