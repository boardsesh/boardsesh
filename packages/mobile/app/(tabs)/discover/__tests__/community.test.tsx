// @vitest-environment jsdom
vi.mock('../../../../src/components/PressableSurface', async () => {
  const { createElement } = await import('react');
  return {
    PressableSurface: ({
      children,
      onPress,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      accessibilityLabel?: string;
    }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  };
});
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { CommunityPlaylistsInput, UseCommunityPlaylistsOptions } from '@boardsesh/playlists-react';

type PlaylistItem = {
  uuid: string;
  name: string;
  climbCount: number;
  creatorName: string;
  boardType?: string;
  gradeSummary?: { gradedClimbCount: number; p10Difficulty: number; p90Difficulty: number } | null;
};
type GradeBoundArg = { minGradeId: number | undefined; maxGradeId: number | undefined };

const hook = vi.hoisted(() => ({
  playlists: [] as PlaylistItem[],
  totalCount: 0,
  isLoading: false,
  isLoadingMore: false,
  hasMore: false,
  hasError: false,
  hasLoadMoreError: false,
  loadMore: vi.fn(),
  retryLoadMore: vi.fn(),
  refetch: vi.fn(),
}));
const hookCalls = vi.hoisted(() => ({ options: [] as UseCommunityPlaylistsOptions[] }));
const viewer = vi.hoisted(() => ({
  isAuthenticated: true,
  profileId: 'me' as string | null,
  profileLoading: false,
  profileFetching: false,
  boardLoading: false,
  boardType: 'kilter',
  // Pending like a real in-flight refetch, so the pull spinner has something to wait on.
  refetchProfile: vi.fn(() => new Promise<void>(() => {})),
}));

// Keep the real filter mapping; only the network hook is stubbed, so the test
// sees exactly the server input each filter state produces.
vi.mock('@boardsesh/playlists-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/playlists-react')>()),
  useCommunityPlaylists: (options: UseCommunityPlaylistsOptions) => {
    hookCalls.options.push(options);
    return hook;
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Params are echoed so assertions see what was interpolated, not just the key.
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  RefreshControl: ({ refreshing, onRefresh }: { refreshing?: boolean; onRefresh?: () => void }) =>
    createElement('button', { 'data-refresh-control': String(!!refreshing), onClick: onRefresh }, 'pull-to-refresh'),
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
  Platform: { OS: 'ios' },
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListEmptyComponent,
    ListFooterComponent,
    refreshControl,
    onEndReached,
  }: {
    data?: PlaylistItem[];
    renderItem: (info: { item: PlaylistItem; index: number }) => ReactNode;
    ListEmptyComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    refreshControl?: ReactNode;
    onEndReached?: () => void;
  }) =>
    createElement(
      'div',
      { 'data-list': 'true' },
      refreshControl,
      data && data.length > 0
        ? data.map((item, index) => createElement('div', { key: item.uuid }, renderItem({ item, index })))
        : ListEmptyComponent,
      ListFooterComponent,
      createElement('button', { 'aria-label': 'end-reached', onClick: onEndReached }, 'end'),
    ),
}));

