import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AUTH_COMMAND_PATHS,
  AUTH_PROTOCOL_VERSION,
  WEB_OAUTH_COMMAND_PATHS,
  WEB_OAUTH_PROTOCOL_VERSION,
} from '@boardsesh/auth-protocol';

const dependencies = vi.hoisted(() => ({
  database: vi.fn(),
  password: vi.fn(),
  oauth: vi.fn(),
  signout: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../../credential-database', () => ({ getCredentialDatabase: dependencies.database }));
vi.mock('../../../utils/logger', () => ({ logger: { warn: dependencies.warn, error: vi.fn() } }));
vi.mock('../../current-store/web-password', async () => {
  const { isWebPasswordCommandFresh, WebPasswordCommandError } = await import('../../current-store/command-context');
  return {
    authenticateWebPassword: dependencies.password,
    registerWebPassword: vi.fn(),
    isWebPasswordCommandFresh,
    WebPasswordCommandError,
  };
});
vi.mock('../../current-store/email-verification', () => ({
  consumeEmailVerification: vi.fn(),
  resendEmailVerification: vi.fn(),
}));
vi.mock('../../current-store/password-recovery', () => ({
  consumePasswordRecovery: vi.fn(),
  requestPasswordRecovery: vi.fn(),
}));
vi.mock('../../current-store/set-password', () => ({ setWebPassword: vi.fn() }));
vi.mock('../../current-store/web-oauth-identity', () => ({
  recordWebOAuthIntent: dependencies.oauth,
  resolveWebOAuthIdentity: vi.fn(),
}));
vi.mock('../web-signout', () => ({ signOutLegacyWebSession: dependencies.signout }));

import { handleCurrentStoreWebAuth } from '../../../handlers/current-store-web-auth';
import { handleCurrentStoreWebOAuth } from '../../../handlers/current-store-web-oauth';
import { handleCurrentStoreWebSignOut } from '../../../handlers/current-store-web-signout';

const rpcSecret = 'owned-private-rpc-service-secret-at-least-32-bytes';
const defaultDatabase = Object.freeze({ owner: 'qualified-private-pool' }) as unknown as DbInstance;
const injectedDatabase = Object.freeze({ owner: 'explicit-owned-test-pool' }) as unknown as DbInstance;
type Handler = (request: IncomingMessage, response: ServerResponse, database?: DbInstance) => Promise<unknown>;
interface Route {
  readonly name: 'password' | 'oauth' | 'signout';
  readonly mode: string;
  readonly path: string;
  readonly handle: Handler;
  command(): Record<string, unknown>;
  unavailable(command: Record<string, unknown>): unknown;
  success(command: Record<string, unknown>): unknown;
}
const routes: Route[] = [
  {
    name: 'password',
    mode: 'CURRENT_STORE_WEB_AUTH_MODE',
    path: AUTH_COMMAND_PATHS.password,
    handle: handleCurrentStoreWebAuth,
    command: () => ({
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'password',
      requestId: randomUUID(),
      issuedAt: Date.now(),
      payload: { email: 'owned@example.test', password: 'owned-synthetic-password' },
    }),
    unavailable: (command) => ({
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'password',
      requestId: command.requestId,
      outcome: 'error',
      code: 'unavailable',
    }),
    success: (command) => ({
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'password',
      requestId: command.requestId,
      outcome: 'invalid_credentials',
    }),
  },
  {
    name: 'oauth',
    mode: 'CURRENT_STORE_WEB_OAUTH_MODE',
    path: WEB_OAUTH_COMMAND_PATHS.intent,
    handle: handleCurrentStoreWebOAuth,
    command: () => ({
      webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
      operation: 'intent',
      requestId: randomUUID(),
      issuedAt: new Date().toISOString(),
      payload: { provider: 'apple', flow: 'a'.repeat(64), actorCookie: null },
    }),
    unavailable: () => ({ error: 'unavailable' }),
    success: (command) => ({
      webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
      operation: 'intent',
      requestId: command.requestId,
      outcome: 'recorded',
      flow: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  },
  {
    name: 'signout',
    mode: 'CURRENT_STORE_WEB_SIGNOUT_MODE',
    path: AUTH_COMMAND_PATHS.signout,
    handle: handleCurrentStoreWebSignOut,
    command: () => ({
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'signout',
      requestId: randomUUID(),
      issuedAt: Date.now(),
      payload: { credential: 'owned-synthetic-credential' },
    }),
    unavailable: (command) => ({
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'signout',
      requestId: command.requestId,
      outcome: 'error',
      code: 'unavailable',
    }),
    success: (command) => ({
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'signout',
      requestId: command.requestId,
      outcome: 'signed_out',
    }),
  },
];

async function invoke(route: Route, command: unknown, options: { authorization?: string; database?: DbInstance } = {}) {
  const stream = Readable.from([Buffer.from(JSON.stringify(command))]);
  const request = Object.assign(stream, {
    method: 'POST',
    url: route.path,
    headers: { authorization: options.authorization ?? `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
  let status = 0;
  let body: unknown;
  let headers: Record<string, string> = {};
  const response = {
    destroyed: false,
    writeHead(code: number, sentHeaders: Record<string, string>) {
      status = code;
      headers = sentHeaders;
    },
    end(serialized: string) {
      body = JSON.parse(serialized) as unknown;
    },
  } as unknown as ServerResponse;
  try {
    await route.handle(request, response, options.database);
  } finally {
    stream.destroy();
  }
  return { status, body, headers };
}

describe('private RPC default credential database selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const [name, content] of Object.entries({
      NODE_ENV: 'test',
      CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
      CURRENT_STORE_WEB_OAUTH_MODE: 'backend-staging',
      CURRENT_STORE_WEB_SIGNOUT_MODE: 'backend-staging',
      CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
      NEXTAUTH_SECRET: 'owned-nextauth-private-rpc-key',
      CURRENT_STORE_AUTH_PROJECTION_ID: 'owned-private-rpc-projection',
      CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
      CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-private-rpc-deleted-email-key-at-least-32-bytes',
      CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'off',
      CURRENT_STORE_SET_PASSWORD_MODE: 'legacy',
      AUTH_IDENTITY_MIRROR: 'off',
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      DEBUG_SQL: 'false',
    }))
      vi.stubEnv(name, content);
    dependencies.database.mockReset().mockResolvedValue(defaultDatabase);
    dependencies.password.mockReset();
    dependencies.oauth.mockReset();
    dependencies.signout.mockReset().mockResolvedValue({ status: 'signed-out' });
  });
  afterEach(() => vi.unstubAllEnvs());

  for (const route of routes) {
    describe(route.name, () => {
      it('keeps disabled commands at404 without constructing the private database', async () => {
        vi.stubEnv(route.mode, 'legacy');
        const result = await invoke(route, route.command());
        expect(result.status).toBe(404);
        expect(result.body).toEqual({ error: 'disabled' });
        expect(dependencies.database).not.toHaveBeenCalled();
        expect(dependencies[route.name]).not.toHaveBeenCalled();
      });
      it('keeps unauthenticated commands at401 before any private pool work', async () => {
        const result = await invoke(route, route.command(), { authorization: 'Bearer wrong-owned-service-secret' });
        expect(result.status).toBe(401);
        expect(result.body).toEqual({ error: 'unauthorized' });
        expect(dependencies.database).not.toHaveBeenCalled();
        expect(dependencies[route.name]).not.toHaveBeenCalled();
      });
      it('rejects malformed command bodies before selecting a database', async () => {
        const result = await invoke(route, { malformed: true });
        expect(result.status).toBe(400);
        expect(result.body).toEqual({ error: 'invalid_request' });
        expect(dependencies.database).not.toHaveBeenCalled();
        expect(dependencies[route.name]).not.toHaveBeenCalled();
      });
      it.each([false, true])('forwards the actual selected handle with injected=%s', async (injected) => {
        const command = route.command();
        const expectedReply = route.success(command);
        if (route.name !== 'signout') dependencies[route.name].mockResolvedValue(expectedReply);
        const result = await invoke(route, command, injected ? { database: injectedDatabase } : {});
        expect(result.status).toBe(200);
        expect(result.body).toEqual(expectedReply);
        expect(result.headers['Cache-Control']).toBe('no-store');
        expect(dependencies.database).toHaveBeenCalledTimes(injected ? 0 : 1);
        expect(dependencies[route.name]).toHaveBeenCalledOnce();
        expect(dependencies[route.name].mock.calls[0][0]).toBe(injected ? injectedDatabase : defaultDatabase);
      });
      it('preserves the sanitized503 reply when private pool initialization fails', async () => {
        const hiddenFailure = 'owned-pool-failure-with-secret-credential';
        dependencies.database.mockRejectedValue(new Error(hiddenFailure));
        const command = route.command();
        const result = await invoke(route, command);
        expect(result.status).toBe(503);
        expect(result.body).toEqual(route.unavailable(command));
        expect(result.headers['Cache-Control']).toBe('no-store');
        expect(JSON.stringify(result)).not.toContain(hiddenFailure);
        const logs = dependencies.warn.mock.calls
          .flat()
          .map((entry: unknown) => (entry instanceof Error ? entry.stack : JSON.stringify(entry)))
          .join(' ');
        expect(logs).not.toContain(hiddenFailure);
        expect(dependencies.database).toHaveBeenCalledOnce();
        expect(dependencies[route.name]).not.toHaveBeenCalled();
      });
    });
  }
});
