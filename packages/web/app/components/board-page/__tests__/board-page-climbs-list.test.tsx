// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { BoardDetails, Climb } from '@/app/lib/types';
import type { ClimbQueueItem, UserPick } from '../../queue-control/types';
import BoardPageClimbsList from '../board-page-climbs-list';

const climbs = [makeClimb('active-climb', 'Active Climb'), makeClimb('my-pick', 'My Pick')];
const myPickItem: ClimbQueueItem = {
  uuid: 'pick-item',
  climb: climbs[1],
  addedBy: 'connection-1',
  suggested: false,
};

let mockCurrentClimb: Climb | null = climbs[0];
let mockPicks: Record<string, UserPick> = {};
let mockSessionData = {
  isSessionActive: false,
  users: [] as Array<{ id: string; username: string; isLeader: boolean; userId?: string | null }>,
  clientId: null as string | null,
};
let mockProfile: { id: string } | null = null;

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('../../graphql-queue', () => ({
  useCurrentClimb: () => ({ currentClimb: mockCurrentClimb }),
  useQueueData: () => ({ picks: mockPicks }),
  useSearchData: () => ({
    climbSearchResults: null,
    hasMoreResults: false,
    hasDoneFirstFetch: false,
    isFetchingClimbs: false,
  }),
  useSessionData: () => mockSessionData,
  useQueueActions: () => ({
    setCurrentClimb: vi.fn(),
    addToQueue: vi.fn(),
    fetchMoreClimbs: vi.fn(),
  }),
}));

vi.mock('../../party-manager/party-profile-context', () => ({
  usePartyProfile: () => ({
    profile: mockProfile,
  }),
}));

vi.mock('../../search-drawer/recent-search-pills', () => ({
  default: () => <div data-testid="recent-search-pills" />,
}));

vi.mock('../angle-selector', () => ({
  default: () => <div data-testid="angle-selector" />,
}));

vi.mock('../climbs-list', () => ({
  default: ({ selectedClimbUuid }: { selectedClimbUuid?: string | null }) => (
    <div data-testid="climbs-list" data-selected-climb-uuid={selectedClimbUuid ?? ''} />
  ),
}));

function makeClimb(uuid: string, name: string): Climb {
  return {
    uuid,
    name,
    setter_username: 'setter',
    description: '',
    frames: 'p1r14',
    angle: 40,
    ascensionist_count: 1,
    difficulty: 'V4',
    quality_average: '3.0',
    stars: 0,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
  } as Climb;
}

function makeBoardDetails(): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 1,
    set_ids: '1',
    images_to_holds: {},
    holdsData: [],
    edge_left: 0,
    edge_right: 0,
    edge_bottom: 0,
    edge_top: 0,
    boardHeight: 100,
    boardWidth: 100,
  } as unknown as BoardDetails;
}

function renderSubject() {
  render(
    <BoardPageClimbsList
      boardDetails={makeBoardDetails()}
      initialClimbs={climbs}
      board_name="kilter"
      layout_id={1}
      size_id={1}
      set_ids={[1]}
      angle={40}
    />,
  );
}

describe('BoardPageClimbsList', () => {
  beforeEach(() => {
    mockCurrentClimb = climbs[0];
    mockPicks = {};
    mockSessionData = {
      isSessionActive: false,
      users: [],
      clientId: null,
    };
    mockProfile = null;
  });

  it('selects the active board climb outside a session', () => {
    renderSubject();

    expect(screen.getByTestId('climbs-list').getAttribute('data-selected-climb-uuid')).toBe('active-climb');
  });

  it('selects my pick instead of the active board climb during a session', () => {
    mockProfile = { id: 'user-1' };
    mockSessionData = {
      isSessionActive: true,
      users: [{ id: 'connection-1', username: 'Josh', isLeader: false, userId: 'user-1' }],
      clientId: 'connection-1',
    };
    mockPicks = {
      'user-1': {
        userId: 'user-1',
        item: myPickItem,
        updatedAt: '2026-05-08T00:00:00.000Z',
      },
    };

    renderSubject();

    expect(screen.getByTestId('climbs-list').getAttribute('data-selected-climb-uuid')).toBe('my-pick');
  });
});
