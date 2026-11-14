import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
const dependencies = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../credential-database', () => ({ getCredentialDatabase: dependencies.get }));
import { runFirstPasswordPreparationMaintenance } from '../first-password-maintenance';
const configuration = {
  AUTH_IDENTITY_DATABASE_CONTRACT: 'private-first-password-v1',
  CURRENT_STORE_FIRST_PASSWORD_MODE: 'legacy',
  CURRENT_STORE_AUTH_PROJECTION_ID: 'owned-scrub-projection',
  CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
  CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-scrub-unrelated-deleted-email-key',
  AUTH_CUTOFF_ENFORCEMENT: 'enforce',
  DEBUG_SQL: 'false',
};
describe('first-password maintenance profile selection', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());
  it.each([undefined, 'private-web-v1', 'private-browser-v1', 'private-provider-v1'])(
    'never opens or falls back to a pool for %s',
    async (contract) => {
      expect(await runFirstPasswordPreparationMaintenance({ AUTH_IDENTITY_DATABASE_CONTRACT: contract })).toEqual({
        observed: 0,
        scrubbed: 0,
      });
      expect(dependencies.get).not.toHaveBeenCalled();
    },
  );
  for (const contract of ['private-first-password-v1', 'private-native-handoff-v1', 'private-browser-renewal-v1'])
    it.each(['legacy', 'backend-staging'])(
      `requires the reviewed ${contract} during feature mode %s, without any JWE reader key`,
      async (mode) => {
        const refusal = new Error('owned-pool-construction-stop');
        dependencies.get.mockRejectedValueOnce(refusal);
        await expect(
          runFirstPasswordPreparationMaintenance({
            ...configuration,
            AUTH_IDENTITY_DATABASE_CONTRACT: contract,
            CURRENT_STORE_FIRST_PASSWORD_MODE: mode,
          }),
        ).rejects.toBe(refusal);
        expect(dependencies.get).toHaveBeenCalledExactlyOnceWith('private-first-password-v1');
      },
    );
  it('rejects unknown selector or observe enforcement before pool work', async () => {
    await expect(
      runFirstPasswordPreparationMaintenance({ ...configuration, CURRENT_STORE_FIRST_PASSWORD_MODE: 'unknown' }),
    ).rejects.toThrow('Invalid CURRENT_STORE_FIRST_PASSWORD_MODE');
    await expect(
      runFirstPasswordPreparationMaintenance({ ...configuration, AUTH_CUTOFF_ENFORCEMENT: 'observe' }),
    ).rejects.toThrow('Staged auth writers need cutoff enforcement');
    expect(dependencies.get).not.toHaveBeenCalled();
  });
});
