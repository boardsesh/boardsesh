import { randomUUID } from 'node:crypto';
import { hkdf } from '@panva/hkdf';
import { EncryptJWT } from 'jose';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it, vi } from 'vite-plus/test';
import {
  authCredentialLineage,
  authSession,
  authSessionDenials,
  authSubjectCutoffs,
  users,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { denyFirstPartySession } from '../lineage';
import { bridgeLegacyCredential } from '../bridge';
import { readFirstPartySession, requireFreshAuthentication } from '../session-reader';
const secret = 'synthetic-independent-bridge-review';
const now = new Date(Math.floor(Date.now() / 1000) * 1000);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
vi.mock('../../admission-pool', () => ({
  readOnAdmissionConnection: async (
    mark: () => void,
    read: (database: typeof environment.database) => PromiseLike<unknown>,
  ) => {
    mark();
    return read(environment.database);
  },
}));
beforeAll(async () => {
  environment = await createEnvironment();
});
afterAll(async () => {
  await environment?.close();
});
async function cookie(
  userId: string,
  sessionId: string,
  issuedAt: Date,
  lifetimeSeconds: number,
  authTime?: number,
  guarded = false,
) {
  const key = await hkdf('sha256', new TextEncoder().encode(secret), '', 'NextAuth.js Generated Encryption Key', 32);
  return new EncryptJWT({
    authSessionId: sessionId,
    ...(authTime === undefined ? {} : { auth_time: authTime }),
    ...(guarded ? { link_guarded: true } : {}),
  })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setSubject(userId)
    .setIssuedAt(issuedAt.getTime() / 1000)
    .setExpirationTime(issuedAt.getTime() / 1000 + lifetimeSeconds)
    .encrypt(key);
}
async function fixture() {
  const userId = randomUUID();
  const sessionId = randomUUID();
  await environment.database.insert(users).values({ id: userId, email: `synthetic-review-${userId}@example.test` });
  return { userId, sessionId };
}
it('does not promote unguarded legacy auth_time into fresh authentication', async () => {
  const { userId, sessionId } = await fixture();
  const proof = await cookie(userId, sessionId, now, 3600, now.getTime() / 1000 - 10);
  const legacy = await readFirstPartySession(
    environment.database,
    { kind: 'legacy-jwe', credential: proof, secret },
    now,
  );
  expect(legacy.status).toBe('admitted');
  if (legacy.status === 'admitted') expect(requireFreshAuthentication(legacy.session, now)).toBe(false);
  const bridged = await bridgeLegacyCredential(environment.database, proof, secret, 'on', now);
  expect(bridged.status).toBe('bridged');
  if (bridged.status === 'bridged') {
    expect(bridged.session.createdAt.getTime()).toBe(0);
    const canonical = await readFirstPartySession(
      environment.database,
      { kind: 'canonical-token', token: bridged.session.token },
      now,
    );
    expect(canonical.status).toBe('admitted');
    if (canonical.status === 'admitted') expect(requireFreshAuthentication(canonical.session, now)).toBe(false);
  }
});
it('accepts a renewed signed cookie on the same SID after the original canonical expiry without freshening', async () => {
  const { userId, sessionId } = await fixture();
  const first = await bridgeLegacyCredential(
    environment.database,
    await cookie(userId, sessionId, now, 120),
    secret,
    'on',
    now,
  );
  expect(first.status).toBe('bridged');
  const later = new Date(now.getTime() + 130000);
  const renewed = await cookie(userId, sessionId, later, 3600, later.getTime() / 1000, true);
  const answer = await bridgeLegacyCredential(environment.database, renewed, secret, 'on', later);
  expect(answer.status).toBe('bridged');
  if (answer.status === 'bridged' && first.status === 'bridged') {
    expect(answer.session.id).toBe(first.session.id);
    expect(answer.session.createdAt.getTime()).toBe(0);
    expect(answer.session.originalAuthenticatedAt).toBeNull();
    expect(answer.session.expiresAt.getTime()).toBe(later.getTime() + 3600000);
  }
  const [lineage] = await environment.database
    .select()
    .from(authCredentialLineage)
    .where(eq(authCredentialLineage.userId, userId));
  expect(lineage.originalExpiresAt.getTime()).toBe(now.getTime() + 120000);
  expect(await environment.database.select().from(authSession).where(eq(authSession.userId, userId))).toHaveLength(1);
});

it('reads a fresh primary SID denial without needing lineage and preserves a different login', async () => {
  const { userId, sessionId } = await fixture();
  const proof = await cookie(userId, sessionId, now, 3600);
  const credential = { kind: 'legacy-jwe' as const, credential: proof, secret };
  expect((await readFirstPartySession(environment.database, credential, now)).status).toBe('admitted');
  await denyFirstPartySession(
    environment.database,
    {
      userId,
      authSessionId: sessionId,
      generation: 0,
      requiresAccountCutoff: false,
      authenticatedAt: null,
      linkGuarded: false,
      expiresAt: new Date(now.getTime() + 3600000),
    },
    now,
  );
  expect((await readFirstPartySession(environment.database, credential, now)).status).toBe('denied');
  const other = await cookie(userId, randomUUID(), now, 3600);
  expect(
    (await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential: other, secret }, now)).status,
  ).toBe('admitted');
  await denyFirstPartySession(
    environment.database,
    {
      userId,
      authSessionId: sessionId,
      generation: 0,
      requiresAccountCutoff: false,
      authenticatedAt: null,
      linkGuarded: false,
      expiresAt: new Date(now.getTime() + 3600000),
    },
    new Date(now.getTime() - 10000),
  );
  const [denial] = await environment.database
    .select()
    .from(authSessionDenials)
    .where(eq(authSessionDenials.sessionId, sessionId));
  expect(denial.expiresAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + (30 * 86400 + 180) * 1000);
});
it('serializes simultaneous first bridges even when canonical insertion is delayed', async () => {
  const { userId, sessionId } = await fixture();
  const proof = await cookie(userId, sessionId, now, 3600);
  await environment.client.unsafe(
    "CREATE FUNCTION review_delay_bridge() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END'; CREATE TRIGGER review_delay_bridge BEFORE INSERT ON auth_session FOR EACH ROW EXECUTE FUNCTION review_delay_bridge()",
  );
  try {
    const answers = await Promise.all(
      [1, 2].map(() => bridgeLegacyCredential(environment.database, proof, secret, 'on', now)),
    );
    expect(answers.map((answer) => answer.status)).toEqual(['bridged', 'bridged']);
    expect(await environment.database.select().from(authSession).where(eq(authSession.userId, userId))).toHaveLength(1);
    expect(
      await environment.database.select().from(authCredentialLineage).where(eq(authCredentialLineage.userId, userId)),
    ).toHaveLength(1);
  } finally {
    await environment.client.unsafe(
      'DROP TRIGGER review_delay_bridge ON auth_session; DROP FUNCTION review_delay_bridge()',
    );
  }
});
it('waits for a committed reset and refuses its old generation without creating a session', async () => {
  const { userId, sessionId } = await fixture();
  const proof = await cookie(userId, sessionId, now, 3600);
  let release!: () => void;
  let locked!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const resetting = environment.database.transaction(async (transaction) => {
    await transaction.select().from(users).where(eq(users.id, userId)).for('update');
    await transaction
      .insert(authSubjectCutoffs)
      .values({ userId, generation: 1, revokedThrough: now, lastOperationId: randomUUID() });
    locked();
    await held;
  });
  await ready;
  const bridging = bridgeLegacyCredential(environment.database, proof, secret, 'on', now);
  try {
    // A second client avoids consuming the two connections occupied by reset and bridge.
    await new Promise((resolve) => setTimeout(resolve, 40));
    release();
    await resetting;
    expect(await bridging).toMatchObject({ status: 'denied' });
    expect(await environment.database.select().from(authSession).where(eq(authSession.userId, userId))).toHaveLength(0);
  } finally {
    release();
    await Promise.allSettled([resetting, bridging]);
  }
});

it('honors the authority gate before taking its user and lineage locks', async () => {
  const { userId, sessionId } = await fixture();
  const proof = await cookie(userId, sessionId, now, 3600);
  const observerUrl = new URL(
    process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
  );
  observerUrl.pathname = `/${environment.client.options.database}`;
  const observer = postgres(observerUrl.toString(), { max: 1, onnotice: () => {} });
  let release!: () => void;
  let locked!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const blocking = environment.database.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975,2)`);
    locked();
    await held;
  });
  await ready;
  const bridging = bridgeLegacyCredential(environment.database, proof, secret, 'on', now);
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const [locks] =
        await observer`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'`;
      if (locks.count > 0) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    release();
    await blocking;
    expect(await bridging).toMatchObject({ status: 'bridged' });
  } finally {
    release();
    await Promise.allSettled([blocking, bridging]);
    await observer.end();
  }
});
