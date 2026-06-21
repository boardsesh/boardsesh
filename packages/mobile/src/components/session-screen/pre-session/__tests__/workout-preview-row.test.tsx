// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { QueueItemRowBoard } from '../../../QueueItemRow';

// Each PressableSurface render lands here so the test can read the refresh
// button's disabled/accessibility state.
const surfaces = vi.hoisted(() => ({
  entries: [] as Array<{
    label?: string;
    disabled?: boolean;
    accessibilityState?: Record<string, unknown>;
    rippleBorderless?: boolean;
    style?: unknown;
  }>,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ActivityIndicator: () => createElement('span', { 'data-testid': 'refresh-spinner' }),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({
    accessibilityLabel,
    disabled,
    accessibilityState,
    rippleBorderless,
    style,
    children,
  }: {
    accessibilityLabel?: string;
    disabled?: boolean;
    accessibilityState?: Record<string, unknown>;
    rippleBorderless?: boolean;
    style?: unknown;
    children?: ReactNode;
  }) => {
    surfaces.entries.push({ label: accessibilityLabel, disabled, accessibilityState, rippleBorderless, style });
    return createElement('button', null, children);
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; formattedCount?: string }) => {
      if (key === 'sends') return `${options?.formattedCount ?? options?.count} sends`;
      if (key === 'playView.tickBar.starRating') return `${options?.count} stars`;
      return key;
    },
  }),
}));
vi.mock('../../../ClimbListItemContent', () => ({ ClimbListItemContent: () => null }));
vi.mock('../../../ClimbListThumbnail', () => ({ THUMBNAIL_WIDTH: 64 }));
vi.mock('../../../Icon', () => ({ Icon: () => createElement('span', { 'data-testid': 'refresh-icon' }) }));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ formatGrade: () => 'V4' }) }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: { primary: '#000' }, opacity: { disabled: 0.5 } }),
}));
vi.mock('../../../../theme/ios-colors', () => ({ iosSystemColors: {} }));
vi.mock('../../../../theme/tokens', () => ({ spacing: {} }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

import { WorkoutPreviewRow } from '../WorkoutPreviewRow';

const board = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 } as QueueItemRowBoard;
const item = {
  uuid: 'qi-1',
  climb: {
    uuid: 'c1',
    name: 'Test Climb',
    difficulty: '12',
    ascensionist_count: 12,
    quality_average: '4.2',
    setter_username: 'setter',
  },
} as unknown as ClimbQueueItem;

// The mocked `t` returns the key, so the refresh button surfaces under its key.
const REFRESH_LABEL = 'mobile.session.preRegenerateClimbForClimb';
const refreshButton = () => surfaces.entries.find((entry) => entry.label === REFRESH_LABEL);
const rowButton = () => surfaces.entries.find((entry) => entry.label?.startsWith(item.climb.name));
const flattenStyle = (style: unknown): Record<string, unknown> => {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
  }
  if (style && typeof style === 'object') return style as Record<string, unknown>;
  return {};
};

function renderRow(overrides: { isRefreshing: boolean; refreshDisabled: boolean; item?: ClimbQueueItem }) {
  return render(
    createElement(WorkoutPreviewRow, {
      item: overrides.item ?? item,
      board,
      isActive: false,
      onPress: vi.fn(),
      onRefresh: vi.fn(),
      ...overrides,
    }),
  );
}

beforeEach(() => {
  surfaces.entries = [];
});

describe('WorkoutPreviewRow refresh button', () => {
  it('lays out the climb content horizontally', () => {
    renderRow({ isRefreshing: false, refreshDisabled: false });
    expect(flattenStyle(rowButton()?.style)).toMatchObject({ flexDirection: 'row', alignItems: 'center' });
  });

  it('announces the visible climb details on the row action', () => {
    renderRow({ isRefreshing: false, refreshDisabled: false });
    expect(rowButton()?.label).toBe('Test Climb, V4, 12 sends, 4 stars, setter');
  });

  it('falls back safely when the climb payload is missing', () => {
    const missingClimbItem = { uuid: 'qi-missing' } as unknown as ClimbQueueItem;
    renderRow({ item: missingClimbItem, isRefreshing: false, refreshDisabled: false });
    expect(surfaces.entries[0]?.label).toBe('mobile.queue.unknownClimb');
  });

  it('is tappable when no row is regenerating', () => {
    renderRow({ isRefreshing: false, refreshDisabled: false });
    expect(refreshButton()?.disabled).toBe(false);
    expect(refreshButton()?.accessibilityState).toMatchObject({ disabled: false, busy: false });
    expect(refreshButton()?.rippleBorderless).toBe(true);
  });

  it('is disabled (and busy=false) while a different row regenerates', () => {
    const { getByTestId } = renderRow({ isRefreshing: false, refreshDisabled: true });
    expect(refreshButton()?.disabled).toBe(true);
    expect(refreshButton()?.accessibilityState).toMatchObject({ disabled: true, busy: false });
    // The dimmed, non-spinning state — the climb's own refresh icon stays put.
    expect(getByTestId('refresh-icon')).toBeTruthy();
  });

  it('shows a spinner and reports busy while this row regenerates', () => {
    const { getByTestId } = renderRow({ isRefreshing: true, refreshDisabled: false });
    expect(getByTestId('refresh-spinner')).toBeTruthy();
    expect(refreshButton()?.disabled).toBe(true);
    expect(refreshButton()?.accessibilityState).toMatchObject({ disabled: true, busy: true });
  });
});
