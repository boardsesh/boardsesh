import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  authEmailReservationMembers,
  authBrowserBindings,
  authEmailReservations,
  authFirstPasswordChallenges,
  users,
} from '@boardsesh/db/schema/auth';
import { createProviderSecurityEnvironment } from './provider-security-fixture';
import { scrubExpiredFirstPasswordPreparations, FIRST_PASSWORD_SCRUB_BATCH_SIZE } from '../first-password-maintenance';
import { captureFirstPasswordRuntime } from '../first-password-policy';
import { requestFirstPasswordChallenge, firstPasswordTokenHash } from '../first-password-challenges';
import { prepareFirstPasswordChallenge, finalizeFirstPasswordChallenge } from '../first-password-finalizer';
import { bindIdentityAuthority } from '../identity-authority';
import { withFirstPasswordAuthority } from '../first-password-context';
import { normalizeAccountEmail } from '../../normalize-email';
import { providerTokenHash } from '../provider-security-context';

let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
const digest = () => randomBytes(32).toString('hex');
async function seedPrepared(active = false) {
  const userId = randomUUID();
  const now = new Date();
  const issuedAt = new Date(now.getTime() - (active ? 1000 : 360_000));
  const expiresAt = new Date(issuedAt.getTime() + 300_000);
  const challengeHash = digest();
  await environment.database.insert(users).values({ id: userId, email: `${userId}@example.test` });
  await environment.database.insert(authFirstPasswordChallenges).values({
    challengeHash,
    purpose: 'first-password',
    operationId: randomUUID(),
    userId,
    emailBindingHash: digest(),
    confirmationTokenHash: digest(),
    recoveryTokenHash: digest(),
    actorCredentialKind: 'canonical-token',
    actorCredentialHash: digest(),
    actorSessionId: randomUUID(),
    actorGeneration: 0,
    actorAuthenticatedAt: null,
    actorLinkGuarded: false,
    actorRequiresAccountCutoff: false,
    actorExpiresAt: new Date(now.getTime() + 3_600_000),
    browserBindingHash: digest(),
    browserVersion: 1,
    browserIntentHash: digest(),
    browserBindingExpiresAt: new Date(now.getTime() + 3_600_000),
    projectionId: 'old-qualification-may-have-ended',
    normalizerVersion: 'old-normalizer',
    writerAuthority: 'current-store',
    writerEpoch: 1,
    phase: 'prepared',
    issuedAt,
    expiresAt,
    pendingPasswordHash: environment.passwordHash,
    preparedAt: new Date(issuedAt.getTime() + 100),
    preparationTokenHash: digest(),
    proposedCredentialHash: digest(),
  });
  return { userId, challengeHash };
}
async function stored(challengeHash: string) {
  const [row] = await environment.database
    .select()
    .from(authFirstPasswordChallenges)
    .where(eq(authFirstPasswordChallenges.challengeHash, challengeHash));
  return row;
}
const scrub = () => scrubExpiredFirstPasswordPreparations(environment.database, environment.qualification);
function observer() {
  const address = new URL(
    process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
  );
  address.pathname = `/${environment.client.options.database}`;
  return postgres(address.toString(), { max: 2, onnotice: () => {} });
}

