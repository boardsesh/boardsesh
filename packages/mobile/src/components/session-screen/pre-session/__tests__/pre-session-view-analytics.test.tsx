// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratorSelection } from '../GeneratorPickerCard';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));

const queue = vi.hoisted(() => ({
  startSession: vi.fn(async () => 'session-1' as string | null),
  setQueue: vi.fn(),
}));

const drawer = vi.hoisted(() => ({ openPlayDrawer: vi.fn() }));

const activeBoard = vi.hoisted(() => ({
  data: { boardType: 'kilter', layoutId: 8, sizeId: 21, setIds: '1,2', angle: 40 } as {
    boardType: string;
    layoutId: number;
    sizeId: number;
    setIds: string;
    angle: number;
  } | null,
}));

// The preview hook is mocked so the test controls the queued/planned counts. The
// generator-on Start path reads `toQueueItems()` (queued) and `plannedCount`.
const previewItems = vi.hoisted(() => [
  { uuid: 'c1', climb: { uuid: 'x' } },
  { uuid: 'c2', climb: { uuid: 'y' } },
]);
const previewRows = vi.hoisted(() =>
  previewItems.map((item, index) => ({
    item,
    slot: { grade: 10, section: 'main', index },
  })),
);
const preview = vi.hoisted(() => ({
  result: {
    items: previewRows as unknown[],
    status: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
    refreshingUuids: new Set<string>(),
    plannedCount: 3,
    plannedSlots: previewRows.map((preview) => preview.slot),
    regenerate: vi.fn(),
    refreshSlot: vi.fn(),
    toQueueItems: () => previewItems,
  },
}));

// Surfaces GeneratorPickerCard's onChange so the test can flip the generator on.
const picker = vi.hoisted(() => ({ onChange: null as ((selection: GeneratorSelection) => void) | null }));
// Surfaces the Start button's onPress.
const startButton = vi.hoisted(() => ({ onPress: null as (() => void) | null }));

vi.mock('../../../../lib/analytics', () => ({ track: analytics.track }));

// Platform + PlatformColor are included so this mock is leak-safe for theme/
// colors.ts if the shared module runner evaluates it under this mock.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

vi.mock('react-native-gesture-handler', () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-reanimated', () => ({
  useSharedValue: (value: number) => ({ value }),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListHeaderComponent,
  }: {
    data?: unknown[];
    renderItem?: (info: { item: unknown; index: number }) => ReactNode;
    ListHeaderComponent?: ReactNode;
  }) =>
    createElement(
      'div',
      null,
      ListHeaderComponent,
      ...(data ?? []).map((rowItem, index) =>
        createElement('div', { key: index }, renderItem?.({ item: rowItem, index })),
      ),
    ),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/board-config', () => ({ toBoardName: (boardType: string) => boardType }));