vi.mock('../../../../src/theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 10: 40, 16: 64 },
}));
vi.mock('../../../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: '#fff', secondaryLabel: '#666', tertiaryLabel: '#999', tertiaryFill: '#eee' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: viewer.isAuthenticated, isLoading: false }),
}));
vi.mock('../../../../src/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ gradeFormat: 'v-grade' }),
}));
// The rail is exercised in its own tests; here it is two buttons that set a band or clear it.
vi.mock('../../../../src/components/grade', () => ({
  GradeRangeRail: ({ bound, onChange }: { bound: GradeBoundArg; onChange: (next: GradeBoundArg) => void }) =>
    createElement(
      'div',
      { 'data-grade-rail': `${bound.minGradeId ?? ''}-${bound.maxGradeId ?? ''}` },
      createElement(
        'button',
        { 'aria-label': 'rail-pick-v3-v5', onClick: () => onChange({ minGradeId: 16, maxGradeId: 20 }) },
        'pick',
      ),
      createElement(
        'button',
        { 'aria-label': 'rail-any', onClick: () => onChange({ minGradeId: undefined, maxGradeId: undefined }) },
        'any',
      ),
    ),
}));
vi.mock('../../../../src/lib/graphql/hooks', () => ({
  useGrades: (boardName: string) => ({ data: boardName ? [{ difficultyId: 16, name: '6a/V3' }] : undefined }),
  useProfile: () => ({
    data: viewer.profileId ? { id: viewer.profileId } : undefined,
    isLoading: viewer.profileLoading,
    isFetching: viewer.profileFetching,
    refetch: viewer.refetchProfile,
  }),
}));
vi.mock('../../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({
    data: viewer.boardLoading ? undefined : { boardType: viewer.boardType, layoutId: 8 },
    isLoading: viewer.boardLoading,
  }),
}));
vi.mock('../../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../../src/components/ReadableColumn', () => ({
  ReadableColumn: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../src/components/Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));
vi.mock('../../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));
vi.mock('../../../../src/components/SearchField', () => ({
  SearchField: ({
    value,
    onChangeText,
    placeholder,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    placeholder: string;
  }) =>
    createElement('input', {
      value,
      'aria-label': placeholder,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
}));
// One button per segment, labelled "<group>:<key>", with the selected one marked.
vi.mock('../../../../src/components/SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    selectedKey,
    onSelect,
    accessibilityLabel,
  }: {
    options: { key: string; label: string }[];
    selectedKey: string;
    onSelect: (key: string) => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'div',
      { 'data-segmented': accessibilityLabel },
      options.map((option) =>
        createElement(
          'button',
          {
            key: option.key,
            'aria-label': `${accessibilityLabel}:${option.key}`,
            'aria-pressed': option.key === selectedKey,
            onClick: () => onSelect(option.key),
          },
          option.label,
        ),
      ),
    ),
}));
vi.mock('../../../../src/components/playlist', () => ({
  PlaylistListRow: ({ name, meta, gradeLabel }: { name: string; meta?: string; gradeLabel?: string | null }) =>
    createElement('div', { 'data-playlist-row': name, 'data-grade': gradeLabel ?? '' }, meta),
  PlaylistListRowSeparator: () => createElement('div', null),
}));

import CommunityPlaylistsScreen from '../community';

function lastInput(): CommunityPlaylistsInput {
  const options = hookCalls.options.at(-1);
  if (!options) throw new Error('useCommunityPlaylists was not called');
  return options.input;
}

beforeEach(() => {
  hook.playlists = [];
  hook.totalCount = 0;
  hook.isLoading = false;
  hook.isLoadingMore = false;
  hook.hasMore = false;
  hook.hasError = false;
  hook.hasLoadMoreError = false;
  hook.loadMore.mockClear();
  hook.retryLoadMore.mockClear();
  hook.refetch.mockClear();
  hookCalls.options = [];
  viewer.isAuthenticated = true;
  viewer.profileId = 'me';
  viewer.boardLoading = false;
  viewer.boardType = 'kilter';
  viewer.profileLoading = false;
  viewer.profileFetching = false;
  viewer.refetchProfile.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CommunityPlaylistsScreen filters', () => {
  it('starts on popular, board-scoped, community-made, without the viewer', () => {
    render(<CommunityPlaylistsScreen />);
    expect(lastInput()).toEqual({
      boardType: 'kilter',
      layoutId: 8,
      generatedRecommendation: false,
      sortBy: 'popular',
      excludeCreatorIds: ['me'],
      maxClimbs: 150,
    });
    expect(hookCalls.options.at(-1)?.enabled).toBe(true);
  });

  it('maps made-by, sort and size taps onto the server input', () => {
    hook.playlists = [{ uuid: 'a', name: 'A', climbCount: 1, creatorName: 'Jess' }];
    const { getByLabelText, getByText } = render(<CommunityPlaylistsScreen />);

    fireEvent.click(getByLabelText('library.community.madeByLabel:mine'));
    expect(lastInput()).toMatchObject({ creatorIds: ['me'] });
    expect(lastInput()).not.toHaveProperty('excludeCreatorIds');

    fireEvent.click(getByLabelText('library.community.sortLabel:recent'));
    expect(lastInput().sortBy).toBe('recent');

    fireEvent.click(getByLabelText('library.community.sizeLabel:session'));
    expect(lastInput()).toMatchObject({ minClimbs: 11, maxClimbs: 30 });
    // The summary states the same band the query sends.
    expect(getByText('library.community.sizeBand.range:{"min":11,"max":30}', { exact: false })).toBeTruthy();

    // Big is capped at the community maximum, and its copy says so.
    fireEvent.click(getByLabelText('library.community.sizeLabel:big'));
    expect(lastInput()).toMatchObject({ minClimbs: 31, maxClimbs: 150 });
    expect(getByText('library.community.sizeBand.range:{"min":31,"max":150}', { exact: false })).toBeTruthy();
  });

  it('drops a grade band picked on another board, and brings it back with that board', () => {
    const { getByLabelText, rerender } = render(<CommunityPlaylistsScreen />);
    fireEvent.click(
      getByLabelText(`library.community.gradeA11y:${JSON.stringify({ band: 'library.community.gradeAny' })}`),
    );
    fireEvent.click(getByLabelText('rail-pick-v3-v5'));
    expect(lastInput()).toMatchObject({ minGrade: 16, maxGrade: 20 });

    viewer.boardType = 'moonboard';
    rerender(<CommunityPlaylistsScreen />);
    expect(lastInput().boardType).toBe('moonboard');
    expect(lastInput()).not.toHaveProperty('minGrade');
    expect(lastInput()).not.toHaveProperty('maxGrade');
    expect(
      getByLabelText(`library.community.gradeA11y:${JSON.stringify({ band: 'library.community.gradeAny' })}`),
    ).toBeTruthy();

    viewer.boardType = 'kilter';
    rerender(<CommunityPlaylistsScreen />);
    expect(lastInput()).toMatchObject({ minGrade: 16, maxGrade: 20 });
  });

  it('asks the server for followed creators when Following is picked', () => {
    const { getByLabelText } = render(<CommunityPlaylistsScreen />);
    fireEvent.click(getByLabelText('library.community.madeByLabel:following'));
    expect(lastInput().followedOnly).toBe(true);
    expect(lastInput()).not.toHaveProperty('excludeCreatorIds');
    expect(lastInput()).not.toHaveProperty('creatorIds');
  });

  it('opens the grade rail from its chip and sends the picked band', () => {
    const { getByLabelText, queryByLabelText, container } = render(<CommunityPlaylistsScreen />);
    const chipLabel = (band: string) => `library.community.gradeA11y:${JSON.stringify({ band })}`;
    expect(container.querySelector('[data-grade-rail]')).toBeNull();

    fireEvent.click(getByLabelText(chipLabel('library.community.gradeAny')));
    fireEvent.click(getByLabelText('rail-pick-v3-v5'));
    expect(lastInput()).toMatchObject({ minGrade: 16, maxGrade: 20 });
    // The chip names the band it applied.
    expect(getByLabelText(chipLabel('V3\u2013V5'))).toBeTruthy();

    fireEvent.click(getByLabelText('rail-any'));
    expect(lastInput()).not.toHaveProperty('minGrade');
    expect(lastInput()).not.toHaveProperty('maxGrade');

    fireEvent.click(getByLabelText(chipLabel('library.community.gradeAny')));
    expect(queryByLabelText('rail-pick-v3-v5')).toBeNull();
  });

  it('debounces the search before it reaches the server input', () => {
    vi.useFakeTimers();
    const { getByLabelText } = render(<CommunityPlaylistsScreen />);

    fireEvent.change(getByLabelText('library.community.searchPlaceholder'), { target: { value: 'crimp' } });
    expect(lastInput()).not.toHaveProperty('name');

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(lastInput().name).toBe('crimp');
  });

  it('hides the made-by control for a signed-out climber', () => {
    viewer.isAuthenticated = false;
    viewer.profileId = null;
    const { queryByLabelText } = render(<CommunityPlaylistsScreen />);
    expect(hookCalls.options.at(-1)?.enabled).toBe(true);
    expect(queryByLabelText('library.community.madeByLabel:mine')).toBeNull();
    expect(lastInput()).not.toHaveProperty('excludeCreatorIds');
  });
});

describe('CommunityPlaylistsScreen states', () => {
  it('shows rows with the creator byline and the result count', () => {
    hook.playlists = [{ uuid: 'a', name: 'Crimp city', climbCount: 12, creatorName: 'Jess' }];
    hook.totalCount = 1;
    const { getByText, container } = render(<CommunityPlaylistsScreen />);

    expect(container.querySelector('[data-playlist-row="Crimp city"]')?.textContent).toBe(
      'library.communityByline:' +
        JSON.stringify({ creatorName: 'Jess', climbCount: 'detail.climbCount:{"count":12}' }),
    );
    expect(getByText('library.community.resultCount:{"count":1}')).toBeTruthy();
  });

  it("shows each row's grade band, and none for a playlist without graded climbs", () => {
    hook.playlists = [
      {
        uuid: 'a',
        name: 'Graded',
        climbCount: 12,
        creatorName: 'Jess',
        boardType: 'kilter',
        gradeSummary: { gradedClimbCount: 12, p10Difficulty: 16, p90Difficulty: 20 },
      },
      { uuid: 'b', name: 'Ungraded', climbCount: 3, creatorName: 'Sam', boardType: 'kilter', gradeSummary: null },
    ];
    const { container } = render(<CommunityPlaylistsScreen />);
    expect(container.querySelector('[data-playlist-row="Graded"]')?.getAttribute('data-grade')).toBe('V3\u2013V5');
    expect(container.querySelector('[data-playlist-row="Ungraded"]')?.getAttribute('data-grade')).toBe('');
  });

  it('says the crew has nothing yet when Following alone comes back empty', () => {
    const { getByLabelText, getByText, queryByText } = render(<CommunityPlaylistsScreen />);
    fireEvent.click(getByLabelText('library.community.madeByLabel:following'));
    expect(getByText('library.community.emptyFollowing.title')).toBeTruthy();
    expect(queryByText('library.community.noMatches.title')).toBeNull();

    // Narrowed further, the climber can loosen a filter instead.
    fireEvent.click(getByLabelText('library.community.sizeLabel:short'));
    expect(getByText('library.community.noMatches.title')).toBeTruthy();
    expect(queryByText('library.community.emptyFollowing.title')).toBeNull();
  });

  it('loads one more page on end-reach only while there is more', () => {
    hook.playlists = [{ uuid: 'a', name: 'A', climbCount: 1, creatorName: 'Jess' }];
    hook.hasMore = true;
    const { getByLabelText, rerender } = render(<CommunityPlaylistsScreen />);
    fireEvent.click(getByLabelText('end-reached'));
    expect(hook.loadMore).toHaveBeenCalledTimes(1);

    hook.hasMore = false;
    rerender(<CommunityPlaylistsScreen />);
    fireEvent.click(getByLabelText('end-reached'));
    expect(hook.loadMore).toHaveBeenCalledTimes(1);
  });

  it('offers Clear filters when the filters match nothing, and keeps the sort', () => {
    const { getByLabelText, getByText } = render(<CommunityPlaylistsScreen />);
    fireEvent.click(getByLabelText('library.community.sortLabel:recent'));
    fireEvent.click(getByLabelText('library.community.sizeLabel:big'));

    expect(getByText('library.community.noMatches.title')).toBeTruthy();
    fireEvent.click(getByLabelText('library.community.noMatches.clearFilters'));

    expect(lastInput()).not.toHaveProperty('minClimbs');
    expect(lastInput().sortBy).toBe('recent');
  });

  it('shows the plain empty state when nothing is filtered', () => {
    const { getByText, queryByText } = render(<CommunityPlaylistsScreen />);
    expect(getByText('library.community.empty.title')).toBeTruthy();
    expect(queryByText('library.community.noMatches.clearFilters')).toBeNull();
  });

  it('shows a spinner, not an empty state, while the first page loads', () => {
    hook.isLoading = true;
    const { container, queryByText } = render(<CommunityPlaylistsScreen />);
    expect(container.querySelector('[data-spinner="true"]')).not.toBeNull();
    expect(queryByText('library.community.empty.title')).toBeNull();
  });

  it('shows a spinner, not an empty state, while the board is still loading', () => {
    viewer.boardLoading = true;
    const { container, queryByText } = render(<CommunityPlaylistsScreen />);
    expect(hookCalls.options.at(-1)?.enabled).toBe(false);
    expect(container.querySelector('[data-spinner="true"]')).not.toBeNull();
    expect(queryByText('library.community.empty.title')).toBeNull();
    expect(queryByText('library.community.resultCount:{"count":0}')).toBeNull();
    // No board yet, so no grade scale: the Grade chip waits for one.
    expect(queryByText('library.community.gradeLabel')).toBeNull();
  });

  it('waits for the profile before fetching, showing a spinner meanwhile', () => {
    viewer.profileId = null;
    viewer.profileLoading = true;
    const { container, queryByText } = render(<CommunityPlaylistsScreen />);
    expect(hookCalls.options.at(-1)?.enabled).toBe(false);
    expect(container.querySelector('[data-spinner="true"]')).not.toBeNull();
    expect(queryByText('library.community.empty.title')).toBeNull();
  });

  it('shows an error, not everyone including the viewer, when the profile fails', () => {
    viewer.profileId = null;
    const { getByText, getByLabelText } = render(<CommunityPlaylistsScreen />);
    expect(hookCalls.options.at(-1)?.enabled).toBe(false);
    expect(getByText('library.community.errors.loadTitle')).toBeTruthy();
    fireEvent.click(getByLabelText('library.errors.tryAgain'));
    expect(viewer.refetchProfile).toHaveBeenCalledTimes(1);
    expect(hook.refetch).not.toHaveBeenCalled();
  });

  it('retries the profile on a pull and spins while it refetches', async () => {
    viewer.profileId = null;
    const { container, rerender, queryByText } = render(<CommunityPlaylistsScreen />);
    const refreshState = () => container.querySelector('[data-refresh-control]')?.getAttribute('data-refresh-control');
    await act(async () => {
      fireEvent.click(container.querySelector('[data-refresh-control]') as HTMLElement);
    });
    expect(viewer.refetchProfile).toHaveBeenCalledTimes(1);
    expect(hook.refetch).not.toHaveBeenCalled();
    // The pull spinner waits on the profile request, not just one microtask.
    expect(refreshState()).toBe('true');

    viewer.profileFetching = true;
    rerender(<CommunityPlaylistsScreen />);
    expect(refreshState()).toBe('true');
    expect(queryByText('library.community.errors.loadTitle')).toBeNull();
    expect(container.querySelector('[data-spinner="true"]')).not.toBeNull();
  });

  it('keeps the rows and offers a retry when a refresh fails', () => {
    hook.playlists = [{ uuid: 'a', name: 'A', climbCount: 1, creatorName: 'Jess' }];
    hook.hasError = true;
    const { getByLabelText, container } = render(<CommunityPlaylistsScreen />);
    expect(container.querySelector('[data-playlist-row="A"]')).not.toBeNull();
    fireEvent.click(getByLabelText('library.community.errors.loadTitle library.errors.tryAgain'));
    expect(hook.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows a footer spinner while the footer retry reloads', () => {
    hook.playlists = [{ uuid: 'a', name: 'A', climbCount: 1, creatorName: 'Jess' }];
    hook.hasError = true;
    hook.isLoading = true;
    const { container, queryByLabelText } = render(<CommunityPlaylistsScreen />);
    expect(queryByLabelText('library.community.errors.loadTitle library.errors.tryAgain')).toBeNull();
    expect(container.querySelector('[data-spinner="true"]')).not.toBeNull();
  });

  it('retries a failed first page', () => {
    hook.hasError = true;
    const { getByText, getByLabelText } = render(<CommunityPlaylistsScreen />);
    expect(getByText('library.community.errors.loadTitle')).toBeTruthy();
    fireEvent.click(getByLabelText('library.errors.tryAgain'));
    expect(hook.refetch).toHaveBeenCalledTimes(1);
  });

  it('retries background pagination from the footer', () => {
    hook.playlists = [{ uuid: 'a', name: 'A', climbCount: 1, creatorName: 'Jess' }];
    hook.hasLoadMoreError = true;
    const { getByLabelText } = render(<CommunityPlaylistsScreen />);
    fireEvent.click(getByLabelText('library.community.loadMoreError library.errors.tryAgain'));
    expect(hook.retryLoadMore).toHaveBeenCalledTimes(1);
  });
});
