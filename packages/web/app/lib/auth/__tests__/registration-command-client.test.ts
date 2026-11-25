import { describe, expect, it, vi } from 'vitest';
import { AUTH_PROTOCOL_VERSION } from '@boardsesh/auth-protocol';
vi.mock('server-only', () => ({}));
import { createRegistrationCommandClient } from '../registration-command-client.server';
import { AuthBackendUnavailableError } from '../auth-command-transport.server';

const environment = {
  NODE_ENV: 'test',
  CURRENT_STORE_WEB_AUTH_MODE: 'legacy',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'http://127.0.0.1:54321',
  CURRENT_STORE_AUTH_RPC_SECRET: 'owned-registration-client-secret-32-characters',
};
function commandBody(request?: RequestInit): Record<string, unknown> {
  if (typeof request?.body !== 'string') throw new Error('Expected serialized command');
  return JSON.parse(request.body) as Record<string, unknown>;
}
function fixture(mutate: (reply: Record<string, unknown>) => Record<string, unknown> = (reply) => reply, status = 201) {
  const send = vi.fn<typeof fetch>(async (_address, request) => {
    const command = commandBody(request);
    return Response.json(
      mutate({
        protocolVersion: AUTH_PROTOCOL_VERSION,
        requestId: command.requestId,
        operation: command.operation,
        outcome: 'created',
        userId: 'owned-client-user',
        createdAt: '2026-11-24T12:00:00.000Z',
        requiresVerification: false,
      }),
      { status },
    );
  });
  return { send, client: createRegistrationCommandClient({ environment, fetch: send }) };
}

describe('default registration-family strict client', () => {
  it('uses the independent private path while staged mode retains its released path', async () => {
    const current = fixture();
    expect((await current.client.register({ email: 'x' })).outcome).toBe('created');
    expect(current.send.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:54321/api/internal/auth/current-store/registration/v1/register',
    );
    const staged = createRegistrationCommandClient({
      environment: { ...environment, CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging' },
      fetch: current.send,
    });
    await staged.register({ email: 'x' });
    expect(current.send.mock.calls[1]?.[0]).toBe('http://127.0.0.1:54321/api/internal/auth/current-store/register');
  });
  it.each([
    ['wrong version', (reply: Record<string, unknown>) => ({ ...reply, protocolVersion: 1 }), 201],
    ['different command', (reply: Record<string, unknown>) => ({ ...reply, operation: 'password' }), 201],
    [
      'different request',
      (reply: Record<string, unknown>) => ({ ...reply, requestId: '00000000-0000-4000-8000-000000000000' }),
      201,
    ],
    ['status disagrees', (reply: Record<string, unknown>) => reply, 200],
    [
      'unknown private field',
      (reply: Record<string, unknown>) => ({ ...reply, credential: 'private-unexpected-field' }),
      201,
    ],
  ] as const)('does not accept or retry %s', async (_name, mutate, status) => {
    const current = fixture(mutate, status);
    await expect(current.client.register({ email: 'x' })).rejects.toThrow(AuthBackendUnavailableError);
    expect(current.send).toHaveBeenCalledOnce();
  });
  it('uses only server-supplied top-level context, never payload context', async () => {
    const current = fixture();
    const client = createRegistrationCommandClient({ environment, fetch: current.send, clientAddress: '203.0.113.9' });
    await client.register({ email: 'x', clientAddress: '198.51.100.7' });
    const command = commandBody(current.send.mock.calls[0]?.[1]);
    expect(command.clientAddress).toBe('203.0.113.9');
    expect(command.payload).toMatchObject({ clientAddress: '198.51.100.7' });
  });
  it('omits unvouched context and leaves staged DTO shapes unchanged', async () => {
    const current = fixture();
    await createRegistrationCommandClient({ environment, fetch: current.send, clientAddress: null }).register({
      email: 'x',
    });
    await createRegistrationCommandClient({
      environment: { ...environment, CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging' },
      fetch: current.send,
      clientAddress: '203.0.113.9',
    }).register({ email: 'x' });
    for (const call of current.send.mock.calls) expect(commandBody(call[1])).not.toHaveProperty('clientAddress');
  });
  it('refuses invalid service context before sending', () => {
    const current = fixture();
    expect(() =>
      createRegistrationCommandClient({ environment, fetch: current.send, clientAddress: 'caller-chosen-bucket' }),
    ).toThrow(AuthBackendUnavailableError);
    expect(current.send).not.toHaveBeenCalled();
  });
  it('never retries a lost response', async () => {
    const send = vi.fn().mockRejectedValue(new Error('private transport failure'));
    await expect(
      createRegistrationCommandClient({ environment, fetch: send }).register({ email: 'x' }),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });
});
