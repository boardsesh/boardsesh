// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Climb } from '@boardsesh/shared-schema';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';

const playlistContext = vi.hoisted(() => ({
  playlists: [] as Playlist[],
  addToPlaylist: vi.fn(),
  removeFromPlaylist: vi.fn(),
  createPlaylist: vi.fn(),
  isLoading: false,
  isAuthenticated: true,
}));
const requestMock = vi.hoisted(() => vi.fn());
const seeded = vi.hoisted(() => ({ members: new Set<string>() }));
const membershipStore = vi.hoisted(() => ({ setMembershipForClimb: vi.fn() }));
const showToast = vi.hoisted(() => vi.fn());
const reportHandledError = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  FlatList: ({
    data,
    renderItem,
    keyExtractor,
    ListHeaderComponent,
    ListEmptyComponent,
  }: {
    data?: readonly Playlist[];
    renderItem?: (info: { item: Playlist; index: number }) => ReactNode;
    keyExtractor?: (item: Playlist, index: number) => string;
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
  }) =>
    createElement(
      'div',
      null,
      ListHeaderComponent,
      data && data.length > 0
        ? data.map((item, index) =>
            createElement(
              'div',
              { key: keyExtractor ? keyExtractor(item, index) : index },
              renderItem?.({ item, index }),
            ),
          )
        : ListEmptyComponent,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError }));
vi.mock('@boardsesh/graphql/operations/playlists', () => ({ GET_PLAYLISTS_FOR_CLIMB: 'GET_PLAYLISTS_FOR_CLIMB' }));
vi.mock('@boardsesh/climb-actions', () => ({ playlistMembershipStore: membershipStore }));
vi.mock('../../../hooks/use-climb-playlist-memberships', () => ({
  useClimbPlaylistMemberships: () => seeded.members,
}));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: requestMock }) }));
vi.mock('../../../providers/playlists-provider', () => ({ usePlaylistsContext: () => playlistContext }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primary: '#6D28D9' },
    systemColors: {
      accent: '#6D28D9',
      fill: '#eeeeee',
      label: '#000',
      secondaryLabel: '#555',
      tertiaryLabel: '#999',
      separator: '#ccc',
    },
  }),
}));
vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { white: '#fff', systemRed: '#f00', systemGray: '#8E8E93' },
}));
vi.mock('../../../theme/tokens', () => ({
  borderRadius: { full: 9999, md: 8 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 10: 40 },
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../ListRow', () => ({
  ListRow: ({
    title,
    onPress,
    trailing,
    accessibilityHint,
  }: {
    title: string;
    onPress?: () => void;
    trailing?: ReactNode;
    accessibilityHint?: string;
  }) =>
    onPress
      ? createElement(
          'button',
          { onClick: onPress, 'aria-label': title, 'data-hint': accessibilityHint },
          title,
          trailing,
        )
      : createElement(
          'div',
          { 'aria-label': title, 'data-row': title, 'data-hint': accessibilityHint },
          title,
          trailing,
        ),
}));

import { InlinePlaylistPicker } from '../InlinePlaylistPicker';

const basePlaylist = {
  id: 'p-1',
  uuid: 'p-1',
  name: 'Hard Crimps',
  climbCount: 3,
  isPublic: false,
  boardType: 'kilter',
  layoutId: 1,
  followerCount: 0,
  isFollowedByMe: false,
  isPinnedByMe: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} satisfies Playlist;

function makePlaylist(uuid: string, boardType: string, layoutId: number): Playlist {
  return { ...basePlaylist, id: uuid, uuid, name: `${boardType} target`, boardType, layoutId };
}

const baseClimb = {
  uuid: 'climb-1',
  name: 'Big Move',
  frames: '',
  angle: 40,
  boardType: 'kilter',
  layoutId: 1,
} as Climb;

function NameInput(props: { value?: string; onChangeText?: (text: string) => void }) {
  return createElement('input', {
    'aria-label': 'name-input',
    value: props.value ?? '',
    onChange: (event: { target: { value: string } }) => props.onChangeText?.(event.target.value),
  });
}

let queryClient: QueryClient;

