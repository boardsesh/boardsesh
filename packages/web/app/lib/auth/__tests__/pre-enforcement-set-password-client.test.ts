import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { AUTH_PROTOCOL_VERSION, SET_PASSWORD_COMPATIBILITY_PATH } from '@boardsesh/auth-protocol';
import { createAuthCommandTransport } from '../auth-command-transport.server';
vi.mock('server-only', () => ({}));
import { createPreEnforcementSetPasswordCommandClient } from '../pre-enforcement-set-password-client.server';

const environment = {
  NODE_ENV: 'test',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'http://127.0.0.1:3070',
  CURRENT_STORE_AUTH_RPC_SECRET: 'owned-set-password-client-private-secret-6975',
};
const payload = {
  credential: 'held-selected-jwe',
  password: ' raw é\u0301 password ',
  confirmPassword: ' raw é\u0301 password ',
  viewer: { userId: 'owner', authSessionId: null },
};
function transport(
  fields: Record<string, unknown> = { outcome: 'set' },
  status = 200,
  mutate?: (reply: Record<string, unknown>) => void,
) {
  return vi.fn<typeof fetch>(async (_input, options) => {
    if (typeof options?.body !== 'string') throw new Error('Owned command body missing');
    const command = JSON.parse(options.body) as { requestId: string };
    const reply = {
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'set-password',
      requestId: command.requestId,
      ...fields,
    };
    mutate?.(reply);
    return Response.json(reply, { status });
  });
}
function serializedBody(options: RequestInit | undefined): string {
  if (typeof options?.body !== 'string') throw new Error('Owned serialized command missing');
  return options.body;
}
afterEach(() => vi.unstubAllGlobals());

