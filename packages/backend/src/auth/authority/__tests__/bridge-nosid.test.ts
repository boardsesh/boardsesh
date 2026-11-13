import { randomUUID } from 'node:crypto';
import { hkdf } from '@panva/hkdf';
import { EncryptJWT } from 'jose';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vite-plus/test';
import {
  authEmailProjection,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  authSession,
  authSessionDenials,
  authCredentialLineage,
  mobileRefreshTokens,
  users,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { bridgeLegacyCredential } from '../bridge';
import { readFirstPartySession, requireFreshAuthentication, type FirstPartySession } from '../session-reader';
import { denyFirstPartySession, denyFirstPartySessionInTransaction } from '../lineage';
import { LEGACY_WEB_MAX_REMAINING_VALIDITY_MS } from '../../legacy-web-credentials';
const secret = 'synthetic-no-sid-review-secret';
const now = new Date(Math.floor(Date.now() / 1000) * 1000);
const expected = {
  expectedProjectionId: 'nosid-projection',
  expectedNormalizerVersion: 'js-trim-lower-v1',
  expectedWriterEpoch: 3,
};
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
beforeEach(async () => {
  await environment.database.delete(authEmailProjection);
  await environment.database.insert(authEmailProjection).values({
    projectionId: expected.expectedProjectionId,
    normalizerVersion: expected.expectedNormalizerVersion,
    writerEpoch: expected.expectedWriterEpoch,
    phase: 'enforced',
    preparedAt: now,
  });
});
async function cookie(userId: string, generation = 0, sessionId?: string) {
  const key = await hkdf('sha256', new TextEncoder().encode(secret), '', 'NextAuth.js Generated Encryption Key', 32);
  return new EncryptJWT({ gen: generation, ...(sessionId ? { authSessionId: sessionId } : {}) })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setSubject(userId)
    .setIssuedAt(now.getTime() / 1000)
    .setExpirationTime(now.getTime() / 1000 + 3600)
    .encrypt(key);
}
async function fixture() {
  const userId = randomUUID();
  await environment.database.insert(users).values({ id: userId, email: `synthetic-${userId}@example.test` });
  const first = await cookie(userId);
  const sibling = await cookie(userId);
  const rotated = await cookie(userId, 0, randomUUID());
  return { userId, first, sibling, rotated };
}
async function read(credential: string) {
  return readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential, secret }, now);
}
async function session(credential: string): Promise<FirstPartySession> {
  const outcome = await read(credential);
  expect(outcome.status).toBe('admitted');
  if (outcome.status !== 'admitted') throw new Error('Synthetic session refused');
  return outcome.session;
}
async function bridge(credential: string) {
  const answer = await bridgeLegacyCredential(environment.database, credential, secret, 'on', now);
  expect(answer.status).toBe('bridged');
  if (answer.status !== 'bridged') throw new Error('Synthetic bridge refused');
  return answer.session;
}
it('preserves no-SID reads, bridge modes, provenance and unknown authentication age without cutoff writes', async () => {
  const { first } = await fixture();
  const legacy = await session(first);
  expect(legacy.requiresAccountCutoff).toBe(true);
  expect(requireFreshAuthentication(legacy, now)).toBe(false);
  expect((await bridgeLegacyCredential(environment.database, first, secret, 'off', now)).status).toBe('off');
  expect((await bridgeLegacyCredential(environment.database, first, secret, 'shadow', now)).status).toBe('shadow');
  const canonical = await bridge(first);
  // Provenance survives even when the optional lineage row is absent.
  await environment.database
    .delete(authCredentialLineage)
    .where(eq(authCredentialLineage.id, canonical.legacyLineageId!));
  const result = await readFirstPartySession(
    environment.database,
    { kind: 'canonical-token', token: canonical.token },
    now,
  );
  expect(result.status).toBe('admitted');
  if (result.status === 'admitted') {
    expect(result.session.requiresAccountCutoff).toBe(true);
    expect(requireFreshAuthentication(result.session, now)).toBe(false);
  }
  expect(await environment.database.select().from(authSubjectCutoffs)).toHaveLength(0);
  expect(await environment.database.select().from(authSecurityMutationEvents)).toHaveLength(0);
});
it.each(['direct', 'canonical'] as const)(
  'ends sibling and new-SID rotations on explicit %s logout, retaining evidence and native generation',
  async (form) => {
    const { userId, first, sibling, rotated } = await fixture();
    await environment.database
      .insert(authSubjectCutoffs)
      .values({ userId, generation: 0, nativeGeneration: 7, revokedThrough: now, lastOperationId: randomUUID() });
    const originals = await Promise.all([first, sibling, rotated].map(bridge));
    await environment.database.insert(mobileRefreshTokens).values({
      userId,
      tokenHash: randomUUID(),
      expiresAt: new Date(now.getTime() + 3600000),
      subjectGeneration: 0,
      nativeGeneration: 7,
    });
    let logout = await session(first);
    if (form === 'canonical') {
      const result = await readFirstPartySession(
        environment.database,
        { kind: 'canonical-token', token: originals[0].token },
        now,
      );
      if (result.status !== 'admitted') throw new Error('Synthetic canonical refused');
      logout = result.session;
    }
    await denyFirstPartySession(environment.database, logout, now, expected);
    for (const credential of [first, sibling, rotated]) {
      expect((await read(credential)).status).toBe('denied');
      expect((await bridgeLegacyCredential(environment.database, credential, secret, 'on', now)).status).toBe('denied');
    }
    for (const canonical of originals)
      expect(
        (await readFirstPartySession(environment.database, { kind: 'canonical-token', token: canonical.token }, now))
          .status,
      ).toBe('denied');
    const [cutoff] = await environment.database
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, userId));
    expect({ generation: cutoff.generation, native: cutoff.nativeGeneration }).toEqual({ generation: 1, native: 7 });
    const [event] = await environment.database
      .select()
      .from(authSecurityMutationEvents)
      .where(eq(authSecurityMutationEvents.userId, userId));
    expect(event).toMatchObject({
      kind: 'legacy-signout',
      previousGeneration: 0,
      generation: 1,
      domains: ['first-party'],
      writerEpoch: 3,
      projectionId: expected.expectedProjectionId,
      operationId: cutoff.lastOperationId,
    });
    expect(await environment.database.select().from(authSession).where(eq(authSession.userId, userId))).toHaveLength(3);
    expect(
      (
        await environment.database.select().from(authCredentialLineage).where(eq(authCredentialLineage.userId, userId))
      ).every((lineage) => lineage.revokedAt !== null),
    ).toBe(true);
    expect(
      (await environment.database.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, userId)))[0]
        .revokedAt,
    ).not.toBeNull();
  },
);
it('repeated concurrent stale logouts leave a newly authenticated generation usable', async () => {
  const { userId, first } = await fixture();
  const old = await session(first);
  await denyFirstPartySession(environment.database, old, now, expected);
  const fresh = await cookie(userId, 1, randomUUID());
  const canonical = await bridge(fresh);
  await Promise.all([1, 2].map(() => denyFirstPartySession(environment.database, old, now, expected)));
  expect((await read(fresh)).status).toBe('admitted');
  expect(
    (await readFirstPartySession(environment.database, { kind: 'canonical-token', token: canonical.token }, now))
      .status,
  ).toBe('admitted');
  expect(
    (await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)))[0]
      .generation,
  ).toBe(1);
  expect(
    await environment.database
      .select()
      .from(authSecurityMutationEvents)
      .where(eq(authSecurityMutationEvents.userId, userId)),
  ).toHaveLength(1);
});
it.each(['missing-expected', 'missing-manifest', 'stale-epoch', 'unenforced'] as const)(
  'refuses fallback without writes when authority is %s',
  async (failure) => {
    const { userId, first } = await fixture();
    const old = await session(first);
    if (failure === 'missing-manifest') await environment.database.delete(authEmailProjection);
    if (failure === 'unenforced') await environment.database.update(authEmailProjection).set({ phase: 'prepared' });
    const authority =
      failure === 'missing-expected'
        ? undefined
        : { ...expected, expectedWriterEpoch: failure === 'stale-epoch' ? 2 : 3 };
    await expect(denyFirstPartySession(environment.database, old, now, authority)).rejects.toThrow();
    expect(
      await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)),
    ).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.userId, userId)),
    ).toHaveLength(0);
    expect((await read(first)).status).toBe('admitted');
  },
);
it('serializes a sibling bridge behind explicit logout and refuses the old generation after commit', async () => {
  const { userId, first, sibling } = await fixture();
  const old = await session(first);
  let release!: () => void;
  let locked!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const blocker = environment.database.transaction(async (transaction) => {
    await transaction.select().from(users).where(eq(users.id, userId)).for('update');
    locked();
    await held;
  });
  await ready;
  const logout = denyFirstPartySession(environment.database, old, now, expected);
  const bridging = bridgeLegacyCredential(environment.database, sibling, secret, 'on', now);
  release();
  await blocker;
  await logout;
  const answer = await bridging;
  // If the bridge won before logout it must already be refused after the commit.
  if (answer.status === 'bridged')
    expect(
      (await readFirstPartySession(environment.database, { kind: 'canonical-token', token: answer.session.token }, now))
        .status,
    ).toBe('denied');
  else expect(answer.status).toBe('denied');
  expect((await read(sibling)).status).toBe('denied');
});

