import { describe, it, expect, vi } from 'vite-plus/test';
import { render } from '@testing-library/react';
import React from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import BoardScrollCard from '../board-scroll-card';

// Mock BoardRenderer
vi.mock('../../board-renderer/board-renderer', () => ({
  default: () => <div data-testid="board-renderer" />,
}));

// Mock getBoardDetails
vi.mock('@/app/lib/board-constants', () => ({
  getBoardDetails: vi.fn(() => ({
    board_name: 'kilter',
    layout_id: 8,
    size_id: 25,
    set_ids: [26, 27],
    images_to_holds: { 'test.png': [] },
    holdsData: [],
    edge_left: 0,
    edge_right: 100,
    edge_bottom: 0,
    edge_top: 100,
    boardWidth: 1080,
    boardHeight: 1920,
    supportsMirroring: false,
  })),
}));

// Mock getMoonBoardDetails
vi.mock('@/app/lib/moonboard-config', () => ({
  getMoonBoardDetails: vi.fn(() => null),
}));

// Mock CSS modules - return identity proxy so class names are the key themselves
vi.mock('../board-scroll.module.css', () => ({
  default: new Proxy(
    {},
    {
      get: (_target, prop) => String(prop),
    },
  ),
}));

function makeUserBoard(overrides?: Partial<UserBoard>): UserBoard {
  return {
    uuid: 'board-1',
    slug: 'my-kilter',
    ownerId: 'user-1',
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27',
    angle: 40,
    name: 'My Kilter',
    locationName: 'The Gym',
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    isAngleAdjustable: false,
    createdAt: '2024-01-01T00:00:00Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    ...overrides,
    id: overrides?.id ?? 1,
  };
}

describe('BoardScrollCard', () => {
  it('renders card with name and ascent count for own board', () => {
    const onClick = vi.fn();
    const { getByText } = render(
      <BoardScrollCard userBoard={makeUserBoard({ totalAscents: 1500 })} onClick={onClick} />,
    );

    expect(getByText('My Kilter')).toBeDefined();
    expect(getByText('1.5k sends')).toBeDefined();
  });

  it('renders card with type and location for nearby board', () => {
    const onClick = vi.fn();
    const { getByText } = render(
      <BoardScrollCard userBoard={makeUserBoard({ distanceMeters: 500 })} onClick={onClick} />,
    );

    expect(getByText('My Kilter')).toBeDefined();
    expect(getByText('Kilter · The Gym')).toBeDefined();
  });

  it('renders BoardRenderer immediately when boardDetails available', () => {
    const onClick = vi.fn();
    const { getByTestId } = render(<BoardScrollCard userBoard={makeUserBoard()} onClick={onClick} />);

    expect(getByTestId('board-renderer')).toBeDefined();
  });

  it('shows fallback icon when no board data provided', () => {
    const onClick = vi.fn();
    const { queryByTestId, container } = render(<BoardScrollCard onClick={onClick} />);

    expect(queryByTestId('board-renderer')).toBeNull();
    expect(container.querySelector('.cardFallback')).not.toBeNull();
  });

  it('disabled card does not trigger onClick', () => {
    const onClick = vi.fn();
    const { getByText } = render(<BoardScrollCard userBoard={makeUserBoard()} onClick={onClick} disabled />);

    const nameEl = getByText('My Kilter');
    const cardRoot = nameEl.parentElement!;
    cardRoot.click();

    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows disabledText when disabled', () => {
    const onClick = vi.fn();
    const { getByText, queryByText } = render(
      <BoardScrollCard userBoard={makeUserBoard()} onClick={onClick} disabled disabledText="Not available" />,
    );

    expect(getByText('Not available')).toBeDefined();
    // The normal meta should be replaced
    expect(queryByText('0 sends')).toBeNull();
  });

  it('selected card has selected class', () => {
    const onClick = vi.fn();
    const { getByText } = render(<BoardScrollCard userBoard={makeUserBoard()} onClick={onClick} selected />);

    const nameEl = getByText('My Kilter');
    const cardRoot = nameEl.parentElement!;
    const cardSquare = cardRoot.querySelector('.cardSquareSelected');
    expect(cardSquare).not.toBeNull();
  });

  it('small size variant applies correct class', () => {
    const onClick = vi.fn();
    const { getByText } = render(<BoardScrollCard userBoard={makeUserBoard()} onClick={onClick} size="small" />);

    const nameEl = getByText('My Kilter');
    const cardRoot = nameEl.parentElement!;
    expect(cardRoot.className).toContain('cardScrollSmall');
  });
});
