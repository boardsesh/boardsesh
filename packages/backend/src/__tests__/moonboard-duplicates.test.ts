import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  buildMoonBoardDuplicateError,
  encodeMoonBoardHoldsToFrames,
  findMoonBoardDuplicateMatches,
  normalizeMoonBoardHolds,
} from '../graphql/resolvers/climbs/moonboard-duplicates';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    execute: vi.fn(),
  },
}));

vi.mock('../db/client', () => ({
  db: mockDb,
}));

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

    const result = await findMoonBoardDuplicateMatches(2, 40, [
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

    mockDb.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        uuid: 'legacy-climb',
        name: 'Legacy Moon',
        frames: encodeMoonBoardHoldsToFrames(holds),
        ascensionist_count: 0,
      },
    ]);

    const result = await findMoonBoardDuplicateMatches(2, 40, [
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

  it('normalizes holds and duplicate error text', () => {
    expect(
      normalizeMoonBoardHolds({
        start: ['A1'],
        hand: ['C3', 'B2'],
        finish: ['C3'],
      }),
    ).toEqual([
      { holdId: 1, holdState: 'STARTING' },
      { holdId: 13, holdState: 'HAND' },
      { holdId: 25, holdState: 'FINISH' },
    ]);

    expect(buildMoonBoardDuplicateError('Existing Climb')).toBe(
      'A MoonBoard climb with the same holds already exists: "Existing Climb"',
    );
  });
});
