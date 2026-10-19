import type { UnlockExpectations, UnlockProof, UnlockReceipt } from '../../lib/ota-unlock-receipt';

export const unlockProof: UnlockProof = {
  repository: 'boardsesh/boardsesh',
  requestId: '01234567-0123-4567-89ab-0123456789ab',
  runId: 42,
  headSha: 'a'.repeat(40),
};
export const unlockExpected: UnlockExpectations = {
  appId: '007e6fd7-f200-448c-9449-8d48ba5d51fc',
  runtimes: { ios: 'a'.repeat(40), android: 'b'.repeat(40) },
  baselines: { ios: '11111111-1111-9111-6111-111111111111', android: '22222222-2222-9222-6222-222222222222' },
};
export const restoredIds = {
  ios: '33333333-3333-9333-6333-333333333333',
  android: '44444444-4444-9444-6444-444444444444',
};
export function unlockReceipt(expected = unlockExpected): UnlockReceipt {
  return {
    ...unlockProof,
    version: 1,
    runAttempt: 1,
    branch: 'production',
    appId: expected.appId,
    platforms: {
      ios: {
        runtimeVersion: expected.runtimes.ios,
        originalUpdateId: expected.baselines.ios,
        restoredUpdateId: restoredIds.ios,
        contentSha256: 'a'.repeat(64),
        mode: 'reverted',
      },
      android: {
        runtimeVersion: expected.runtimes.android,
        originalUpdateId: expected.baselines.android,
        restoredUpdateId: restoredIds.android,
        contentSha256: 'b'.repeat(64),
        mode: 'reverted',
      },
    },
  };
}
