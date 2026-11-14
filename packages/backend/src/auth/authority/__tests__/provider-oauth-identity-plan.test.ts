import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authSession,
  authSubjectCutoffs,
  userProfiles,
  users,
} from '@boardsesh/db/schema/auth';
import {
  applyReservedCurrentStoreOAuthIdentityPlan,
  planReservedCurrentStoreOAuthIdentity,
  resolveReservedCurrentStoreOAuthIdentity,
  type CurrentStoreOAuthIdentityPlan,
  type VerifiedCurrentStoreOAuthIdentity,
} from '../../current-store/provider-oauth-identity';
import { reserveEnforcedEmail, retiredEmailKey } from '../../current-store/email-reservations';
import { createProviderSecurityEnvironment } from './provider-security-fixture';

let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
const policy = { actorUserId: null, storeProviderImage: true, emailVerification: 'unverified' } as const;
async function authority() {
  const [manifest] = await environment.database.select().from(authEmailProjection);
  return { ...environment.qualification, expectedWriterEpoch: manifest.writerEpoch };
}
function identity(): VerifiedCurrentStoreOAuthIdentity {
  return {
    sub: randomUUID(),
    email: ` Plan-${randomUUID()}@Example.Test `,
    emailVerified: true,
    name: 'Provider name',
    image: 'https://owned.example.test/provider-image',
  };
}
async function inventory() {
  return {
    users: await environment.database.select().from(users).orderBy(users.id),
    legacyProviders: await environment.database
      .select()
      .from(accounts)
      .orderBy(accounts.provider, accounts.providerAccountId),
    primaryProviders: await environment.database.select().from(authAccount).orderBy(authAccount.id),
    reservations: await environment.database
      .select()
      .from(authEmailReservations)
      .orderBy(authEmailReservations.normalizedEmail),
    members: await environment.database
      .select()
      .from(authEmailReservationMembers)
      .orderBy(authEmailReservationMembers.normalizedEmail, authEmailReservationMembers.userId),
    profiles: await environment.database.select().from(userProfiles).orderBy(userProfiles.userId),
    sessions: await environment.database.select().from(authSession).orderBy(authSession.id),
    cutoffs: await environment.database.select().from(authSubjectCutoffs).orderBy(authSubjectCutoffs.userId),
  };
}
async function plan(provider: 'google' | 'apple', assertion: VerifiedCurrentStoreOAuthIdentity) {
  const expected = await authority();
  const result = await environment.database.transaction((transaction) =>
    planReservedCurrentStoreOAuthIdentity(transaction, expected, provider, assertion, policy),
  );
  if (result.outcome !== 'planned') throw new Error(`Owned planning fixture refused: ${result.outcome}`);
  return result.plan;
}
async function apply(
  provider: 'google' | 'apple',
  assertion: VerifiedCurrentStoreOAuthIdentity,
  planned: CurrentStoreOAuthIdentityPlan,
) {
  const expected = await authority();
  return environment.database.transaction((transaction) =>
    applyReservedCurrentStoreOAuthIdentityPlan(transaction, expected, provider, assertion, policy, planned),
  );
}

