import type { RolloutHealth } from '../../lib/ota-rollout';
import type { StableCandidate, StableRelease } from '../../lib/ota-stable';

export const baselineIds = {
  ios: '11111111-1111-1111-1111-111111111111',
  android: '22222222-2222-2222-2222-222222222222',
};
export const candidateFixture = (): StableCandidate => ({
  sourceRunId: '101',
  preparationRunId: '102',
  preparedAt: '2026-10-08T19:17:00Z',
  qaPassed: true,
  receipt: {
    commitHash: 'a'.repeat(40),
    message: 'Release',
    baselineProductionUpdateIds: baselineIds,
    platforms: {
      ios: { runtimeVersion: 'b'.repeat(40), bundleSha256: 'c'.repeat(64) },
      android: { runtimeVersion: 'd'.repeat(40), bundleSha256: 'e'.repeat(64) },
    },
  },
});
export const activeFixture = (): StableRelease => ({
  candidate: candidateFixture(),
  phase: 'ramping',
  updateIds: { ios: '31', android: '32' },
  unchangedPlatforms: {},
  completedPlatforms: {},
  startedAt: '2026-10-08T22:00:00Z',
  stepSince: '2026-10-08T22:00:00Z',
  percentage: 5,
  pendingPercentage: null,
});
export const healthFixture = (
  verdict: 'healthy' | 'unhealthy' | 'insufficient-evidence' = 'healthy',
): RolloutHealth[] =>
  (['ios', 'android'] as const).map((platform) => ({
    rollout: {
      branch: 'production',
      runtimeVersion: candidateFixture().receipt.platforms[platform].runtimeVersion,
      platform,
      updateId: platform === 'ios' ? '31' : '32',
      controlUpdateId: '1',
      percentage: 5,
      createdAt: '2026-10-08T22:00:00Z',
    },
    canaryUpdateUUID: baselineIds[platform],
    controlUpdateUUID: baselineIds[platform],
    canaryIssues: null,
    canary: { devicesOnUpdate: 20, successfulDevices: 20, faultyDevices: 0 },
    control: { devicesOnUpdate: 100, successfulDevices: 100, faultyDevices: 0 },
    judgement: { verdict, reason: 'Test cohort' },
  }));
