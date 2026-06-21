import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardSerialConfig } from '@boardsesh/graphql/operations';
import { GET_BOARDS_BY_SERIAL_NUMBERS, GET_MY_BOARD_SERIAL_CONFIGS } from '@boardsesh/graphql/operations';

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

import { resolveSerialNumbers } from '../resolve-serials';

type SavedResponse = { boardsBySerialNumbers: UserBoard[] };
type RecordedResponse = { myBoardSerialConfigs: BoardSerialConfig[] };

/**
 * Wire mockRequest to dispatch by GraphQL operation. Either response can be a
 * value (resolves) or an Error (rejects). Call-order-independent so the test
 * doesn't break if Promise.all interleaves differently.
 */
function setRequests(opts: { saved?: SavedResponse | Error; recorded?: RecordedResponse | Error }) {
  mockRequest.mockImplementation((doc: unknown) => {
    if (doc === GET_BOARDS_BY_SERIAL_NUMBERS) {
      const r = opts.saved ?? { boardsBySerialNumbers: [] };
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }
    if (doc === GET_MY_BOARD_SERIAL_CONFIGS) {
      const r = opts.recorded ?? { myBoardSerialConfigs: [] };
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }
    return Promise.reject(new Error(`Unexpected GraphQL document in test: ${String(doc)}`));
  });
}

function savedBoard(serialNumber: string, overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid: `board-${serialNumber}`,
    slug: `board-${serialNumber}`,
    ownerId: 'owner',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    name: `Board ${serialNumber}`,
    isPublic: false,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: new Date(0).toISOString(),
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    serialNumber,
    ...overrides,
  } as UserBoard;
}

function recordedConfig(serialNumber: string, overrides: Partial<BoardSerialConfig> = {}): BoardSerialConfig {
  return {
    serialNumber,
    boardName: 'tension',
    layoutId: 2,
    sizeId: 5,
    setIds: '1',
    apiLevel: null,
    updatedAt: new Date(0).toISOString(),
    boardUuid: null,
    boardSlug: null,
    ...overrides,
  };
}

describe('resolveSerialNumbers', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty Map when no serials are passed', async () => {
    const result = await resolveSerialNumbers('tok', [], { isAuthenticated: true });
    expect(result.size).toBe(0);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('dedupes serials before issuing the request', async () => {
    setRequests({});

    await resolveSerialNumbers('tok', ['A', 'A', 'B'], { isAuthenticated: true });

    // Both calls receive the deduped serial array
    expect(mockRequest).toHaveBeenCalledTimes(2);
    for (const call of mockRequest.mock.calls) {
      expect(call[1]).toEqual({ serialNumbers: ['A', 'B'] });
    }
  });

  it('saved-board entries take precedence over recorded entries on the same serial', async () => {
    setRequests({
      saved: { boardsBySerialNumbers: [savedBoard('SN-1', { name: 'Real Board' })] },
      recorded: { myBoardSerialConfigs: [recordedConfig('SN-1', { boardName: 'kilter', layoutId: 99 })] },
    });

    const result = await resolveSerialNumbers('tok', ['SN-1'], { isAuthenticated: true });

    const entry = result.get('SN-1');
    expect(entry?.kind).toBe('saved');
    expect(entry?.kind === 'saved' && entry.board.name).toBe('Real Board');
  });

  it('falls back to recorded entry when no saved board matches the serial', async () => {
    setRequests({
      saved: { boardsBySerialNumbers: [] },
      recorded: { myBoardSerialConfigs: [recordedConfig('SN-2')] },
    });

    const result = await resolveSerialNumbers('tok', ['SN-2'], { isAuthenticated: true });

    const entry = result.get('SN-2');
    expect(entry?.kind).toBe('recorded');
  });

  it('skips saved boards with a null serialNumber so they do not poison the map', async () => {
    setRequests({
      saved: { boardsBySerialNumbers: [savedBoard('SN-3', { serialNumber: null as unknown as string })] },
    });

    const result = await resolveSerialNumbers('tok', ['SN-3'], { isAuthenticated: true });
    expect(result.has('SN-3')).toBe(false);
  });

  it('saved-board half still surfaces when the recorded query rejects', async () => {
    setRequests({
      saved: { boardsBySerialNumbers: [savedBoard('SN-4')] },
      recorded: new Error('recorded query failed'),
    });

    const result = await resolveSerialNumbers('tok', ['SN-4'], { isAuthenticated: true });

    expect(result.get('SN-4')?.kind).toBe('saved');
  });

  it('returns the recorded fallback when the saved query rejects', async () => {
    setRequests({
      saved: new Error('saved query failed'),
      recorded: { myBoardSerialConfigs: [recordedConfig('SN-5')] },
    });

    const result = await resolveSerialNumbers('tok', ['SN-5'], { isAuthenticated: true });

    expect(result.get('SN-5')?.kind).toBe('recorded');
  });

  it('returns an empty Map when both queries reject (no exception bubbles up)', async () => {
    setRequests({ saved: new Error('saved'), recorded: new Error('recorded') });

    const result = await resolveSerialNumbers('tok', ['SN-6'], { isAuthenticated: true });
    expect(result.size).toBe(0);
  });

  it('skips the recorded query entirely for unauthenticated callers', async () => {
    setRequests({});

    await resolveSerialNumbers('tok', ['SN-7']); // no isAuthenticated

    // Only the public boardsBySerialNumbers query fired
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0][0]).toBe(GET_BOARDS_BY_SERIAL_NUMBERS);
  });
});