vi.mock('../../../Button', () => ({
  Button: ({ onPress }: { onPress?: () => void }) => {
    startButton.onPress = onPress ?? null;
    return createElement('button');
  },
}));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../GlassSurface', () => ({ GlassSurface: () => null }));
vi.mock('../../../SectionHeader', () => ({ SectionHeader: () => null }));
vi.mock('../../RecordTopChrome', () => ({ RecordTopChrome: () => null }));
vi.mock('../../SessionStartFab', () => ({
  SESSION_START_FAB_HEIGHT: 60,
  SessionStartFab: ({ onPress }: { onPress?: () => void }) => {
    startButton.onPress = onPress ?? null;
    return null;
  },
}));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, features: { inBodyLargeTitle: false, filtersInTopChrome: false } }),
}));
vi.mock('../../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => activeBoard }));
vi.mock('../../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../../providers/queue-provider', () => ({
  useQueueActions: () => ({ startSession: queue.startSession, setQueue: queue.setQueue }),
}));
vi.mock('../../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: drawer.openPlayDrawer }),
}));
vi.mock('../../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({
    insideTabs: true,
    scrollBottomPadding: 0,
    tabBarBottom: 0,
    tabBarHeight: 0,
    fixedFooterBottom: 0,
  }),
}));
vi.mock('../../../../hooks/use-native-glass', () => ({ useNativeGlass: () => false }));
vi.mock('../../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16 }, borderRadius: { lg: 16 } }));
vi.mock('../BoardSummaryCard', () => ({ BoardSummaryCard: () => null }));
vi.mock('../WorkoutPreviewRow', () => ({ WorkoutPreviewRow: () => null }));
vi.mock('../use-workout-preview', () => ({ useWorkoutPreview: () => preview.result }));
vi.mock('../GeneratorPickerCard', () => ({
  GeneratorPickerCard: ({ onChange }: { onChange: (selection: GeneratorSelection) => void }) => {
    picker.onChange = onChange;
    return null;
  },
}));

import { PreSessionView } from '../PreSessionView';

beforeEach(() => {
  analytics.track.mockClear();
  queue.startSession.mockClear();
  queue.startSession.mockResolvedValue('session-1');
  queue.setQueue.mockClear();
  activeBoard.data = { boardType: 'kilter', layoutId: 8, sizeId: 21, setIds: '1,2', angle: 40 };
  preview.result.items = previewRows as unknown[];
  preview.result.status = 'ready';
  preview.result.refreshingUuids = new Set<string>();
  preview.result.plannedSlots = previewRows.map((preview) => preview.slot);
  picker.onChange = null;
  startButton.onPress = null;
});

describe('PreSessionView analytics', () => {
  it('replaces the queue and fires "Session Queue Generated" with the queued/failed counts when starting with the generator on', async () => {
    render(createElement(PreSessionView));

    // Flip the generator on so handleStart takes the generate branch.
    act(() => {
      picker.onChange?.({
        type: 'on',
        options: {
          type: 'volume',
          targetGrade: 10,
          warmUp: 'none',
          mainSetClimbs: 20,
          mainSetVariability: 0,
          minAscents: 0,
          minRating: 0,
          onlyTallClimbs: false,
          onlyWideClimbs: false,
          climbBias: 'any',
        },
      });
    });

    await act(async () => {
      startButton.onPress?.();
      // Let the async handleStart chain (startSession → setQueue → track) settle.
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(analytics.track).toHaveBeenCalledWith('Session Queue Generated', {
        workoutType: 'volume',
        boardName: 'kilter',
        angle: 40,
        // 2 climbs queued out of a 3-slot plan → 1 short.
        savedCount: 2,
        failedCount: 1,
      }),
    );

    // Queue replaced with the preview items, first climb set current.
    expect(queue.setQueue).toHaveBeenCalledTimes(1);
    expect(queue.setQueue).toHaveBeenCalledWith(previewItems, previewItems[0]);
    expect(analytics.track).toHaveBeenCalledWith('Session Queue Generated', {
      workoutType: 'volume',
      boardName: 'kilter',
      angle: 40,
      // 2 climbs queued out of a 3-slot plan → 1 short.
      savedCount: 2,
      failedCount: 1,
    });
  });

  it('does not replace the queue or fire when the generator is off', async () => {
    render(createElement(PreSessionView));

    await act(async () => {
      startButton.onPress?.();
    });
    await waitFor(() => expect(queue.startSession).toHaveBeenCalled());

    expect(queue.setQueue).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalledWith('Session Queue Generated', expect.anything());
  });

  it('does not start a generated session while the preview is still loading', async () => {
    preview.result.status = 'loading';
    render(createElement(PreSessionView));

    act(() => {
      picker.onChange?.({
        type: 'on',
        options: {
          type: 'volume',
          targetGrade: 10,
          warmUp: 'none',
          mainSetClimbs: 20,
          mainSetVariability: 0,
          minAscents: 0,
          minRating: 0,
          onlyTallClimbs: false,
          onlyWideClimbs: false,
          climbBias: 'any',
        },
      });
    });

    await act(async () => {
      startButton.onPress?.();
      await Promise.resolve();
    });

    expect(queue.startSession).not.toHaveBeenCalled();
    expect(queue.setQueue).not.toHaveBeenCalled();
  });
});
