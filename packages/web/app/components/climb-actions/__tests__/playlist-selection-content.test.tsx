import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BoardDetails } from '@/app/lib/types';
import PlaylistSelectionContent from '../playlist-selection-content';

const mockUsePlaylists = vi.fn();
const mockShowMessage = vi.fn();

vi.mock('../use-playlists', () => ({
  usePlaylists: (args: unknown) => mockUsePlaylists(args),
}));

vi.mock('../../providers/snackbar-provider', () => ({
  useSnackbar: () => ({
    showMessage: mockShowMessage,
  }),
}));

vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal: vi.fn() }),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

function createBoardDetails(overrides?: Partial<BoardDetails>): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 1,
    set_ids: '1',
    images_to_holds: {},
    holdsData: {},
    edge_left: 0,
    edge_right: 0,
    edge_bottom: 0,
    edge_top: 0,
    boardHeight: 100,
    boardWidth: 100,
    ...overrides,
  } as BoardDetails;
}

describe('PlaylistSelectionContent failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows add failure message when addToPlaylist rejects', async () => {
    mockUsePlaylists.mockReturnValue({
      playlists: [{ uuid: 'pl-1', id: '1', name: 'Test Playlist', climbCount: 3, color: null }],
      playlistsContainingClimb: new Set<string>(),
      addToPlaylist: vi.fn().mockRejectedValue(new Error('network')),
      removeFromPlaylist: vi.fn(),
      createPlaylist: vi.fn(),
      isAuthenticated: true,
      isLoading: false,
    });

    render(<PlaylistSelectionContent climbUuid="climb-1" angle={40} boardDetails={createBoardDetails()} />);

    fireEvent.click(screen.getByText('Test Playlist'));

    await waitFor(() => {
      expect(mockShowMessage).toHaveBeenCalledWith('Failed to add to playlist', 'error');
    });
  });

  it('shows remove failure message when removeFromPlaylist rejects', async () => {
    mockUsePlaylists.mockReturnValue({
      playlists: [{ uuid: 'pl-1', id: '1', name: 'Test Playlist', climbCount: 3, color: null }],
      playlistsContainingClimb: new Set<string>(['pl-1']),
      addToPlaylist: vi.fn(),
      removeFromPlaylist: vi.fn().mockRejectedValue(new Error('network')),
      createPlaylist: vi.fn(),
      isAuthenticated: true,
      isLoading: false,
    });

    render(<PlaylistSelectionContent climbUuid="climb-1" angle={40} boardDetails={createBoardDetails()} />);

    fireEvent.click(screen.getByText('Test Playlist'));

    await waitFor(() => {
      expect(mockShowMessage).toHaveBeenCalledWith('Failed to remove from playlist', 'error');
    });
  });

  it('shows create failure message when createPlaylist rejects', async () => {
    const onDone = vi.fn();
    mockUsePlaylists.mockReturnValue({
      playlists: [{ uuid: 'pl-1', id: '1', name: 'Test Playlist', climbCount: 3, color: null }],
      playlistsContainingClimb: new Set<string>(),
      addToPlaylist: vi.fn(),
      removeFromPlaylist: vi.fn(),
      createPlaylist: vi.fn().mockRejectedValue(new Error('network')),
      isAuthenticated: true,
      isLoading: false,
    });

    render(
      <PlaylistSelectionContent climbUuid="climb-1" angle={40} boardDetails={createBoardDetails()} onDone={onDone} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /create new playlist/i }));
    fireEvent.change(screen.getByPlaceholderText('e.g., Hard Crimps'), {
      target: { value: 'My Playlist' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockShowMessage).toHaveBeenCalledWith('Failed to create playlist', 'error');
    });
    expect(onDone).not.toHaveBeenCalled();
  });

  it('supports keyboard selection on playlist items', async () => {
    const addToPlaylist = vi.fn().mockResolvedValue(undefined);
    mockUsePlaylists.mockReturnValue({
      playlists: [{ uuid: 'pl-1', id: '1', name: 'Keyboard Playlist', climbCount: 3, color: null }],
      playlistsContainingClimb: new Set<string>(),
      addToPlaylist,
      removeFromPlaylist: vi.fn(),
      createPlaylist: vi.fn(),
      isAuthenticated: true,
      isLoading: false,
    });

    render(<PlaylistSelectionContent climbUuid="climb-1" angle={40} boardDetails={createBoardDetails()} />);

    const playlistItem = screen.getByRole('button', { name: /add to playlist keyboard playlist/i });
    expect(playlistItem.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(playlistItem, { key: 'Enter' });

    await waitFor(() => {
      expect(addToPlaylist).toHaveBeenCalledWith('pl-1');
    });
  });

  it('uses newPlaylist.uuid (not id) when auto-adding after create', async () => {
    const addToPlaylist = vi.fn().mockResolvedValue(undefined);
    const createPlaylist = vi.fn().mockResolvedValue({
      id: 'numeric-id',
      uuid: 'uuid-id',
      name: 'Created Playlist',
      climbCount: 0,
      color: null,
    });

    mockUsePlaylists.mockReturnValue({
      playlists: [{ uuid: 'pl-1', id: '1', name: 'Existing Playlist', climbCount: 3, color: null }],
      playlistsContainingClimb: new Set<string>(),
      addToPlaylist,
      removeFromPlaylist: vi.fn(),
      createPlaylist,
      isAuthenticated: true,
      isLoading: false,
    });

    render(<PlaylistSelectionContent climbUuid="climb-1" angle={40} boardDetails={createBoardDetails()} />);

    fireEvent.click(screen.getByRole('button', { name: /create new playlist/i }));
    fireEvent.change(screen.getByPlaceholderText('e.g., Hard Crimps'), {
      target: { value: 'Created Playlist' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(createPlaylist).toHaveBeenCalled();
      expect(addToPlaylist).toHaveBeenCalledWith('uuid-id');
    });
  });
});
