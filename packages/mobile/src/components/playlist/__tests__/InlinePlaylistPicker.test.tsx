// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
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
const qstate = vi.hoisted(() => ({ data: [] as string[] | undefined, loading: false }));
const queryClientMock = vi.hoisted(() => ({
  getQueryData: vi.fn(),
  setQueryData: vi.fn(),
  cancelQueries: vi.fn(async () => {}),
}));
const membershipStore = vi.hoisted(() => ({ setMembershipForClimb: vi.fn() }));
const showToast = vi.hoisted(() => vi.fn());
const reportHandledError = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
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

// Interpolating values into the key keeps the named-toast copy assertable without
// pulling in a real i18n instance.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.entries(values).map(([name, value]) => `${name}=${String(value)}`)}` : key,
  }),
}));

vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: qstate.data, isLoading: qstate.loading }),
  useQueryClient: () => queryClientMock,
}));

vi.mock('@boardsesh/graphql/operations/playlists', () => ({ GET_PLAYLISTS_FOR_CLIMB: 'GET_PLAYLISTS_FOR_CLIMB' }));
vi.mock('@boardsesh/climb-actions', () => ({ playlistMembershipStore: membershipStore }));
// The store-seed hook — the picker uses it as an instant fallback for checkmarks.
vi.mock('../../../hooks/use-climb-playlist-memberships', () => ({
  useClimbPlaylistMemberships: () => new Set<string>(),
}));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: vi.fn() }) }));

vi.mock('../../../providers/playlists-provider', () => ({
  usePlaylistsContext: () => playlistContext,
}));

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

vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

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
    createElement('button', { onClick: onPress, 'aria-label': title, 'data-hint': accessibilityHint }, title, trailing),
}));

import { InlinePlaylistPicker } from '../InlinePlaylistPicker';

const climb = { uuid: 'climb-1', name: 'Big Move', frames: '' } as Climb;

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

function makePlaylist(uuid: string, name: string): Playlist {
  return { ...basePlaylist, id: uuid, uuid, name };
}

// A trivial injected text input so the component stays presentation-agnostic.
function NameInput(props: { value?: string; onChangeText?: (text: string) => void }) {
  return createElement('input', {
    'aria-label': 'name-input',
    value: props.value ?? '',
    onChange: (event: { target: { value: string } }) => props.onChangeText?.(event.target.value),
  });
}

function renderPicker(onBack?: () => void, onDetachedFailure?: (message: string) => void) {
  return render(
    <InlinePlaylistPicker
      climb={climb}
      angle={40}
      boardName="kilter"
      layoutId={1}
      TextInputComponent={NameInput as never}
      onBack={onBack}
      onDetachedFailure={onDetachedFailure}
    />,
  );
}

