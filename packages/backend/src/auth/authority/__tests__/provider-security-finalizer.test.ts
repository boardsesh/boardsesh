import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authEmailVerificationState,
  authPasswordRecoveryState,
  authProviderReauthenticationReceipts,
  authProviderSecurityIntents,
  authSession,
  authSubjectCutoffs,
  mobileRefreshTokens,
  oauthClient,
  oauthConnections,
  oauthGrants,
  oauthRefreshToken,
  users,
} from '@boardsesh/db/schema/auth';
import { createProviderSecurityEnvironment } from './provider-security-fixture';
import { finalizeProviderSecurityMutation, prepareProviderSecurityMutation } from '../provider-security-finalizer';
import {
  bindProviderSecurityFlow,
  createProviderSecurityIntent,
  readProviderSecurityMethods,
} from '../provider-security-intents';
import { reauthenticateProviderWithPassword } from '../provider-security-reauthentication';
import { acknowledgeProviderSecurityResult } from '../provider-security-terminal';
import { providerTokenHash } from '../provider-security-context';
import { readFirstPartySession } from '../session-reader';
import type { FirstPartyCredential } from '../session-reader';
import * as sessionReader from '../session-reader';
import { readLockedWebSubjectState } from '../../current-store/web-credential-state';
import { recordFunctionLevelIdentityMirrorForTests } from '../mirror-activation';
import { sessionTokenDigest } from '../session-token';

// These writers run with the mirror on and no backend boot (function-level mirror).
recordFunctionLevelIdentityMirrorForTests();

let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
async function admit(credential: FirstPartyCredential) {
  return environment.database.transaction((transaction) =>
    readFirstPartySession(transaction, credential, new Date(), (userId) =>
      readLockedWebSubjectState(transaction, userId),
    ),
  );
}
async function providerRow(userId: string, subject: string, selected: 'current-store' | 'better-auth') {
  return selected === 'current-store'
    ? environment.database
        .select()
        .from(accounts)
        .where(and(eq(accounts.userId, userId), eq(accounts.providerAccountId, subject)))
    : environment.database
        .select()
        .from(authAccount)
        .where(and(eq(authAccount.userId, userId), eq(authAccount.accountId, subject)));
}
async function storedIntent(token: string) {
  const [intent] = await environment.database
    .select()
    .from(authProviderSecurityIntents)
    .where(eq(authProviderSecurityIntents.intentHash, providerTokenHash(token)));
  return intent;
}
async function partner(userId: string) {
  const clientId = randomUUID();
  const id = randomUUID();
  await environment.database
    .insert(oauthClient)
    .values({ id: clientId, clientId, redirectUris: ['https://owned.example.test/callback'] });
  await environment.database
    .insert(oauthConnections)
    .values({ id, userId, clientId, generation: 0, scopes: ['logbook:read'] });
  await environment.database
    .insert(oauthGrants)
    .values({ authorizationCodeId: randomUUID(), connectionId: id, generation: 0 });
  await environment.database.insert(oauthRefreshToken).values({
    id: randomUUID(),
    token: randomUUID(),
    userId,
    clientId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    scopes: ['logbook:read'],
  });
  return id;
}

