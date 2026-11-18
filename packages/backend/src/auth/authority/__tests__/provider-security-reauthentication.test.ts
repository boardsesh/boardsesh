import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { hash } from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  authAccount,
  authEmailProjection,
  authProviderReauthenticationReceipts,
  authProviderSecurityIntents,
  authSecurityMutationEvents,
  authSession,
  authSubjectCutoffs,
  userCredentials,
  users,
} from '@boardsesh/db/schema/auth';
import type { ProviderSecurityActor } from '@boardsesh/auth-protocol';
import { createEnvironment } from './environment';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { bindIdentityAuthority } from '../identity-authority';
import { captureIdentityAuthority, switchIdentityAuthority, type IdentityAuthorityName } from '../router';
import { createProviderSecurityIntent, type ProviderSecurityRuntime } from '../provider-security-intents';
import { reauthenticateProviderWithPassword } from '../provider-security-reauthentication';
import { providerTokenHash } from '../provider-security-context';
import { sessionTokenDigest } from '../session-token';

const phase = vi.hoisted(() => ({ afterCompare: undefined as (() => Promise<void>) | undefined }));
vi.mock('bcryptjs', async (original) => {
  const actual = await original<typeof import('bcryptjs')>();
  return {
    ...actual,
    compare: async (password: string, passwordHash: string) => {
      const matched = await actual.compare(password, passwordHash);
      await phase.afterCompare?.();
      return matched;
    },
  };
});
const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = requireWeb('next-auth/jwt') as {
  encode(input: { secret: string; token: Record<string, unknown>; maxAge: number }): Promise<string>;
};
const secret = 'provider-operation-owned-reauthentication-secret';
const qualification = {
  expectedProjectionId: randomUUID(),
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
};
const runtime: ProviderSecurityRuntime = {
  qualification,
  legacySecret: secret,
  methods: {
    configuredProviders: ['google', 'apple'],
    googleAudience: 'owned-google-client',
    googleReauthenticationEnabled: true,
  },
};
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let passwordHash: string;
let differentHash: string;
async function switchTo(selected: IdentityAuthorityName) {
  await environment.database.transaction(async (transaction) => {
    const [manifest] = await transaction.select().from(authEmailProjection);
    if (manifest.writerAuthority !== selected)
      await switchIdentityAuthority(transaction, {
        projectionId: qualification.expectedProjectionId,
        epoch: manifest.writerEpoch,
        from: manifest.writerAuthority,
        to: selected,
      });
  });
}
async function sessionFixture(selected: IdentityAuthorityName, kind: ProviderSecurityActor['presented']['kind']) {
  await switchTo(selected);
  const userId = randomUUID();
  const sid = randomUUID();
  const authenticatedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 86_400_000);
  await environment.database.insert(users).values({ id: userId, email: `provider-${userId}@example.test` });
  await environment.database.transaction(async (transaction) => {
    const identity = bindIdentityAuthority(transaction, await captureIdentityAuthority(transaction, qualification));
    await identity.insertPassword(userId, passwordHash, 0);
  });
  const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000);
  const raw =
    kind === 'legacy-jwe'
      ? await jwt.encode({
          secret,
          maxAge: 3600,
          token: {
            sub: userId,
            authSessionId: sid,
            gen: 0,
            auth_time: authenticatedAt.getTime() / 1000,
            link_guarded: true,
          },
        })
      : randomBytes(32).toString('base64url');
  if (kind === 'canonical-token')
    await environment.database.insert(authSession).values({
      id: sid,
      userId,
      token: sessionTokenDigest(raw),
      expiresAt,
      updatedAt: new Date(),
      originalAuthenticatedAt: authenticatedAt,
      revocationGeneration: 0,
    });
  const actor: ProviderSecurityActor = {
    presented: kind === 'legacy-jwe' ? { kind, credential: raw } : { kind, token: raw },
    expectedUserId: userId,
    expectedAuthSessionId: sid,
  };
  return { userId, sid, authenticatedAt, sourceExpiresAt: expiresAt, actor, raw };
}
async function actorFixture(selected: IdentityAuthorityName) {
  const owner = await sessionFixture(selected, 'canonical-token');
  const intent = await createProviderSecurityIntent(environment.database, runtime, {
    actor: owner.actor,
    action: 'link',
    provider: 'apple',
    methodId: null,
  });
  return { ...owner, ...intent };
}
async function intentRow(owner: Awaited<ReturnType<typeof actorFixture>>) {
  const [row] = await environment.database
    .select()
    .from(authProviderSecurityIntents)
    .where(eq(authProviderSecurityIntents.intentHash, providerTokenHash(owner.intentToken)));
  return row;
}
async function receipts(owner: Awaited<ReturnType<typeof actorFixture>>) {
  return environment.database
    .select()
    .from(authProviderReauthenticationReceipts)
    .where(eq(authProviderReauthenticationReceipts.intentHash, providerTokenHash(owner.intentToken)));
}

