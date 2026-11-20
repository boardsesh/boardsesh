// @vitest-environment node
import { describe, expect, it, vi } from 'vite-plus/test';
import { WEB_SESSION_COMMAND_PATHS } from '@boardsesh/auth-protocol';
vi.mock('server-only', () => ({}));
import { createWebSessionCommandClient } from '../web-session-command-client.server';

const environment = {
  NODE_ENV: 'test',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'https://backend.boardsesh.test',
  CURRENT_STORE_AUTH_RPC_SECRET: 'web-session-command-client-test-rpc-secret-0001',
};
const presented = { kind: 'canonical-token' as const, token: 'session-token' };
const expected = { userId: 'user-1', authSessionId: 'session-1' };

/** A backend answering `status` with `reply(requestId)`, recording what it was sent. */
function backend(status: number, reply: (command: { requestId: string; operation: string }) => unknown) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const send: typeof fetch = async (input, init) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      requestId: string;
      operation: string;
    };
    sent.push({ url: input instanceof Request ? input.url : input.toString(), body });
    return new Response(JSON.stringify(reply(body)), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { sent, client: createWebSessionCommandClient({ environment, fetch: send }) };
}

const replyBase = (command: { requestId: string; operation: string }) => ({
  webSessionProtocolVersion: 1,
  requestId: command.requestId,
  operation: command.operation,
});

describe('web session command client', () => {
  it('reads an active session and a confirmed signed-out one', async () => {
    const active = backend(200, (command) => ({
      ...replyBase(command),
      outcome: 'active',
      userId: 'user-1',
      authSessionId: 'session-1',
      generation: 0,
      expiresAt: '2026-12-18T00:00:00.000Z',
      source: 'login',
      authenticatedAt: null,
      linkGuarded: true,
      user: { id: 'user-1', email: 'climber@example.test', name: null, image: null },
    }));
    await expect(active.client.read(presented)).resolves.toMatchObject({ status: 'active' });
    expect(active.sent[0].url).toBe(`https://backend.boardsesh.test${WEB_SESSION_COMMAND_PATHS.session}`);
    expect(active.sent[0].body).toMatchObject({ operation: 'session', payload: { presented } });
    const signedOut = backend(401, (command) => ({ ...replyBase(command), outcome: 'unauthenticated' }));
    await expect(signedOut.client.read(presented)).resolves.toEqual({ status: 'signed-out' });
  });

  it.each([
    ['the transport refusal', 401, () => ({ error: 'unauthorized' })],
    ['the switched-off command', 404, () => ({ error: 'disabled' })],
    [
      'an unavailable reply',
      503,
      (command: { requestId: string; operation: string }) => ({
        ...replyBase(command),
        outcome: 'error',
        code: 'unavailable',
      }),
    ],
    [
      'a reply for another request',
      401,
      (command: { requestId: string; operation: string }) => ({
        ...replyBase(command),
        requestId: crypto.randomUUID(),
        outcome: 'unauthenticated',
      }),
    ],
    [
      'a reply with the wrong status',
      200,
      (command: { requestId: string; operation: string }) => ({ ...replyBase(command), outcome: 'unauthenticated' }),
    ],
  ])('treats %s as unavailable, never as signed out', async (_case, status, reply) => {
    await expect(backend(status, reply).client.read(presented)).rejects.toThrow('AuthBackendUnavailable');
    await expect(backend(status, reply).client.signOut(presented, expected)).rejects.toThrow('AuthBackendUnavailable');
  });

  it('signs out with the presented session and the expected login', async () => {
    const signedOut = backend(200, (command) => ({ ...replyBase(command), outcome: 'signed_out' }));
    await expect(signedOut.client.signOut(presented, expected)).resolves.toBe('signed_out');
    expect(signedOut.sent[0].body).toMatchObject({
      operation: 'signout',
      payload: { presented, expectedUserId: 'user-1', expectedAuthSessionId: 'session-1' },
    });
    const changed = backend(409, (command) => ({ ...replyBase(command), outcome: 'identity_changed' }));
    await expect(changed.client.signOut(presented, expected)).resolves.toBe('identity_changed');
  });

  it('bridges a legacy cookie, and treats denied and every unparsed answer apart', async () => {
    const bridged = backend(200, (command) => ({
      ...replyBase(command),
      outcome: 'bridged',
      userId: 'user-1',
      sessionId: 'session-1',
      token: 'bridged-token',
      expiresAt: '2026-12-18T00:00:00.000Z',
      generation: 0,
    }));
    await expect(bridged.client.bridge('legacy-cookie')).resolves.toMatchObject({ status: 'bridged' });
    expect(bridged.sent[0].url).toBe(`https://backend.boardsesh.test${WEB_SESSION_COMMAND_PATHS.bridge}`);
    expect(bridged.sent[0].body).toMatchObject({ operation: 'bridge', payload: { credential: 'legacy-cookie' } });
    const denied = backend(401, (command) => ({ ...replyBase(command), outcome: 'denied' }));
    await expect(denied.client.bridge('legacy-cookie')).resolves.toEqual({ status: 'denied' });
    const refused = backend(401, () => ({ error: 'unauthorized' }));
    await expect(refused.client.bridge('legacy-cookie')).rejects.toThrow('AuthBackendUnavailable');
    const wrongStatus = backend(200, (command) => ({ ...replyBase(command), outcome: 'denied' }));
    await expect(wrongStatus.client.bridge('legacy-cookie')).rejects.toThrow('AuthBackendUnavailable');
  });

  it('asks for a browser access token, and keeps both refusal reasons apart from every unparsed answer', async () => {
    const granted = backend(200, (command) => ({
      ...replyBase(command),
      outcome: 'active',
      userId: 'user-1',
      authSessionId: 'session-1',
      expiresAt: '2026-12-18T00:00:00.000Z',
      rolled: false,
      accessToken: 'header.payload.signature',
      accessTokenExpiresAt: '2026-11-18T00:15:00.000Z',
    }));
    await expect(granted.client.access(presented)).resolves.toMatchObject({
      status: 'active',
      grant: { userId: 'user-1', authSessionId: 'session-1', accessToken: 'header.payload.signature' },
    });
    expect(granted.sent[0].url).toBe(`https://backend.boardsesh.test${WEB_SESSION_COMMAND_PATHS.access}`);
    expect(granted.sent[0].body).toMatchObject({ operation: 'access', payload: { presented } });
    for (const [reason, status] of [
      ['no_session', 'no-session'],
      ['bridge_required', 'bridge-required'],
    ] as const) {
      const refused = backend(401, (command) => ({ ...replyBase(command), outcome: 'unauthenticated', reason }));
      await expect(refused.client.access(presented)).resolves.toEqual({ status });
    }
    for (const [status, reply] of [
      [401, () => ({ error: 'unauthorized' })],
      [404, () => ({ error: 'disabled' })],
      [
        200,
        (command: { requestId: string; operation: string }) => ({
          ...replyBase(command),
          outcome: 'unauthenticated',
          reason: 'no_session',
        }),
      ],
      [
        503,
        (command: { requestId: string; operation: string }) => ({
          ...replyBase(command),
          outcome: 'error',
          code: 'unavailable',
        }),
      ],
    ] as const)
      await expect(backend(status, reply).client.access(presented)).rejects.toThrow('AuthBackendUnavailable');
  });
});
