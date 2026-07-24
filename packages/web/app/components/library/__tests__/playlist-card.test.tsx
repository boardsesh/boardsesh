import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import PlaylistCard from '../playlist-card';

// Mock PlaylistPreviewSquare to inspect props
const mockPreviewSquare = vi.fn();
vi.mock('../playlist-preview-square', () => ({
  default: (props: Record<string, unknown>) => {
    mockPreviewSquare(props);
    return <div data-testid="preview-square" />;
  },
}));

// Mock CSS modules
vi.mock('../library.module.css', () => ({
  default: new Proxy(
    {},
    {
      get: (_target, prop) => String(prop),
    },
  ),
}));

describe('PlaylistCard', () => {
  it('renders grid variant with PlaylistPreviewSquare', () => {
    render(
      <PlaylistCard
        name="My Kilter Playlist"
        climbCount={5}
        boardType="kilter"
        layoutId={1}
        color="#FF6600"
        icon="🔥"
        href="/playlists/abc"
        variant="grid"
        index={0}
      />,
    );

    expect(screen.getByTestId('preview-square')).toBeDefined();
    expect(mockPreviewSquare).toHaveBeenCalledWith(
      expect.objectContaining({
        boardType: 'kilter',
        layoutId: 1,
        color: '#FF6600',
        icon: '🔥',
        index: 0,
      }),
    );
  });

  it('renders scroll variant with PlaylistPreviewSquare', () => {
    render(
      <PlaylistCard
        name="My Tension Playlist"
        climbCount={12}
        boardType="tension"
        layoutId={10}
        color="#00FF00"
        href="/playlists/def"
        variant="scroll"
        index={2}
      />,
    );

    expect(screen.getByTestId('preview-square')).toBeDefined();
    expect(mockPreviewSquare).toHaveBeenCalledWith(
      expect.objectContaining({
        boardType: 'tension',
        layoutId: 10,
        color: '#00FF00',
        index: 2,
      }),
    );
  });

  it('displays name and climb count correctly', () => {
    render(
      <PlaylistCard name="Test Playlist" climbCount={3} boardType="kilter" href="/playlists/xyz" variant="scroll" />,
    );

    expect(screen.getByText('Test Playlist')).toBeDefined();
    expect(screen.getByText('3 climbs')).toBeDefined();
  });

  it('uses singular "climb" for count of 1', () => {
    render(<PlaylistCard name="Solo" climbCount={1} boardType="kilter" href="/playlists/xyz" variant="scroll" />);

    expect(screen.getByText('1 climb')).toBeDefined();
  });

  it('renders correct link href', () => {
    const { container } = render(
      <PlaylistCard name="Linked" climbCount={5} boardType="kilter" href="/playlists/linked-id" variant="grid" />,
    );

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/playlists/linked-id');
  });

  it('renders the board label on the scroll variant when provided', () => {
    render(
      <PlaylistCard
        name="Cross-board playlist"
        climbCount={8}
        boardType="tension"
        boardLabel="Tension"
        href="/playlists/xyz"
        variant="scroll"
      />,
    );

    expect(screen.getByText('Tension')).toBeDefined();
  });

  it('omits the board label when none is provided', () => {
    render(<PlaylistCard name="No label" climbCount={4} boardType="kilter" href="/playlists/xyz" variant="scroll" />);

    // The board's brand name should not appear anywhere on the card.
    expect(screen.queryByText('Kilter')).toBeNull();
  });

  it('passes isLikedClimbs through to PlaylistPreviewSquare', () => {
    mockPreviewSquare.mockClear();

    render(
      <PlaylistCard
        name="Liked"
        climbCount={10}
        boardType="kilter"
        href="/playlists/liked"
        variant="scroll"
        isLikedClimbs
      />,
    );

    expect(mockPreviewSquare).toHaveBeenCalledWith(
      expect.objectContaining({
        isLikedClimbs: true,
      }),
    );
  });
});