it('rolls back the cutoff and retained sessions when append-only evidence cannot be written', async () => {
  const { userId, first } = await fixture();
  const old = await session(first);
  const canonical = await bridge(first);
  await environment.client.unsafe(
    "CREATE FUNCTION refuse_signout_event() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''synthetic evidence unavailable''; END'; CREATE TRIGGER refuse_signout_event BEFORE INSERT ON auth_security_mutation_events FOR EACH ROW EXECUTE FUNCTION refuse_signout_event()",
  );
  try {
    await expect(denyFirstPartySession(environment.database, old, now, expected)).rejects.toThrow();
    expect(
      await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)),
    ).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.userId, userId)),
    ).toHaveLength(0);
    expect((await read(first)).status).toBe('admitted');
    expect(
      (await readFirstPartySession(environment.database, { kind: 'canonical-token', token: canonical.token }, now))
        .status,
    ).toBe('admitted');
    expect(
      (
        await environment.database.select().from(authCredentialLineage).where(eq(authCredentialLineage.userId, userId))
      )[0].revokedAt,
    ).toBeNull();
  } finally {
    await environment.client.unsafe(
      'DROP TRIGGER refuse_signout_event ON auth_security_mutation_events; DROP FUNCTION refuse_signout_event()',
    );
  }
});

