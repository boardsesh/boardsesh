import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { currentStoreWebAuthConfiguration } from '../../../handlers/current-store-web-auth';
import { currentStoreWebOAuthConfiguration } from '../../../handlers/current-store-web-oauth';
import { logger } from '../../../utils/logger';
import {
  currentStoreAccountDeletionConfiguration,
  currentStoreBatchSystemUsersConfiguration,
  currentStoreNativeOAuthConfiguration,
  currentStoreNativeRegistrationConfiguration,
  currentStoreSystemBoardOwnerConfiguration,
  DELETED_EMAIL_KEY_ENV,
} from '../authority-configuration';

type Environment = Record<string, string | undefined>;

const digestKey = 'owned-deleted-email-digest-key-for-configuration';
const shared: Environment = {
  CURRENT_STORE_AUTH_PROJECTION_ID: 'owned-projection',
  CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
  CURRENT_STORE_AUTH_RPC_SECRET: 'owned-current-store-rpc-secret-of-enough-bytes',
  CURRENT_STORE_BATCH_SYSTEM_USERS_RPC_SECRET: 'owned-batch-system-user-secret-of-enough-bytes',
  NEXTAUTH_SECRET: 'owned-nextauth-secret-of-enough-bytes-for-tests',
  [DELETED_EMAIL_KEY_ENV]: digestKey,
};
/** Every staged mode, each read through its own configuration entry point. */
const modes: readonly (readonly [string, (environment: Environment) => unknown])[] = [
  [
    'web password',
    (environment) =>
      currentStoreWebAuthConfiguration({ ...environment, CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging' }),
  ],
  [
    'web OAuth',
    (environment) =>
      currentStoreWebOAuthConfiguration({ ...environment, CURRENT_STORE_WEB_OAUTH_MODE: 'backend-staging' }),
  ],
  [
    'native registration',
    (environment) =>
      currentStoreNativeRegistrationConfiguration({
        ...environment,
        CURRENT_STORE_NATIVE_REGISTRATION_MODE: 'reserved-staging',
      }),
  ],
  [
    'native OAuth',
    (environment) =>
      currentStoreNativeOAuthConfiguration({ ...environment, CURRENT_STORE_NATIVE_OAUTH_MODE: 'reserved-staging' }),
  ],
  [
    'system board owner',
    (environment) =>
      currentStoreSystemBoardOwnerConfiguration({
        ...environment,
        CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE: 'reserved-staging',
      }),
  ],
  [
    'batch system users',
    (environment) =>
      currentStoreBatchSystemUsersConfiguration({
        ...environment,
        CURRENT_STORE_BATCH_SYSTEM_USERS_MODE: 'backend-staging',
      }),
  ],
  [
    'account deletion',
    (environment) =>
      currentStoreAccountDeletionConfiguration({
        ...environment,
        CURRENT_STORE_ACCOUNT_DELETION_MODE: 'reserved-staging',
      }),
  ],
];

afterEach(() => vi.restoreAllMocks());

describe('the deleted-address digest key in every staged mode', () => {
  it.each(modes)('%s starts with the key', (_mode, configure) => {
    expect(configure(shared)).toMatchObject({ authority: { expectedProjectionId: 'owned-projection' } });
  });

  it.each(modes)('%s fails at configuration without the key, naming the variable', (_mode, configure) => {
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    for (const key of [undefined, '', 'tiny-key', ` ${digestKey}`, shared.NEXTAUTH_SECRET]) {
      logged.mockClear();
      expect(() => configure({ ...shared, [DELETED_EMAIL_KEY_ENV]: key })).toThrow();
      expect(logged).toHaveBeenCalledOnce();
      const [line] = logged.mock.calls[0] as unknown as [string];
      expect(line).toContain(DELETED_EMAIL_KEY_ENV);
      if (key) expect(line.includes(key.trim())).toBe(false);
    }
  });
});
