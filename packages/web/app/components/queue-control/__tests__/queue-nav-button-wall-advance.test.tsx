// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { ClimbQueueItem } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string) => key,
  }),
}));

const { mockTrack } = vi.hoisted(() => ({ mockTrack: vi.fn() }));
vi.mock('@/app/lib/analytics', () => ({ track: mockTrack }));

const mockSetCurrentClimbQueueItem = vi.fn();
const mockGetNextClimbQueueItem = vi.fn();
const mockGetPreviousClimbQueueItem = vi.fn();

let sessionDataMock: { viewOnlyMode: boolean; isPersistentSessionActive: boolean } = {
  viewOnlyMode: false,
  isPersistentSessionActive: false,
};

vi.mock('../../graphql-queue', () => ({
  useQueueActions: () => ({
    setCurrentClimbQueueItem: mockSetCurrentClimbQueueItem,
    getNextClimbQueueItem: mockGetNextClimbQueueItem,
    getPreviousClimbQueueItem: mockGetPreviousClimbQueueItem,
  }),
  useSessionData: () => sessionDataMock,
}));

vi.mock('@/app/hooks/use-resolved-board-details', () => ({
  useResolvedBoardDetails: () => ({
    rawParams: {
      board_name: 'kilter',
      layout_id: '1',
      size_id: '1',
      set_ids: '1',
      angle: '40',
    },
    angle: 40,
    searchParams: new URLSearchParams(),
    isPlayPage: false,
    resolvedDetails: {
      board_name: 'kilter',
      layout_name: 'Original',
      size_name: '12x12',
      size_description: 'Standard',
      set_names: ['Base'],
    },
  }),
}));

import QueueNavButton from '../queue-nav-button';

const sampleItem: ClimbQueueItem = {
  uuid: 'queue-target',
  climb: {
    uuid: 'climb-target',
    name: 'Target Climb',
    setter_username: 'setter',
    description: '',
    frames: 'p1r12',
    angle: 40,
    ascensionist_count: 1,
    difficulty: 'V4',
    quality_average: '3.0',
    stars: 0,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
  },
};

const boardDetails = { layout_name: 'Original' } as Parameters<typeof QueueNavButton>[0]['boardDetails'];

function findWallAdvanceCall() {
  return mockTrack.mock.calls.find((args) => args[0] === 'Wall Advance');
}

describe('QueueNavButton Wall Advance event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNextClimbQueueItem.mockReturnValue(sampleItem);
    mockGetPreviousClimbQueueItem.mockReturnValue(sampleItem);
    sessionDataMock = { viewOnlyMode: false, isPersistentSessionActive: false };
  });

  it('fires Wall Advance with bar_button source in solo mode', () => {
    render(<QueueNavButton direction="next" boardDetails={boardDetails} />);

    fireEvent.click(screen.getByRole('button'));

    const call = findWallAdvanceCall();
    expect(call).toBeTruthy();
    // Always-live model: no pressedByRole — every press is an unqualified
    // broadcast advance.
    expect(call?.[1]).toMatchObject({
      source: 'bar_button',
      direction: 'next',
      mode: 'solo',
      boardLayout: 'Original',
    });
    expect(call?.[1]).not.toHaveProperty('pressedByRole');
  });

  it('fires Wall Advance with mode=party when any participant presses in a party session', () => {
    sessionDataMock = { viewOnlyMode: false, isPersistentSessionActive: true };
    render(<QueueNavButton direction="previous" boardDetails={boardDetails} />);

    fireEvent.click(screen.getByRole('button'));

    const call = findWallAdvanceCall();
    expect(call).toBeTruthy();
    expect(call?.[1]).toMatchObject({
      source: 'bar_button',
      direction: 'previous',
      mode: 'party',
      boardLayout: 'Original',
    });
    expect(call?.[1]).not.toHaveProperty('pressedByRole');
  });

  it('still fires Queue Navigation alongside Wall Advance (analytics continuity)', () => {
    render(<QueueNavButton direction="next" boardDetails={boardDetails} />);

    fireEvent.click(screen.getByRole('button'));

    const queueNavCall = mockTrack.mock.calls.find((args) => args[0] === 'Queue Navigation');
    const wallAdvanceCall = findWallAdvanceCall();
    expect(queueNavCall).toBeTruthy();
    expect(wallAdvanceCall).toBeTruthy();
  });

  it('disables the button when there is no advance target', () => {
    mockGetNextClimbQueueItem.mockReturnValue(null);
    render(<QueueNavButton direction="next" boardDetails={boardDetails} />);

    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(findWallAdvanceCall()).toBeUndefined();
  });
});
