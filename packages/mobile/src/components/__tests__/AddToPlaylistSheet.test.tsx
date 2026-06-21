// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';

const playlistContext = vi.hoisted(() => ({
  playlists: [] as Playlist[],
  addToPlaylist: vi.fn(),
  createPlaylist: vi.fn(),
  isLoading: false,
  isAuthenticated: true,
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));

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
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('@gorhom/bottom-sheet', () => ({
  BottomSheetModal: function BottomSheetModal() {
    return null;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key === 'actions.playlist.toast.createdNamed' && typeof options?.name === 'string'
        ? `${key} ${options.name}`
        : key,
  }),
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primary: '#6D28D9' },
    systemColors: { accent: '#6D28D9', fill: '#eeeeee' },
  }),
}));

vi.mock('../../providers/toast-provider', () => ({
  useToast: () => toast,
}));

vi.mock('../../providers/playlists-provider', () => ({
  usePlaylistsContext: () => playlistContext,
}));

vi.mock('../../theme/ios-colors', () => ({
  iosSystemColors: { systemGray: '#8E8E93' },
}));

vi.mock('../../theme/tokens', () => ({
  borderRadius: { full: 9999 },
  spacing: { 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
}));

vi.mock('../ModalSheet', () => ({
  ModalSheet: forwardRef(function ModalSheet(
    { children, onDismiss }: { children?: ReactNode; onDismiss?: () => void },
    ref,
  ) {
    useImperativeHandle(ref, () => ({ present: vi.fn(), dismiss: vi.fn() }));
    return createElement(
      'div',
      { 'data-modal-sheet': 'true' },
      children,
      createElement('button', { 'aria-label': 'dismiss-add-to-playlist-sheet', onClick: onDismiss }, 'dismiss'),
    );
  }),
}));

vi.mock('../ClimbPreviewCard', () => ({
  ClimbPreviewCard: () => createElement('div', { 'data-climb-preview': 'true' }),
}));

vi.mock('../ListRow', () => ({
  ListRow: ({ title, subtitle, onPress }: { title: string; subtitle?: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress, 'aria-label': title }, `${title}${subtitle ? ` ${subtitle}` : ''}`),
}));

vi.mock('../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../playlist', () => ({
  PlaylistFormSheet: ({
    visible,
    submitting,
    onSubmit,
    onClose,
  }: {
    visible: boolean;
    submitting?: boolean;
    onSubmit: (values: { name: string; description?: string; color?: string; icon?: string }) => void;
    onClose: () => void;
  }) =>
    visible
      ? createElement(
          'div',
          null,
          createElement(
            'button',
            {
              'aria-label': 'submit-created-playlist',
              'data-submitting': submitting ? 'true' : 'false',
              onClick: () =>
                onSubmit({
                  name: 'Projects',
                  description: 'Moon projects',
                  color: '#ff00ff',
                  icon: 'star',
                }),
            },
            'submit create',
          ),
          createElement('button', { 'aria-label': 'close-created-playlist-form', onClick: onClose }, 'close create'),
        )
      : null,
}));

import { AddToPlaylistSheet } from '../AddToPlaylistSheet';

const climb = {
  uuid: 'climb-1',
  name: 'Big Move',
  frames: '',
  angle: 40,
} as Climb;

const playlist = {
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

function makeSheetPlaylist(uuid: string, name: string): Playlist {
  return { ...playlist, id: uuid, uuid, name };
}

function renderedPlaylistRowLabels(container: HTMLElement, playlistNames: string[]): string[] {
  const expectedNames = new Set(playlistNames);
  return Array.from(container.querySelectorAll('button[aria-label]'))
    .map((button) => button.getAttribute('aria-label') ?? '')
    .filter((label) => expectedNames.has(label));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function renderSheet(onClose = vi.fn()) {
  return {
    onClose,
    ...render(
      <AddToPlaylistSheet
        visible
        climb={climb}
        boardName="kilter"
        layoutId={1}
        sizeId={10}
        setIds="1,2"
        angle={40}
        onClose={onClose}
      />,
    ),
  };
}

describe('AddToPlaylistSheet', () => {
  beforeEach(() => {
    playlistContext.playlists = [];
    playlistContext.isLoading = false;
    playlistContext.isAuthenticated = true;
    playlistContext.addToPlaylist.mockReset();
    playlistContext.createPlaylist.mockReset();
    toast.showToast.mockReset();
  });

  it('renders existing playlist rows alphabetically by name', () => {
    const unsortedPlaylists = [
      makeSheetPlaylist('p-banana', 'banana'),
      makeSheetPlaylist('p-apple', 'Apple'),
      makeSheetPlaylist('p-eclair', 'Éclair'),
      makeSheetPlaylist('p-cherry', 'cherry'),
    ];
    playlistContext.playlists = unsortedPlaylists;
    const { container } = renderSheet();

    expect(
      renderedPlaylistRowLabels(
        container,
        unsortedPlaylists.map((entry) => entry.name),
      ),
    ).toEqual(['Apple', 'banana', 'cherry', 'Éclair']);
  });

  it('creates a playlist from the sheet and adds the current climb to it', async () => {
    const created = { ...playlist, uuid: 'p-new', id: 'p-new', name: 'Projects', climbCount: 0 };
    const createDeferred = deferred<typeof created>();
    playlistContext.createPlaylist.mockReturnValueOnce(createDeferred.promise);
    playlistContext.addToPlaylist.mockResolvedValueOnce(undefined);
    const { getByLabelText, onClose } = renderSheet();

    fireEvent.click(getByLabelText('actions.playlist.popover.createNew'));
    fireEvent.click(getByLabelText('submit-created-playlist'));

    await waitFor(() => {
      expect(playlistContext.createPlaylist).toHaveBeenCalledWith('Projects', 'Moon projects', '#ff00ff', 'star', {
        boardType: 'kilter',
        layoutId: 1,
      });
      expect(getByLabelText('submit-created-playlist').getAttribute('data-submitting')).toBe('true');
    });

    createDeferred.resolve(created);

    await waitFor(() => {
      expect(playlistContext.addToPlaylist).toHaveBeenCalledWith('p-new', 'climb-1', 40);
    });
    expect(toast.showToast).toHaveBeenCalledWith(expect.stringContaining('Projects'), 'success');
    expect(onClose).toHaveBeenCalled();
  });

  it('adds the current climb to an existing playlist row', async () => {
    playlistContext.playlists = [playlist];
    playlistContext.addToPlaylist.mockResolvedValueOnce(undefined);
    const { getByLabelText, onClose } = renderSheet();

    fireEvent.click(getByLabelText('Hard Crimps'));

    await waitFor(() => {
      expect(playlistContext.addToPlaylist).toHaveBeenCalledWith('p-1', 'climb-1', 40);
    });
    expect(toast.showToast).toHaveBeenCalledWith('actions.playlist.toast.added', 'success');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes the add sheet and shows an error when adding an existing playlist row fails', async () => {
    playlistContext.playlists = [playlist];
    playlistContext.addToPlaylist.mockRejectedValueOnce(new Error('add failed'));
    const { getByLabelText, onClose } = renderSheet();

    fireEvent.click(getByLabelText('Hard Crimps'));

    await waitFor(() => {
      expect(playlistContext.addToPlaylist).toHaveBeenCalledWith('p-1', 'climb-1', 40);
    });
    expect(toast.showToast).toHaveBeenCalledWith('actions.playlist.toast.addFailed', 'error');
    expect(onClose).toHaveBeenCalled();
  });

  it('resets the create sheet when the add sheet is dismissed mid-create', async () => {
    const created = { ...playlist, uuid: 'p-new', id: 'p-new', name: 'Projects', climbCount: 0 };
    const createDeferred = deferred<typeof created>();
    playlistContext.createPlaylist.mockReturnValueOnce(createDeferred.promise);
    playlistContext.addToPlaylist.mockResolvedValueOnce(undefined);
    const { getByLabelText, queryByLabelText, onClose } = renderSheet();

    fireEvent.click(getByLabelText('actions.playlist.popover.createNew'));
    fireEvent.click(getByLabelText('submit-created-playlist'));

    await waitFor(() => {
      expect(getByLabelText('submit-created-playlist').getAttribute('data-submitting')).toBe('true');
    });

    fireEvent.click(getByLabelText('dismiss-add-to-playlist-sheet'));

    expect(queryByLabelText('submit-created-playlist')).toBeNull();
    expect(onClose).toHaveBeenCalled();

    fireEvent.click(getByLabelText('actions.playlist.popover.createNew'));
    expect(getByLabelText('submit-created-playlist').getAttribute('data-submitting')).toBe('false');

    await act(async () => {
      createDeferred.resolve(created);
      await createDeferred.promise;
    });
    expect(playlistContext.addToPlaylist).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(getByLabelText('submit-created-playlist').getAttribute('data-submitting')).toBe('false');
  });

  it('resets the create sheet when the create form is closed mid-create', async () => {
    const created = { ...playlist, uuid: 'p-new', id: 'p-new', name: 'Projects', climbCount: 0 };
    const createDeferred = deferred<typeof created>();
    playlistContext.createPlaylist.mockReturnValueOnce(createDeferred.promise);
    playlistContext.addToPlaylist.mockResolvedValueOnce(undefined);
    const { getByLabelText, queryByLabelText, onClose } = renderSheet();

    fireEvent.click(getByLabelText('actions.playlist.popover.createNew'));
    fireEvent.click(getByLabelText('submit-created-playlist'));

    await waitFor(() => {
      expect(getByLabelText('submit-created-playlist').getAttribute('data-submitting')).toBe('true');
    });

    fireEvent.click(getByLabelText('close-created-playlist-form'));

    expect(queryByLabelText('submit-created-playlist')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(getByLabelText('actions.playlist.popover.createNew'));
    expect(getByLabelText('submit-created-playlist').getAttribute('data-submitting')).toBe('false');

    await act(async () => {
      createDeferred.resolve(created);
      await createDeferred.promise;
    });
    expect(playlistContext.addToPlaylist).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(getByLabelText('submit-created-playlist').getAttribute('data-submitting')).toBe('false');
  });

  it('keeps the add sheet open when playlist creation succeeds but adding the climb fails', async () => {
    const created = { ...playlist, uuid: 'p-new', id: 'p-new', name: 'Projects', climbCount: 0 };
    playlistContext.createPlaylist.mockResolvedValueOnce(created);
    playlistContext.addToPlaylist.mockRejectedValueOnce(new Error('add failed'));
    const { getByLabelText, queryByLabelText, onClose } = renderSheet();

    fireEvent.click(getByLabelText('actions.playlist.popover.createNew'));
    fireEvent.click(getByLabelText('submit-created-playlist'));

    await waitFor(() => {
      expect(playlistContext.addToPlaylist).toHaveBeenCalledWith('p-new', 'climb-1', 40);
    });
    expect(queryByLabelText('submit-created-playlist')).toBeNull();
    expect(toast.showToast).toHaveBeenCalledWith('actions.playlist.toast.addFailed', 'error');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the create sheet open when playlist creation fails', async () => {
    playlistContext.createPlaylist.mockRejectedValueOnce(new Error('create failed'));
    const { getByLabelText, onClose } = renderSheet();

    fireEvent.click(getByLabelText('actions.playlist.popover.createNew'));
    fireEvent.click(getByLabelText('submit-created-playlist'));

    await waitFor(() => {
      expect(toast.showToast).toHaveBeenCalledWith('actions.playlist.toast.createFailed', 'error');
    });
    expect(getByLabelText('submit-created-playlist')).not.toBeNull();
    expect(playlistContext.addToPlaylist).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not show the create action for signed-out users', () => {
    playlistContext.isAuthenticated = false;
    const { queryByLabelText, getByText } = renderSheet();

    expect(queryByLabelText('actions.playlist.popover.createNew')).toBeNull();
    expect(getByText('actions.playlist.popover.signInBlurb')).not.toBeNull();
  });
});
