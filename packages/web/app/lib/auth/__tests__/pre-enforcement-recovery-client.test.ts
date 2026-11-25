import { describe, expect, it, vi } from 'vite-plus/test';
import { RECOVERY_COMMAND_PATHS, PASSWORD_RESET_DEVICE_TOKEN_CAPABILITY_HEADER } from '@boardsesh/auth-protocol';
vi.mock('server-only', () => ({}));
import { createPreEnforcementRecoveryCommandClient } from '../pre-enforcement-recovery-client.server';

const environment = {
  NODE_ENV: 'test',
  CURRENT_STORE_WEB_AUTH_MODE: 'legacy',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'http://127.0.0.1:3070',
  CURRENT_STORE_AUTH_RPC_SECRET: 'owned-recovery-client-rpc-secret-6975',
};
const operations = ['forgot-password', 'reset-password'] as const;
type Operation = (typeof operations)[number];
function commandBody(options: RequestInit | undefined): Record<string, unknown> {
  if (typeof options?.body !== 'string') throw new Error('Owned serialized command missing');
  return JSON.parse(options.body) as Record<string, unknown>;
}
function transport(mutate: (reply: Record<string, unknown>) => void = () => {}, status = 200) {
  return vi.fn<typeof fetch>(async (_input, options) => {
    if (typeof options?.body !== 'string') throw new Error('Owned command body missing');
    const command = JSON.parse(options.body) as { requestId: string; operation: Operation };
    const reply: Record<string, unknown> = {
      protocolVersion: 2,
      operation: command.operation,
      requestId: command.requestId,
      outcome: command.operation === 'forgot-password' ? 'accepted' : 'reset',
    };
    mutate(reply);
    return Response.json(reply, { status });
  });
}
function invoke(operation: Operation, send: typeof fetch, payload: unknown = { token: 'raw' }, address?: string) {
  const client = createPreEnforcementRecoveryCommandClient({ environment, fetch: send });
  return operation === 'forgot-password'
    ? client.forgotPassword(payload, address)
    : client.resetPassword(payload, address);
}
describe('strict default recovery private client', () => {
  it.each(operations)('binds %s to its dedicated path and preserves the raw unknown payload', async (operation) => {
    const send = transport();
    const payload = {
      email: ' Mixed@example.test ',
      password: ' é\u0301 raw ',
      token: 'uuid-or-pr1',
      clientAddress: '9.9.9.9',
    };
    await invoke(operation, send, payload, '8.8.8.8');
    expect(send).toHaveBeenCalledOnce();
    const [url, options] = send.mock.calls[0];
    expect(url).toBe(`${environment.CURRENT_STORE_AUTH_BACKEND_ORIGIN}${RECOVERY_COMMAND_PATHS[operation]}`);
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    if (typeof options?.body !== 'string') throw new Error('Owned body missing');
    const command = JSON.parse(options.body) as Record<string, unknown>;
    expect(command).toEqual({
      protocolVersion: 2,
      operation,
      requestId: expect.any(String),
      issuedAt: expect.any(Number),
      payload,
      clientAddress: '8.8.8.8',
    });
    expect(command.requestId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
    const headers = new Headers(options?.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${environment.CURRENT_STORE_AUTH_RPC_SECRET}`);
    expect(headers.get('Cookie')).toBeNull();
    expect(headers.get('Origin')).toBeNull();
    expect(headers.get(PASSWORD_RESET_DEVICE_TOKEN_CAPABILITY_HEADER)).toBe(
      operation === 'reset-password' ? '1' : null,
    );
  });
  it.each(operations)(
    'does not promote payload context or a bucket string into %s envelope metadata',
    async (operation) => {
      const send = transport();
      await invoke(operation, send, { clientAddress: '8.8.8.8' }, '2001:db8:1:2::/64');
      const options = send.mock.calls[0][1];
      expect(commandBody(options)).not.toHaveProperty('clientAddress');
    },
  );
  it.each(operations)('retains a present null payload for %s validation at the authority', async (operation) => {
    const send = transport();
    await invoke(operation, send, null);
    expect(commandBody(send.mock.calls[0][1])).toHaveProperty('payload', null);
  });
  it.each(
    operations.flatMap((operation) =>
      ['requestId', 'operation', 'version', 'extra', 'outcome', 'status'].map((invalid) => ({ operation, invalid })),
    ),
  )('refuses $operation $invalid disagreement without retry', async ({ operation, invalid }) => {
    const send = transport(
      (reply) => {
        if (invalid === 'requestId') reply.requestId = '00000000-0000-4000-8000-000000000000';
        if (invalid === 'operation')
          reply.operation = operation === 'reset-password' ? 'forgot-password' : 'reset-password';
        if (invalid === 'version') reply.protocolVersion = 99;
        if (invalid === 'extra') reply.auth_time = Date.now();
        if (invalid === 'outcome') reply.outcome = 'authenticated';
      },
      invalid === 'status' ? 201 : 200,
    );
    await expect(invoke(operation, send)).rejects.toThrow('AuthBackendUnavailable');
    expect(send).toHaveBeenCalledOnce();
  });
  it('keeps invalid-or-expired private200 and legacy-unbound private503 authoritative', async () => {
    for (const [outcome, status] of [
      ['invalid_or_expired', 200],
      ['legacy_unbound', 503],
    ] as const) {
      const send = transport((reply) => {
        reply.outcome = outcome;
      }, status);
      expect((await invoke('reset-password', send)).outcome).toBe(outcome);
      expect(send).toHaveBeenCalledOnce();
    }
  });
  it.each(['old-backend', 'lost-reply', 'json', 'content-type', 'redirect', 'oversize'])(
    'retains %s uncertainty with one send',
    async (failure) => {
      const send = vi.fn<typeof fetch>(async () => {
        if (failure === 'lost-reply') throw new Error('private lost acknowledgement');
        if (failure === 'old-backend') return Response.json({ error: 'disabled' }, { status: 404 });
        if (failure === 'content-type') return new Response('{}');
        if (failure === 'redirect') return Response.redirect('https://elsewhere.test/', 307);
        if (failure === 'oversize')
          return new Response('x'.repeat(1000000), { headers: { 'Content-Type': 'application/json' } });
        return new Response('{', { headers: { 'Content-Type': 'application/json' } });
      });
      await expect(invoke('reset-password', send)).rejects.toThrow('AuthBackendUnavailable');
      expect(send).toHaveBeenCalledOnce();
    },
  );
  it('bounds outbound payload bytes before any private send', async () => {
    const send = transport();
    await expect(invoke('reset-password', send, { password: 'x'.repeat(1000000) })).rejects.toThrow(
      'AuthBackendUnavailable',
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('bounds a stalled transport, aborts it and never retries', async () => {
    const send = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const client = createPreEnforcementRecoveryCommandClient({ environment, fetch: send, timeoutMs: 5 });
    await expect(client.resetPassword({ token: 'raw' })).rejects.toThrow('AuthBackendUnavailable');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it.each(['missing-origin', 'insecure', 'shared-secret', 'short-secret'])(
    'refuses %s configuration before sending',
    async (invalid) => {
      const send = transport();
      const configured = { ...environment, NEXTAUTH_SECRET: '' };
      if (invalid === 'missing-origin') configured.CURRENT_STORE_AUTH_BACKEND_ORIGIN = '';
      if (invalid === 'insecure') configured.CURRENT_STORE_AUTH_BACKEND_ORIGIN = 'http://public.example.test';
      if (invalid === 'shared-secret') configured.NEXTAUTH_SECRET = configured.CURRENT_STORE_AUTH_RPC_SECRET;
      if (invalid === 'short-secret') configured.CURRENT_STORE_AUTH_RPC_SECRET = 'short';
      expect(() => createPreEnforcementRecoveryCommandClient({ environment: configured, fetch: send })).toThrow(
        'AuthBackendUnavailable',
      );
      expect(send).not.toHaveBeenCalled();
    },
  );
});