function renderPicker(options?: {
  climb?: Climb;
  angle?: number;
  boardName?: 'kilter' | 'tension';
  layoutId?: number;
}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <InlinePlaylistPicker
        climb={options?.climb ?? baseClimb}
        angle={options?.angle ?? 40}
        boardName={options?.boardName ?? 'kilter'}
        layoutId={options?.layoutId ?? 1}
        TextInputComponent={NameInput as never}
      />
    </QueryClientProvider>,
  );
}

function hasCheck(row: HTMLElement): boolean {
  return row.querySelector('[data-icon="check.small"]') !== null;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe('InlinePlaylistPicker membership certainty and angle', () => {
  beforeEach(() => {
    cleanup();
    queryClient?.clear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    playlistContext.playlists = [makePlaylist('p-target', 'kilter', 1)];
    playlistContext.isLoading = false;
    playlistContext.isAuthenticated = true;
    playlistContext.addToPlaylist.mockReset().mockResolvedValue(undefined);
    playlistContext.removeFromPlaylist.mockReset().mockResolvedValue(undefined);
    playlistContext.createPlaylist.mockReset();
    requestMock.mockReset().mockResolvedValue({ playlistsForClimb: [] });
    seeded.members = new Set();
    membershipStore.setMembershipForClimb.mockReset();
    showToast.mockReset();
    reportHandledError.mockReset();
  });

  it('keeps an unseeded null-layout row visibly non-actionable and does not guess a query layout', () => {
    const existingServerMember = new Set(['p-target']);
    playlistContext.playlists = [makePlaylist('p-target', 'tension', 10)];
    const screen = renderPicker({ climb: { ...baseClimb, boardType: 'tension', layoutId: null, angle: 35 } as Climb });

    const row = screen.getByText('tension target').closest('[data-row="tension target"]');
    expect(row).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'tension target' })).toBeNull();
    expect(screen.getByText('actions.playlist.popover.membershipUnknown')).toBeTruthy();
    expect(requestMock).not.toHaveBeenCalled();
    expect(existingServerMember.has('p-target')).toBe(true);
    expect(playlistContext.addToPlaylist).not.toHaveBeenCalled();
    expect(playlistContext.removeFromPlaylist).not.toHaveBeenCalled();
  });

  it('lets a positively seeded member be removed even when the layout is unknown', async () => {
    playlistContext.playlists = [makePlaylist('p-target', 'tension', 10)];
    seeded.members = new Set(['p-target']);
    const screen = renderPicker({ climb: { ...baseClimb, boardType: 'tension', layoutId: null, angle: 35 } as Climb });

    const row = screen.getByRole('button', { name: 'tension target' });
    expect(hasCheck(row)).toBe(true);
    fireEvent.click(row);

    await waitFor(() => expect(playlistContext.removeFromPlaylist).toHaveBeenCalledWith('p-target', 'climb-1'));
    expect(playlistContext.addToPlaylist).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('locks empty rows while the exact-layout membership query is loading', async () => {
    const pending = deferred<{ playlistsForClimb: string[] }>();
    requestMock.mockReturnValue(pending.promise);
    const screen = renderPicker();

    expect(screen.getByText('actions.playlist.popover.membershipChecking')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'kilter target' })).toBeNull();
    expect(playlistContext.addToPlaylist).not.toHaveBeenCalled();

    pending.resolve({ playlistsForClimb: [] });
    await screen.findByRole('button', { name: 'kilter target' });
  });

  it('keeps empty rows locked when the exact-layout query fails', async () => {
    requestMock.mockRejectedValue(new Error('network unavailable'));
    const screen = renderPicker();

    await screen.findByText('actions.playlist.popover.membershipUnavailable');
    expect(screen.queryByRole('button', { name: 'kilter target' })).toBeNull();
    expect(playlistContext.addToPlaylist).not.toHaveBeenCalled();
  });

  it('adds after an authoritative empty response', async () => {
    const screen = renderPicker();
    const row = await screen.findByRole('button', { name: 'kilter target' });

    fireEvent.click(row);

    await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalledWith('p-target', 'climb-1', 40));
    await waitFor(() => expect(hasCheck(row)).toBe(true));
  });

  it('removes a member returned by the exact-layout query', async () => {
    requestMock.mockResolvedValue({ playlistsForClimb: ['p-target'] });
    const screen = renderPicker();
    const row = await screen.findByRole('button', { name: 'kilter target' });

    expect(hasCheck(row)).toBe(true);
    fireEvent.click(row);

    await waitFor(() => expect(playlistContext.removeFromPlaylist).toHaveBeenCalledWith('p-target', 'climb-1'));
    expect(playlistContext.addToPlaylist).not.toHaveBeenCalled();
  });

  it('uses the climb angle for a cached null-layout cross-board add', async () => {
    const crossBoardClimb = { ...baseClimb, boardType: 'tension', layoutId: null, angle: 35 } as Climb;
    playlistContext.playlists = [makePlaylist('p-target', 'tension', 10)];
    queryClient.setQueryData(['playlistsForClimb', 'tension', null, 'climb-1'], []);
    const screen = renderPicker({ climb: crossBoardClimb, angle: 40 });
    const row = await screen.findByRole('button', { name: 'tension target' });

    fireEvent.click(row);

    await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalledWith('p-target', 'climb-1', 35));
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('preserves the active same-board angle and known-layout preview snapshot', async () => {
    const sameBoard = { ...baseClimb, angle: 35 } as Climb;
    const sameBoardScreen = renderPicker({ climb: sameBoard, angle: 40 });
    fireEvent.click(await sameBoardScreen.findByRole('button', { name: 'kilter target' }));
    await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalledWith('p-target', 'climb-1', 40));

    cleanup();
    queryClient.clear();
    playlistContext.addToPlaylist.mockClear();
    playlistContext.playlists = [makePlaylist('p-target', 'tension', 10)];
    const knownLayoutCrossBoard = { ...baseClimb, boardType: 'tension', layoutId: 10, angle: 35 } as Climb;
    const previewScreen = renderPicker({ climb: knownLayoutCrossBoard, angle: 42 });
    fireEvent.click(await previewScreen.findByRole('button', { name: 'tension target' }));
    await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalledWith('p-target', 'climb-1', 42));
  });

  it('rolls back the optimistic checkmark when the target board rejects an angle', async () => {
    playlistContext.addToPlaylist.mockRejectedValue(new Error('unsupported angle'));
    const screen = renderPicker();
    const row = await screen.findByRole('button', { name: 'kilter target' });
    const key = ['playlistsForClimb', 'kilter', 1, 'climb-1'];

    fireEvent.click(row);
    await waitFor(() => expect(reportHandledError).toHaveBeenCalled());

    expect(queryClient.getQueryData(key)).toEqual([]);
    expect(hasCheck(row)).toBe(false);
  });

  it('blocks additions with a non-finite angle and explains why', async () => {
    const screen = renderPicker({ climb: baseClimb, angle: Number.NaN });

    await screen.findByText('actions.playlist.popover.angleUnavailable');
    expect(screen.queryByRole('button', { name: 'kilter target' })).toBeNull();
    expect(screen.queryByLabelText('actions.playlist.popover.createNew')).toBeNull();
    expect(playlistContext.addToPlaylist).not.toHaveBeenCalled();
    expect(playlistContext.createPlaylist).not.toHaveBeenCalled();
  });

  it('keeps create and mutations unavailable when signed out or layout is unknown', () => {
    playlistContext.isAuthenticated = false;
    const signedOut = renderPicker();
    expect(signedOut.queryByLabelText('actions.playlist.popover.createNew')).toBeNull();
    expect(requestMock).not.toHaveBeenCalled();

    cleanup();
    playlistContext.isAuthenticated = true;
    playlistContext.playlists = [makePlaylist('p-target', 'tension', 10)];
    const unknownLayout = renderPicker({
      climb: { ...baseClimb, boardType: 'tension', layoutId: null, angle: 35 } as Climb,
    });
    expect(unknownLayout.queryByLabelText('actions.playlist.popover.createNew')).toBeNull();
    expect(unknownLayout.queryByRole('button', { name: 'tension target' })).toBeNull();
  });
});
