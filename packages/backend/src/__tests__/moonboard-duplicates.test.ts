import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    execute: vi.fn(),
  },
}));

vi.mock('../db/client', () => ({
  db: mockDb,
  createRequestDb: () => mockDb,
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb),
}));

import {
  buildMoonBoardClimbHoldRows,
  buildMoonBoardDuplicateError,
  encodeMoonBoardHoldsToFrames,
  findMoonBoardDuplicateMatches,
} from '../graphql/resolvers/climbs/moonboard-duplicates';

describe('moonboard duplicate helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the highest-ascension exact duplicate match by name', async () => {
    mockDb.execute
      .mockResolvedValueOnce([
        {
          uuid: 'popular-climb',
          name: 'Popular Moon',
          ascensionist_count: 42,
          signature: '1:STARTING,13:HAND,25:FINISH',
        },
        {
          uuid: 'older-climb',
          name: 'Older Moon',
          ascensionist_count: 4,
          signature: '1:STARTING,13:HAND,25:FINISH',
        },
      ])
      .mockResolvedValueOnce([]);

    const result = await findMoonBoardDuplicateMatches(mockDb as never, 2, 40, [
      {
        clientKey: 'candidate-1',
        holds: {
          start: ['A1'],
          hand: ['B2'],
          finish: ['C3'],
        },
      },
    ]);

    expect(result).toEqual([
      {
        clientKey: 'candidate-1',
        exists: true,
        existingClimbUuid: 'popular-climb',
        existingClimbName: 'Popular Moon',
      },
    ]);
  });

  it('falls back to legacy MoonBoard climbs that do not have hold rows yet', async () => {
    const holds = {
      start: ['A1'],
      hand: ['B2'],
      finish: ['C3'],
    };

    mockDb.execute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          uuid: 'legacy-climb',
          name: 'Legacy Moon',
          frames: encodeMoonBoardHoldsToFrames(holds),
          ascensionist_count: 0,
        },
      ]);

    const result = await findMoonBoardDuplicateMatches(mockDb as never, 2, 40, [
      {
        clientKey: 'candidate-1',
        holds,
      },
    ]);

    expect(result[0]).toMatchObject({
      clientKey: 'candidate-1',
      exists: true,
      existingClimbUuid: 'legacy-climb',
      existingClimbName: 'Legacy Moon',
    });
  });

  it('normalizes hold rows and duplicate error text', () => {
    expect(buildMoonBoardClimbHoldRows('new-climb', {
      start: ['A1'],
      hand: ['C3', 'B2'],
      finish: ['C3'],
    })).toEqual([
      { boardType: 'moonboard', climbUuid: 'new-climb', holdId: 1, frameNumber: 0, holdState: 'STARTING' },
      { boardType: 'moonboard', climbUuid: 'new-climb', holdId: 13, frameNumber: 0, holdState: 'HAND' },
      { boardType: 'moonboard', climbUuid: 'new-climb', holdId: 25, frameNumber: 0, holdState: 'FINISH' },
    ]);

    expect(buildMoonBoardDuplicateError('Existing Climb')).toBe(
      'A MoonBoard climb with the same holds already exists: "Existing Climb"',
    );
  });
});
