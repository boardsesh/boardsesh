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
const membershipStore = vi.hoisted(() => ({
  getMembershipsForClimb: vi.fn((_climbUuid: string): ReadonlySet<string> => new Set()),
  setMembershipForClimb: vi.fn((_climbUuid: string, _playlistUuids: readonly string[]) => {}),
}));
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
    disabled,
    trailing,
    accessibilityHint,
  }: {
    title: string;
    onPress?: () => void;
    disabled?: boolean;
    trailing?: ReactNode;
    accessibilityHint?: string;
  }) =>
    onPress
      ? createElement(
          'button',
          { onClick: onPress, 'aria-label': title, 'data-hint': accessibilityHint, disabled },
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

function rowIsDisabled(row: HTMLElement): boolean {
  return row instanceof HTMLButtonElement && row.disabled;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type MembershipAction = 'add' | 'remove';

function setControlledServerMembership(
  initialMembers: readonly string[],
  firstAction: MembershipAction,
  followUpSucceeds = false,
) {
  const serverMembers = new Set(initialMembers);
  const firstRequest = deferred<void>();
  const calls: Array<{ playlistUuid: string; action: MembershipAction }> = [];
  let firstRequestStarted = false;

  requestMock.mockImplementation(async () => ({ playlistsForClimb: [...serverMembers] }));

  const runAction = (action: MembershipAction, playlistUuid: string): Promise<void> => {
    calls.push({ playlistUuid, action });
    if (playlistUuid === 'p-a' && action === firstAction && !firstRequestStarted) {
      firstRequestStarted = true;
      return firstRequest.promise.then(
        () => {
          if (action === 'add') serverMembers.add(playlistUuid);
          else serverMembers.delete(playlistUuid);
        },
        (error: unknown) => {
          throw error;
        },
      );
    }

    if (playlistUuid === 'p-a') {
      if (followUpSucceeds) {
        if (action === 'add') serverMembers.add(playlistUuid);
        else serverMembers.delete(playlistUuid);
        return Promise.resolve();
      }
      return Promise.reject(new Error('follow-up action rejected'));
    }
    return Promise.reject(new Error('sibling action rejected'));
  };

  playlistContext.addToPlaylist.mockImplementation((playlistUuid: string) => runAction('add', playlistUuid));
  playlistContext.removeFromPlaylist.mockImplementation((playlistUuid: string) => runAction('remove', playlistUuid));

  return { serverMembers, firstRequest, calls };
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
    membershipStore.getMembershipsForClimb.mockReset().mockImplementation(() => seeded.members);
    membershipStore.setMembershipForClimb.mockReset().mockImplementation((_climbUuid, playlistUuids) => {
      seeded.members = new Set(playlistUuids);
    });
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

  it('keeps sibling membership unknown after a seeded removal and re-adds only that row', async () => {
    const crossBoardClimb = { ...baseClimb, boardType: 'tension', layoutId: null, angle: 35 } as Climb;
    playlistContext.playlists = [
      { ...makePlaylist('p-a', 'tension', 10), name: 'Playlist A' },
      { ...makePlaylist('p-b', 'tension', 10), name: 'Playlist B' },
    ];
    seeded.members = new Set(['p-a']);
    const options = { climb: crossBoardClimb, angle: 40 };
    const firstMount = renderPicker(options);
    const memberRow = firstMount.getByRole('button', { name: 'Playlist A' });
    const unknownRow = firstMount.getByText('Playlist B').closest('[data-row="Playlist B"]');

    fireEvent.click(memberRow);

    await waitFor(() => expect(playlistContext.removeFromPlaylist).toHaveBeenCalledWith('p-a', 'climb-1'));
    expect(firstMount.queryByRole('button', { name: 'Playlist B' })).toBeNull();
    expect(hasCheck(firstMount.getByRole('button', { name: 'Playlist A' }))).toBe(false);
    expect(unknownRow).not.toBeNull();
    expect(playlistContext.addToPlaylist).not.toHaveBeenCalledWith('p-b', 'climb-1', expect.any(Number));
    expect(queryClient.getQueryData(['playlistsForClimb', 'tension', null, 'climb-1'])).toBeUndefined();
    expect(queryClient.getQueryData(['playlistMembershipOverrides', 'tension', null, 'climb-1'])).toEqual({
      revision: 1,
      activeMutationOwnersByPlaylistUuid: {},
      byPlaylistUuid: { 'p-a': { isMember: false, revision: 1, pending: false } },
    });

    firstMount.unmount();
    const reopened = renderPicker(options);
    const reAddRow = reopened.getByRole('button', { name: 'Playlist A' });
    expect(hasCheck(reAddRow)).toBe(false);
    expect(reopened.getByText('Playlist B').closest('[data-row="Playlist B"]')).not.toBeNull();

    fireEvent.click(reAddRow);
    await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalledWith('p-a', 'climb-1', 35));
    expect(playlistContext.addToPlaylist).not.toHaveBeenCalledWith('p-b', 'climb-1', expect.any(Number));
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('restores a failed seeded removal without unlocking an unknown sibling', async () => {
    const crossBoardClimb = { ...baseClimb, boardType: 'tension', layoutId: null, angle: 35 } as Climb;
    playlistContext.playlists = [
      { ...makePlaylist('p-a', 'tension', 10), name: 'Playlist A' },
      { ...makePlaylist('p-b', 'tension', 10), name: 'Playlist B' },
    ];
    seeded.members = new Set(['p-a']);
    playlistContext.removeFromPlaylist.mockRejectedValueOnce(new Error('offline'));
    const screen = renderPicker({ climb: crossBoardClimb });

    fireEvent.click(screen.getByRole('button', { name: 'Playlist A' }));

    await waitFor(() => expect(reportHandledError).toHaveBeenCalled());
    expect(hasCheck(screen.getByRole('button', { name: 'Playlist A' }))).toBe(true);
    expect(screen.getByText('Playlist B').closest('[data-row="Playlist B"]')).not.toBeNull();
    expect(queryClient.getQueryData(['playlistsForClimb', 'tension', null, 'climb-1'])).toBeUndefined();
    expect(queryClient.getQueryData(['playlistMembershipOverrides', 'tension', null, 'climb-1'])).toEqual({
      revision: 1,
      activeMutationOwnersByPlaylistUuid: {},
      byPlaylistUuid: {},
    });
    expect(playlistContext.addToPlaylist).not.toHaveBeenCalled();
  });

  it('rolls back one failed row without undoing another row that succeeded meanwhile', async () => {
    const crossBoardClimb = { ...baseClimb, boardType: 'tension', layoutId: null, angle: 35 } as Climb;
    playlistContext.playlists = [
      { ...makePlaylist('p-a', 'tension', 10), name: 'Playlist A' },
      { ...makePlaylist('p-b', 'tension', 10), name: 'Playlist B' },
    ];
    seeded.members = new Set(['p-a', 'p-b']);
    const pendingA = deferred<void>();
    const rejectedA = pendingA.promise.then(() => {
      throw new Error('playlist A removal failed');
    });
    rejectedA.catch(() => {});
    playlistContext.removeFromPlaylist.mockReset().mockReturnValueOnce(rejectedA).mockResolvedValueOnce(undefined);
    const screen = renderPicker({ climb: crossBoardClimb });

    fireEvent.click(screen.getByRole('button', { name: 'Playlist A' }));
    await waitFor(() => expect(playlistContext.removeFromPlaylist).toHaveBeenCalledWith('p-a', 'climb-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Playlist B' }));
    await waitFor(() => expect(playlistContext.removeFromPlaylist).toHaveBeenCalledWith('p-b', 'climb-1'));

    pendingA.resolve();
    await waitFor(() => expect(reportHandledError).toHaveBeenCalledTimes(1));

    expect(hasCheck(screen.getByRole('button', { name: 'Playlist A' }))).toBe(true);
    expect(hasCheck(screen.getByRole('button', { name: 'Playlist B' }))).toBe(false);
    expect(queryClient.getQueryData(['playlistMembershipOverrides', 'tension', null, 'climb-1'])).toEqual({
      revision: 2,
      activeMutationOwnersByPlaylistUuid: {},
      byPlaylistUuid: {
        'p-b': { isMember: false, revision: 2, pending: false },
      },
    });
  });

  it('keeps unknown siblings locked when a seeded known-layout row changes during fetch', async () => {
    const pending = deferred<{ playlistsForClimb: string[] }>();
    requestMock.mockReturnValue(pending.promise);
    const knownLayoutClimb = { ...baseClimb, boardType: 'tension', layoutId: 10, angle: 35 } as Climb;
    playlistContext.playlists = [
      { ...makePlaylist('p-a', 'tension', 10), name: 'Playlist A' },
      { ...makePlaylist('p-b', 'tension', 10), name: 'Playlist B' },
    ];
    seeded.members = new Set(['p-a']);
    const screen = renderPicker({ climb: knownLayoutClimb, angle: 40 });

    fireEvent.click(screen.getByRole('button', { name: 'Playlist A' }));

    await waitFor(() => expect(playlistContext.removeFromPlaylist).toHaveBeenCalledWith('p-a', 'climb-1'));
    expect(screen.queryByRole('button', { name: 'Playlist B' })).toBeNull();
    expect(hasCheck(screen.getByRole('button', { name: 'Playlist A' }))).toBe(false);
    expect(playlistContext.addToPlaylist).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['playlistsForClimb', 'tension', 10, 'climb-1'])).toBeUndefined();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('makes every row actionable after a complete fetched empty result', async () => {
    playlistContext.playlists = [
      { ...makePlaylist('p-a', 'kilter', 1), name: 'Playlist A' },
      { ...makePlaylist('p-b', 'kilter', 1), name: 'Playlist B' },
    ];
    requestMock.mockResolvedValue({ playlistsForClimb: [] });
    const screen = renderPicker();

    const firstRow = await screen.findByRole('button', { name: 'Playlist A' });
    expect(screen.getByRole('button', { name: 'Playlist B' })).toBeTruthy();
    fireEvent.click(firstRow);

    await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalledWith('p-a', 'climb-1', 40));
    expect(screen.getByRole('button', { name: 'Playlist B' })).toBeTruthy();
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

  it('lets a newer complete response replace a settled removal after the picker remounts', async () => {
    playlistContext.playlists = [
      { ...makePlaylist('p-a', 'kilter', 1), name: 'Playlist A' },
      { ...makePlaylist('p-b', 'kilter', 1), name: 'Playlist B' },
    ];
    requestMock
      .mockResolvedValueOnce({ playlistsForClimb: ['p-a'] })
      .mockResolvedValueOnce({ playlistsForClimb: ['p-a', 'p-b'] });
    const firstMount = renderPicker();
    fireEvent.click(await firstMount.findByRole('button', { name: 'Playlist A' }));
    await waitFor(() => expect(playlistContext.removeFromPlaylist).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const overrides = queryClient.getQueryData<{
        byPlaylistUuid: Record<string, { isMember: boolean; pending: boolean }>;
      }>(['playlistMembershipOverrides', 'kilter', 1, 'climb-1']);
      expect(overrides?.byPlaylistUuid['p-a']).toMatchObject({ isMember: false, pending: false });
    });
    firstMount.unmount();

    const reopened = renderPicker();
    const reopenedRow = await reopened.findByRole('button', { name: 'Playlist A' });
    await queryClient.refetchQueries({ queryKey: ['playlistsForClimb', 'kilter', 1, 'climb-1'], exact: true });

    await waitFor(() => expect(hasCheck(reopenedRow)).toBe(true));
    expect(hasCheck(reopened.getByRole('button', { name: 'Playlist B' }))).toBe(true);
    fireEvent.click(reopenedRow);
    await waitFor(() => expect(playlistContext.removeFromPlaylist).toHaveBeenCalledTimes(2));
    expect(playlistContext.addToPlaylist).not.toHaveBeenCalled();
  });

  it('lets a newer complete empty response replace a settled add after the picker remounts', async () => {
    requestMock.mockResolvedValueOnce({ playlistsForClimb: [] }).mockResolvedValueOnce({ playlistsForClimb: [] });
    const firstMount = renderPicker();
    fireEvent.click(await firstMount.findByRole('button', { name: 'kilter target' }));
    await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const overrides = queryClient.getQueryData<{
        byPlaylistUuid: Record<string, { isMember: boolean; pending: boolean }>;
      }>(['playlistMembershipOverrides', 'kilter', 1, 'climb-1']);
      expect(overrides?.byPlaylistUuid['p-target']).toMatchObject({ isMember: true, pending: false });
    });
    firstMount.unmount();

    const reopened = renderPicker();
    const reopenedRow = await reopened.findByRole('button', { name: 'kilter target' });
    expect(hasCheck(reopenedRow)).toBe(true);
    await queryClient.refetchQueries({ queryKey: ['playlistsForClimb', 'kilter', 1, 'climb-1'], exact: true });

    await waitFor(() => expect(hasCheck(reopenedRow)).toBe(false));
    fireEvent.click(reopenedRow);
    await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalledTimes(2));
    expect(playlistContext.removeFromPlaylist).not.toHaveBeenCalled();
  });

  it('preserves a mutation overlapping a read, then reconciles it with the next read', async () => {
    requestMock.mockResolvedValueOnce({ playlistsForClimb: ['p-target'] });
    const pendingRemoval = deferred<void>();
    playlistContext.removeFromPlaylist.mockReturnValueOnce(pendingRemoval.promise);
    const screen = renderPicker();
    const row = await screen.findByRole('button', { name: 'kilter target' });
    fireEvent.click(row);
    await waitFor(() => expect(playlistContext.removeFromPlaylist).toHaveBeenCalledTimes(1));

    const overlappingRead = deferred<{ playlistsForClimb: string[] }>();
    requestMock.mockReturnValueOnce(overlappingRead.promise);
    const overlappingRefetch = queryClient.refetchQueries({
      queryKey: ['playlistsForClimb', 'kilter', 1, 'climb-1'],
      exact: true,
    });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
    overlappingRead.resolve({ playlistsForClimb: ['p-target'] });
    await overlappingRefetch;

    expect(hasCheck(row)).toBe(false);
    pendingRemoval.resolve();
    await waitFor(() => {
      const overrides = queryClient.getQueryData<{
        byPlaylistUuid: Record<string, { isMember: boolean; pending: boolean }>;
      }>(['playlistMembershipOverrides', 'kilter', 1, 'climb-1']);
      expect(overrides?.byPlaylistUuid['p-target']).toMatchObject({ isMember: false, pending: false });
    });
    expect(hasCheck(row)).toBe(false);

    requestMock.mockResolvedValueOnce({ playlistsForClimb: [] });
    await queryClient.refetchQueries({ queryKey: ['playlistsForClimb', 'kilter', 1, 'climb-1'], exact: true });
    expect(hasCheck(row)).toBe(false);
    expect(queryClient.getQueryData(['playlistsForClimb', 'kilter', 1, 'climb-1'])).toMatchObject({
      playlistUuids: [],
    });
  });

  it.each([
    { olderAction: 'remove' as const, olderResult: 'success' as const, initiallyMember: true },
    { olderAction: 'remove' as const, olderResult: 'error' as const, initiallyMember: true },
    { olderAction: 'add' as const, olderResult: 'success' as const, initiallyMember: false },
    { olderAction: 'add' as const, olderResult: 'error' as const, initiallyMember: false },
  ])(
    'serializes a remounted row through older $olderAction $olderResult, then follows server truth',
    async ({ olderAction, olderResult, initiallyMember }) => {
      const initialMembers = ['p-sibling', ...(initiallyMember ? ['p-a'] : [])];
      const { serverMembers, firstRequest, calls } = setControlledServerMembership(initialMembers, olderAction);
      playlistContext.playlists = [
        { ...makePlaylist('p-a', 'kilter', 1), name: 'Playlist A' },
        { ...makePlaylist('p-sibling', 'kilter', 1), name: 'Playlist B' },
      ];

      const firstMount = renderPicker();
      const firstRow = await firstMount.findByRole('button', { name: 'Playlist A' });
      expect(hasCheck(firstRow)).toBe(initiallyMember);
      fireEvent.click(firstRow);
      await waitFor(() => expect(calls.filter(({ playlistUuid }) => playlistUuid === 'p-a')).toHaveLength(1));
      expect(calls[0]).toMatchObject({ playlistUuid: 'p-a', action: olderAction });
      expect(rowIsDisabled(firstRow)).toBe(true);
      expect(hasCheck(firstRow)).toBe(olderAction === 'add');

      firstMount.unmount();
      const reopened = renderPicker();
      const reopenedRow = await reopened.findByRole('button', { name: 'Playlist A' });
      const siblingRow = reopened.getByRole('button', { name: 'Playlist B' });
      expect(rowIsDisabled(reopenedRow)).toBe(true);
      fireEvent.click(reopenedRow);
      expect(calls.filter(({ playlistUuid }) => playlistUuid === 'p-a')).toHaveLength(1);

      // The row lock is per playlist: a sibling can still fail and roll back.
      fireEvent.click(siblingRow);
      await waitFor(() => expect(reportHandledError).toHaveBeenCalled());
      expect(hasCheck(siblingRow)).toBe(true);
      expect(calls).toContainEqual({ playlistUuid: 'p-sibling', action: 'remove' });
      expect(rowIsDisabled(reopenedRow)).toBe(true);
      expect(hasCheck(reopenedRow)).toBe(olderAction === 'add');

      if (olderResult === 'success') firstRequest.resolve();
      else firstRequest.reject(new Error('older action rejected'));

      await waitFor(() => {
        expect(rowIsDisabled(reopenedRow)).toBe(false);
        expect(hasCheck(reopenedRow)).toBe(serverMembers.has('p-a'));
      });

      const membershipKey = ['playlistsForClimb', 'kilter', 1, 'climb-1'];
      await queryClient.refetchQueries({ queryKey: membershipKey, exact: true });
      expect(hasCheck(reopenedRow)).toBe(serverMembers.has('p-a'));

      const expectedNextAction: MembershipAction = serverMembers.has('p-a') ? 'remove' : 'add';
      fireEvent.click(reopenedRow);
      await waitFor(() => expect(calls.filter(({ playlistUuid }) => playlistUuid === 'p-a')).toHaveLength(2));
      expect(calls.filter(({ playlistUuid }) => playlistUuid === 'p-a')[1]).toMatchObject({
        playlistUuid: 'p-a',
        action: expectedNextAction,
      });

      await waitFor(() => {
        expect(rowIsDisabled(reopenedRow)).toBe(false);
        expect(
          queryClient.getQueryData<{
            activeMutationOwnersByPlaylistUuid: Record<string, object>;
          }>(['playlistMembershipOverrides', 'kilter', 1, 'climb-1'])?.activeMutationOwnersByPlaylistUuid['p-a'],
        ).toBeUndefined();
      });
      await queryClient.refetchQueries({ queryKey: membershipKey, exact: true });
      expect(hasCheck(reopenedRow)).toBe(serverMembers.has('p-a'));
      const retryAction: MembershipAction = serverMembers.has('p-a') ? 'remove' : 'add';
      fireEvent.click(reopenedRow);
      await waitFor(() => expect(calls.filter(({ playlistUuid }) => playlistUuid === 'p-a')).toHaveLength(3));
      expect(calls.filter(({ playlistUuid }) => playlistUuid === 'p-a')[2]).toMatchObject({
        playlistUuid: 'p-a',
        action: retryAction,
      });
    },
  );

  it('isolates a new auth cache owner from an older remounted mutation', async () => {
    const firstRequest = deferred<void>();
    const newAccountRequest = deferred<void>();
    const oldAccountMembers = new Set(['p-target']);
    const newAccountMembers = new Set<string>();
    let currentAccountMembers = oldAccountMembers;
    let removeCalls = 0;

    requestMock.mockImplementation(async () => ({ playlistsForClimb: [...currentAccountMembers] }));
    playlistContext.removeFromPlaylist.mockImplementation(() => {
      removeCalls += 1;
      return firstRequest.promise.then(() => oldAccountMembers.delete('p-target'));
    });
    playlistContext.addToPlaylist.mockImplementation(() =>
      newAccountRequest.promise.then(() => newAccountMembers.add('p-target')),
    );

    const oldPicker = renderPicker();
    fireEvent.click(await oldPicker.findByRole('button', { name: 'kilter target' }));
    await waitFor(() => expect(removeCalls).toBe(1));
    oldPicker.unmount();

    // AuthProvider clears QueryClient at the account boundary. The old network
    // request may finish later, but its owner cannot settle a new cache entry.
    queryClient.clear();
    currentAccountMembers = newAccountMembers;
    const newPicker = renderPicker();
    const newAccountRow = await newPicker.findByRole('button', { name: 'kilter target' });
    fireEvent.click(newAccountRow);
    await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalledTimes(1));
    const membershipOverridesKey = ['playlistMembershipOverrides', 'kilter', 1, 'climb-1'];
    const newOwner = queryClient.getQueryData<{
      activeMutationOwnersByPlaylistUuid: Record<string, object>;
    }>(membershipOverridesKey)?.activeMutationOwnersByPlaylistUuid['p-target'];
    expect(newOwner).toBeDefined();

    firstRequest.resolve();
    await waitFor(() => expect(oldAccountMembers.has('p-target')).toBe(false));
    expect(
      queryClient.getQueryData<{
        activeMutationOwnersByPlaylistUuid: Record<string, object>;
      }>(membershipOverridesKey)?.activeMutationOwnersByPlaylistUuid['p-target'],
    ).toBe(newOwner);
    expect(rowIsDisabled(newAccountRow)).toBe(true);

    newAccountRequest.resolve();
    await waitFor(() => expect(rowIsDisabled(newAccountRow)).toBe(false));
    expect(newAccountMembers.has('p-target')).toBe(true);
    expect(hasCheck(newAccountRow)).toBe(true);
  });

  it('retries only after an older error settles and then follows the new server truth', async () => {
    const { serverMembers, firstRequest, calls } = setControlledServerMembership(['p-a'], 'remove', true);
    playlistContext.playlists = [{ ...makePlaylist('p-a', 'kilter', 1), name: 'Playlist A' }];

    const firstMount = renderPicker();
    fireEvent.click(await firstMount.findByRole('button', { name: 'Playlist A' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    firstMount.unmount();

    const reopened = renderPicker();
    const row = await reopened.findByRole('button', { name: 'Playlist A' });
    expect(rowIsDisabled(row)).toBe(true);
    fireEvent.click(row);
    expect(calls).toHaveLength(1);

    firstRequest.reject(new Error('older removal rejected'));
    await waitFor(() => {
      expect(rowIsDisabled(row)).toBe(false);
      expect(hasCheck(row)).toBe(true);
    });
    await queryClient.refetchQueries({ queryKey: ['playlistsForClimb', 'kilter', 1, 'climb-1'], exact: true });
    expect(hasCheck(row)).toBe(true);

    fireEvent.click(row);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ playlistUuid: 'p-a', action: 'remove' });
    await waitFor(() => {
      expect(rowIsDisabled(row)).toBe(false);
      expect(serverMembers.has('p-a')).toBe(false);
      expect(hasCheck(row)).toBe(false);
    });
    await queryClient.refetchQueries({ queryKey: ['playlistsForClimb', 'kilter', 1, 'climb-1'], exact: true });
    expect(hasCheck(row)).toBe(false);

    fireEvent.click(row);
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]).toMatchObject({ playlistUuid: 'p-a', action: 'add' });
    await waitFor(() => expect(serverMembers.has('p-a')).toBe(true));
  });

  it('keeps the active-row lock scoped to the climb membership query', async () => {
    const kilterMembers = new Set(['p-shared']);
    const secondClimbMembers = new Set<string>();
    const kilterRequest = deferred<void>();
    const secondClimbRequest = deferred<void>();
    playlistContext.playlists = [makePlaylist('p-shared', 'kilter', 1)];
    requestMock.mockResolvedValueOnce({ playlistsForClimb: ['p-shared'] });
    playlistContext.removeFromPlaylist.mockImplementation(() =>
      kilterRequest.promise.then(() => kilterMembers.delete('p-shared')),
    );
    playlistContext.addToPlaylist.mockImplementation(() =>
      secondClimbRequest.promise.then(() => secondClimbMembers.add('p-shared')),
    );

    const kilterPicker = renderPicker();
    fireEvent.click(await kilterPicker.findByRole('button', { name: 'kilter target' }));
    await waitFor(() => expect(playlistContext.removeFromPlaylist).toHaveBeenCalledTimes(1));
    kilterPicker.unmount();

    const secondClimbMembershipKey = ['playlistsForClimb', 'kilter', 1, 'climb-2'];
    queryClient.setQueryData(secondClimbMembershipKey, {
      playlistUuids: [],
      overrideRevisionAtFetchStart: 0,
      pendingOverrideRevisionsAtFetchStart: {},
    });
    const secondClimb = { ...baseClimb, uuid: 'climb-2' } as Climb;
    const secondPicker = renderPicker({ climb: secondClimb });
    const secondRow = await secondPicker.findByRole('button', { name: 'kilter target' });
    fireEvent.click(secondRow);
    await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalledTimes(1));
    expect(rowIsDisabled(secondRow)).toBe(true);

    const kilterOwner = queryClient.getQueryData<{
      activeMutationOwnersByPlaylistUuid: Record<string, object>;
    }>(['playlistMembershipOverrides', 'kilter', 1, 'climb-1'])?.activeMutationOwnersByPlaylistUuid['p-shared'];
    const secondOwner = queryClient.getQueryData<{
      activeMutationOwnersByPlaylistUuid: Record<string, object>;
    }>(['playlistMembershipOverrides', 'kilter', 1, 'climb-2'])?.activeMutationOwnersByPlaylistUuid['p-shared'];
    expect(kilterOwner).toBeDefined();
    expect(secondOwner).toBeDefined();
    expect(secondOwner).not.toBe(kilterOwner);

    kilterRequest.resolve();
    await waitFor(() =>
      expect(
        queryClient.getQueryData<{
          activeMutationOwnersByPlaylistUuid: Record<string, object>;
        }>(['playlistMembershipOverrides', 'kilter', 1, 'climb-1'])?.activeMutationOwnersByPlaylistUuid['p-shared'],
      ).toBeUndefined(),
    );
    expect(rowIsDisabled(secondRow)).toBe(true);

    secondClimbRequest.resolve();
    await waitFor(() => {
      expect(rowIsDisabled(secondRow)).toBe(false);
      expect(secondClimbMembers.has('p-shared')).toBe(true);
      expect(hasCheck(secondRow)).toBe(true);
    });
    expect(kilterMembers.has('p-shared')).toBe(false);
  });

  it('uses the climb angle for a cached null-layout cross-board add', async () => {
    const crossBoardClimb = { ...baseClimb, boardType: 'tension', layoutId: null, angle: 35 } as Climb;
    playlistContext.playlists = [makePlaylist('p-target', 'tension', 10)];
    queryClient.setQueryData(['playlistsForClimb', 'tension', null, 'climb-1'], {
      playlistUuids: [],
      overrideRevisionAtFetchStart: 0,
      pendingOverrideRevisionsAtFetchStart: {},
    });
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

    expect(queryClient.getQueryData(key)).toMatchObject({ playlistUuids: [] });
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
