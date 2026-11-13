import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import type { DbInstance } from '@boardsesh/db/client';
import type { WebOAuthIntentCommand, WebOAuthResolveCommand } from '@boardsesh/auth-protocol';
import { recordWebOAuthIntent, resolveWebOAuthIdentity } from '../../current-store/web-oauth-identity';
import { resolveReservedCurrentStoreOAuthIdentity } from '../../current-store/provider-oauth-identity';
import { CURRENT_EMAIL_NORMALIZER_VERSION, type CurrentStoreTransaction } from '../../current-store/foundation-context';

const authority = {
  expectedProjectionId: randomUUID(),
  expectedWriterEpoch: 1,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
};
const noStorage = new Proxy(
  {},
  {
    get() {
      throw new Error('Disabled provider reached storage');
    },
  },
);
const metadata = { webOAuthProtocolVersion: 1, issuedAt: new Date().toISOString(), requestId: randomUUID() };
const payload = { provider: 'facebook', flow: 'a'.repeat(64), actorCookie: null };

describe('Facebook product refusal before storage', () => {
  it('refuses a direct intent caller even if its compile-time type was bypassed', async () => {
    const command = { ...metadata, operation: 'intent', payload } as unknown as WebOAuthIntentCommand;
    await expect(recordWebOAuthIntent(noStorage as DbInstance, authority, 'unused', command)).resolves.toMatchObject({
      operation: 'intent',
      outcome: 'denied',
      code: 'identity_unavailable',
    });
  });

  it('refuses a direct resolve caller before receipt reads or nonce claims', async () => {
    const command = {
      ...metadata,
      operation: 'resolve',
      payload: { ...payload, subject: 'stored-subject', email: null, name: null, image: null },
    } as unknown as WebOAuthResolveCommand;
    await expect(resolveWebOAuthIdentity(noStorage as DbInstance, authority, 'unused', command)).resolves.toMatchObject(
      { operation: 'resolve', outcome: 'denied', code: 'identity_unavailable' },
    );
  });

  it('refuses the selected writer helper before locks or selected identity reads', async () => {
    await expect(
      resolveReservedCurrentStoreOAuthIdentity(
        noStorage as CurrentStoreTransaction,
        authority,
        'facebook' as 'google',
        { sub: 'stored-subject', email: null, emailVerified: false, name: null },
        { storeProviderImage: true, emailVerification: 'unverified', actorUserId: null },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
  });
});