describe('backend-fixed provider identity planning and final transaction application', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
  });
  beforeEach(() => {
    vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'owned-provider-identity-plan-retired-email-key');
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => environment?.close());

  for (const selected of ['current-store', 'better-auth'] as const) {
    for (const provider of ['google', 'apple'] as const) {
      it(`${selected}/${provider}: fixes a new UID/metadata without writing identity, then applies the exact plan`, async () => {
        await environment.selectAuthority(selected);
        const assertion = identity();
        const before = await inventory();
        const planned = await plan(provider, assertion);
        expect(planned.kind).toBe('new');
        expect(Object.isFrozen(planned.user)).toBe(true);
        expect(planned.user.email).toBe(assertion.email!.trim().toLowerCase());
        expect(planned.user.emailVerified).toBeNull();
        expect(planned.generation).toBe(0);
        expect(await inventory()).toEqual(before);
        const result = await apply(provider, assertion, planned);
        expect(result.outcome).toBe('created');
        if (result.outcome !== 'created') throw new Error('Owned plan did not create its fixed identity');
        expect(result.user).toMatchObject({
          id: planned.user.id,
          email: planned.user.email,
          name: planned.user.name,
          image: planned.user.image,
          emailVerified: null,
          createdAt: new Date(planned.user.createdAt),
        });
        expect(
          await environment.database.select().from(userProfiles).where(eq(userProfiles.userId, planned.user.id)),
        ).toHaveLength(1);
        expect(
          await environment.database.select().from(authSession).where(eq(authSession.userId, planned.user.id)),
        ).toHaveLength(0);
        expect(
          await environment.database.select().from(accounts).where(eq(accounts.providerAccountId, assertion.sub)),
        ).toMatchObject([{ userId: planned.user.id }]);
        expect(
          await environment.database.select().from(authAccount).where(eq(authAccount.accountId, assertion.sub)),
        ).toMatchObject([{ userId: planned.user.id, sourceGeneration: 0 }]);
      });
      it(`${selected}/${provider}: plans the actual returning owner without mirroring or changing profile`, async () => {
        const assertion = identity();
        const owner = await environment.actor(selected, 'canonical-token', { provider, subject: assertion.sub });
        const expected = await authority();
        const [stored] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
        await environment.database.transaction((transaction) =>
          reserveEnforcedEmail(transaction, { ...expected, rawEmail: stored.email, requestedUserId: stored.id }),
        );
        const before = await inventory();
        const planned = await plan(provider, assertion);
        expect(planned.kind).toBe('existing');
        expect(planned.user.id).toBe(owner.userId);
        expect(planned.user.email).toBe(stored.email);
        expect(await inventory()).toEqual(before);
        const result = await apply(provider, assertion, planned);
        expect(result.outcome).toBe('linked');
        expect((await environment.database.select().from(users).where(eq(users.id, stored.id)))[0]).toEqual(stored);
      });
    }

    it(`${selected}: late transaction failure rolls back user, provider, reservation, profile and both mirrors`, async () => {
      await environment.selectAuthority(selected);
      const assertion = identity();
      const planned = await plan('apple', assertion);
      const before = await inventory();
      const expected = await authority();
      await expect(
        environment.database.transaction(async (transaction) => {
          const result = await applyReservedCurrentStoreOAuthIdentityPlan(
            transaction,
            expected,
            'apple',
            assertion,
            policy,
            planned,
          );
          expect(result.outcome).toBe('created');
          throw new Error('Owned late credential or browser CAS failure');
        }),
      ).rejects.toThrow('Owned late credential or browser CAS failure');
      expect(await inventory()).toEqual(before);
    });

    it(`${selected}: a late UID collision cannot substitute another account for the backend-fixed target`, async () => {
      await environment.selectAuthority(selected);
      const assertion = identity();
      const planned = await plan('google', assertion);
      await environment.database
        .insert(users)
        .values({ id: planned.user.id, email: `different-${randomUUID()}@example.test` });
      const before = await inventory();
      await expect(apply('google', assertion, planned)).rejects.toThrow();
      expect(await inventory()).toEqual(before);
    });

    it(`${selected}: new planning uses the database clock while the host clock is wrong`, async () => {
      await environment.selectAuthority(selected);
      const assertion = identity();
      const [before] = await environment.client<{ now: Date | string }[]>`SELECT clock_timestamp() AS now`;
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2040-01-01T00:00:00.000Z') });
      const planned = await plan('apple', assertion).finally(() => vi.useRealTimers());
      const [after] = await environment.client<{ now: Date | string }[]>`SELECT clock_timestamp() AS now`;
      expect(Date.parse(planned.user.createdAt)).toBeGreaterThanOrEqual(new Date(before.now).getTime());
      expect(Date.parse(planned.user.createdAt)).toBeLessThanOrEqual(new Date(after.now).getTime());
    });

    it(`${selected}: captures verified profile and plan metadata before transaction awaits`, async () => {
      await environment.selectAuthority(selected);
      const assertion = { ...identity() };
      const original = { ...assertion };
      const expected = await authority();
      const planned = await environment.database.transaction(async (transaction) => {
        const pending = planReservedCurrentStoreOAuthIdentity(transaction, expected, 'google', assertion, policy);
        assertion.name = 'Changed after invocation';
        assertion.email = `changed-${randomUUID()}@example.test`;
        return pending;
      });
      if (planned.outcome !== 'planned') throw new Error('Owned capture fixture refused');
      expect(planned.plan.user.name).toBe(original.name);
      expect(planned.plan.user.email).toBe(original.email!.trim().toLowerCase());
      const mutablePlan = { ...planned.plan, user: { ...planned.plan.user } };
      const result = await environment.database.transaction(async (transaction) => {
        const pending = applyReservedCurrentStoreOAuthIdentityPlan(
          transaction,
          expected,
          'google',
          original,
          policy,
          mutablePlan,
        );
        mutablePlan.user.id = randomUUID();
        mutablePlan.user.name = 'Changed after apply invocation';
        return pending;
      });
      expect(result.outcome).toBe('created');
      if (result.outcome !== 'created') throw new Error('Owned capture fixture did not apply');
      expect(result.user.id).toBe(planned.plan.user.id);
      expect(result.user.name).toBe(original.name);
    });

    it.each(['generation', 'deleted', 'name', 'image', 'verification'] as const)(
      `${selected}: rejects returning owner %s drift after planning without identity writes`,
      async (field) => {
        const assertion = identity();
        const owner = await environment.actor(selected, 'canonical-token', {
          provider: 'apple',
          subject: assertion.sub,
        });
        const expected = await authority();
        const [stored] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
        await environment.database.transaction((transaction) =>
          reserveEnforcedEmail(transaction, { ...expected, rawEmail: stored.email, requestedUserId: stored.id }),
        );
        const planned = await plan('apple', assertion);
        if (field === 'generation' || field === 'deleted')
          await environment.database.insert(authSubjectCutoffs).values({
            userId: owner.userId,
            generation: 1,
            revokedThrough: new Date(),
            lastOperationId: randomUUID(),
            ...(field === 'deleted' ? { deletedAt: new Date() } : {}),
          });
        if (field === 'name')
          await environment.database
            .update(users)
            .set({ name: 'Changed stored name' })
            .where(eq(users.id, owner.userId));
        if (field === 'image')
          await environment.database
            .update(users)
            .set({ image: 'https://owned.example.test/changed' })
            .where(eq(users.id, owner.userId));
        if (field === 'verification')
          await environment.database.update(users).set({ emailVerified: new Date() }).where(eq(users.id, owner.userId));
        const before = await inventory();
        if (field === 'deleted') expect((await apply('apple', assertion, planned)).outcome).toBe('deleted');
        else await expect(apply('apple', assertion, planned)).rejects.toThrow();
        expect(await inventory()).toEqual(before);
      },
    );

    it(`${selected}: registration taking the email after planning cannot receive an implicit provider link`, async () => {
      await environment.selectAuthority(selected);
      const assertion = identity();
      const planned = await plan('google', assertion);
      const other = await environment.actor(selected, 'canonical-token');
      await environment.database.update(users).set({ email: planned.user.email }).where(eq(users.id, other.userId));
      const expected = await authority();
      await environment.database.transaction((transaction) =>
        reserveEnforcedEmail(transaction, { ...expected, rawEmail: planned.user.email, requestedUserId: other.userId }),
      );
      const before = await inventory();
      expect((await apply('google', assertion, planned)).outcome).toBe('conflict');
      expect(await inventory()).toEqual(before);
    });

    it(`${selected}: a subject created after planning cannot replace the fixed new owner`, async () => {
      await environment.selectAuthority(selected);
      const assertion = identity();
      const planned = await plan('apple', assertion);
      const other = await environment.actor(selected, 'canonical-token', { provider: 'apple', subject: assertion.sub });
      const expected = await authority();
      const [stored] = await environment.database.select().from(users).where(eq(users.id, other.userId));
      await environment.database.transaction((transaction) =>
        reserveEnforcedEmail(transaction, { ...expected, rawEmail: stored.email, requestedUserId: stored.id }),
      );
      const before = await inventory();
      await expect(apply('apple', assertion, planned)).rejects.toThrow('RESERVATION_INCONSISTENT');
      expect(await inventory()).toEqual(before);
    });

    it(`${selected}: a deleted-email digest blocks read-only planning without consuming or rewriting it`, async () => {
      await environment.selectAuthority(selected);
      const assertion = identity();
      const expected = await authority();
      const normalizedEmail = assertion.email!.trim().toLowerCase();
      await environment.database.insert(authEmailReservations).values({
        normalizedEmail: retiredEmailKey(normalizedEmail),
        basisProjectionId: expected.expectedProjectionId,
        state: 'blocked_deleted',
      });
      const before = await inventory();
      const result = await environment.database.transaction((transaction) =>
        planReservedCurrentStoreOAuthIdentity(transaction, expected, 'google', assertion, policy),
      );
      expect(result.outcome).toBe('conflict');
      expect(await inventory()).toEqual(before);
    });

    it(`${selected}: the immediate legacy writer still creates an account in one transaction`, async () => {
      await environment.selectAuthority(selected);
      const assertion = identity();
      const expected = await authority();
      const result = await environment.database.transaction((transaction) =>
        resolveReservedCurrentStoreOAuthIdentity(transaction, expected, 'apple', assertion, policy),
      );
      expect(result.outcome).toBe('created');
      if (result.outcome !== 'created') throw new Error('Immediate writer refused');
      expect(result.user.email).toBe(assertion.email!.trim().toLowerCase());
    });
  }
});