describe('default set-password strict compatibility client', () => {
  it('uses the dedicated path and preserves raw credential/password and null presentation SID', async () => {
    const send = transport();
    expect(
      (await createPreEnforcementSetPasswordCommandClient({ environment, fetch: send }).setPassword(payload, '8.8.8.8'))
        .outcome,
    ).toBe('set');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBe(environment.CURRENT_STORE_AUTH_BACKEND_ORIGIN + SET_PASSWORD_COMPATIBILITY_PATH);
    const options = send.mock.calls[0][1];
    expect(new Headers(options?.headers).get('Authorization')).toBe(
      `Bearer ${environment.CURRENT_STORE_AUTH_RPC_SECRET}`,
    );
    expect(JSON.parse(serializedBody(options))).toMatchObject({
      protocolVersion: 2,
      operation: 'set-password',
      payload,
      clientAddress: '8.8.8.8',
    });
  });
  it.each([
    [{ outcome: 'set' }, 200],
    [{ outcome: 'already_set' }, 409],
    [{ outcome: 'unauthenticated' }, 401],
    [{ outcome: 'identity_changed' }, 409],
    [{ outcome: 'error', code: 'rate_limited', retryAfterSeconds: 20 }, 429],
    [{ outcome: 'error', code: 'replayed' }, 503],
    [{ outcome: 'error', code: 'unavailable' }, 503],
    [{ outcome: 'error', code: 'rolled_back' }, 500],
  ])('accepts only the literal correlated private matrix%j/%s', async (fields, status) => {
    const send = transport(fields, status);
    expect(
      await createPreEnforcementSetPasswordCommandClient({ environment, fetch: send }).setPassword(payload),
    ).toMatchObject(fields);
    expect(send).toHaveBeenCalledOnce();
  });
  it.each(['requestId', 'operation', 'protocol', 'proof', 'unknown', 'bad-retry'])(
    'sanitizes invalid reply%s without retry',
    async (kind) => {
      const send = transport(undefined, 200, (reply) => {
        if (kind === 'requestId') reply.requestId = '00000000-0000-4000-8000-000000000000';
        if (kind === 'operation') reply.operation = 'password';
        if (kind === 'protocol') reply.protocolVersion = 1;
        if (kind === 'proof') reply.credentialProof = { generation: 1 };
        if (kind === 'unknown') reply.outcome = 'committed';
        if (kind === 'bad-retry')
          Object.assign(reply, { outcome: 'error', code: 'rate_limited', retryAfterSeconds: Number.NaN });
      });
      await expect(
        createPreEnforcementSetPasswordCommandClient({ environment, fetch: send }).setPassword(payload),
      ).rejects.toThrow('AuthBackendUnavailable');
      expect(send).toHaveBeenCalledOnce();
    },
  );
  it.each([201, 401, 409, 500, 503])('refuses HTTP%s disagreement even with a correlated set reply', async (status) => {
    const send = transport(undefined, status);
    await expect(
      createPreEnforcementSetPasswordCommandClient({ environment, fetch: send }).setPassword(payload),
    ).rejects.toThrow('AuthBackendUnavailable');
    expect(send).toHaveBeenCalledOnce();
  });
  it.each([400, 401, 404, 409, 500, 503])('does not turn bare service HTTP%s into a user verdict', async (status) => {
    const send = vi.fn<typeof fetch>(async () =>
      Response.json({ error: 'internal detail with submitted secret' }, { status }),
    );
    await expect(
      createPreEnforcementSetPasswordCommandClient({ environment, fetch: send }).setPassword(payload),
    ).rejects.toThrow('AuthBackendUnavailable');
    expect(send).toHaveBeenCalledOnce();
  });
  it('does not retry a lost acknowledgement and never retains its cause', async () => {
    const send = vi.fn<typeof fetch>(async () => {
      throw new Error('unknown COMMIT secret');
    });
    await expect(
      createPreEnforcementSetPasswordCommandClient({ environment, fetch: send }).setPassword(payload),
    ).rejects.toMatchObject({ message: 'AuthBackendUnavailable' });
    expect(send).toHaveBeenCalledOnce();
  });
  it('bounds a pending fetch without a second send', async () => {
    const send = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    await expect(
      createPreEnforcementSetPasswordCommandClient({ environment, fetch: send, timeoutMs: 1 }).setPassword(payload),
    ).rejects.toThrow('AuthBackendUnavailable');
    expect(send).toHaveBeenCalledOnce();
  });
  it('bounds a response whose body never ends', async () => {
    const send = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    await expect(
      createPreEnforcementSetPasswordCommandClient({ environment, fetch: send, timeoutMs: 1 }).setPassword(payload),
    ).rejects.toThrow('AuthBackendUnavailable');
    expect(send).toHaveBeenCalledOnce();
  });
  it('keeps the existing16KiB transport default while accepting the measured16772-byte family envelope', async () => {
    const send = transport();
    const client = createPreEnforcementSetPasswordCommandClient({ environment, fetch: send });
    await client.setPassword({
      ...payload,
      credential: 'x'.repeat(15927),
      password: '🧗'.repeat(64),
      confirmPassword: '🧗'.repeat(64),
      viewer: { userId: 'owner', authSessionId: 's'.repeat(1025) },
    });
    expect(send).toHaveBeenCalledOnce();
    const serialized = serializedBody(send.mock.calls[0][1]);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(16384);
    const otherSend = transport();
    await expect(
      createAuthCommandTransport({ paths: [SET_PASSWORD_COMPATIBILITY_PATH], environment, fetch: otherSend }).post(
        SET_PASSWORD_COMPATIBILITY_PATH,
        JSON.parse(serialized),
      ),
    ).rejects.toThrow('AuthBackendUnavailable');
    expect(otherSend).not.toHaveBeenCalled();
  });
  it.each(['界'.repeat(128), '\u0000'.repeat(128)])(
    'checks actual complete UTF8/escaped JSON at the exact65536-byte boundary',
    async (password) => {
      const send = transport();
      const client = createPreEnforcementSetPasswordCommandClient({ environment, fetch: send });
      const probe = { ...payload, password, confirmPassword: password };
      await client.setPassword(probe);
      const overhead = Buffer.byteLength(serializedBody(send.mock.calls[0][1])) - Buffer.byteLength(probe.credential);
      send.mockClear();
      const boundary = { ...probe, credential: 'x'.repeat(65536 - overhead) };
      await client.setPassword(boundary);
      expect(Buffer.byteLength(serializedBody(send.mock.calls[0][1]))).toBe(65536);
      send.mockClear();
      await expect(client.setPassword({ ...boundary, credential: boundary.credential + 'x' })).rejects.toThrow(
        'AuthBackendUnavailable',
      );
      expect(send).not.toHaveBeenCalled();
    },
  );
  it('validates finite outgoing payload and configuration before sending', async () => {
    const send = transport();
    await expect(
      createPreEnforcementSetPasswordCommandClient({ environment, fetch: send }).setPassword({
        ...payload,
        confirmPassword: 'mismatch',
      }),
    ).rejects.toThrow('AuthBackendUnavailable');
    expect(() =>
      createPreEnforcementSetPasswordCommandClient({
        environment: { ...environment, CURRENT_STORE_AUTH_RPC_SECRET: '' },
        fetch: send,
      }),
    ).toThrow('AuthBackendUnavailable');
    expect(send).not.toHaveBeenCalled();
  });
});
