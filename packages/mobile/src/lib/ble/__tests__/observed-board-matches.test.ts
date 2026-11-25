import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SerialBoardRequestCard, UserBoard } from '@boardsesh/shared-schema';
import {
  GET_OBSERVED_BOARD_SERIAL_MATCHES,
  GET_OBSERVED_BOARD_SERIAL_MATCHES_WITH_REQUEST_CARDS,
} from '@boardsesh/graphql/operations';
import { requestCardOf } from '../../boards/in-range-request-card';

const harness = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: harness.request }) }));

const { fetchBoardsForObservedSerials } = await import('../observed-board-matches');

// The anonymous stub a private board comes back as (#6375): no uuid, the board type as its name.
function stub(overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid: '',
    slug: '',
    ownerId: '',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,2',
    name: 'kilter',
    isPublic: false,
    isUnlisted: false,
    hideLocation: false,
    isOwned: false,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    canEdit: false,
    serialNumber: null,
    ...overrides,
  };
}

const CARD: SerialBoardRequestCard = {
  requested: false,
  ownerDisplayName: 'Sam',
  ownerAvatarUrl: null,
  preview: { uuid: 'board-1', name: 'Garage', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 },
};

const KILTER = new Map([['SER1', 'kilter' as const]]);

beforeEach(() => harness.request.mockReset());

describe('fetchBoardsForObservedSerials request cards', () => {
  it('asks for cards only when told to, and puts each on the stub it stands for', async () => {
    const readable = stub({ uuid: 'readable-1', name: 'Open wall' });
    harness.request.mockResolvedValue({
      observedBoardSerialMatches: [
        {
          boardType: 'kilter',
          observedSerialNumber: 'SER1',
          candidates: [readable, stub()],
          candidateRequestCards: [null, CARD],
        },
      ],
    });

    const boards = await fetchBoardsForObservedSerials(['SER1'], KILTER, { requestCards: true });

    expect(harness.request).toHaveBeenCalledWith(GET_OBSERVED_BOARD_SERIAL_MATCHES_WITH_REQUEST_CARDS, {
      input: [{ boardType: 'kilter', observedSerialNumber: 'SER1' }],
    });
    expect(boards.map(requestCardOf)).toEqual([null, CARD]);
    expect(boards.map((board) => board.serialNumber)).toEqual(['SER1', 'SER1']);
  });

  it('keeps the old lookup, with no cards, for every other caller', async () => {
    harness.request.mockResolvedValue({
      observedBoardSerialMatches: [{ boardType: 'kilter', observedSerialNumber: 'SER1', candidates: [stub()] }],
    });
    const boards = await fetchBoardsForObservedSerials(['SER1'], KILTER);
    expect(harness.request).toHaveBeenCalledWith(GET_OBSERVED_BOARD_SERIAL_MATCHES, expect.anything());
    expect(boards.map(requestCardOf)).toEqual([null]);
  });

  it('never turns a board the climber can open into a request', async () => {
    harness.request.mockResolvedValue({
      observedBoardSerialMatches: [
        {
          boardType: 'kilter',
          observedSerialNumber: 'SER1',
          candidates: [stub({ uuid: 'readable-1' }), stub({ boardType: 'tension' })],
          // A card on a readable board, and a card of another board type: both ignored.
          candidateRequestCards: [CARD, { ...CARD, preview: { ...CARD.preview, boardType: 'tension' } }],
        },
      ],
    });
    const boards = await fetchBoardsForObservedSerials(['SER1'], KILTER, { requestCards: true });
    expect(boards.map(requestCardOf)).toEqual([null]);
  });
});