describe('operation-bound selected-authority actual password reauthentication', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    for (const filename of ['0312_browser_binding_selection.sql', '0313_provider_security_receipts.sql'])
      await environment.client.unsafe(
        readFileSync(new URL(`../../../../../db/drizzle/${filename}`, import.meta.url), 'utf8'),
      );
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId: qualification.expectedProjectionId });
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
    [passwordHash, differentHash] = await Promise.all([hash(' exact password ', 4), hash(' different password ', 4)]);
  });
  afterEach(() => {
    phase.afterCompare = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => environment?.close());
  for (const selected of ['current-store', 'better-auth'] as const) {
    it(`${selected}: actual password proves only the intent while original session age and expiry stay unchanged`, async () => {
      const owner = await actorFixture(selected);
      const before = await intentRow(owner);
      const proved = await reauthenticateProviderWithPassword(environment.database, runtime, {
        actor: owner.actor,
        intentToken: owner.intentToken,
        password: ' exact password ',
      });
      expect(proved.reauthenticationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const [receipt] = await receipts(owner);
      expect(receipt.method).toBe('password');
      expect(receipt.authenticatedAt.getTime()).toBeGreaterThan(owner.authenticatedAt.getTime() + 3_600_000);
      expect(receipt.expiresAt.getTime()).toBeLessThanOrEqual(receipt.authenticatedAt.getTime() + 300_000);
      expect(receipt.expiresAt.getTime()).toBeLessThanOrEqual(before.expiresAt.getTime());
      expect(receipt.consumedAt).toBeNull();
      expect(await intentRow(owner)).toEqual(before);
      expect(
        await environment.database
          .select()
          .from(authSecurityMutationEvents)
          .where(eq(authSecurityMutationEvents.userId, owner.userId)),
      ).toHaveLength(0);
      const [session] = await environment.database.select().from(authSession).where(eq(authSession.id, owner.sid));
      expect(session.token).toBe(sessionTokenDigest(owner.raw));
      expect(session.revocationGeneration).toBe(0);
      expect(session.originalAuthenticatedAt).toEqual(owner.authenticatedAt);
      expect(session.expiresAt).toEqual(owner.sourceExpiresAt);
    });
    it(`${selected}: a legacy NextAuth cookie is admitted for reads but cannot start a link it could not survive`, async () => {
      const owner = await sessionFixture(selected, 'legacy-jwe');
      await expect(
        createProviderSecurityIntent(environment.database, runtime, {
          actor: owner.actor,
          action: 'link',
          provider: 'apple',
          methodId: null,
        }),
      ).rejects.toMatchObject({ outcome: 'canonical_session_required', code: 'canonical_session_required' });
      expect(
        await environment.database
          .select()
          .from(authProviderSecurityIntents)
          .where(eq(authProviderSecurityIntents.userId, owner.userId)),
      ).toHaveLength(0);
    });
    it(`${selected}: wrong password and wrong actor cannot consume the intent or mint a receipt`, async () => {
      const owner = await actorFixture(selected);
      const before = await intentRow(owner);
      await expect(
        reauthenticateProviderWithPassword(environment.database, runtime, {
          ...owner,
          password: 'exact password',
        }),
      ).rejects.toMatchObject({ outcome: 'reauthentication_required' });
      await expect(
        reauthenticateProviderWithPassword(environment.database, runtime, {
          ...owner,
          actor: { ...owner.actor, expectedUserId: randomUUID() },
          password: ' exact password ',
        }),
      ).rejects.toMatchObject({ outcome: 'identity_changed' });
      expect(await receipts(owner)).toHaveLength(0);
      expect(await intentRow(owner)).toEqual(before);
    });
    it(`${selected}: a generation change after actual comparison cannot restamp proof or consume intent`, async () => {
      const owner = await actorFixture(selected);
      const before = await intentRow(owner);
      phase.afterCompare = async () => {
        phase.afterCompare = undefined;
        await environment.database
          .insert(authSubjectCutoffs)
          .values({ userId: owner.userId, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
      };
      await expect(
        reauthenticateProviderWithPassword(environment.database, runtime, { ...owner, password: ' exact password ' }),
      ).rejects.toMatchObject({ outcome: 'unauthenticated' });
      expect(await receipts(owner)).toHaveLength(0);
      expect(await intentRow(owner)).toEqual(before);
    });
    it(`${selected}: exact primary hash is re-read after bcrypt instead of accepting a stale successful comparison`, async () => {
      const owner = await actorFixture(selected);
      const before = await intentRow(owner);
      phase.afterCompare = async () => {
        phase.afterCompare = undefined;
        if (selected === 'current-store')
          await environment.database
            .update(userCredentials)
            .set({ passwordHash: differentHash })
            .where(eq(userCredentials.userId, owner.userId));
        else
          await environment.database
            .update(authAccount)
            .set({ password: differentHash })
            .where(and(eq(authAccount.userId, owner.userId), eq(authAccount.providerId, 'credential')));
      };
      await expect(
        reauthenticateProviderWithPassword(environment.database, runtime, { ...owner, password: ' exact password ' }),
      ).rejects.toMatchObject({ outcome: 'identity_changed' });
      expect(await receipts(owner)).toHaveLength(0);
      expect(await intentRow(owner)).toEqual(before);
      expect(
        (
          await reauthenticateProviderWithPassword(environment.database, runtime, {
            ...owner,
            password: ' different password ',
          })
        ).reauthenticationToken,
      ).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
    it(`${selected}: releases the gate during real bcrypt and refuses an authority switch before receipt creation`, async () => {
      const owner = await actorFixture(selected);
      const before = await intentRow(owner);
      phase.afterCompare = async () => {
        phase.afterCompare = undefined;
        await switchTo(selected === 'current-store' ? 'better-auth' : 'current-store');
      };
      await expect(
        reauthenticateProviderWithPassword(environment.database, runtime, { ...owner, password: ' exact password ' }),
      ).rejects.toThrow('STALE_AUTHORITY');
      expect(await receipts(owner)).toHaveLength(0);
      expect(await intentRow(owner)).toEqual(before);
    });
  }
});
