import { describe, expect, it } from 'vitest';
import type { SerialBoardRequestCard, UserBoard } from '@boardsesh/shared-schema';
import type { DiscoveryBoardItem } from '../../../components/board-discovery/BoardDiscoveryCardView';
import {
  friendBoardFromRequestCard,
  requestCardOf,
  withInRangeRequestCard,
  type InRangeRequestCopy,
  type ObservedBoard,
} from '../in-range-request-card';

const CARD: SerialBoardRequestCard = {
  requested: false,
  ownerDisplayName: 'Sam',
  ownerAvatarUrl: 'https://a.test/sam.png',
  preview: { uuid: 'board-1', name: 'Garage', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 },
};

const COPY: InRangeRequestCopy = {
  titleNamed: (name) => `${name}'s board is here`,
  titleUnnamed: "A climber's board is here",
  ownerFallback: 'A climber',
};

// The hero item the picker already builds for the stub: the board type as its name.
const STUB_ITEM: DiscoveryBoardItem = {
  key: 'geometry:SER1:kilter:1:10:1,2:40',
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  title: 'kilter',
  subtitle: 'Kilter',
};

function observed(uuid: string, requestCard?: SerialBoardRequestCard): ObservedBoard {
  return { uuid, boardType: 'kilter', ...(requestCard ? { requestCard } : {}) } as ObservedBoard;
}

describe('the In range row for a board a serial matched', () => {
  it.each([
    ['a stub with a card', observed('', CARD), 'ask', "Sam's board is here"],
    [
      'a stub whose owner was already asked',
      observed('', { ...CARD, requested: true }),
      'waiting',
      "Sam's board is here",
    ],
    ['an owner with no name', observed('', { ...CARD, ownerDisplayName: '  ' }), 'ask', "A climber's board is here"],
  ] as const)('%s: asks to climb', (_label, board, askToClimb, title) => {
    const item = withInRangeRequestCard(STUB_ITEM, board as UserBoard, COPY);
    expect(item).toMatchObject({ key: STUB_ITEM.key, title, askToClimb });
    // What the board is and its angle; never the owner twice, never a place.
    expect(item.subtitle).toMatch(/^Kilter.* · 40°$/);
    expect(item.subtitle).not.toContain('Sam');
  });

  it.each([
    ['a stub with no card (Only me, over the cap, signed out)', observed('')],
    ['a board the climber can open', observed('board-1', CARD)],
  ])('%s: draws exactly as before', (_label, board) => {
    expect(withInRangeRequestCard(STUB_ITEM, board as UserBoard, COPY)).toBe(STUB_ITEM);
    expect(requestCardOf(board as UserBoard)).toBeNull();
  });

  it('opens the ask sheet on the board the card names, without the owner id', () => {
    expect(friendBoardFromRequestCard(CARD)).toEqual({
      viewerAccess: 'CAN_REQUEST',
      owner: { userId: '', displayName: 'Sam', avatarUrl: 'https://a.test/sam.png' },
      preview: CARD.preview,
      board: null,
    });
    expect(friendBoardFromRequestCard({ ...CARD, requested: true }).viewerAccess).toBe('REQUESTED');
  });
});