describe('buffered provider mutation selected-authority finalize transaction', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => environment?.close());
  for (const selected of ['current-store', 'better-auth'] as const) {
    it(`${selected}: proof expiry during a real held final write rolls back credentials and keeps only terminal intent consumption`, async () => {
      vi.stubEnv('AUTH_IDENTITY_MIRROR', 'off');
      const owner = await environment.actor(selected, 'canonical-token');
      const connectionId = await partner(owner.userId);
      const prepared = await environment.prepareLink(owner);
      await environment.database.execute(sql`UPDATE auth_provider_reauthentication_receipts
        SET expires_at = clock_timestamp() + interval '2 seconds'
        WHERE receipt_hash = ${providerTokenHash(prepared.reauthenticationToken)}`);
      await environment.database
        .execute(sql`CREATE FUNCTION hold_provider_final_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.phase = 'committed' THEN PERFORM pg_sleep(3); END IF; RETURN NEW; END $$`);
      await environment.database
        .execute(sql`CREATE TRIGGER hold_provider_final_write BEFORE UPDATE ON auth_provider_security_intents
        FOR EACH ROW EXECUTE FUNCTION hold_provider_final_write()`);
      try {
        const pending = finalizeProviderSecurityMutation(environment.database, environment.runtime, prepared);
        let observedSleep = false;
        const until = Date.now() + 2000;
        while (!observedSleep && Date.now() < until) {
          const [state] = await environment.client<{ sleeping: boolean }[]>`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep'
          ) AS sleeping`;
          observedSleep = state.sleeping;
          if (!observedSleep) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const reply = await pending;
        expect(observedSleep).toBe(true);
        expect(reply).toMatchObject({ outcome: 'reauthentication_required', code: 'expired' });
      } finally {
        await environment.database.execute(
          sql`DROP TRIGGER hold_provider_final_write ON auth_provider_security_intents`,
        );
        await environment.database.execute(sql`DROP FUNCTION hold_provider_final_write()`);
      }
      expect(await providerRow(owner.userId, prepared.subject, selected)).toHaveLength(0);
      expect(
        await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, owner.userId)),
      ).toHaveLength(0);
      const [session] = await environment.database.select().from(authSession).where(eq(authSession.id, owner.sid));
      expect(session.token).toBe(sessionTokenDigest(owner.actor.credential));
      expect(session.revocationGeneration).toBe(0);
      const [connection] = await environment.database
        .select()
        .from(oauthConnections)
        .where(eq(oauthConnections.id, connectionId));
      expect(connection.generation).toBe(0);
      expect(connection.revokedAt).toBeNull();
      expect((await storedIntent(prepared.intentToken)).phase).toBe('terminal');
      const [proof] = await environment.database
        .select()
        .from(authProviderReauthenticationReceipts)
        .where(eq(authProviderReauthenticationReceipts.receiptHash, providerTokenHash(prepared.reauthenticationToken)));
      expect(proof.consumedAt).toBeNull();
    });
    it(`${selected}: a verified callback for another provider cannot consume this provider's intent or proof`, async () => {
      const owner = await environment.actor(selected, 'canonical-token');
      const intent = await createProviderSecurityIntent(environment.database, environment.runtime, {
        actor: owner.webActor,
        action: 'link',
        provider: 'apple',
        methodId: null,
      });
      const bound = { actor: owner.webActor, intentToken: intent.intentToken };
      const proof = await reauthenticateProviderWithPassword(environment.database, environment.runtime, {
        ...bound,
        password: ' exact password ',
      });
      const flowHash = randomBytes(32).toString('hex');
      await bindProviderSecurityFlow(environment.database, environment.runtime, { ...bound, flowHash });
      const before = await storedIntent(intent.intentToken);
      const subject = randomUUID();
      await expect(
        prepareProviderSecurityMutation(environment.database, environment.runtime, {
          ...bound,
          reauthenticationToken: proof.reauthenticationToken,
          flowHash,
          providerProof: { provider: 'google', subject, email: 'verified@example.test', emailVerified: true },
        }),
      ).rejects.toMatchObject({ outcome: 'denied', code: 'invalid_proof' });
      expect(await storedIntent(intent.intentToken)).toEqual(before);
      expect(await providerRow(owner.userId, subject, selected)).toHaveLength(0);
      const [receipt] = await environment.database
        .select()
        .from(authProviderReauthenticationReceipts)
        .where(eq(authProviderReauthenticationReceipts.receiptHash, providerTokenHash(proof.reauthenticationToken)));
      expect(receipt.consumedAt).toBeNull();
    });
    it(`${selected}: explicit unlink can remove a disabled provider while retaining the selected usable password`, async () => {
      const subject = randomUUID();
      const owner = await environment.actor(selected, 'canonical-token', { provider: 'apple', subject });
      const runtime = {
        ...environment.runtime,
        methods: { ...environment.runtime.methods, configuredProviders: ['google'] as const },
      };
      const methods = await readProviderSecurityMethods(environment.database, runtime, owner.webActor);
      const method = methods.providers.find((provider) => provider.provider === 'apple');
      expect(method).toMatchObject({ usable: false, canUnlink: true });
      const intent = await createProviderSecurityIntent(environment.database, runtime, {
        actor: owner.webActor,
        action: 'unlink',
        provider: 'apple',
        methodId: method!.methodId,
      });
      const bound = { actor: owner.webActor, intentToken: intent.intentToken };
      const proof = await reauthenticateProviderWithPassword(environment.database, runtime, {
        ...bound,
        password: ' exact password ',
      });
      const prepared = await prepareProviderSecurityMutation(environment.database, runtime, {
        ...bound,
        reauthenticationToken: proof.reauthenticationToken,
        flowHash: null,
        providerProof: null,
      });
      expect(prepared.outcome).toBe('prepared');
      if (prepared.outcome !== 'prepared') throw new Error('Unlink preparation unavailable');
      const command = { ...intent, ...bound, ...proof, ...prepared, subject };
      expect(await finalizeProviderSecurityMutation(environment.database, runtime, command)).toEqual({
        outcome: 'committed',
        generation: 1,
      });
      expect(await providerRow(owner.userId, subject, selected)).toHaveLength(0);
      // The same session, same token, reads on at the new generation.
      expect((await readProviderSecurityMethods(environment.database, runtime, owner.webActor)).passwordUsable).toBe(
        true,
      );
    });
    it(`${selected}: preparation writes no identity; finalization keeps this device's session and token and revokes only this user's other credentials`, async () => {
      vi.stubEnv('AUTH_IDENTITY_MIRROR', 'off');
      const owner = await environment.actor(selected, 'canonical-token');
      const sibling = await environment.actor(selected, 'canonical-token');
      const ownerPartner = await partner(owner.userId);
      const siblingPartner = await partner(sibling.userId);
      const nativeId = randomUUID();
      const otherSessionId = randomUUID();
      const otherToken = randomBytes(32).toString('base64url');
      await environment.database.insert(mobileRefreshTokens).values({
        id: nativeId,
        userId: owner.userId,
        tokenHash: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 3_600_000),
        subjectGeneration: 0,
        nativeGeneration: 0,
        sessionId: randomUUID(),
      });
      await environment.database.insert(authSession).values({
        id: otherSessionId,
        userId: owner.userId,
        token: sessionTokenDigest(otherToken),
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        originalAuthenticatedAt: new Date(Date.now() - 60_000),
        revocationGeneration: 0,
      });
      expect((await admit({ kind: 'canonical-token', token: otherToken })).status).toBe('admitted');
      const [originalProfile] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
      const [originalSession] = await environment.database
        .select()
        .from(authSession)
        .where(eq(authSession.id, owner.sid));
      const prepared = await environment.prepareLink(owner);
      expect(await providerRow(owner.userId, prepared.subject, selected)).toHaveLength(0);
      expect(
        await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, owner.userId)),
      ).toHaveLength(0);
      const reply = await finalizeProviderSecurityMutation(environment.database, environment.runtime, prepared);
      expect(reply).toEqual({ outcome: 'committed', generation: 1 });
      expect(await providerRow(owner.userId, prepared.subject, selected)).toHaveLength(1);
      const [profile] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
      expect(profile).toEqual(originalProfile);
      // The requesting session survives: same id, same token, same sign-in time and expiry.
      const accepted = await admit(owner.credential);
      expect(accepted.status).toBe('admitted');
      if (accepted.status !== 'admitted') throw new Error('Requesting session was denied');
      expect(accepted.session).toMatchObject({
        userId: owner.userId,
        authSessionId: owner.sid,
        generation: 1,
        authenticatedAt: owner.authenticatedAt,
        expiresAt: owner.sourceExpiresAt,
      });
      const [session] = await environment.database.select().from(authSession).where(eq(authSession.id, owner.sid));
      expect(session).toEqual({ ...originalSession, revocationGeneration: 1, updatedAt: session.updatedAt });
      // Every other first-party credential of the account ends.
      expect((await admit({ kind: 'canonical-token', token: otherToken })).status).toBe('denied');
      const [native] = await environment.database
        .select()
        .from(mobileRefreshTokens)
        .where(eq(mobileRefreshTokens.id, nativeId));
      expect(native.revokedAt).not.toBeNull();
      const [other] = await environment.database.select().from(authSession).where(eq(authSession.id, otherSessionId));
      expect(other.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
      const [revokedPartner] = await environment.database
        .select()
        .from(oauthConnections)
        .where(eq(oauthConnections.id, ownerPartner));
      const [untouchedPartner] = await environment.database
        .select()
        .from(oauthConnections)
        .where(eq(oauthConnections.id, siblingPartner));
      expect(revokedPartner.revokedAt).not.toBeNull();
      expect(revokedPartner.generation).toBe(1);
      expect(untouchedPartner.revokedAt).toBeNull();
      expect(untouchedPartner.generation).toBe(0);
      expect(
        await environment.database.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.userId, owner.userId)),
      ).toHaveLength(0);
      expect(
        await environment.database.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.userId, sibling.userId)),
      ).toHaveLength(1);
      expect(
        await environment.database.select().from(oauthGrants).where(eq(oauthGrants.connectionId, ownerPartner)),
      ).toHaveLength(0);
      expect(
        (
          await environment.database
            .select()
            .from(authPasswordRecoveryState)
            .where(eq(authPasswordRecoveryState.userId, owner.userId))
        )[0].generation,
      ).toBe(1);
      expect(
        (
          await environment.database
            .select()
            .from(authEmailVerificationState)
            .where(eq(authEmailVerificationState.userId, owner.userId))
        )[0].generation,
      ).toBe(1);
      const acknowledged = await acknowledgeProviderSecurityResult(environment.database, environment.runtime, prepared);
      expect(acknowledged).toEqual({ outcome: 'recovered', generation: 1 });
      const [proof] = await environment.database
        .select()
        .from(authProviderReauthenticationReceipts)
        .where(eq(authProviderReauthenticationReceipts.receiptHash, providerTokenHash(prepared.reauthenticationToken)));
      expect(proof.consumedAt).not.toBeNull();
      expect((await storedIntent(prepared.intentToken)).phase).toBe('committed');
      expect((await admit(sibling.credential)).status).toBe('admitted');
    });
    it(`${selected}: reverse mirror failure rolls back link, cutoffs, sessions and partner revocation while spending only the validated intent`, async () => {
      vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
      const owner = await environment.actor(selected, 'canonical-token');
      const connectionId = await partner(owner.userId);
      const prepared = await environment.prepareLink(owner);
      const targetTable = selected === 'current-store' ? 'auth_account' : 'accounts';
      await environment.database.execute(
        sql.raw(
          `CREATE FUNCTION reject_provider_mirror() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned reverse mirror refusal'; END $$`,
        ),
      );
      await environment.database.execute(
        sql.raw(
          `CREATE TRIGGER reject_provider_mirror BEFORE INSERT ON ${targetTable} FOR EACH ROW EXECUTE FUNCTION reject_provider_mirror()`,
        ),
      );
      try {
        expect(
          (await finalizeProviderSecurityMutation(environment.database, environment.runtime, prepared)).outcome,
        ).toBe('unavailable');
      } finally {
        await environment.database.execute(sql.raw(`DROP TRIGGER reject_provider_mirror ON ${targetTable}`));
        await environment.database.execute(sql`DROP FUNCTION reject_provider_mirror()`);
      }
      expect(await providerRow(owner.userId, prepared.subject, selected)).toHaveLength(0);
      expect(
        await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, owner.userId)),
      ).toHaveLength(0);
      const [session] = await environment.database.select().from(authSession).where(eq(authSession.id, owner.sid));
      expect(session.token).toBe(sessionTokenDigest(owner.actor.credential));
      const [connection] = await environment.database
        .select()
        .from(oauthConnections)
        .where(eq(oauthConnections.id, connectionId));
      expect(connection.revokedAt).toBeNull();
      expect(connection.generation).toBe(0);
      expect((await storedIntent(prepared.intentToken)).phase).toBe('terminal');
    });
  }
  it('keeps unknown ancestry and unknown age through finalization: the row never gains a sign-in time', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token', { unknownAge: true });
    // The bridged row of a legacy cookie that had no session id.
    await environment.database
      .update(authSession)
      .set({ legacyLineageId: `credential:${owner.sid}` })
      .where(eq(authSession.id, owner.sid));
    const before = await admit(owner.credential);
    expect(before).toMatchObject({
      status: 'admitted',
      session: { authenticatedAt: null, linkGuarded: false, requiresAccountCutoff: true, source: 'bridge' },
    });
    const prepared = await environment.prepareLink(owner);
    expect(await finalizeProviderSecurityMutation(environment.database, environment.runtime, prepared)).toEqual({
      outcome: 'committed',
      generation: 1,
    });
    expect(await admit(owner.credential)).toMatchObject({
      status: 'admitted',
      session: {
        authSessionId: owner.sid,
        generation: 1,
        authenticatedAt: null,
        linkGuarded: false,
        requiresAccountCutoff: true,
        source: 'bridge',
      },
    });
    const [session] = await environment.database.select().from(authSession).where(eq(authSession.id, owner.sid));
    expect(session).toMatchObject({ originalAuthenticatedAt: null, legacyLineageId: `credential:${owner.sid}` });
  });
  it('a lost-success ACK never returns a bearer and answers only the same session at the generation it made', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const prepared = await environment.prepareLink(owner);
    expect((await finalizeProviderSecurityMutation(environment.database, environment.runtime, prepared)).outcome).toBe(
      'committed',
    );
    const stranger = await environment.actor('better-auth', 'canonical-token');
    await expect(
      acknowledgeProviderSecurityResult(environment.database, environment.runtime, {
        ...prepared,
        actor: { ...stranger.webActor, expectedUserId: owner.userId, expectedAuthSessionId: owner.sid },
      }),
    ).rejects.toMatchObject({ outcome: 'denied', code: 'invalid_proof' });
    await expect(
      acknowledgeProviderSecurityResult(environment.database, environment.runtime, {
        ...prepared,
        recoveryToken: randomBytes(32).toString('base64url'),
      }),
    ).rejects.toMatchObject({ outcome: 'denied', code: 'invalid_proof' });
    // A later security change moved the session on: the ACK is not this one's any more.
    await environment.database
      .update(authSubjectCutoffs)
      .set({ generation: 2 })
      .where(eq(authSubjectCutoffs.userId, owner.userId));
    await environment.database
      .update(authSession)
      .set({ revocationGeneration: 2 })
      .where(eq(authSession.id, owner.sid));
    await expect(
      acknowledgeProviderSecurityResult(environment.database, environment.runtime, prepared),
    ).rejects.toMatchObject({ outcome: 'identity_changed' });
  });
  it('preserves primary unavailability as unavailable rather than claiming an identity mismatch or ACK', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const prepared = await environment.prepareLink(owner);
    expect((await finalizeProviderSecurityMutation(environment.database, environment.runtime, prepared)).outcome).toBe(
      'committed',
    );
    const before = await storedIntent(prepared.intentToken);
    vi.spyOn(sessionReader, 'readFirstPartySession').mockResolvedValueOnce({ status: 'unavailable' });
    await expect(
      acknowledgeProviderSecurityResult(environment.database, environment.runtime, prepared),
    ).rejects.toMatchObject({ outcome: 'unavailable', code: 'authority_unavailable' });
    expect(await storedIntent(prepared.intentToken)).toEqual(before);
  });
});
