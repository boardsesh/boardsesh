// @vitest-environment node
import { describe, expect, it, vi } from 'vite-plus/test';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol/client-errors';
import {
  BROWSER_PASSWORD_COMMAND_PATHS,
  browserPasswordCommandSchema,
  type BrowserPasswordReply,
} from '@boardsesh/auth-protocol/browser-password-v1';
vi.mock('server-only', () => ({}));
import { createBrowserPasswordCommandClient } from '../browser-password-command-client.server';
import {
  browserPasswordFixture,
  passwordTestCredentialHash,
  passwordTestEnvironment,
} from './fixtures/browser-password';

function fixture(transform: (reply: BrowserPasswordReply) => unknown = (reply) => reply, status = 200) {
  const current = browserPasswordFixture();
  const send = vi.fn<typeof fetch>(async (_url, options) => {
    if (typeof options?.body !== 'string') throw new Error('Expected private command');
    const request = browserPasswordCommandSchema.parse(JSON.parse(options.body));
    const metadata = { browserPasswordProtocolVersion: 1 as const, requestId: request.requestId };
    const reply: BrowserPasswordReply =
      request.operation === 'prepare'
        ? { ...metadata, operation: 'prepare', outcome: 'prepared', ...current }
        : request.operation === 'abort'
          ? { ...metadata, operation: 'abort', outcome: 'aborted' }
          : {
              ...metadata,
              operation: request.operation,
              outcome: 'completed',
              cursor: current.preparation.futureBrowserCursor,
              candidateCredentialHash: passwordTestCredentialHash(current.candidate),
              credentialProof: current.preparation.credentialProof,
              credentialExpiresAt: current.preparation.credentialExpiresAt,
            };
    if (reply.outcome === 'prepared') {
      // Source/candidate are test inputs, never reply fields.
      const {
        source: _source,
        candidate: _candidate,
        ...prepared
      } = { ...reply, source: current.source, candidate: current.candidate };
      return Response.json(transform(prepared), { status });
    }
    return Response.json(transform(reply), { status });
  });
  const client = createBrowserPasswordCommandClient({ environment: passwordTestEnvironment, fetch: send });
  const prepare = {
    source: current.source,
    email: ' exact@example.test ',
    password: '  unchanged\u0000密码  ',
    credentialKind: 'canonical-token' as const,
    nonceHash: current.preparation.nonceHash,
  };
  const bound = {
    source: current.source,
    operationToken: current.operationToken,
    browserIntentToken: current.browserIntentToken,
    preparation: current.preparation,
  };
  return { current, client, send, prepare, bound };
}
describe('private browser password command client', () => {
  it.each(['prepare', 'finalize', 'acknowledge', 'abort'] as const)(
    'makes exactly one fixed authenticated %s request',
    async (operation) => {
      const current = fixture();
      const reply =
        operation === 'prepare'
          ? await current.client.prepare(current.prepare)
          : operation === 'abort'
            ? await current.client.abort(current.bound)
            : await current.client[operation]({ ...current.bound, candidate: current.current.candidate });
      expect(reply.operation).toBe(operation);
      expect(current.send).toHaveBeenCalledTimes(1);
      expect(current.send.mock.calls[0]).toMatchObject([
        passwordTestEnvironment.CURRENT_STORE_AUTH_BACKEND_ORIGIN + BROWSER_PASSWORD_COMMAND_PATHS[operation],
        {
          method: 'POST',
          redirect: 'error',
          cache: 'no-store',
          headers: { Authorization: 'Bearer ' + passwordTestEnvironment.CURRENT_STORE_AUTH_RPC_SECRET },
        },
      ]);
      if (operation === 'prepare')
        expect(JSON.parse(current.send.mock.calls[0][1]?.body as string).payload.password).toBe(
          current.prepare.password,
        );
    },
  );
  it.each(['legacy', '', 'unknown', ' backend-staging'])('refuses %s mode before I/O', (mode) => {
    const send = vi.fn<typeof fetch>();
    expect(() =>
      createBrowserPasswordCommandClient({
        environment: { ...passwordTestEnvironment, CURRENT_STORE_BROWSER_PASSWORD_MODE: mode },
        fetch: send,
      }),
    ).toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['nonce', 'canonical-token', 'request-id', 'http-status', 'extra-private-field'] as const)(
    'rejects prepared %s substitution',
    async (change) => {
      const current = fixture(
        (reply) => {
          if (reply.outcome !== 'prepared') return reply;
          if (change === 'nonce') return { ...reply, preparation: { ...reply.preparation, nonceHash: 'a'.repeat(64) } };
          if (change === 'canonical-token') return { ...reply, proposedCanonicalToken: 'a'.repeat(43) };
          if (change === 'request-id') return { ...reply, requestId: 'e750c219-74dd-40cd-9ae9-e415ac324fef' };
          if (change === 'extra-private-field') return { ...reply, password: 'never-return-this' };
          return reply;
        },
        change === 'http-status' ? 401 : 200,
      );
      await expect(current.client.prepare(current.prepare)).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
      expect(current.send).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['candidate', 'sid', 'cursor', 'expiry'] as const)(
    'rejects completed %s drift without finalization retry',
    async (change) => {
      const current = fixture((reply) => {
        if (reply.outcome !== 'completed') return reply;
        if (change === 'candidate') return { ...reply, candidateCredentialHash: 'a'.repeat(64) };
        if (change === 'sid')
          return { ...reply, credentialProof: { ...reply.credentialProof, authSessionId: 'other-SID' } };
        if (change === 'cursor') return { ...reply, cursor: { ...reply.cursor, version: reply.cursor.version + 1 } };
        return { ...reply, credentialExpiresAt: new Date(Date.parse(reply.credentialExpiresAt) + 1_000).toISOString() };
      });
      await expect(current.client.finalize({ ...current.bound, candidate: current.current.candidate })).rejects.toThrow(
        AUTH_BACKEND_UNAVAILABLE,
      );
      expect(current.send).toHaveBeenCalledTimes(1);
    },
  );
  it('refuses a substituted source before any physical command', async () => {
    const current = fixture();
    await expect(
      current.client.abort({ ...current.bound, source: { ...current.current.source, bindingToken: 'a'.repeat(43) } }),
    ).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
    expect(current.send).not.toHaveBeenCalled();
  });
});