it('the generated constraint refuses partner-domain legacy logout events', async () => {
  const { userId } = await fixture();
  await expect(
    environment.database.insert(authSecurityMutationEvents).values({
      operationId: randomUUID(),
      userId,
      previousGeneration: 0,
      generation: 1,
      kind: 'legacy-signout',
      domains: ['first-party', 'partner'],
      revokedThrough: now,
      writerEpoch: 3,
      projectionId: expected.expectedProjectionId,
    }),
  ).rejects.toThrow();
  expect(
    await environment.database
      .select()
      .from(authSecurityMutationEvents)
      .where(eq(authSecurityMutationEvents.userId, userId)),
  ).toHaveLength(0);
});

it('captures the admitted logout generation before the first await, so caller reuse cannot bless a stale proof', async () => {
  const { userId, first } = await fixture();
  const old = await session(first);
  await environment.database.insert(authSubjectCutoffs).values({
    userId,
    generation: 1,
    revokedThrough: now,
    lastOperationId: randomUUID(),
  });
  const fresh = await cookie(userId, 1, randomUUID());
  const pending = denyFirstPartySession(environment.database, old, now, expected);
  Object.assign(old, { generation: 1 });
  await expect(pending).resolves.toBeUndefined();
  const [cutoff] = await environment.database
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, userId));
  expect(cutoff.generation).toBe(1);
  expect((await read(fresh)).status).toBe('admitted');
  expect(
    await environment.database
      .select()
      .from(authSecurityMutationEvents)
      .where(eq(authSecurityMutationEvents.userId, userId)),
  ).toHaveLength(0);
});

it('captures fallback identity, provenance, authority and date contents before asynchronous work', async () => {
  const original = await fixture();
  const other = await fixture();
  const admitted = await session(original.first);
  const canonical = await bridge(original.first);
  const authority = { ...expected };
  const requestedNow = new Date(now.getTime());
  const pending = denyFirstPartySession(environment.database, admitted, requestedNow, authority);
  Object.assign(admitted, { userId: other.userId, authSessionId: randomUUID(), requiresAccountCutoff: false });
  admitted.expiresAt.setTime(now.getTime() + 100 * 86400000);
  requestedNow.setTime(now.getTime() + 100 * 86400000);
  Object.assign(authority, {
    expectedProjectionId: 'reused-projection',
    expectedNormalizerVersion: 'reused-version',
    expectedWriterEpoch: 99,
  });
  await expect(pending).resolves.toBeUndefined();
  const [cutoff] = await environment.database
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, original.userId));
  expect(cutoff.generation).toBe(1);
  expect(
    await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, other.userId)),
  ).toHaveLength(0);
  const [retained] = await environment.database.select().from(authSession).where(eq(authSession.id, canonical.id));
  expect(retained.expiresAt.getTime()).toBe(now.getTime());
  const [lineage] = await environment.database
    .select()
    .from(authCredentialLineage)
    .where(eq(authCredentialLineage.userId, original.userId));
  expect(lineage.revokedAt?.getTime()).toBe(now.getTime());
  const [event] = await environment.database
    .select()
    .from(authSecurityMutationEvents)
    .where(eq(authSecurityMutationEvents.userId, original.userId));
  expect(event).toMatchObject({
    writerEpoch: expected.expectedWriterEpoch,
    projectionId: expected.expectedProjectionId,
  });
  expect((await read(other.first)).status).toBe('admitted');
});

