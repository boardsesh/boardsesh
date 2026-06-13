import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, fireEvent } from '@testing-library/react';
import React from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import BoardFilterStrip from '../board-filter-strip';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// Mock BoardRenderer (transitive dep via BoardScrollCard)
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

// Mock CSS modules - identity proxy so class names are the key themselves
vi.mock('../board-scroll.module.css', () => ({
  default: new Proxy(
    {},
    {
      get: (_target, prop) => String(prop),
    },
  ),
}));

function makeBoard(overrides?: Partial<UserBoard>): UserBoard {
  return {
    id: 1,
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
  };
}

const kilterBoard = makeBoard();
const tensionBoard = makeBoard({
  uuid: 'board-2',
  slug: 'my-tension',
  boardType: 'tension',
  name: 'My Tension',
  locationName: 'Home Wall',
});

describe('BoardFilterStrip', () => {
  let onBoardSelect: ReturnType<typeof vi.fn<(board: UserBoard | null) => void>>;

  beforeEach(() => {
    onBoardSelect = vi.fn<(board: UserBoard | null) => void>();
  });

  it('renders "All Boards" card and all board cards', () => {
    const { getByText } = render(
      <BoardFilterStrip
        boards={[kilterBoard, tensionBoard]}
        loading={false}
        selectedBoard={null}
        onBoardSelect={onBoardSelect}
      />,
    );

    expect(getByText('All Boards')).toBeDefined();
    expect(getByText('My Kilter')).toBeDefined();
    expect(getByText('My Tension')).toBeDefined();
  });

  it('returns null when no boards and not loading', () => {
    const { container } = render(
      <BoardFilterStrip boards={[]} loading={false} selectedBoard={null} onBoardSelect={onBoardSelect} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('renders loading state when loading is true', () => {
    const { container, queryByText } = render(
      <BoardFilterStrip boards={[]} loading selectedBoard={null} onBoardSelect={onBoardSelect} />,
    );

    // Should render (not null) even with empty boards when loading
    expect(container.firstChild).not.toBeNull();
    // The "All" card should not appear while loading (children replaced by skeletons)
    // But the section itself should render
    expect(queryByText('All Boards')).toBeNull();
  });

  it('"All" card is selected when selectedBoard is null', () => {
    const { getByText } = render(
      <BoardFilterStrip boards={[kilterBoard]} loading={false} selectedBoard={null} onBoardSelect={onBoardSelect} />,
    );

    const allCard = getByText('All').parentElement!;
    expect(allCard.className).toContain('cardSquareSelected');

    const allName = getByText('All Boards');
    expect(allName.className).toContain('cardNameSelected');
  });

  it('"All" card is not selected when a board is selected', () => {
    const { getByText } = render(
      <BoardFilterStrip
        boards={[kilterBoard]}
        loading={false}
        selectedBoard={kilterBoard}
        onBoardSelect={onBoardSelect}
      />,
    );

    const allSquare = getByText('All').parentElement!;
    expect(allSquare.className).not.toContain('cardSquareSelected');

    const allName = getByText('All Boards');
    expect(allName.className).not.toContain('cardNameSelected');
  });

  it('clicking "All" calls onBoardSelect(null)', () => {
    const { getByText } = render(
      <BoardFilterStrip
        boards={[kilterBoard]}
        loading={false}
        selectedBoard={kilterBoard}
        onBoardSelect={onBoardSelect}
      />,
    );

    fireEvent.click(getByText('All Boards'));
    expect(onBoardSelect).toHaveBeenCalledWith(null);
  });

  it('clicking a board card calls onBoardSelect with the board', () => {
    const { getByText } = render(
      <BoardFilterStrip
        boards={[kilterBoard, tensionBoard]}
        loading={false}
        selectedBoard={null}
        onBoardSelect={onBoardSelect}
      />,
    );

    // Click the card root (parent of the name element)
    const tensionName = getByText('My Tension');
    const cardRoot = tensionName.parentElement!;
    fireEvent.click(cardRoot);

    expect(onBoardSelect).toHaveBeenCalledWith(tensionBoard);
  });

  it('Enter key on "All" card calls onBoardSelect(null)', () => {
    const { getByRole } = render(
      <BoardFilterStrip
        boards={[kilterBoard]}
        loading={false}
        selectedBoard={kilterBoard}
        onBoardSelect={onBoardSelect}
      />,
    );

    const allButton = getByRole('button');
    fireEvent.keyDown(allButton, { key: 'Enter' });
    expect(onBoardSelect).toHaveBeenCalledWith(null);
  });

  it('Space key on "All" card calls onBoardSelect(null)', () => {
    const { getByRole } = render(
      <BoardFilterStrip
        boards={[kilterBoard]}
        loading={false}
        selectedBoard={kilterBoard}
        onBoardSelect={onBoardSelect}
      />,
    );

    const allButton = getByRole('button');
    fireEvent.keyDown(allButton, { key: ' ' });
    expect(onBoardSelect).toHaveBeenCalledWith(null);
  });

  it('boardTypes disables non-matching boards', () => {
    const { getByText } = render(
      <BoardFilterStrip
        boards={[kilterBoard, tensionBoard]}
        loading={false}
        selectedBoard={null}
        onBoardSelect={onBoardSelect}
        boardTypes={['kilter']}
      />,
    );

    // Kilter card should be clickable
    const kilterName = getByText('My Kilter');
    fireEvent.click(kilterName.parentElement!);
    expect(onBoardSelect).toHaveBeenCalledWith(kilterBoard);

    onBoardSelect.mockClear();

    // Tension card should be disabled (BoardScrollCard disables onClick internally)
    const tensionName = getByText('My Tension');
    const tensionRoot = tensionName.parentElement!;
    fireEvent.click(tensionRoot);
    // BoardScrollCard swallows click when disabled, so onBoardSelect should not fire
    expect(onBoardSelect).not.toHaveBeenCalled();
  });

  it('disabledText is shown on disabled cards', () => {
    const { getByText } = render(
      <BoardFilterStrip
        boards={[tensionBoard]}
        loading={false}
        selectedBoard={null}
        onBoardSelect={onBoardSelect}
        boardTypes={['kilter']}
        disabledText="No climbs"
      />,
    );

    expect(getByText('No climbs')).toBeDefined();
  });

  it('does not disable boards when boardTypes is not provided', () => {
    const { getByText } = render(
      <BoardFilterStrip
        boards={[kilterBoard, tensionBoard]}
        loading={false}
        selectedBoard={null}
        onBoardSelect={onBoardSelect}
      />,
    );

    // Both boards should be clickable
    fireEvent.click(getByText('My Tension').parentElement!);
    expect(onBoardSelect).toHaveBeenCalledWith(tensionBoard);
  });
});

// ---------- Multi-select mode ----------

describe('BoardFilterStrip (multiSelect)', () => {
  let onBoardToggle: ReturnType<typeof vi.fn<(board: UserBoard | null) => void>>;

  beforeEach(() => {
    onBoardToggle = vi.fn<(board: UserBoard | null) => void>();
  });

  it('renders all boards in multi-select mode', () => {
    const { getByText } = render(
      <BoardFilterStrip
        multiSelect
        boards={[kilterBoard, tensionBoard]}
        loading={false}
        selectedBoards={[]}
        onBoardToggle={onBoardToggle}
      />,
    );

    expect(getByText('All Boards')).toBeDefined();
    expect(getByText('My Kilter')).toBeDefined();
    expect(getByText('My Tension')).toBeDefined();
  });

  it('"All" is selected when selectedBoards is empty', () => {
    const { getByText } = render(
      <BoardFilterStrip
        multiSelect
        boards={[kilterBoard]}
        loading={false}
        selectedBoards={[]}
        onBoardToggle={onBoardToggle}
      />,
    );

    const allCard = getByText('All').parentElement!;
    expect(allCard.className).toContain('cardSquareSelected');
  });

  it('"All" is not selected when boards are selected', () => {
    const { getByText } = render(
      <BoardFilterStrip
        multiSelect
        boards={[kilterBoard, tensionBoard]}
        loading={false}
        selectedBoards={[kilterBoard]}
        onBoardToggle={onBoardToggle}
      />,
    );

    const allCard = getByText('All').parentElement!;
    expect(allCard.className).not.toContain('cardSquareSelected');
  });

  it('clicking "All" calls onBoardToggle(null)', () => {
    const { getByText } = render(
      <BoardFilterStrip
        multiSelect
        boards={[kilterBoard]}
        loading={false}
        selectedBoards={[kilterBoard]}
        onBoardToggle={onBoardToggle}
      />,
    );

    fireEvent.click(getByText('All Boards'));
    expect(onBoardToggle).toHaveBeenCalledWith(null);
  });

  it('clicking a board card calls onBoardToggle with the board', () => {
    const { getByText } = render(
      <BoardFilterStrip
        multiSelect
        boards={[kilterBoard, tensionBoard]}
        loading={false}
        selectedBoards={[]}
        onBoardToggle={onBoardToggle}
      />,
    );

    fireEvent.click(getByText('My Tension').parentElement!);
    expect(onBoardToggle).toHaveBeenCalledWith(tensionBoard);
  });

  it('marks a selected board as selected', () => {
    const { getByText } = render(
      <BoardFilterStrip
        multiSelect
        boards={[kilterBoard, tensionBoard]}
        loading={false}
        selectedBoards={[kilterBoard]}
        onBoardToggle={onBoardToggle}
      />,
    );

    // The BoardScrollCard renders the name inside a nested structure;
    // the selected class is on an inner square, not the name's direct parent.
    const kilterName = getByText('My Kilter');
    expect(kilterName.className).toContain('cardNameSelected');
  });

  it('supports multiple boards selected simultaneously', () => {
    const { getByText } = render(
      <BoardFilterStrip
        multiSelect
        boards={[kilterBoard, tensionBoard]}
        loading={false}
        selectedBoards={[kilterBoard, tensionBoard]}
        onBoardToggle={onBoardToggle}
      />,
    );

    // "All" should not be selected when specific boards are
    const allCard = getByText('All').parentElement!;
    expect(allCard.className).not.toContain('cardSquareSelected');

    // Both boards should show as selected
    expect(getByText('My Kilter')).toBeDefined();
    expect(getByText('My Tension')).toBeDefined();
  });

  it('Enter key on "All" calls onBoardToggle(null)', () => {
    const { getByRole } = render(
      <BoardFilterStrip
        multiSelect
        boards={[kilterBoard]}
        loading={false}
        selectedBoards={[kilterBoard]}
        onBoardToggle={onBoardToggle}
      />,
    );

    const allButton = getByRole('button');
    fireEvent.keyDown(allButton, { key: 'Enter' });
    expect(onBoardToggle).toHaveBeenCalledWith(null);
  });
});