function hasCheck(button: HTMLElement): boolean {
  return !!button.querySelector('[data-icon="check.small"]');
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('InlinePlaylistPicker', () => {
  beforeEach(() => {
    playlistContext.playlists = [];
    playlistContext.isLoading = false;
    playlistContext.isAuthenticated = true;
    playlistContext.addToPlaylist.mockReset().mockResolvedValue(undefined);
    playlistContext.removeFromPlaylist.mockReset().mockResolvedValue(undefined);
    playlistContext.createPlaylist.mockReset();
    qstate.data = [];
    qstate.loading = false;
    queryClientMock.getQueryData.mockReset().mockReturnValue(undefined);
    queryClientMock.setQueryData.mockReset();
    queryClientMock.cancelQueries.mockClear();
    membershipStore.setMembershipForClimb.mockReset();
    showToast.mockReset();
    reportHandledError.mockReset();
  });

  it('shows the sign-in blurb and no create button when signed out', () => {
    playlistContext.isAuthenticated = false;
    const { queryByLabelText, getByText } = renderPicker();
    expect(queryByLabelText('actions.playlist.popover.createNew')).toBeNull();
    expect(getByText('actions.playlist.popover.signInBlurb')).not.toBeNull();
  });

  it('shows the empty state and a create button when authed with no playlists', () => {
    const { getByText, getByLabelText } = renderPicker();
    expect(getByText('actions.playlist.popover.empty')).not.toBeNull();
    expect(getByLabelText('actions.playlist.popover.createNew')).not.toBeNull();
  });

  it('renders rows sorted by name with a checkmark only on member playlists', () => {
    playlistContext.playlists = [makePlaylist('p-b', 'banana'), makePlaylist('p-a', 'Apple')];
    qstate.data = ['p-a'];
    const { getByLabelText } = renderPicker();
    // 'Apple' is a member (checkmark), 'banana' is not.
    expect(hasCheck(getByLabelText('Apple'))).toBe(true);
    expect(hasCheck(getByLabelText('banana'))).toBe(false);
    expect(getByLabelText('Apple').getAttribute('data-hint')).toBe('actions.playlist.toast.removed');
    expect(getByLabelText('banana').getAttribute('data-hint')).toBe('actions.playlist.toast.added');
  });

  // #4224: the provider's `playlists` spans every board the user has
  // playlists on; the picker (default props: boardName="kilter", layoutId=1)
  // must only offer playlists for the climb's own board+layout.
  it('never renders a playlist from a different board or layout as a row', () => {
    playlistContext.playlists = [
      makePlaylist('p-kilter', 'Kilter warmups'),
      { ...basePlaylist, id: 'p-tension', uuid: 'p-tension', name: 'Tension crimps', boardType: 'tension' },
      { ...basePlaylist, id: 'p-other-layout', uuid: 'p-other-layout', name: 'Other layout', layoutId: 2 },
    ];
    const { getByLabelText, queryByLabelText } = renderPicker();
    expect(getByLabelText('Kilter warmups')).not.toBeNull();
    expect(queryByLabelText('Tension crimps')).toBeNull();
    expect(queryByLabelText('Other layout')).toBeNull();
  });

  it('adds the climb when tapping a non-member row (optimistic + store sync)', async () => {
    playlistContext.playlists = [makePlaylist('p-1', 'Hard Crimps')];
    qstate.data = [];
    const { getByLabelText } = renderPicker();

    fireEvent.click(getByLabelText('Hard Crimps'));

    await waitFor(() => {
      expect(playlistContext.addToPlaylist).toHaveBeenCalledWith('p-1', 'climb-1', 40);
    });
    expect(playlistContext.removeFromPlaylist).not.toHaveBeenCalled();
    expect(queryClientMock.setQueryData).toHaveBeenCalledWith(['playlistsForClimb', 'kilter', 1, 'climb-1'], ['p-1']);
    expect(membershipStore.setMembershipForClimb).toHaveBeenCalledWith('climb-1', ['p-1']);
  });

  it('removes the climb when tapping a member row', async () => {
    playlistContext.playlists = [makePlaylist('p-1', 'Hard Crimps')];
    qstate.data = ['p-1'];
    const { getByLabelText } = renderPicker();

    fireEvent.click(getByLabelText('Hard Crimps'));

    await waitFor(() => {
      expect(playlistContext.removeFromPlaylist).toHaveBeenCalledWith('p-1', 'climb-1');
    });
    expect(playlistContext.addToPlaylist).not.toHaveBeenCalled();
    expect(queryClientMock.setQueryData).toHaveBeenCalledWith(['playlistsForClimb', 'kilter', 1, 'climb-1'], []);
  });

  it('reverts the optimistic membership and surfaces an inline error on failure', async () => {
    playlistContext.playlists = [makePlaylist('p-1', 'Hard Crimps')];
    qstate.data = [];
    playlistContext.addToPlaylist.mockReset().mockRejectedValueOnce(new Error('boom'));
    const { getByLabelText, getByText } = renderPicker();

    fireEvent.click(getByLabelText('Hard Crimps'));

    await waitFor(() => {
      expect(getByText('actions.playlist.toast.addFailed')).not.toBeNull();
    });
    // Optimistic write then revert to the previous set.
    expect(queryClientMock.setQueryData).toHaveBeenNthCalledWith(1, expect.anything(), ['p-1']);
    expect(queryClientMock.setQueryData).toHaveBeenNthCalledWith(2, expect.anything(), []);
  });

  // #3891: the climber taps a playlist, sees the optimistic checkmark, and
  // dismisses the sheet/overlay before the request settles — which on gym wifi is
  // most of the window. The catch block still runs (the rollback below proves it),
  // but `setError` on an unmounted component is a silent no-op, so the failure used
  // to reach nobody: no banner, no toast, no Sentry. These four cases pin the
  // routing; 5 and 6 are only meaningful as a pair (each alone is satisfied by an
  // always-toast or a never-toast implementation).
  describe('failure feedback survives the host being dismissed', () => {
    function setupDeferredAdd(members: string[] = []) {
      playlistContext.playlists = [makePlaylist('p-1', 'Minimoon circuit')];
      qstate.data = members;
      const pending = deferred<void>();
      const rejection = pending.promise.then(() => {
        throw new Error('offline');
      });
      // Swallow the rejection here so an unhandled-rejection warning can't fail the
      // run; the component has its own catch on the same promise.
      rejection.catch(() => {});
      return { pending, rejection };
    }

    it('toasts the failure, naming the playlist, when the picker unmounted before the add settled', async () => {
      const { pending, rejection } = setupDeferredAdd();
      playlistContext.addToPlaylist.mockReset().mockReturnValueOnce(rejection);
      const { getByLabelText, unmount } = renderPicker();

      fireEvent.click(getByLabelText('Minimoon circuit'));
      await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalled());
      // Optimistic checkmark is already written — this is what the climber saw
      // before dismissing.
      expect(queryClientMock.setQueryData).toHaveBeenNthCalledWith(1, expect.anything(), ['p-1']);

      unmount();
      pending.resolve();

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith(
          'actions.playlist.toast.addFailedNamed:playlist=Minimoon circuit',
          'error',
        );
      });
      // The optimistic membership is still rolled back, so the checkmark is gone
      // when the picker is reopened.
      expect(membershipStore.setMembershipForClimb).toHaveBeenLastCalledWith('climb-1', []);
    });

    it('keeps the failure inline and does NOT toast while the picker is still mounted', async () => {
      const { pending, rejection } = setupDeferredAdd();
      playlistContext.addToPlaylist.mockReset().mockReturnValueOnce(rejection);
      const { getByLabelText, getByText } = renderPicker();

      fireEvent.click(getByLabelText('Minimoon circuit'));
      await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalled());
      pending.resolve();

      await waitFor(() => expect(getByText('actions.playlist.toast.addFailed')).not.toBeNull());
      // A root toast would render behind the sheet / FullWindowOverlay hosting the
      // picker, so this one must stay inline.
      expect(showToast).not.toHaveBeenCalled();
    });

    it('toasts the remove failure (not the add copy) when the picker is gone', async () => {
      const { pending, rejection } = setupDeferredAdd(['p-1']);
      playlistContext.removeFromPlaylist.mockReset().mockReturnValueOnce(rejection);
      const { getByLabelText, unmount } = renderPicker();

      fireEvent.click(getByLabelText('Minimoon circuit'));
      await waitFor(() => expect(playlistContext.removeFromPlaylist).toHaveBeenCalled());
      unmount();
      pending.resolve();

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith(
          'actions.playlist.toast.removeFailedNamed:playlist=Minimoon circuit',
          'error',
        );
      });
      // Membership is restored, so the checkmark comes back.
      expect(membershipStore.setMembershipForClimb).toHaveBeenLastCalledWith('climb-1', ['p-1']);
    });

    // Mount state alone is the WRONG signal for "is a toast visible". The reaction
    // overlay's back button pops to its action menu, which unmounts the picker
    // while the FullWindowOverlay / transparent Modal is still presented — and a
    // root toast renders behind those, then self-dismisses in 3s. So the host gets
    // to say where a detached failure goes; only hosts whose dismissal IS the
    // picker's unmount (the ModalSheet) fall through to the toast.
    it('hands the failure to the host channel instead of a toast when the host outlives the picker', async () => {
      const { pending, rejection } = setupDeferredAdd();
      playlistContext.addToPlaylist.mockReset().mockReturnValueOnce(rejection);
      const onDetachedFailure = vi.fn();
      const { getByLabelText, unmount } = renderPicker(undefined, onDetachedFailure);

      fireEvent.click(getByLabelText('Minimoon circuit'));
      await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalled());
      // Back-to-menu: the picker goes, the overlay stays.
      unmount();
      pending.resolve();

      await waitFor(() => {
        expect(onDetachedFailure).toHaveBeenCalledWith(
          'actions.playlist.toast.addFailedNamed:playlist=Minimoon circuit',
        );
      });
      expect(showToast).not.toHaveBeenCalled();
    });

    it.each([
      ['mounted', false],
      ['unmounted', true],
    ])('reports the toggle failure to Sentry while %s', async (_label, dismiss) => {
      const { pending, rejection } = setupDeferredAdd();
      playlistContext.addToPlaylist.mockReset().mockReturnValueOnce(rejection);
      const { getByLabelText, unmount } = renderPicker();

      fireEvent.click(getByLabelText('Minimoon circuit'));
      await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalled());
      if (dismiss) unmount();
      pending.resolve();

      await waitFor(() => {
        expect(reportHandledError).toHaveBeenCalledWith(expect.any(Error), {
          tags: { source: 'playlist', op: 'toggle-membership' },
        });
      });
      expect(reportHandledError).toHaveBeenCalledTimes(1);
    });
  });

  it('creates a playlist inline and adds the climb to it', async () => {
    const created = makePlaylist('p-new', 'Projects');
    playlistContext.createPlaylist.mockResolvedValueOnce(created);
    const { getByLabelText } = renderPicker();

    fireEvent.click(getByLabelText('actions.playlist.popover.createNew'));
    fireEvent.change(getByLabelText('name-input'), { target: { value: 'Projects' } });
    fireEvent.click(getByLabelText('actions.playlist.create.submit'));

    await waitFor(() => {
      expect(playlistContext.createPlaylist).toHaveBeenCalledWith('Projects', undefined, undefined, undefined, {
        boardType: 'kilter',
        layoutId: 1,
      });
    });
    await waitFor(() => {
      expect(playlistContext.addToPlaylist).toHaveBeenCalledWith('p-new', 'climb-1', 40);
    });
  });

  it('keeps the created playlist and reports an add error (not a create error) when the follow-up add fails', async () => {
    const created = makePlaylist('p-new', 'Projects');
    playlistContext.createPlaylist.mockResolvedValueOnce(created);
    playlistContext.addToPlaylist.mockReset().mockRejectedValueOnce(new Error('add failed'));
    const { getByLabelText, queryByLabelText, getByText } = renderPicker();

    fireEvent.click(getByLabelText('actions.playlist.popover.createNew'));
    fireEvent.change(getByLabelText('name-input'), { target: { value: 'Projects' } });
    fireEvent.click(getByLabelText('actions.playlist.create.submit'));

    await waitFor(() => {
      expect(getByText('actions.playlist.toast.addFailedNamed:playlist=Projects')).not.toBeNull();
    });
    // Created exactly once (no duplicate), the add was attempted, and the form
    // closed — so a retry taps the existing row rather than re-creating.
    expect(playlistContext.createPlaylist).toHaveBeenCalledTimes(1);
    expect(playlistContext.addToPlaylist).toHaveBeenCalledWith('p-new', 'climb-1', 40);
    expect(queryByLabelText('actions.playlist.create.submit')).toBeNull();
  });

  it('toasts a failed create-then-add when the picker went away mid-request', async () => {
    // The same hole as the toggle path, one flow over: the create succeeds, the
    // picker unmounts, then the add rejects. This one used to be gated on
    // isCurrent() — false after unmount — so it reported nothing at all. The form
    // is already closed by the time the add runs, so a stale token here means the
    // picker is gone, which is exactly when the toast is the only channel left.
    const created = makePlaylist('p-new', 'Projects');
    playlistContext.createPlaylist.mockResolvedValueOnce(created);
    const pending = deferred<void>();
    const rejection = pending.promise.then(() => {
      throw new Error('offline');
    });
    rejection.catch(() => {});
    playlistContext.addToPlaylist.mockReset().mockReturnValueOnce(rejection);
    const { getByLabelText, unmount } = renderPicker();

    fireEvent.click(getByLabelText('actions.playlist.popover.createNew'));
    fireEvent.change(getByLabelText('name-input'), { target: { value: 'Projects' } });
    fireEvent.click(getByLabelText('actions.playlist.create.submit'));
    await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalled());

    unmount();
    pending.resolve();

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('actions.playlist.toast.addFailedNamed:playlist=Projects', 'error');
    });
    expect(reportHandledError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { source: 'playlist', op: 'create-then-add' },
    });
  });

  it('names the playlist when a create-then-add fails while a SECOND create form is open', async () => {
    // The other way the create token goes stale, with the picker still mounted:
    // submit a second inline create while the first playlist's add is in flight.
    // The stale continuation must still speak (dropping it loses the first
    // playlist's add silently), it must name which playlist it is about, and the
    // message has to land in the form's error slot — the list header that
    // normally carries it isn't mounted while the form is open.
    const first = makePlaylist('p-first', 'Minimoon circuit');
    const secondCreate = deferred<Playlist>();
    playlistContext.createPlaylist.mockReset().mockResolvedValueOnce(first).mockReturnValueOnce(secondCreate.promise);
    const pendingAdd = deferred<void>();
    const rejection = pendingAdd.promise.then(() => {
      throw new Error('offline');
    });
    rejection.catch(() => {});
    playlistContext.addToPlaylist.mockReset().mockReturnValueOnce(rejection);
    const { getByLabelText, getByText } = renderPicker();

    fireEvent.click(getByLabelText('actions.playlist.popover.createNew'));
    fireEvent.change(getByLabelText('name-input'), { target: { value: 'Minimoon circuit' } });
    fireEvent.click(getByLabelText('actions.playlist.create.submit'));
    await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalledWith('p-first', 'climb-1', 40));

    // Second create: bumps the token, so the first add's continuation is stale.
    fireEvent.click(getByLabelText('actions.playlist.popover.createNew'));
    fireEvent.change(getByLabelText('name-input'), { target: { value: 'Board projects' } });
    fireEvent.click(getByLabelText('actions.playlist.create.submit'));
    await waitFor(() => expect(playlistContext.createPlaylist).toHaveBeenCalledTimes(2));

    pendingAdd.resolve();

    await waitFor(() => {
      expect(getByText('actions.playlist.toast.addFailedNamed:playlist=Minimoon circuit')).not.toBeNull();
    });
    // Still mounted, so nothing goes to the (invisible-behind-the-host) toast.
    expect(showToast).not.toHaveBeenCalled();
    secondCreate.resolve(makePlaylist('p-second', 'Board projects'));
  });

  it('shows a create failure inline and keeps the form open without adding', async () => {
    playlistContext.createPlaylist.mockRejectedValueOnce(new Error('create failed'));
    const { getByLabelText, getByText } = renderPicker();

    fireEvent.click(getByLabelText('actions.playlist.popover.createNew'));
    fireEvent.change(getByLabelText('name-input'), { target: { value: 'Projects' } });
    fireEvent.click(getByLabelText('actions.playlist.create.submit'));

    await waitFor(() => {
      expect(getByText('actions.playlist.toast.createFailed')).not.toBeNull();
    });
    expect(playlistContext.addToPlaylist).not.toHaveBeenCalled();
    // Form stays open (submit still present) so the user can fix and retry.
    expect(getByLabelText('actions.playlist.create.submit')).not.toBeNull();
  });

  it('blocks create with an empty name and shows a validation error', () => {
    const { getByLabelText, getByText } = renderPicker();
    fireEvent.click(getByLabelText('actions.playlist.popover.createNew'));
    fireEvent.click(getByLabelText('actions.playlist.create.submit'));
    expect(getByText('actions.playlist.validation.nameRequired')).not.toBeNull();
    expect(playlistContext.createPlaylist).not.toHaveBeenCalled();
  });

  it('ignores repeat taps on a playlist row while its toggle is in flight', async () => {
    playlistContext.playlists = [makePlaylist('p-1', 'Hard Crimps')];
    qstate.data = [];
    const addDeferred = deferred<void>();
    playlistContext.addToPlaylist.mockReset().mockReturnValueOnce(addDeferred.promise);
    const { getByLabelText } = renderPicker();

    fireEvent.click(getByLabelText('Hard Crimps')); // add — in flight
    fireEvent.click(getByLabelText('Hard Crimps')); // ignored while the first settles

    await waitFor(() => expect(playlistContext.addToPlaylist).toHaveBeenCalledTimes(1));
    expect(playlistContext.removeFromPlaylist).not.toHaveBeenCalled();
    addDeferred.resolve();
  });

  it('aborts the create continuation when the picker unmounts mid-create', async () => {
    const createDeferred = deferred<Playlist>();
    playlistContext.createPlaylist.mockReturnValueOnce(createDeferred.promise);
    const { getByLabelText, unmount } = renderPicker();

    fireEvent.click(getByLabelText('actions.playlist.popover.createNew'));
    fireEvent.change(getByLabelText('name-input'), { target: { value: 'Projects' } });
    fireEvent.click(getByLabelText('actions.playlist.create.submit'));
    await waitFor(() => expect(playlistContext.createPlaylist).toHaveBeenCalled());

    // Dismiss the overlay (back / backdrop) → picker unmounts → in-flight create's
    // continuation must abort rather than add the climb the user backed out of.
    unmount();
    createDeferred.resolve(makePlaylist('p-new', 'Projects'));
    await createDeferred.promise;
    await Promise.resolve();

    expect(playlistContext.addToPlaylist).not.toHaveBeenCalled();
  });
});
