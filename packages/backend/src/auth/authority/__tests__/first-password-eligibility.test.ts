import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import {
  authBrowserBindings,
  authEmailReservationMembers,
  authEmailReservations,
  authSubjectCutoffs,
  users,
} from '@boardsesh/db/schema/auth';
import { createProviderSecurityEnvironment } from './provider-security-fixture';
import {
  captureFirstPasswordActor,
  lockFirstPasswordEligibility,
  withFirstPasswordAuthority,
} from '../first-password-context';
import { captureFirstPasswordRuntime, firstPasswordEmailBinding } from '../first-password-policy';
import { bindIdentityAuthority } from '../identity-authority';
import { readBrowserBinding } from '../browser-binding';
import { normalizeAccountEmail } from '../../normalize-email';

let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
type Owner = Awaited<ReturnType<typeof environment.actor>>;
const runtime = () =>
  captureFirstPasswordRuntime({
    qualification: environment.runtime.qualification,
    legacySecret: environment.runtime.legacySecret,
    emailBindingKey: 'owned-first-password-private-rpc-key-6975',
  });

async function reserve(owner: Owner) {
  const [user] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
  const normalizedEmail = normalizeAccountEmail(user.email);
  await environment.database.insert(authEmailReservations).values({
    normalizedEmail,
    basisProjectionId: environment.runtime.qualification.expectedProjectionId,
    state: 'owned',
    ownerUserId: owner.userId,
  });
  await environment.database.insert(authEmailReservationMembers).values({ normalizedEmail, userId: owner.userId });
  return normalizedEmail;
}
async function admit(owner: Owner) {
  const captured = runtime();
  const actor = captureFirstPasswordActor(owner.actor, captured);
  return withFirstPasswordAuthority(environment.database, captured, (transaction, authority) =>
    lockFirstPasswordEligibility(transaction, authority, captured, actor),
  );
}
async function sourceState(owner: Owner) {
  return {
    cutoff: await environment.database
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, owner.userId)),
    binding: await environment.database
      .select()
      .from(authBrowserBindings)
      .where(eq(authBrowserBindings.userId, owner.userId)),
  };
}

