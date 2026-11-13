import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authBrowserBindings,
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
import { providerCredentialHash } from '../provider-security-result';
import { providerTokenHash } from '../provider-security-context';
import { readFirstPartySession } from '../session-reader';
import type { FirstPartyCredential } from '../session-reader';
import { readLockedWebSubjectState } from '../../current-store/web-credential-state';
import { readBrowserBinding } from '../browser-binding';
import * as browserAuthority from '../browser-binding';

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
      const candidate = await environment.candidate(prepared, 'canonical-token');
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
        const pending = finalizeProviderSecurityMutation(environment.database, environment.runtime, {
          ...prepared,
          candidate,
        });
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
      expect(session.token).toBe(owner.actor.credential);
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
        actor: owner.actor,
        action: 'link',
        provider: 'apple',
        methodId: null,
      });
      const bound = {
        actor: owner.actor,
        intentToken: intent.intentToken,
        browserIntentToken: intent.browserIntentToken,
      };
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
      const methods = await readProviderSecurityMethods(environment.database, runtime, owner.actor);
      const method = methods.providers.find((provider) => provider.provider === 'apple');
      expect(method).toMatchObject({ usable: false, canUnlink: true });
      const intent = await createProviderSecurityIntent(environment.database, runtime, {
        actor: owner.actor,
        action: 'unlink',
        provider: 'apple',
        methodId: method!.methodId,
      });
      const bound = {
        actor: owner.actor,
        intentToken: intent.intentToken,
        browserIntentToken: intent.browserIntentToken,
      };
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
      const candidate = await environment.candidate(command, 'canonical-token');
      expect(
        (await finalizeProviderSecurityMutation(environment.database, runtime, { ...command, candidate })).outcome,
      ).toBe('committed');
      expect(await providerRow(owner.userId, subject, selected)).toHaveLength(0);
      expect(
        (
          await readProviderSecurityMethods(environment.database, runtime, {
            ...owner.actor,
            credential: candidate.credential,
            browserVersion: owner.actor.browserVersion + 1,
          })
        ).passwordUsable,
      ).toBe(true);
    });
    for (const kind of ['legacy-jwe', 'canonical-token'] as const) {
      it(`${selected}/${kind}: preparation writes no identity; finalization keeps this device and revokes only this user's other credentials`, async () => {
        vi.stubEnv('AUTH_IDENTITY_MIRROR', 'off');
        const owner = await environment.actor(selected, kind);
        const sibling = await environment.actor(selected, 'canonical-token');
        const ownerPartner = await partner(owner.userId);
        const siblingPartner = await partner(sibling.userId);
        const nativeId = randomUUID();
        const otherSessionId = randomUUID();
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
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 3_600_000),
          updatedAt: new Date(),
          revocationGeneration: 0,
        });
        const [originalProfile] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
        const prepared = await environment.prepareLink(owner);
        expect(await providerRow(owner.userId, prepared.subject, selected)).toHaveLength(0);
        expect(
          await environment.database
            .select()
            .from(authSubjectCutoffs)
            .where(eq(authSubjectCutoffs.userId, owner.userId)),
        ).toHaveLength(0);
        const candidate = await environment.candidate(prepared, kind);
        const reply = await finalizeProviderSecurityMutation(environment.database, environment.runtime, {
          ...prepared,
          candidate,
        });
        expect(reply.outcome).toBe('committed');
        expect(await providerRow(owner.userId, prepared.subject, selected)).toHaveLength(1);
        const [profile] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
        expect(profile).toEqual(originalProfile);
        const current =
          candidate.kind === 'legacy-jwe'
            ? { kind: candidate.kind, credential: candidate.credential, secret: environment.secret }
            : { kind: candidate.kind, token: candidate.credential };
        const accepted = await admit(current);
        expect(accepted.status).toBe('admitted');
        if (accepted.status !== 'admitted') throw new Error('Requesting continuation was denied');
        expect(accepted.session).toMatchObject({
          userId: owner.userId,
          authSessionId: owner.sid,
          generation: 1,
          authenticatedAt: owner.authenticatedAt,
          expiresAt: prepared.credentialExpiresAt,
        });
        expect((await admit(owner.credential)).status).toBe('denied');
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
          await environment.database
            .select()
            .from(oauthRefreshToken)
            .where(eq(oauthRefreshToken.userId, sibling.userId)),
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
        const acknowledged = await acknowledgeProviderSecurityResult(environment.database, environment.runtime, {
          ...prepared,
          candidate,
        });
        expect(acknowledged).toMatchObject({
          outcome: 'recovered',
          candidateCredentialHash: providerCredentialHash(candidate),
        });
        expect(Object.keys(acknowledged).sort()).toEqual(['browserCursor', 'candidateCredentialHash', 'outcome']);
        const [proof] = await environment.database
          .select()
          .from(authProviderReauthenticationReceipts)
          .where(
            eq(authProviderReauthenticationReceipts.receiptHash, providerTokenHash(prepared.reauthenticationToken)),
          );
        expect(proof.consumedAt).not.toBeNull();
        expect((await storedIntent(prepared.intentToken)).phase).toBe('committed');
        expect(
          (
            await readBrowserBinding(
              environment.database,
              environment.qualification,
              sibling.actor.browserBindingToken,
              { version: sibling.actor.browserVersion, credential: sibling.credential },
            )
          ).status,
        ).toBe('admitted');
      });
    }
    it(`${selected}: reverse mirror failure rolls back link, cutoffs, sessions and partner revocation while spending only the validated intent`, async () => {
      vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
      const owner = await environment.actor(selected, 'canonical-token');
      const connectionId = await partner(owner.userId);
      const prepared = await environment.prepareLink(owner);
      const candidate = await environment.candidate(prepared, 'canonical-token');
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
          (
            await finalizeProviderSecurityMutation(environment.database, environment.runtime, {
              ...prepared,
              candidate,
            })
          ).outcome,
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
      expect(session.token).toBe(owner.actor.credential);
      const [connection] = await environment.database
        .select()
        .from(oauthConnections)
        .where(eq(oauthConnections.id, connectionId));
      expect(connection.revokedAt).toBeNull();
      expect(connection.generation).toBe(0);
      expect((await storedIntent(prepared.intentToken)).phase).toBe('terminal');
    });
  }
  it('preserves conservative unknown ancestry and unknown age through actual JWT encoding and finalization', async () => {
    const owner = await environment.actor('better-auth', 'legacy-jwe', { unknownAge: true });
    const prepared = await environment.prepareLink(owner);
    expect(prepared.credentialProof).toMatchObject({
      authenticatedAt: null,
      linkGuarded: false,
      requiresAccountCutoff: true,
    });
    const candidate = await environment.candidate(prepared, 'legacy-jwe');
    expect(
      (await finalizeProviderSecurityMutation(environment.database, environment.runtime, { ...prepared, candidate }))
        .outcome,
    ).toBe('committed');
    const [binding] = await environment.database
      .select()
      .from(authBrowserBindings)
      .where(eq(authBrowserBindings.id, providerTokenHash(owner.actor.browserBindingToken)));
    expect(binding).toMatchObject({
      authenticatedAt: null,
      requiresAccountCutoff: true,
      linkGuarded: false,
      generation: 1,
    });
  });
  it('never returns a bearer or acknowledges a different candidate after lost success', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const prepared = await environment.prepareLink(owner);
    const candidate = await environment.candidate(prepared, 'canonical-token');
    expect(
      (await finalizeProviderSecurityMutation(environment.database, environment.runtime, { ...prepared, candidate }))
        .outcome,
    ).toBe('committed');
    await expect(
      acknowledgeProviderSecurityResult(environment.database, environment.runtime, {
        ...prepared,
        candidate: { ...candidate, credential: randomBytes(32).toString('base64url') },
      }),
    ).rejects.toMatchObject({ outcome: 'denied' });
    await environment.database
      .update(authSubjectCutoffs)
      .set({ generation: 2 })
      .where(eq(authSubjectCutoffs.userId, owner.userId));
    await expect(
      acknowledgeProviderSecurityResult(environment.database, environment.runtime, { ...prepared, candidate }),
    ).rejects.toMatchObject({ outcome: 'identity_changed' });
  });
  it('preserves primary unavailability as unavailable rather than claiming an identity mismatch or ACK', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const prepared = await environment.prepareLink(owner);
    const candidate = await environment.candidate(prepared, 'canonical-token');
    expect(
      (await finalizeProviderSecurityMutation(environment.database, environment.runtime, { ...prepared, candidate }))
        .outcome,
    ).toBe('committed');
    const before = await storedIntent(prepared.intentToken);
    vi.spyOn(browserAuthority, 'readBrowserBindingInTransaction').mockResolvedValueOnce({ status: 'unavailable' });
    await expect(
      acknowledgeProviderSecurityResult(environment.database, environment.runtime, { ...prepared, candidate }),
    ).rejects.toMatchObject({ outcome: 'unavailable', code: 'authority_unavailable' });
    expect(await storedIntent(prepared.intentToken)).toEqual(before);
  });
});
