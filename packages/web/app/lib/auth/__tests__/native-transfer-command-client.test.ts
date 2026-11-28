import { describe, expect, it, vi } from 'vite-plus/test';
vi.mock('server-only', () => ({}));
import { createNativeTransferCommandClient } from '../native-transfer-command-client.server';
import { AuthBackendUnavailableError } from '../auth-command-transport.server';

const environment = {
  NODE_ENV: 'test',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'http://localhost:8080',
  CURRENT_STORE_AUTH_RPC_SECRET: 'synthetic-native-transfer-private-rpc-secret',
};
function reply(requestId: string) {
  return {
    nativeTransferProtocolVersion: 1,
    operation: 'claim',
    requestId,
    outcome: 'claimed',
    user: { id: 'original-user', email: 'original@example.test', name: null, image: null },
    sourceGeneration: 3,
  };
}
describe('private browser native-transfer client', () => {
  it('sends only the signed token to the fixed private path and validates the reply', async () => {
    const send = vi.fn<typeof fetch>(async (_input, init) => {
      const command = JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as {
        requestId: string;
        payload: unknown;
      };
      expect(command.payload).toEqual({ transferToken: 'signed.transfer' });
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer ${environment.CURRENT_STORE_AUTH_RPC_SECRET}`,
      );
      return Response.json(reply(command.requestId));
    });
    const result = await createNativeTransferCommandClient({ environment, fetch: send }).claim('signed.transfer');
    expect(result.outcome).toBe('claimed');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBe('http://localhost:8080/api/internal/auth/current-store/native-transfer');
  });
  it.each(['wrong-request', 'wrong-version', 'wrong-status', 'extra-field', 'unavailable', 'old-backend'] as const)(
    'treats %s as unavailable without retry',
    async (failure) => {
      const send = vi.fn<typeof fetch>(async (_input, init) => {
        const { requestId } = JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as { requestId: string };
        const valid = reply(requestId);
        if (failure === 'wrong-request')
          return Response.json({ ...valid, requestId: '00000000-0000-4000-8000-000000000001' });
        if (failure === 'wrong-version') return Response.json({ ...valid, nativeTransferProtocolVersion: 2 });
        if (failure === 'wrong-status') return Response.json(valid, { status: 401 });
        if (failure === 'extra-field') return Response.json({ ...valid, token: 'unexpected' });
        if (failure === 'old-backend') return Response.json({ error: 'disabled' }, { status: 404 });
        return Response.json(
          { nativeTransferProtocolVersion: 1, operation: 'claim', requestId, outcome: 'unavailable' },
          { status: 503 },
        );
      });
      await expect(
        createNativeTransferCommandClient({ environment, fetch: send }).claim('signed.transfer'),
      ).rejects.toBeInstanceOf(AuthBackendUnavailableError);
      expect(send).toHaveBeenCalledOnce();
    },
  );
});
