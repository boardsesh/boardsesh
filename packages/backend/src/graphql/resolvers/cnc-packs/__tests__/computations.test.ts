import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const { submitMock, readMock, ownedAssetsMock, resolveAssetsMock } = vi.hoisted(() => ({
  submitMock: vi.fn(),
  readMock: vi.fn(),
  ownedAssetsMock: vi.fn(),
  resolveAssetsMock: vi.fn(),
}));
vi.mock('../../../../db/client', () => ({ db: {}, dbRead: {} }));
vi.mock('../../../../services/cnc/computations', () => ({
  submitCncComputation: submitMock,
  readCncComputation: readMock,
}));
vi.mock('../../../../services/cnc/art-assets', () => ({ getOwnedArtAssets: ownedAssetsMock }));
vi.mock('../config', () => ({
  resolveCncConfig: () => ({ layoutRequest: { board: {} }, artwork: [], artworkInput: [] }),
  resolveArtworkAssets: resolveAssetsMock,
  artworkAssetIds: () => [],
}));
vi.mock('../queries', () => ({ toGraphQLWorkerError: (error: unknown) => error }));
vi.mock('../../shared/helpers', async (original) => ({
  ...(await original<typeof import('../../shared/helpers')>()),
  applyRateLimit: vi.fn(async () => {}),
}));
import { cncComputationMutations, cncComputationQueries } from '../computations';

const signedIn: ConnectionContext = {
  connectionId: 'account-1',
  transport: 'http',
  isAuthenticated: true,
  userId: 'account-1',
};
const anonymous: ConnectionContext = { connectionId: 'anonymous', transport: 'http', isAuthenticated: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'cnc-packs');
  submitMock.mockResolvedValue({ id: 'request-1', status: 'queued' });
  readMock.mockResolvedValue({ id: 'request-1', status: 'ready' });
  ownedAssetsMock.mockResolvedValue(new Map());
  resolveAssetsMock.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe('CNC computation release access', () => {
  it.each([anonymous, signedIn])(
    'blocks new no-hole layout work while the flag is off for $connectionId',
    async (context) => {
      vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'cnc-packs=false');
      await expect(cncComputationMutations.requestCncLayout(undefined, { config: {} }, context)).rejects.toMatchObject({
        extensions: { code: 'CNC_WORKER_UNAVAILABLE' },
      });
      expect(submitMock).not.toHaveBeenCalled();
    },
  );

  it('blocks private layouts and artwork before submission or asset access', async () => {
    vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'cnc-packs=false');
    await expect(
      cncComputationMutations.requestCncLayout(undefined, { config: {}, includeHoles: true }, signedIn),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_WORKER_UNAVAILABLE' } });
    await expect(
      cncComputationMutations.requestCncArtworkValidation(undefined, { config: {} }, signedIn),
    ).rejects.toMatchObject({ extensions: { code: 'CNC_WORKER_UNAVAILABLE' } });
    expect(submitMock).not.toHaveBeenCalled();
    expect(resolveAssetsMock).not.toHaveBeenCalled();
    expect(ownedAssetsMock).not.toHaveBeenCalled();
  });

  it('allows public layouts and keeps their result ownership anonymous', async () => {
    await cncComputationMutations.requestCncLayout(undefined, { config: {} }, anonymous);
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: null,
        operation: 'layout',
        request: { layoutRequest: { board: {} }, includeHoles: false },
      }),
    );
  });

  it('retains authentication and ownership for holes and artwork when enabled', async () => {
    await expect(
      cncComputationMutations.requestCncLayout(undefined, { config: {}, includeHoles: true }, anonymous),
    ).rejects.toThrow(/Authentication required/);
    await expect(
      cncComputationMutations.requestCncArtworkValidation(undefined, { config: {} }, anonymous),
    ).rejects.toThrow(/Authentication required/);
    await cncComputationMutations.requestCncLayout(undefined, { config: {}, includeHoles: true }, signedIn);
    expect(submitMock).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'account-1', operation: 'layout' }));
    await cncComputationMutations.requestCncArtworkValidation(undefined, { config: {} }, signedIn);
    expect(resolveAssetsMock).toHaveBeenCalledWith('account-1', []);
    expect(submitMock).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'account-1', operation: 'artwork' }));
  });

  it('keeps already-submitted results readable by their owner with the flag off', async () => {
    vi.stubEnv('FEATURE_FLAG_OVERRIDES', 'cnc-packs=false');
    const requestId = '44444444-4444-4444-8444-444444444444';
    await expect(cncComputationQueries.cncComputation(undefined, { id: requestId }, signedIn)).resolves.toMatchObject({
      status: 'ready',
    });
    expect(readMock).toHaveBeenCalledWith(requestId, 'account-1');
  });
});
