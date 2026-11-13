import { describe, it, expect, vi } from 'vite-plus/test';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import type { BoardImageDetails, Climb } from '@/app/lib/types';
import ClimbThumbnail from '../climb-thumbnail';

const mockPathname = '/b/moonrise-gym/40/list';

const boardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 2,
  set_ids: [3, 4],
  backgroundImagePaths: [],

  boardHeight: 100,
  boardWidth: 100,
  layout_name: 'Homewall',
  size_name: '8x12 Full Ride',
  size_description: 'Main',
  set_names: ['Main Kicker', 'Aux Kicker'],
} as BoardImageDetails;

const climb = {
  uuid: 'ABC123',
  name: 'Moon Landing',
  angle: 40,
  setter_username: 'setter',
  description: '',
  frames: '',
  ascensionist_count: 0,
  difficulty: 'V4',
  quality_average: '3',
  stars: 0,
  difficulty_error: '0',
  benchmark_difficulty: null,
} as Climb;

describe('ClimbThumbnail', () => {
  it('fires onClick when a climb is present', () => {
    const onClick = vi.fn();
    render(
      <ClimbThumbnail boardDetails={boardDetails} currentClimb={climb} pathname={mockPathname} onClick={onClick} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not expose a button when there is no climb', () => {
    render(
      <ClimbThumbnail boardDetails={boardDetails} currentClimb={null} pathname={mockPathname} onClick={vi.fn()} />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});
