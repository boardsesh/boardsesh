import { describe, expect, it, vi } from 'vite-plus/test';
import { PRE_ENFORCEMENT_PASSWORD_PATH } from '@boardsesh/auth-protocol';
vi.mock('server-only', () => ({}));
import { createPreEnforcementPasswordCommandClient } from '../pre-enforcement-password-client.server';
const environment = {
  NODE_ENV: 'test',
  CURRENT_STORE_WEB_AUTH_MODE: 'legacy',
  CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'off',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'http://127.0.0.1:3070',
  CURRENT_STORE_AUTH_RPC_SECRET: 'owned-password-client-rpc-secret-6975',
};
function transport(mutate: (reply: Record<string, unknown>) => void = () => {}, status = 200) {
  return vi.fn<typeof fetch>(async (_input, options) => {
    if (typeof options?.body !== 'string') throw new Error('Owned command body missing');
    const command = JSON.parse(options.body) as { requestId: string };
    const reply: Record<string, unknown> = {
      protocolVersion: 2,
      operation: 'password',
      requestId: command.requestId,
      outcome: 'authenticated',
      user: { id: 'owner', email: 'Owner@example.test', name: null, image: null },
      verification: { userId: 'owner', required: false, verified: true },
      credentialProof: {
        version: 1,
        userId: 'owner',
        authSessionId: 'actual-login',
        generation: 3,
        authenticatedAt: '2026-11-24T01:02:03.000Z',
        linkGuarded: true,
      },
    };
    mutate(reply);
    return Response.json(reply, { status });
  });
}
describe('default web password strict mandatory-proof transport', () => {
  it('uses the separate private path without staged mode and preserves submitted password bytes', async () => {
    const send = transport();
    const client = createPreEnforcementPasswordCommandClient({ environment, fetch: send });
    expect((await client.password('  Mixed@example.test  ', ' é\u0301 raw ', '8.8.8.8')).outcome).toBe('authenticated');
    expect(send).toHaveBeenCalledOnce();
    const [url, options] = send.mock.calls[0];
    expect(new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).pathname).toBe(
      PRE_ENFORCEMENT_PASSWORD_PATH,
    );
    if (typeof options?.body !== 'string') throw new Error('Owned command body missing');
    expect(JSON.parse(options.body)).toMatchObject({
      credentialProofVersion: 1,
      clientAddress: '8.8.8.8',
      payload: { email: '  Mixed@example.test  ', password: ' é\u0301 raw ' },
    });
  });
  it.each(['requestId', 'operation', 'missing', 'null-age', 'unguarded', 'wrong-owner', 'session', 'carried'] as const)(
    'refuses %s without retry',
    async (invalid) => {
      const send = transport((reply) => {
        if (invalid === 'requestId') reply.requestId = '00000000-0000-4000-8000-000000000000';
        if (invalid === 'operation') reply.operation = 'register';
        if (invalid === 'missing') delete reply.credentialProof;
        if (invalid === 'session')
          reply.webSession = {
            sessionId: 'other',
            token: 'opaque',
            generation: 3,
            expiresAt: '2026-12-24T01:02:03.000Z',
          };
        const proof = reply.credentialProof as Record<string, unknown> | undefined;
        if (proof && invalid === 'null-age') proof.authenticatedAt = null;
        if (proof && invalid === 'unguarded') proof.linkGuarded = false;
        if (proof && invalid === 'wrong-owner') proof.userId = 'sibling';
        if (proof && invalid === 'carried') proof.requiresAccountCutoff = true;
      });
      await expect(
        createPreEnforcementPasswordCommandClient({ environment, fetch: send }).password('owner@example.test', 'raw'),
      ).rejects.toThrow('AuthBackendUnavailable');
      expect(send).toHaveBeenCalledOnce();
    },
  );
  it('refuses status disagreement without retry', async () => {
    const send = transport(undefined, 201);
    await expect(
      createPreEnforcementPasswordCommandClient({ environment, fetch: send }).password('owner@example.test', 'raw'),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });
  it('retains uncertainty after an unavailable old backend or lost acknowledgement', async () => {
    for (const send of [
      vi.fn<typeof fetch>(async () => Response.json({ error: 'disabled' }, { status: 404 })),
      vi.fn<typeof fetch>(async () => {
        throw new Error('lost committed acknowledgement');
      }),
    ]) {
      await expect(
        createPreEnforcementPasswordCommandClient({ environment, fetch: send }).password('owner@example.test', 'raw'),
      ).rejects.toThrow();
      expect(send).toHaveBeenCalledOnce();
    }
  });
});
