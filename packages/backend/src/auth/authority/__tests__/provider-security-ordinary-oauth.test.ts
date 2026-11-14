import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authEmailProjection,
  authWebOAuthCommands,
  authWebOAuthIntents,
  users,
} from '@boardsesh/db/schema/auth';
import { WEB_OAUTH_PROTOCOL_VERSION } from '@boardsesh/auth-protocol';
import { createProviderSecurityEnvironment } from './provider-security-fixture';
import { recordWebOAuthIntent, resolveWebOAuthIdentity } from '../../current-store/web-oauth-identity';
import { reserveEnforcedEmail } from '../../current-store/email-reservations';
import { admitOwnedProviderForRenewal } from '../provider-security-owned-provider';

let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
async function authority() {
  const [manifest] = await environment.database.select().from(authEmailProjection);
  return { ...environment.qualification, expectedWriterEpoch: manifest.writerEpoch };
}
async function reserve(userId: string) {
  const [user] = await environment.database.select().from(users).where(eq(users.id, userId));
  const expected = await authority();
  await environment.database.transaction(async (transaction) =>
    reserveEnforcedEmail(transaction, {
      ...expected,
      rawEmail: user.email,
      requestedUserId: userId,
    }),
  );
}
async function flow(actorCookie: string | null) {
  const flow = randomBytes(32).toString('hex');
  const result = await recordWebOAuthIntent(environment.database, await authority(), environment.secret, {
    webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
    operation: 'intent',
    requestId: randomUUID(),
    issuedAt: new Date().toISOString(),
    payload: { provider: 'google', flow, actorCookie },
  });
  expect(result.outcome).toBe('recorded');
  const [intent] = await environment.database
    .select()
    .from(authWebOAuthIntents)
    .where(eq(authWebOAuthIntents.flowHash, flow));
  return { flow, intent };
}
async function resolve(flow: string, actorCookie: string | null, subject: string) {
  return resolveWebOAuthIdentity(environment.database, await authority(), environment.secret, {
    webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
    operation: 'resolve',
    requestId: randomUUID(),
    issuedAt: new Date().toISOString(),
    credentialProofVersion: 1,
    payload: {
      provider: 'google',
      flow,
      actorCookie,
      subject,
      email: `provider-${randomUUID()}@example.test`,
      name: 'Untrusted callback profile',
      image: 'https://owned.example.test/provider-image',
    },
  });
}

describe('provider-security staging forbids ordinary OAuth linking before legacy intent consumption', () => {
  beforeEach(() => vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'owned-provider-ordinary-retired-mailbox-key'));
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => environment?.close());
  for (const selected of ['current-store', 'better-auth'] as const) {
    it(`${selected}: unowned ordinary callback cannot reach an implicit link or consume its legacy intent/command`, async () => {
      vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'backend-staging');
      vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
      const owner = await environment.actor(selected, 'legacy-jwe');
      const pending = await flow(owner.actor.credential);
      const beforeCommands = await environment.database.select().from(authWebOAuthCommands);
      const subject = randomUUID();
      expect((await resolve(pending.flow, owner.actor.credential, subject)).outcome).toBe('denied');
      expect(
        (
          await environment.database
            .select()
            .from(authWebOAuthIntents)
            .where(eq(authWebOAuthIntents.intentHash, pending.intent.intentHash))
        )[0],
      ).toEqual(pending.intent);
      expect(await environment.database.select().from(authWebOAuthCommands)).toEqual(beforeCommands);
      expect(
        await environment.database.select().from(accounts).where(eq(accounts.providerAccountId, subject)),
      ).toHaveLength(0);
      expect(
        await environment.database.select().from(authAccount).where(eq(authAccount.accountId, subject)),
      ).toHaveLength(0);
    });
    it(`${selected}: a returning owned callback keeps the original actor SID and age without rewriting profile fields`, async () => {
      vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'backend-staging');
      vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
      const subject = randomUUID();
      const owner = await environment.actor(selected, 'legacy-jwe', { provider: 'google', subject });
      await reserve(owner.userId);
      const [before] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
      const admission = await admitOwnedProviderForRenewal(environment.database, environment.runtime, {
        actor: owner.actor,
        provider: 'google',
        subject,
      });
      expect(admission.credentialProof).toMatchObject({
        userId: owner.userId,
        authSessionId: owner.sid,
        generation: 0,
        authenticatedAt: owner.authenticatedAt?.toISOString(),
        linkGuarded: true,
      });
      const pending = await flow(owner.actor.credential);
      const result = await resolve(pending.flow, owner.actor.credential, subject);
      expect(result.outcome).toBe('resolved');
      if (result.outcome !== 'resolved') throw new Error('Owned ordinary callback refused');
      expect(result.credentialProof).toMatchObject({
        userId: owner.userId,
        authSessionId: owner.sid,
        generation: 0,
        authenticatedAt: owner.authenticatedAt?.toISOString(),
      });
      expect((await environment.database.select().from(users).where(eq(users.id, owner.userId)))[0]).toEqual(before);
    });
    it(`${selected}: ownership changing after a successful read-only preflight is rechecked before legacy consume`, async () => {
      vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'backend-staging');
      vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
      const subject = randomUUID();
      const owner = await environment.actor(selected, 'legacy-jwe', { provider: 'google', subject });
      const other = await environment.actor(selected, 'canonical-token');
      await reserve(owner.userId);
      const pending = await flow(owner.actor.credential);
      expect(
        (
          await admitOwnedProviderForRenewal(environment.database, environment.runtime, {
            actor: owner.actor,
            provider: 'google',
            subject,
          })
        ).outcome,
      ).toBe('owned');
      if (selected === 'current-store')
        await environment.database
          .update(accounts)
          .set({ userId: other.userId })
          .where(and(eq(accounts.provider, 'google'), eq(accounts.providerAccountId, subject)));
      else
        await environment.database
          .update(authAccount)
          .set({ userId: other.userId })
          .where(and(eq(authAccount.providerId, 'google'), eq(authAccount.accountId, subject)));
      const beforeCommands = await environment.database.select().from(authWebOAuthCommands);
      expect((await resolve(pending.flow, owner.actor.credential, subject)).outcome).toBe('denied');
      expect(
        (
          await environment.database
            .select()
            .from(authWebOAuthIntents)
            .where(eq(authWebOAuthIntents.intentHash, pending.intent.intentHash))
        )[0],
      ).toEqual(pending.intent);
      expect(await environment.database.select().from(authWebOAuthCommands)).toEqual(beforeCommands);
    });
    it(`${selected}: anonymous ordinary provider sign-in remains available without becoming a fresh reauthentication receipt`, async () => {
      vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'backend-staging');
      vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
      await environment.selectAuthority(selected);
      const pending = await flow(null);
      const result = await resolve(pending.flow, null, randomUUID());
      expect(result.outcome).toBe('resolved');
      if (result.outcome !== 'resolved') throw new Error('Anonymous ordinary sign-in refused');
      expect(result.createdUser).toBe(true);
    });
  }
});
