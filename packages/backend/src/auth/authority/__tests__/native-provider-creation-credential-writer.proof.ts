import { vi } from 'vite-plus/test';
vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_CONTENT_NATIVE_ISSUER');
      },
    },
  ),
  dbRead: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_CONTENT_NATIVE_READER');
      },
    },
  ),
}));
vi.mock('../../../redis/client', () => ({ redisClientManager: { isRedisConnected: () => false } }));

import { defineNativeProviderCreationTests } from './fixtures/native-provider-creation-scenarios';
defineNativeProviderCreationTests(true);
