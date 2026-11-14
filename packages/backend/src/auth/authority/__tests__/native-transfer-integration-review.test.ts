import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vite-plus/test';
const webRequire = createRequire(new URL('../../../../../web/package.json', import.meta.url));
vi.doMock(webRequire.resolve('server-only'), () => ({}));
import { users } from '@boardsesh/db/schema';
// Load the real web issuer without adding it to the backend rootDir program.
const { issueNativeOAuthTransferToken } = (await import(
  fileURLToPath(new URL('../../../../../web/app/lib/auth/native-oauth-transfer.ts', import.meta.url))
)) as {
  issueNativeOAuthTransferToken: (input: {
    userId: string;
    generation: number;
    authSessionId: string;
    nextPath: string;
  }) => string;
};
import { createEnvironment } from './environment';
import { denyFirstPartySession } from '../lineage';

let environment: Awaited<ReturnType<typeof createEnvironment>>;
vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get: (_target, property) => {
        const member: unknown = Reflect.get(environment.database, property);
        return typeof member === 'function'
          ? (...arguments_: unknown[]) => Reflect.apply(member, environment.database, arguments_)
          : member;
      },
    },
  ),
}));
vi.mock('../../admission-pool', () => ({
  readOnAdmissionConnection: async (
    mark: () => void,
    read: (database: typeof environment.database) => PromiseLike<unknown>,
  ) => {
    mark();
    return read(environment.database);
  },
}));
beforeAll(async () => {
  environment = await createEnvironment();
});
afterAll(async () => environment?.close());
afterEach(() => vi.unstubAllEnvs());

it('an unattributed web-issued transfer cannot outlive signout of its source SID', async () => {
  vi.stubEnv('NEXTAUTH_SECRET', 'synthetic-real-issuer-integration-secret');
  vi.stubEnv('AUTH_LEGACY_BRIDGE_MODE', 'off');
  vi.stubEnv('AUTH_NATIVE_REVOCATION_MODE', 'legacy');
  const userId = randomUUID();
  const authSessionId = randomUUID();
  const now = new Date();
  await environment.database.insert(users).values({ id: userId, email: `transfer-integration-${userId}@example.test` });
  const transferToken = issueNativeOAuthTransferToken({ userId, generation: 0, authSessionId, nextPath: '/' });
  await denyFirstPartySession(
    environment.database,
    {
      userId,
      authSessionId,
      generation: 0,
      requiresAccountCutoff: false,
      linkGuarded: false,
      authenticatedAt: null,
      expiresAt: new Date(now.getTime() + 3600000),
    },
    now,
  );
  const { handleNativeAuthExchange } = await import('../../../handlers/native-auth');
  const server = createServer((request, response) => {
    void handleNativeAuthExchange(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('OWNED_HTTP_ADDRESS_REQUIRED');
    const response = await fetch(`http://127.0.0.1:${address.port}/auth/native/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transferToken }),
    });
    expect(response.status).toBe(401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
