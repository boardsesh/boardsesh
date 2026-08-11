import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import PlaylistEditDrawer from '../playlist-edit-drawer';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

const mockUseWsAuthToken = vi.fn();
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => mockUseWsAuthToken(),
}));

const mockExecuteGraphQL = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  executeGraphQL: (...args: unknown[]) => mockExecuteGraphQL(...args),
}));

vi.mock('@/app/components/swipeable-drawer/swipeable-drawer', () => ({
  default: (props: { open: boolean; extra?: React.ReactNode; children?: React.ReactNode }) => {
    if (!props.open) return null;
    return (
      <div data-testid="drawer">
        {props.children}
        <div data-testid="drawer-extra">{props.extra}</div>
      </div>
    );
  },
}));

function createPlaylist(overrides?: Partial<Playlist>): Playlist {
  return {
    id: '1',
    uuid: 'pl-uuid-1',
    boardType: 'kilter',
    layoutId: 1,
    name: 'Crimp circuit',
    description: 'Ten hard ones',
    isPublic: false,
    color: '#ff0000',
    icon: '🔥',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Playlist;
}

const getDescriptionField = () =>
  screen.getByPlaceholderText(tFromCatalog('playlists', 'edit.fields.descriptionPlaceholder')) as HTMLTextAreaElement;
const getSave = () =>
  within(screen.getByTestId('drawer-extra')).getByRole('button', {
    name: tFromCatalog('playlists', 'edit.actions.save'),
  });
const getRemoveIcon = () => screen.getByRole('button', { name: tFromCatalog('playlists', 'edit.fields.removeIcon') });

describe('PlaylistEditDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWsAuthToken.mockReturnValue({ token: 'test-token', isAuthenticated: true, isLoading: false });
  });

  function renderDrawer(playlist: Playlist) {
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    const queryClient = createTestQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <PlaylistEditDrawer open playlist={playlist} onClose={onClose} onSuccess={onSuccess} />
      </QueryClientProvider>,
    );
    return { onClose, onSuccess };
  }

  // The server contract is '' = clear the field, undefined = leave it unchanged.
  // The drawer used to map an emptied field to undefined, so "Remove" on the
  // icon and a cleared description silently did nothing on save.
  it("sends '' for an emptied description and a removed icon so the server clears them", async () => {
    const playlist = createPlaylist();
    mockExecuteGraphQL.mockResolvedValueOnce({ updatePlaylist: playlist });
    const { onSuccess, onClose } = renderDrawer(playlist);

    await waitFor(() => expect(getDescriptionField().value).toBe('Ten hard ones'));

    fireEvent.change(getDescriptionField(), { target: { value: '' } });
    fireEvent.click(getRemoveIcon());
    fireEvent.click(getSave());

    await waitFor(() => expect(mockExecuteGraphQL).toHaveBeenCalledTimes(1));

    const [, variables, token] = mockExecuteGraphQL.mock.calls[0];
    expect(variables).toEqual({
      input: {
        playlistId: 'pl-uuid-1',
        name: 'Crimp circuit',
        description: '',
        color: '#ff0000',
        icon: '',
        isPublic: false,
        basedOn: {
          updatedAt: '2026-01-01T00:00:00Z',
          name: 'Crimp circuit',
          description: 'Ten hard ones',
          isPublic: false,
          color: '#ff0000',
          icon: '🔥',
        },
      },
    });
    expect(token).toBe('test-token');
    expect(onSuccess).toHaveBeenCalledWith(playlist);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves untouched fields at their seeded values', async () => {
    const playlist = createPlaylist();
    mockExecuteGraphQL.mockResolvedValueOnce({ updatePlaylist: playlist });
    renderDrawer(playlist);

    await waitFor(() => expect(getDescriptionField().value).toBe('Ten hard ones'));
    fireEvent.click(getSave());

    await waitFor(() => expect(mockExecuteGraphQL).toHaveBeenCalledTimes(1));

    const [, variables] = mockExecuteGraphQL.mock.calls[0];
    expect(variables).toEqual({
      input: {
        playlistId: 'pl-uuid-1',
        name: 'Crimp circuit',
        description: 'Ten hard ones',
        color: '#ff0000',
        icon: '🔥',
        isPublic: false,
        basedOn: {
          updatedAt: '2026-01-01T00:00:00Z',
          name: 'Crimp circuit',
          description: 'Ten hard ones',
          isPublic: false,
          color: '#ff0000',
          icon: '🔥',
        },
      },
    });
  });

  it("sends '' for a playlist that never had a colour or icon", async () => {
    const playlist = createPlaylist({ color: undefined, icon: undefined, description: undefined });
    mockExecuteGraphQL.mockResolvedValueOnce({ updatePlaylist: playlist });
    renderDrawer(playlist);

    await waitFor(() => expect(getDescriptionField().value).toBe(''));
    fireEvent.click(getSave());

    await waitFor(() => expect(mockExecuteGraphQL).toHaveBeenCalledTimes(1));

    const [, variables] = mockExecuteGraphQL.mock.calls[0];
    expect(variables).toEqual({
      input: {
        playlistId: 'pl-uuid-1',
        name: 'Crimp circuit',
        description: '',
        color: '',
        icon: '',
        isPublic: false,
        basedOn: {
          updatedAt: '2026-01-01T00:00:00Z',
          name: 'Crimp circuit',
          description: null,
          isPublic: false,
          color: null,
          icon: null,
        },
      },
    });
  });

  it('sends no basedOn when the playlist has no updatedAt (a stale pre-field cache)', async () => {
    const playlist = createPlaylist({ updatedAt: '' });
    mockExecuteGraphQL.mockResolvedValueOnce({ updatePlaylist: playlist });
    renderDrawer(playlist);

    await waitFor(() => expect(getDescriptionField().value).toBe('Ten hard ones'));
    fireEvent.click(getSave());

    await waitFor(() => expect(mockExecuteGraphQL).toHaveBeenCalledTimes(1));

    const [, variables] = mockExecuteGraphQL.mock.calls[0];
    expect(variables).toEqual({
      input: {
        playlistId: 'pl-uuid-1',
        name: 'Crimp circuit',
        description: 'Ten hard ones',
        color: '#ff0000',
        icon: '🔥',
        isPublic: false,
        basedOn: undefined,
      },
    });
  });

  it('shows an error and keeps the drawer open when the mutation fails', async () => {
    const playlist = createPlaylist();
    mockExecuteGraphQL.mockRejectedValueOnce(new Error('boom'));
    const { onSuccess, onClose } = renderDrawer(playlist);

    fireEvent.click(getSave());

    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith(tFromCatalog('playlists', 'edit.messages.updateFailed'), 'error'),
    );
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  function conflictError(overrides?: Partial<Record<string, unknown>>) {
    return {
      response: {
        errors: [
          {
            message: 'Playlist changed since you loaded it',
            extensions: {
              code: 'PLAYLIST_UPDATE_CONFLICT',
              playlistUuid: 'pl-uuid-1',
              serverUpdatedAt: '2026-01-02T00:00:00Z',
              serverName: 'Crimp circuit',
              serverDescription: 'Rewritten by someone else',
              serverIsPublic: true,
              serverColor: '#00ff00',
              serverIcon: '⭐',
              ...overrides,
            },
          },
        ],
      },
    };
  }

  it('renders the conflict dialog quoting both names when the mutation is refused', async () => {
    const playlist = createPlaylist();
    mockExecuteGraphQL.mockRejectedValueOnce(conflictError({ serverName: 'Someone else renamed this' }));
    renderDrawer(playlist);

    await waitFor(() => expect(getDescriptionField().value).toBe('Ten hard ones'));
    fireEvent.change(screen.getByPlaceholderText(tFromCatalog('playlists', 'edit.fields.namePlaceholder')), {
      target: { value: 'My new name' },
    });
    fireEvent.click(getSave());

    await waitFor(() => expect(screen.getByText(tFromCatalog('playlists', 'edit.conflict.title'))).toBeTruthy());
    expect(
      screen.getByText(
        tFromCatalog('playlists', 'edit.conflict.message', {
          serverName: 'Someone else renamed this',
          yourName: 'My new name',
        }),
      ),
    ).toBeTruthy();
    // Only one attempt so far — the dialog is a resolution step, not a retry.
    expect(mockExecuteGraphQL).toHaveBeenCalledTimes(1);
  });

  it('uses the messageDetails wording when the server kept the same name', async () => {
    const playlist = createPlaylist();
    mockExecuteGraphQL.mockRejectedValueOnce(conflictError({ serverName: 'Crimp circuit' }));
    renderDrawer(playlist);

    await waitFor(() => expect(getDescriptionField().value).toBe('Ten hard ones'));
    fireEvent.click(getSave());

    await waitFor(() =>
      expect(screen.getByText(tFromCatalog('playlists', 'edit.conflict.messageDetails'))).toBeTruthy(),
    );
  });

  it('"Use theirs" adopts the server values without a second mutation call', async () => {
    const playlist = createPlaylist();
    mockExecuteGraphQL.mockRejectedValueOnce(conflictError());
    const { onSuccess, onClose } = renderDrawer(playlist);

    await waitFor(() => expect(getDescriptionField().value).toBe('Ten hard ones'));
    fireEvent.click(getSave());
    await waitFor(() => expect(screen.getByText(tFromCatalog('playlists', 'edit.conflict.title'))).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('playlists', 'edit.conflict.keepTheirs') }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Crimp circuit',
        description: 'Rewritten by someone else',
        isPublic: true,
        color: '#00ff00',
        icon: '⭐',
        updatedAt: '2026-01-02T00:00:00Z',
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockExecuteGraphQL).toHaveBeenCalledTimes(1);
  });

  it('"Keep mine" retries the mutation basedOn the server values', async () => {
    const playlist = createPlaylist();
    mockExecuteGraphQL.mockRejectedValueOnce(conflictError());
    mockExecuteGraphQL.mockResolvedValueOnce({ updatePlaylist: playlist });
    const { onSuccess } = renderDrawer(playlist);

    await waitFor(() => expect(getDescriptionField().value).toBe('Ten hard ones'));
    fireEvent.click(getSave());
    await waitFor(() => expect(screen.getByText(tFromCatalog('playlists', 'edit.conflict.title'))).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('playlists', 'edit.conflict.keepMine') }));

    await waitFor(() => expect(mockExecuteGraphQL).toHaveBeenCalledTimes(2));
    const [, variables] = mockExecuteGraphQL.mock.calls[1];
    expect((variables as { input: { basedOn: unknown } }).input.basedOn).toEqual({
      updatedAt: '2026-01-02T00:00:00Z',
      name: 'Crimp circuit',
      description: 'Rewritten by someone else',
      isPublic: true,
      color: '#00ff00',
      icon: '⭐',
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it('shows the changedAgain message inline when the retry conflicts again, without calling onSuccess', async () => {
    const playlist = createPlaylist();
    mockExecuteGraphQL.mockRejectedValueOnce(conflictError());
    mockExecuteGraphQL.mockRejectedValueOnce(conflictError({ serverUpdatedAt: '2026-01-03T00:00:00Z' }));
    const { onSuccess } = renderDrawer(playlist);

    await waitFor(() => expect(getDescriptionField().value).toBe('Ten hard ones'));
    fireEvent.click(getSave());
    await waitFor(() => expect(screen.getByText(tFromCatalog('playlists', 'edit.conflict.title'))).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('playlists', 'edit.conflict.keepMine') }));

    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith(tFromCatalog('playlists', 'edit.conflict.changedAgain'), 'error'),
    );
    expect(onSuccess).not.toHaveBeenCalled();
    // The dialog itself closes rather than chaining another prompt. MUI's
    // Dialog stays mounted through its exit transition, so give it room to
    // finish rather than asserting removal synchronously.
    await waitFor(() => expect(screen.queryByText(tFromCatalog('playlists', 'edit.conflict.title'))).toBeNull(), {
      timeout: 2000,
    });
  });

  it('cancelling the conflict dialog keeps the drawer open with the edit intact', async () => {
    const playlist = createPlaylist();
    mockExecuteGraphQL.mockRejectedValueOnce(conflictError());
    const { onClose } = renderDrawer(playlist);

    await waitFor(() => expect(getDescriptionField().value).toBe('Ten hard ones'));
    fireEvent.change(screen.getByPlaceholderText(tFromCatalog('playlists', 'edit.fields.namePlaceholder')), {
      target: { value: 'My new name' },
    });
    fireEvent.click(getSave());
    await waitFor(() => expect(screen.getByText(tFromCatalog('playlists', 'edit.conflict.title'))).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('playlists', 'edit.conflict.cancel') }));

    // MUI's Dialog stays mounted through its exit transition, so give it
    // room to finish rather than asserting removal synchronously.
    await waitFor(() => expect(screen.queryByText(tFromCatalog('playlists', 'edit.conflict.title'))).toBeNull(), {
      timeout: 2000,
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(
      (screen.getByPlaceholderText(tFromCatalog('playlists', 'edit.fields.namePlaceholder')) as HTMLInputElement).value,
    ).toBe('My new name');
  });
});