it('captures stable-login identity and expiry dates without following a reused caller object', async () => {
  const { userId } = await fixture();
  const firstSid = randomUUID();
  const otherSid = randomUUID();
  const first = await cookie(userId, 0, firstSid);
  const other = await cookie(userId, 0, otherSid);
  const admitted = await session(first);
  const requestedNow = new Date(now.getTime());
  const pending = denyFirstPartySession(environment.database, admitted, requestedNow);
  Object.assign(admitted, { authSessionId: otherSid });
  admitted.expiresAt.setTime(now.getTime() + 100 * 86400000);
  requestedNow.setTime(now.getTime() + 100 * 86400000);
  await expect(pending).resolves.toBeUndefined();
  expect((await read(first)).status).toBe('denied');
  expect((await read(other)).status).toBe('admitted');
  const [denial] = await environment.database
    .select()
    .from(authSessionDenials)
    .where(eq(authSessionDenials.sessionId, firstSid));
  expect(denial.deniedAt.getTime()).toBe(now.getTime());
  expect(denial.expiresAt.getTime()).toBe(now.getTime() + LEGACY_WEB_MAX_REMAINING_VALIDITY_MS);
});

it('the declared event-domain predicate agrees with first-party-only logout and existing two-domain mutations', async () => {
  const constraint = getTableConfig(authSecurityMutationEvents).checks.find(
    (check) => check.name === 'auth_security_mutation_events_domains',
  );
  if (!constraint) throw new Error('Missing declared domain constraint');
  for (const [kind, partner, accepted] of [
    ['legacy-signout', false, true],
    ['legacy-signout', true, false],
    ['password-reset', true, true],
    ['password-reset', false, false],
  ] as const) {
    const domains = partner ? sql`ARRAY['first-party', 'partner']::text[]` : sql`ARRAY['first-party']::text[]`;
    const [result] = await environment.database.execute(
      sql`SELECT ${constraint.value} AS accepted FROM (VALUES (${kind}::text, ${domains})) AS "auth_security_mutation_events"("kind", "domains")`,
    );
    expect(result.accepted).toBe(accepted);
  }
});

it.each([false, true])('captures caller-transaction logout proof before yielding, fallback=%s', async (fallback) => {
  const original = await fixture();
  const other = await fixture();
  const credential = fallback ? original.first : await cookie(original.userId, 0, randomUUID());
  const admitted = await session(credential);
  const originalSid = admitted.authSessionId;
  const requestedNow = new Date(now.getTime());
  const authority = { ...expected };
  await environment.database.transaction(async (transaction) => {
    const pending = denyFirstPartySessionInTransaction(transaction, admitted, requestedNow, authority);
    Object.assign(admitted, {
      userId: other.userId,
      authSessionId: randomUUID(),
      generation: 99,
      requiresAccountCutoff: !fallback,
    });
    admitted.expiresAt.setTime(now.getTime() + 100 * 86400000);
    requestedNow.setTime(now.getTime() + 100 * 86400000);
    Object.assign(authority, { expectedProjectionId: 'reused-projection', expectedWriterEpoch: 99 });
    await pending;
  });
  expect((await read(credential)).status).toBe('denied');
  expect((await read(other.first)).status).toBe('admitted');
  const cutoffs = await environment.database
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, original.userId));
  if (fallback) {
    expect(cutoffs[0]).toMatchObject({ generation: 1, nativeGeneration: 0 });
    const [event] = await environment.database
      .select()
      .from(authSecurityMutationEvents)
      .where(eq(authSecurityMutationEvents.userId, original.userId));
    expect(event).toMatchObject({
      kind: 'legacy-signout',
      writerEpoch: expected.expectedWriterEpoch,
      projectionId: expected.expectedProjectionId,
      domains: ['first-party'],
    });
  } else {
    expect(cutoffs).toHaveLength(0);
    const [denial] = await environment.database
      .select()
      .from(authSessionDenials)
      .where(eq(authSessionDenials.sessionId, originalSid));
    expect(denial.deniedAt.getTime()).toBe(now.getTime());
    expect(denial.expiresAt.getTime()).toBe(now.getTime() + LEGACY_WEB_MAX_REMAINING_VALIDITY_MS);
  }
});
