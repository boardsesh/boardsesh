import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { authBrowserIntents, authEmailProjection, authSession, authWebOAuthIntents } from '@boardsesh/db/schema/auth';
import { createProviderSecurityEnvironment } from './provider-security-fixture';
import { beginBrowserIntent, commitBrowserLoginInTransaction, readBrowserBinding } from '../browser-binding';
import { captureIdentityAuthority } from '../router';
import { transactionSettings } from '../../current-store/command-context';
import { providerTokenHash } from '../provider-security-context';

let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;

async function attempt(selected: 'current-store' | 'better-auth') {
  const actor = await environment.actor(selected, 'canonical-token');
  const target = await environment.actor(selected, 'canonical-token');
  const presentedActor = { version: actor.actor.browserVersion, credential: actor.credential };
  const intent = await beginBrowserIntent(
    environment.database,
    environment.qualification,
    actor.actor.browserBindingToken,
    {
      operation: 'login',
      expectedVersion: actor.actor.browserVersion,
      presented: presentedActor,
    },
  );
  if (intent.status !== 'prepared') throw new Error('Owned login intent refused');
  const candidate = { kind: 'canonical-token' as const, token: randomBytes(32).toString('base64url') };
  const candidateSessionId = randomUUID();
  const flowHash = randomBytes(32).toString('hex');
  const intentHash = randomBytes(32).toString('hex');
  const issueAndCommit = () =>
    environment.database.transaction(async (transaction) => {
      await transactionSettings(transaction);
      const authority = await captureIdentityAuthority(transaction, environment.qualification);
      const now = new Date();
      await transaction.insert(authSession).values({
        id: candidateSessionId,
        userId: target.userId,
        token: candidate.token,
        expiresAt: new Date(now.getTime() + 3_600_000),
        updatedAt: now,
        originalAuthenticatedAt: null,
        revocationGeneration: 0,
      });
      await transaction.insert(authWebOAuthIntents).values({
        intentHash,
        provider: 'apple',
        flowHash,
        actorUserId: actor.userId,
        actorLineageHash: providerTokenHash(actor.actor.credential),
        actorObservedGeneration: 0,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
        consumedAt: now,
      });
      const result = await commitBrowserLoginInTransaction(
        transaction,
        authority,
        actor.actor.browserBindingToken,
        intent.intentToken,
        candidate,
        presentedActor,
      );
      // Issuers must roll back their credential writes on every refused login.
      if (result.status !== 'committed') throw new Error('Owned final login refused');
      return result;
    });
  return { actor, target, intent, candidate, candidateSessionId, intentHash, issueAndCommit };
}

describe('credential issuance and browser login in one caller-owned transaction', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
  });
  afterAll(async () => environment?.close());
  for (const selected of ['current-store', 'better-auth'] as const) {
    it(`${selected}: commits credential, flow receipt and exact B selection together`, async () => {
      const pending = await attempt(selected);
      const committed = await pending.issueAndCommit();
      expect(committed.session?.userId).toBe(pending.target.userId);
      expect(
        await environment.database.select().from(authSession).where(eq(authSession.id, pending.candidateSessionId)),
      ).toHaveLength(1);
      expect(
        await environment.database
          .select()
          .from(authWebOAuthIntents)
          .where(eq(authWebOAuthIntents.intentHash, pending.intentHash)),
      ).toHaveLength(1);
      expect(
        await readBrowserBinding(
          environment.database,
          environment.qualification,
          pending.actor.actor.browserBindingToken,
          { version: committed.cursor.version, credential: pending.candidate },
        ),
      ).toMatchObject({
        status: 'admitted',
        session: { userId: pending.target.userId, authenticatedAt: null, linkGuarded: false },
      });
    });

    it(`${selected}: a real post-selection authority change throws and rolls back every earlier write`, async () => {
      const pending = await attempt(selected);
      const [before] = await environment.database.select().from(authEmailProjection);
      await environment.database
        .execute(sql`CREATE FUNCTION drift_owned_login_authority() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN UPDATE auth_email_projection SET writer_epoch = writer_epoch + 1 WHERE is_current; RETURN NEW; END $$`);
      await environment.database
        .execute(sql`CREATE TRIGGER drift_owned_login_authority AFTER UPDATE ON auth_browser_bindings
        FOR EACH ROW EXECUTE FUNCTION drift_owned_login_authority()`);
      try {
        await expect(pending.issueAndCommit()).rejects.toThrow();
      } finally {
        await environment.database.execute(sql`DROP TRIGGER drift_owned_login_authority ON auth_browser_bindings`);
        await environment.database.execute(sql`DROP FUNCTION drift_owned_login_authority()`);
      }
      expect(
        await environment.database.select().from(authSession).where(eq(authSession.id, pending.candidateSessionId)),
      ).toHaveLength(0);
      expect(
        await environment.database
          .select()
          .from(authWebOAuthIntents)
          .where(eq(authWebOAuthIntents.intentHash, pending.intentHash)),
      ).toHaveLength(0);
      const [intent] = await environment.database
        .select()
        .from(authBrowserIntents)
        .where(eq(authBrowserIntents.id, providerTokenHash(pending.intent.intentToken)));
      expect(intent.consumedAt).toBeNull();
      expect((await environment.database.select().from(authEmailProjection))[0]).toEqual(before);
      expect(
        await readBrowserBinding(
          environment.database,
          environment.qualification,
          pending.actor.actor.browserBindingToken,
          { version: pending.actor.actor.browserVersion, credential: pending.actor.credential },
        ),
      ).toMatchObject({ status: 'admitted', session: { userId: pending.actor.userId } });
    });
  }
});
