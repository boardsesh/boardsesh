import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const serverClientMocks = vi.hoisted(() => ({
  cachedUserClimbPercentile: vi.fn(),
  cachedUserProfileStats: vi.fn(),
  cachedUserTicks: vi.fn(),
  serverUserProfileStats: vi.fn(),
  serverUserTicks: vi.fn(),
}));

vi.mock('@/app/lib/graphql/server-cached-client', () => serverClientMocks);

import { fetchProfileStatsData } from '../server-profile-stats';

const quantumTick = {
  climbUuid: 'quantum-climb-1',
  angle: 40,
  status: 'send',
  attemptCount: 2,
  difficulty: 18,
  effectiveDifficulty: 19,
  boardseshDifficulty: null,
  boardseshConfidence: null,
  climbedAt: '2026-08-30T12:00:00.000Z',
  layoutId: 9101,
};

beforeEach(() => {
  for (const mock of Object.values(serverClientMocks)) mock.mockReset();
  serverClientMocks.cachedUserProfileStats.mockResolvedValue(null);
  serverClientMocks.serverUserProfileStats.mockResolvedValue(null);
  serverClientMocks.cachedUserClimbPercentile.mockResolvedValue(null);
});

describe('fetchProfileStatsData Quantum ticks', () => {
  it('includes Quantum in cached public-profile SSR data', async () => {
    serverClientMocks.cachedUserTicks.mockImplementation(async (_userId, boardType) =>
      boardType === 'quantum' ? [quantumTick] : [],
    );

    const result = await fetchProfileStatsData('user-1');

    expect(serverClientMocks.cachedUserTicks).toHaveBeenCalledWith('user-1', 'quantum');
    expect(result.initialAllBoardsTicks.quantum).toEqual([
      {
        climbed_at: quantumTick.climbedAt,
        difficulty: 18,
        effectiveDifficulty: 19,
        tries: 2,
        angle: 40,
        status: 'send',
        layoutId: 9101,
        boardType: 'quantum',
        climbUuid: 'quantum-climb-1',
      },
    ]);
  });

  it('includes Quantum in uncached current-user SSR data', async () => {
    serverClientMocks.serverUserTicks.mockImplementation(async (_userId, boardType) =>
      boardType === 'quantum' ? [quantumTick] : [],
    );

    await fetchProfileStatsData('user-1', { skipCache: true });

    expect(serverClientMocks.serverUserTicks).toHaveBeenCalledWith('user-1', 'quantum');
    expect(serverClientMocks.cachedUserTicks).not.toHaveBeenCalled();
  });
});