describe('bounded first-password pending-hash scrubbing', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
    await environment.client.unsafe(
      readFileSync(new URL('../../../../../db/drizzle/0314_first_password_challenges.sql', import.meta.url), 'utf8'),
    );
  });
  afterAll(async () => environment?.close());
  it('scrubs expired old-authority material and preserves active/unrelated confirmations without deleting either account', async () => {
    const expired = await seedPrepared();
    const active = await seedPrepared(true);
    const before = await stored(active.challengeHash);
    expect(await scrub()).toEqual({ observed: 1, scrubbed: 1 });
    expect(await stored(expired.challengeHash)).toMatchObject({
      phase: 'terminal',
      pendingPasswordHash: null,
      preparedAt: null,
      preparationTokenHash: null,
      proposedCredentialHash: null,
    });
    expect(await stored(active.challengeHash)).toEqual(before);
    expect(await environment.database.select().from(users).where(eq(users.id, expired.userId))).toHaveLength(1);
    expect(await scrub()).toEqual({ observed: 0, scrubbed: 0 });
  });
  it('processes at most the fixed batch and makes progress on the next tick', async () => {
    const rows = [];
    for (let index = 0; index < FIRST_PASSWORD_SCRUB_BATCH_SIZE + 2; index++) rows.push(await seedPrepared());
    const first = await scrub();
    expect(first.observed).toBe(FIRST_PASSWORD_SCRUB_BATCH_SIZE);
    expect(first.scrubbed).toBeGreaterThan(0);
    expect(first.scrubbed).toBeLessThanOrEqual(FIRST_PASSWORD_SCRUB_BATCH_SIZE);
    const remaining = [];
    for (const row of rows) if ((await stored(row.challengeHash)).pendingPasswordHash !== null) remaining.push(row);
    expect(remaining).toHaveLength(rows.length - first.scrubbed);
    expect(remaining.length).toBeGreaterThanOrEqual(2);
    let cleared = first.scrubbed;
    for (let attempt = 0; attempt < 8 && cleared < rows.length; attempt++) {
      const next = await scrub();
      expect(next.observed).toBeLessThanOrEqual(FIRST_PASSWORD_SCRUB_BATCH_SIZE);
      expect(next.scrubbed).toBeGreaterThan(0);
      cleared += next.scrubbed;
    }
    expect(cleared).toBe(rows.length);
  });
  it('scrubs the old account hash after its stable binding selected a later deleted account, without editing the tombstone', async () => {
    const old = await seedPrepared();
    const later = await environment.actor('current-store', 'canonical-token', { password: false, provider: 'apple' });
    const bindingId = providerTokenHash(later.actor.browserBindingToken);
    await environment.database
      .update(authFirstPasswordChallenges)
      .set({ browserBindingHash: bindingId })
      .where(eq(authFirstPasswordChallenges.challengeHash, old.challengeHash));
    await environment.database.delete(users).where(eq(users.id, later.userId));
    const [before] = await environment.database
      .select()
      .from(authBrowserBindings)
      .where(eq(authBrowserBindings.id, bindingId));
    expect(await scrub()).toEqual({ observed: 1, scrubbed: 1 });
    const [after] = await environment.database
      .select()
      .from(authBrowserBindings)
      .where(eq(authBrowserBindings.id, bindingId));
    expect(after).toEqual(before);
    expect((await stored(old.challengeHash)).pendingPasswordHash).toBeNull();
  });
  it('stops by its database-clock work budget during observed real per-write delay rather than draining every candidate', async () => {
    for (let index = 0; index < FIRST_PASSWORD_SCRUB_BATCH_SIZE; index++) await seedPrepared();
    await environment.database.execute(
      sql`CREATE FUNCTION delay_first_password_scrub() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='terminal' THEN PERFORM pg_sleep(0.075); END IF; RETURN NEW; END $$`,
    );
    await environment.database.execute(
      sql`CREATE TRIGGER delay_first_password_scrub BEFORE UPDATE ON auth_first_password_challenges FOR EACH ROW EXECUTE FUNCTION delay_first_password_scrub()`,
    );
    const connection = observer();
    const pending = scrub();
    try {
      let observed = false;
      const until = Date.now() + 2000;
      while (!observed && Date.now() < until) {
        const [state] = await connection<
          { sleeping: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='PgSleep') AS sleeping`;
        observed = state.sleeping;
        if (!observed) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observed).toBe(true);
      const result = await pending;
      expect(result.observed).toBe(FIRST_PASSWORD_SCRUB_BATCH_SIZE);
      expect(result.scrubbed).toBeGreaterThan(0);
      expect(result.scrubbed).toBeLessThan(FIRST_PASSWORD_SCRUB_BATCH_SIZE);
    } finally {
      await pending;
      await environment.database.execute(
        sql`DROP TRIGGER delay_first_password_scrub ON auth_first_password_challenges`,
      );
      await environment.database.execute(sql`DROP FUNCTION delay_first_password_scrub()`);
      await connection.end({ timeout: 5 });
    }
    await scrub();
  });
  it('skips an actually locked user without changing the pending hash, then retries after release', async () => {
    const expired = await seedPrepared();
    const before = await stored(expired.challengeHash);
    const connection = observer();
    let ready = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = connection.begin(async (transaction) => {
      await transaction`SELECT id FROM users WHERE id=${expired.userId} FOR UPDATE`;
      ready();
      await released;
    });
    await started;
    try {
      expect(await scrub()).toEqual({ observed: 1, scrubbed: 0 });
      expect(await stored(expired.challengeHash)).toEqual(before);
    } finally {
      release();
      await holding;
      await connection.end({ timeout: 5 });
    }
    expect(await scrub()).toEqual({ observed: 1, scrubbed: 1 });
  });
  for (const selected of ['current-store', 'better-auth'] as const) {
    it(`${selected}: skips the actual held finalizer, then scrubs only after its expired transaction rolls back`, async () => {
      const owner = await environment.actor(selected, 'canonical-token', { password: false, provider: 'apple' });
      const [user] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
      const normalizedEmail = normalizeAccountEmail(user.email);
      await environment.database.insert(authEmailReservations).values({
        normalizedEmail,
        basisProjectionId: environment.qualification.expectedProjectionId,
        state: 'owned',
        ownerUserId: owner.userId,
      });
      await environment.database.insert(authEmailReservationMembers).values({ normalizedEmail, userId: owner.userId });
      const runtime = captureFirstPasswordRuntime({
        qualification: environment.qualification,
        legacySecret: environment.secret,
        emailBindingKey: 'first-password-maintenance-owned-private-key-6975',
      });
      const issued = await requestFirstPasswordChallenge(environment.database, runtime, { actor: owner.actor });
      const bound = {
        actor: owner.actor,
        challengeToken: issued.challengeToken,
        browserIntentToken: issued.browserIntentToken,
      };
      const prepared = await prepareFirstPasswordChallenge(environment.database, runtime, {
        ...bound,
        confirmationToken: issued.mailPlan.token,
        password: ' owned maintenance password ',
        confirmPassword: ' owned maintenance password ',
      });
      const candidate = await environment.candidate(prepared, 'canonical-token');
      const command = { ...bound, ...prepared, candidate };
      const challengeHash = firstPasswordTokenHash('challenge', issued.challengeToken);
      await environment.database.execute(
        sql`UPDATE auth_first_password_challenges SET expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE challenge_hash=${challengeHash}`,
      );
      const expiresAt = (await stored(challengeHash)).expiresAt;
      const connection = observer();
      let ready = () => {};
      let release = () => {};
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = connection.begin(async (transaction) => {
        await transaction`SELECT pg_advisory_xact_lock(69750315)`;
        ready();
        await released;
      });
      await started;
      await environment.database.execute(
        sql`CREATE FUNCTION hold_first_password_maintenance_race() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='committed' THEN PERFORM pg_advisory_xact_lock(69750315); END IF; RETURN NEW; END $$`,
      );
      await environment.database.execute(
        sql`CREATE TRIGGER hold_first_password_maintenance_race BEFORE UPDATE ON auth_first_password_challenges FOR EACH ROW EXECUTE FUNCTION hold_first_password_maintenance_race()`,
      );
      const pending = finalizeFirstPasswordChallenge(environment.database, runtime, command).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        let observed = false;
        const until = Date.now() + 2000;
        while (!observed && Date.now() < until) {
          const [state] = await connection<
            { waiting: boolean }[]
          >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%update%auth_first_password_challenges%') AS waiting`;
          observed = state.waiting;
          if (!observed) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(observed).toBe(true);
        while (true) {
          const [clock] = await connection<
            { milliseconds: number }[]
          >`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::double precision AS milliseconds`;
          if (clock.milliseconds > expiresAt.getTime()) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(await scrub()).toEqual({ observed: 1, scrubbed: 0 });
        release();
        await holding;
        expect(await pending).toMatchObject({ error: { outcome: 'denied', code: 'expired' } });
        expect((await stored(challengeHash)).phase).toBe('prepared');
      } finally {
        release();
        await holding;
        await pending;
        await environment.database.execute(
          sql`DROP TRIGGER hold_first_password_maintenance_race ON auth_first_password_challenges`,
        );
        await environment.database.execute(sql`DROP FUNCTION hold_first_password_maintenance_race()`);
        await connection.end({ timeout: 5 });
      }
      expect(await scrub()).toEqual({ observed: 1, scrubbed: 1 });
      expect((await stored(challengeHash)).pendingPasswordHash).toBeNull();
      expect(
        await withFirstPasswordAuthority(environment.database, runtime, (transaction, authority) =>
          bindIdentityAuthority(transaction, authority).readPassword(owner.userId),
        ),
      ).toBeNull();
    });
  }
});