describe('first-password actual selected-authority eligibility', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
  });
  afterAll(async () => environment?.close());

  for (const selected of ['current-store', 'better-auth'] as const) {
    for (const kind of ['legacy-jwe', 'canonical-token'] as const) {
      it(`${selected}/${kind}: admits only actual Apple-only ownership without refreshing age or writing state`, async () => {
        const owner = await environment.actor(selected, kind, {
          password: false,
          provider: 'apple',
          unknownAge: true,
        });
        await reserve(owner);
        const before = await sourceState(owner);
        const source = await readBrowserBinding(
          environment.database,
          environment.runtime.qualification,
          owner.actor.browserBindingToken,
          { version: owner.actor.browserVersion, credential: owner.credential },
        );
        if (source.status !== 'admitted') throw new Error('Owned original credential did not admit');
        const result = await admit(owner);
        expect(result.session).toMatchObject({
          userId: owner.userId,
          authSessionId: owner.sid,
          generation: 0,
          authenticatedAt: null,
          linkGuarded: false,
        });
        expect(result.session.expiresAt.getTime()).toBe(source.session.expiresAt.getTime());
        expect(result.session).toEqual(source.session);
        expect(result.emailBindingHash).toMatch(/^[a-f0-9]{64}$/);
        expect(await sourceState(owner)).toEqual(before);
      });
    }

    it(`${selected}: refuses an existing selected password or any additional provider without consuming source state`, async () => {
      const passwordOwner = await environment.actor(selected, 'canonical-token', { provider: 'apple' });
      await reserve(passwordOwner);
      const passwordBefore = await sourceState(passwordOwner);
      await expect(admit(passwordOwner)).rejects.toMatchObject({ outcome: 'denied', code: 'already_set' });
      expect(await sourceState(passwordOwner)).toEqual(passwordBefore);
      const mixedOwner = await environment.actor(selected, 'canonical-token', { password: false, provider: 'apple' });
      await reserve(mixedOwner);
      await withFirstPasswordAuthority(environment.database, runtime(), async (transaction, authority) => {
        await bindIdentityAuthority(transaction, authority).insertProvider(
          { userId: mixedOwner.userId, provider: 'google', subject: randomUUID() },
          0,
        );
      });
      const mixedBefore = await sourceState(mixedOwner);
      await expect(admit(mixedOwner)).rejects.toMatchObject({ outcome: 'denied', code: 'not_eligible' });
      expect(await sourceState(mixedOwner)).toEqual(mixedBefore);
    });

    it(`${selected}: refuses missing or ambiguous reservation membership and a wrong actor UID`, async () => {
      const owner = await environment.actor(selected, 'canonical-token', { password: false, provider: 'apple' });
      const before = await sourceState(owner);
      await expect(admit(owner)).rejects.toMatchObject({ outcome: 'denied', code: 'not_eligible' });
      const normalizedEmail = await reserve(owner);
      await environment.database.insert(authEmailReservationMembers).values({ normalizedEmail, userId: randomUUID() });
      await expect(admit(owner)).rejects.toMatchObject({ outcome: 'denied', code: 'not_eligible' });
      await expect(admit({ ...owner, actor: { ...owner.actor, expectedUserId: randomUUID() } })).rejects.toMatchObject({
        outcome: 'identity_changed',
        code: 'invalid_proof',
      });
      expect(await sourceState(owner)).toEqual(before);
    });

    it(`${selected}: captures the backend HMAC key before an observed provider-row wait`, async () => {
      const owner = await environment.actor(selected, 'canonical-token', { password: false, provider: 'apple' });
      await reserve(owner);
      const mutableRuntime = { ...runtime() };
      const original = captureFirstPasswordRuntime(mutableRuntime);
      const actor = captureFirstPasswordActor(owner.actor, original);
      const address = new URL(
        process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
      );
      address.pathname = `/${environment.client.options.database}`;
      const observer = postgres(address.toString(), { max: 2, onnotice: () => {} });
      let ready = () => {};
      let release = () => {};
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = observer.begin(async (transaction) => {
        if (selected === 'better-auth')
          await transaction`SELECT id FROM auth_account WHERE user_id=${owner.userId} FOR UPDATE`;
        else await transaction`SELECT provider FROM accounts WHERE "userId"=${owner.userId} FOR UPDATE`;
        ready();
        await released;
      });
      await started;
      let completed = false;
      const pending = withFirstPasswordAuthority(environment.database, mutableRuntime, (transaction, authority) =>
        lockFirstPasswordEligibility(transaction, authority, mutableRuntime, actor),
      ).finally(() => {
        completed = true;
      });
      try {
        let observedWait = false;
        const until = Date.now() + 2_000;
        while (!completed && !observedWait && Date.now() < until) {
          const [state] = await observer<{ waiting: boolean }[]>`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
              AND wait_event_type='Lock' AND query ILIKE '%for update%'
              AND (query ILIKE '%auth_account%' OR query ILIKE '%accounts%')
          ) AS waiting`;
          observedWait = state.waiting;
          if (!observedWait) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(observedWait).toBe(true);
        expect(completed).toBe(false);
        mutableRuntime.emailBindingKey = 'rotated-private-rpc-secret-at-least-32-bytes';
        release();
        await holding;
        const result = await pending;
        expect(result.emailBindingHash).toBe(
          firstPasswordEmailBinding(original, result.identity.receipt, owner.userId, result.recipient),
        );
        expect(result.emailBindingHash).not.toBe(
          firstPasswordEmailBinding(mutableRuntime, result.identity.receipt, owner.userId, result.recipient),
        );
      } finally {
        release();
        await holding;
        await pending;
        await observer.end({ timeout: 5 });
      }
    });

    it(`${selected}: observes a real provider row wait and refuses a newly committed non-Apple identity`, async () => {
      const owner = await environment.actor(selected, 'canonical-token', { password: false, provider: 'apple' });
      await reserve(owner);
      const before = await sourceState(owner);
      const address = new URL(
        process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
      );
      address.pathname = `/${environment.client.options.database}`;
      const observer = postgres(address.toString(), { max: 2, onnotice: () => {} });
      let ready = () => {};
      let release = () => {};
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = observer.begin(async (transaction) => {
        if (selected === 'better-auth')
          await transaction`UPDATE auth_account SET provider_id='google' WHERE user_id=${owner.userId} AND provider_id='apple'`;
        else
          await transaction`UPDATE accounts SET provider='google' WHERE "userId"=${owner.userId} AND provider='apple'`;
        ready();
        await released;
      });
      let completed = false;
      await started;
      const pending = admit(owner)
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          completed = true;
        });
      try {
        let observedWait = false;
        const until = Date.now() + 2_000;
        while (!completed && !observedWait && Date.now() < until) {
          const [state] = await observer<{ waiting: boolean }[]>`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
              AND wait_event_type='Lock' AND query ILIKE '%for update%'
              AND (query ILIKE '%auth_account%' OR query ILIKE '%accounts%')
          ) AS waiting`;
          observedWait = state.waiting;
          if (!observedWait) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(observedWait).toBe(true);
        expect(completed).toBe(false);
        release();
        await holding;
        expect(await pending).toMatchObject({ error: { outcome: 'denied', code: 'not_eligible' } });
        expect(await sourceState(owner)).toEqual(before);
      } finally {
        release();
        await holding;
        await pending;
        await observer.end({ timeout: 5 });
      }
    });
  }
});
