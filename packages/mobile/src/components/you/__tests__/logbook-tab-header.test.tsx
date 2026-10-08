// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOGBOOK_FILTERS, DEFAULT_LOGBOOK_SORT } from '@boardsesh/logbook';

const state = vi.hoisted(() => ({
  native: true,
  offline: false,
  pending: false,
  error: false,
  measure: undefined as ((height: number) => void) | undefined,
  listProps: undefined as
    | {
        contentContainerStyle: { paddingTop: number };
        scrollIndicatorInsets: { top: number };
        contentInsetAdjustmentBehavior: string;
      }
    | undefined,
}));

function flattenStyles(styles: unknown): Record<string, unknown> {
  return Object.assign({}, ...[styles].flat(10).filter(Boolean));
}

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ fontScale: 1 }),
  RefreshControl: () => null,
  StyleSheet: { create: (styles: unknown) => styles, flatten: flattenStyles, hairlineWidth: 1 },
  View: ({
    children,
    style,
    pointerEvents,
    accessibilityElementsHidden,
  }: {
    children?: ReactNode;
    style?: unknown;
    pointerEvents?: string;
    accessibilityElementsHidden?: boolean;
  }) =>
    createElement(
      'div',
      {
        'data-style': JSON.stringify(flattenStyles(style)),
        'data-pointer': pointerEvents,
        'data-accessibility-hidden': accessibilityElementsHidden,
      },
      children,
    ),
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: NonNullable<typeof state.listProps>) => {
    state.listProps = props;
    return createElement('div', { 'data-testid': 'results' });
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('../../../hooks/use-native-root-header', () => ({ useNativeRootHeader: () => state.native }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: 'material',
    systemColors: {},
    brandColors: {},
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 2: 8, 3: 12, 4: 16, 5: 20, 8: 32 },
  borderRadius: { full: 9999 },
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { black: '#000' } }));
vi.mock('../../../providers/feature-flags-provider', () => ({ useFeatureFlag: () => true }));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../hooks/use-offline-query-state', () => ({
  useOfflineQueryState: () => ({
    isBlocked: state.offline,
    reason: state.offline ? 'offline' : undefined,
  }),
}));
vi.mock('../../../providers/logbook-delete-provider', () => ({
  usePendingLogbookDeletes: () => new Set(),
  useLogbookDeleteActions: () => ({ getDeleteScope: vi.fn(), scheduleDelete: vi.fn() }),
}));
vi.mock('../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({}) }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: vi.fn() }));
vi.mock('../../../lib/tick-to-climb', () => ({ tickToClimb: vi.fn() }));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({ renderBoardToPlaylistConfig: vi.fn() }));
vi.mock('../../../lib/graphql/hooks', () => {
  const feed = () => ({
    data: undefined,
    isPending: state.pending,
    isError: state.error,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  });
  return { useGrades: () => ({}), useUserAscentsFeed: feed, useUserGroupedAscentsFeed: feed };
});
vi.mock('../use-logbook-search', () => ({
  useLogbookSearch: () => ({ filters: DEFAULT_LOGBOOK_FILTERS, sort: DEFAULT_LOGBOOK_SORT, name: '', hydrated: true }),
  countActiveLogbookFilters: () => 0,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
}));
vi.mock('../../SearchHeader', () => ({ SearchHeader: () => createElement('div', { 'data-testid': 'search' }) }));
vi.mock('../../search/FilterButton', () => ({
  FILTER_FAB_SIZE: 48,
  FilterButton: () => createElement('button', { 'data-testid': 'filters' }),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'loading' }),
}));
vi.mock('../../OfflineState', () => ({ OfflineState: () => createElement('div', { 'data-testid': 'offline' }) }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../LogbookRow', () => ({ LogbookRow: () => null }));
vi.mock('../LogbookDayDivider', () => ({ LogbookDayDivider: () => null, LogbookWallSubDivider: () => null }));
vi.mock('../LogbookEditSheet', () => ({ LogbookEditSheet: () => null }));
vi.mock('../LogbookEntryChooserSheet', () => ({ LogbookEntryChooserSheet: () => null }));
vi.mock('../LogbookFilterSheet', () => ({ LogbookFilterSheet: () => null }));
vi.mock('../BoardLinkPrompt', () => ({ BoardLinkPrompt: () => null }));
vi.mock('../LogbookChipRow', () => ({ LogbookChipRow: () => null }));
vi.mock('../LogbookFacetRail', () => ({ LogbookFacetRail: () => null }));

import { LogbookTab } from '../LogbookTab';

function renderHeader(controls: ReactNode, onHeightChange: (height: number) => void) {
  state.measure = onHeightChange;
  return createElement('div', { 'data-testid': 'composed-header' }, controls);
}

beforeEach(() => {
  state.native = true;
  state.offline = false;
  state.pending = false;
  state.error = false;
  state.listProps = undefined;
  state.measure = undefined;
});
afterEach(cleanup);

describe('Logbook composed profile header', () => {
  it('keeps native results mounted invisibly until measurement and counts supplementary height once', () => {
    const { getByTestId } = render(<LogbookTab userId="me" renderHeader={renderHeader} />);
    const resultsFrame = getByTestId('results').parentElement!;
    expect(resultsFrame.dataset.style).toContain('"opacity":0');
    expect(resultsFrame.dataset.pointer).toBe('none');
    expect(resultsFrame.dataset.accessibilityHidden).toBe('true');
    expect(state.listProps?.contentInsetAdjustmentBehavior).toBe('automatic');
    expect(getByTestId('results').compareDocumentPosition(getByTestId('composed-header'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    act(() => state.measure?.(180));
    expect(resultsFrame.dataset.style).not.toContain('"opacity":0');
    expect(resultsFrame.dataset.pointer).toBe('auto');
    expect(state.listProps?.contentContainerStyle.paddingTop).toBe(180);
    expect(state.listProps?.scrollIndicatorInsets.top).toBe(180);
    expect(resultsFrame.dataset.style).not.toContain('"paddingTop"');

    // An expanded facet rail contributes to the same measurement, not a second inset.
    act(() => state.measure?.(260));
    expect(state.listProps?.contentContainerStyle.paddingTop).toBe(260);
    expect(state.listProps?.scrollIndicatorInsets.top).toBe(260);
  });

  it('starts Material results below the entire opaque measured header', () => {
    state.native = false;
    const { getByTestId } = render(<LogbookTab userId="me" renderHeader={renderHeader} />);
    act(() => state.measure?.(280));
    expect(getByTestId('results').parentElement!.dataset.style).toContain('"paddingTop":280');
    expect(getByTestId('results').parentElement!.dataset.style).toContain('"overflow":"hidden"');
    expect(state.listProps?.contentContainerStyle.paddingTop).toBe(0);
    expect(state.listProps?.contentInsetAdjustmentBehavior).toBe('never');
  });

  it('leaves public profile controls in flow without adding supplementary padding', () => {
    const { getByTestId, queryByTestId } = render(<LogbookTab userId="other" viewerIsOwner={false} topInset={24} />);
    expect(queryByTestId('composed-header')).toBeNull();
    expect(getByTestId('search').compareDocumentPosition(getByTestId('results'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(state.listProps?.contentContainerStyle.paddingTop).toBe(0);
    expect(getByTestId('results').parentElement!.dataset.pointer).toBe('auto');
  });

  it.each(['missing-user', 'loading', 'error', 'offline'] as const)(
    'retains tabs and controls in the %s state',
    (status) => {
      state.pending = status === 'loading';
      state.error = status === 'error';
      state.offline = status === 'offline';
      const { getByTestId, queryByTestId } = render(
        <LogbookTab userId={status === 'missing-user' ? undefined : 'me'} renderHeader={renderHeader} />,
      );
      expect(getByTestId('composed-header').contains(getByTestId('search'))).toBe(true);
      expect(getByTestId('composed-header').contains(getByTestId('filters'))).toBe(true);
      expect(queryByTestId('results')).toBeNull();
      act(() => state.measure?.(180));
      expect(getByTestId('composed-header')).toBeTruthy();
    },
  );
});
