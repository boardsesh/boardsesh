import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DbInstance } from '@boardsesh/db/client';
import {
  accounts,
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  authSubjectCutoffs,
  authSecurityMutationEvents,
  sessions,
  users,
  userProfiles,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { db } from '../../../db/client';
import { normalizeAccountEmail } from '../../normalize-email';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION, type ExpectedCurrentStoreAuthority } from '../foundation-context';
import { recordSecurityMutation } from '../security-mutations';
import { startAppRouterCompound } from './fixtures/app-router-compound';

type Provider = 'google' | 'apple' | 'facebook';
interface Outcome {
  user: {
    id: string;
    email: string;
    name: string | null;
    image: string | null;
    emailVerified: string | null;
    createdAt: string;
  };
  createdUser: boolean;
  sourceProof: string;
  sourceSid: string;
  generation: number;
  flow: string;
  attemptId: string;
  originalAuthenticatedAt: number | null;
}
const webRequire = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = webRequire('next-auth/jwt') as {
  encode(options: { secret: string; token: Record<string, unknown>; maxAge: number }): Promise<string>;
};
const role = `ba03_router_compound_${randomUUID().replaceAll('-', '')}`;
const rolePassword = randomBytes(32).toString('hex');
const signingKey = randomBytes(32).toString('base64url');
const trackedRoles: string[] = [];
const allTables = [
  users,
  userProfiles,
  accounts,
  sessions,
  verificationTokens,
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  authSubjectCutoffs,
];
let pool: ReturnType<typeof postgres> | undefined;
let writer: DbInstance;
let authority: ExpectedCurrentStoreAuthority;
let service: Awaited<ReturnType<typeof startAppRouterCompound>> | undefined;
let cleanupFailed = false;
const hash = (input: string) => createHash('sha256').update(input).digest('hex');
const flow = () => hash(randomUUID());
async function admin(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout='5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout='4000ms'`);
    return transaction.execute(statement);
  });
}
async function request(path: string, body: object, secret = service!.secret) {
  return fetch(`${service!.origin}${path}`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
}
async function intent(provider: Provider = 'google', actorCookie: string | null = null, ownedFlow = flow()) {
  const response = await request('/intent', { provider, flow: ownedFlow, actorCookie });
  expect(response.status).toBe(200);
  return { provider, flow: ownedFlow, actorCookie, attemptId: randomUUID() };
}
async function compound(
  command: Awaited<ReturnType<typeof intent>>,
  subject: string = randomUUID(),
  email = `Mixed.${randomUUID()}+Tag@Example.TEST`,
) {
  return request('/compound', {
    ...command,
    subject,
    email,
    name: 'Owned profile',
    image: 'https://images.example.test/owned.png',
  });
}
async function outcome(response: Response) {
  if (response.status !== 200) throw new Error(`Owned compound rejected with ${response.status}`);
  return (await response.json()) as Outcome;
}
async function cookie(result: Outcome, maxAge = 3600) {
  return jwt.encode({
    secret: signingKey,
    token: { sub: result.user.id, authSessionId: result.sourceSid, sourceProof: result.sourceProof },
    maxAge,
  });
}
async function seed(email = `linked.${randomUUID()}@example.test`) {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email,
    name: 'Original profile',
    image: 'https://images.example.test/original.png',
    emailVerified: new Date('2024-01-02T03:04:05.000Z'),
  });
  await db.transaction((transaction) =>
    reserveEnforcedEmail(transaction, { ...authority, rawEmail: email, requestedUserId: id }),
  );
  return { id, email };
}
async function link(userId: string, provider: Provider = 'google', subject = randomUUID()) {
  await db.insert(accounts).values({ userId, type: 'oauth', provider, providerAccountId: subject });
  return subject;
}
async function countSources() {
  return (await db.select().from(sessions)).length;
}
async function terminal(ownedFlow: string) {
  return db
    .select()
    .from(verificationTokens)
    .where(eq(verificationTokens.identifier, `ba03-flow:app-router-consumed:${ownedFlow}`));
}

describe('synthetic App Router compound source/intent authority', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    const url = new URL(process.env.DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.startsWith('/boardsesh_backend_test_w') ||
      !['5433', '15475', '15478'].includes(url.port)
    )
      throw new Error('Compound fixture requires an owned local worker database');
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL statement_timeout='5000ms'`);
      await transaction.execute(
        sql`CREATE ROLE ${sql.identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${rolePassword}'`)}`,
      );
      trackedRoles.push(role);
      await transaction.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
      await transaction.execute(
        sql`GRANT SELECT,INSERT,UPDATE ON TABLE ${sql.join([users, accounts, authEmailProjection, authEmailReservations, authEmailReservationMembers, authSubjectCutoffs], sql`, `)} TO ${sql.identifier(role)}`,
      );
      await transaction.execute(sql`GRANT INSERT ON TABLE ${userProfiles} TO ${sql.identifier(role)}`);
      await transaction.execute(sql`GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ${sessions} TO ${sql.identifier(role)}`);
      await transaction.execute(sql`GRANT SELECT,INSERT ON TABLE ${verificationTokens} TO ${sql.identifier(role)}`);
    });
    url.username = role;
    url.password = rolePassword;
    pool = postgres(url.toString(), {
      max: 2,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { statement_timeout: 6000, lock_timeout: 4000 },
    });
    writer = drizzle(pool);
  });
  beforeEach(async () => {
    if (cleanupFailed) throw new Error('Previous compound fixture cleanup failed');
    await db.delete(sessions);
    await db.delete(verificationTokens);
    await db.delete(authEmailReservationMembers);
    await db.delete(authEmailReservations);
    await db.delete(authSecurityMutationEvents);
    await db.delete(authSubjectCutoffs);
    await db.delete(authEmailProjection);
    await db.delete(users);
    authority = {
      expectedProjectionId: randomUUID(),
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      expectedWriterEpoch: 1,
    };
    await db.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId: authority.expectedProjectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, authority.expectedProjectionId));
    });
    service = await startAppRouterCompound({ database: writer, authority, nextAuthSecret: signingKey });
  });
  afterEach(async () => {
    try {
      await service?.close();
      service = undefined;
    } catch {
      cleanupFailed = true;
      throw new Error('Owned compound listener did not quiesce');
    }
  });
  afterAll(async () => {
    const failures: Error[] = [];
    try {
      await service?.close();
    } catch {
      failures.push(new Error('Owned compound service cleanup failed'));
    }
    try {
      await pool?.end({ timeout: 3 });
    } catch {
      failures.push(new Error('Owned compound pool cleanup failed'));
    }
    for (const owned of trackedRoles) {
      try {
        await admin(sql`REVOKE ALL PRIVILEGES ON TABLE ${sql.join(allTables, sql`, `)} FROM ${sql.identifier(owned)}`);
      } catch {
        failures.push(new Error('Owned compound table grant cleanup failed'));
      }
      try {
        await admin(sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(owned)}`);
      } catch {
        failures.push(new Error('Owned compound schema grant cleanup failed'));
      }
      try {
        await admin(sql`DROP ROLE IF EXISTS ${sql.identifier(owned)}`);
      } catch {
        failures.push(new Error('Owned compound role cleanup failed'));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned compound cleanup failed');
  });

  it('atomically creates free-key user/default profile/link and a verifiable synthetic source', async () => {
    const command = await intent();
    const result = await outcome(await compound(command));
    expect(result.createdUser).toBe(true);
    expect(result.user.emailVerified).toBeNull();
    expect(result.originalAuthenticatedAt).toBeNull();
    expect(result.generation).toBe(0);
    expect(result.attemptId).toBe(command.attemptId);
    expect((await db.select().from(userProfiles))[0]).toMatchObject({
      userId: result.user.id,
      displayName: 'Owned profile',
      avatarUrl: 'https://images.example.test/owned.png',
    });
    expect((await db.select().from(accounts))[0].userId).toBe(result.user.id);
    expect((await db.select().from(authEmailReservations))[0].ownerUserId).toBe(result.user.id);
    expect((await request('/validate', { actorCookie: await cookie(result) })).status).toBe(200);
    expect(await countSources()).toBe(1);
    expect(await terminal(command.flow)).toHaveLength(1);
    expect(JSON.stringify(await db.select().from(verificationTokens)).includes(result.sourceProof)).toBe(false);
  });
  it.each(['google', 'apple', 'facebook'] as const)(
    'retains existing %s subject owner and profile when claims are changed or missing',
    async (provider) => {
      const user = await seed();
      const subject = await link(user.id, provider);
      const command = await intent(provider);
      const result = await outcome(
        await request('/compound', {
          ...command,
          subject,
          name: 'Changed claim',
          image: 'https://changed.example.test/new.png',
        }),
      );
      expect(result.createdUser).toBe(false);
      expect(result.user).toMatchObject({
        id: user.id,
        email: user.email,
        name: 'Original profile',
        image: 'https://images.example.test/original.png',
        emailVerified: '2024-01-02T03:04:05.000Z',
      });
      expect(await db.select().from(users)).toHaveLength(1);
    },
  );
  it('keeps a known linked collision member eligible without choosing the ambiguous email owner', async () => {
    const user = await seed();
    const sibling = randomUUID();
    await db.insert(users).values({ id: sibling, email: user.email.toUpperCase() });
    await db
      .insert(authEmailReservationMembers)
      .values({ normalizedEmail: normalizeAccountEmail(user.email), userId: sibling });
    await db
      .update(authEmailReservations)
      .set({ state: 'blocked_ambiguous', ownerUserId: null })
      .where(eq(authEmailReservations.normalizedEmail, normalizeAccountEmail(user.email)));
    const subject = await link(user.id);
    const result = await outcome(await compound(await intent(), subject));
    expect(result.user.id).toBe(user.id);
    expect(await db.select().from(users)).toHaveLength(2);
  });
  it('denies occupied key creation without email auto-linking or a new active source', async () => {
    const owner = await seed();
    const command = await intent();
    expect((await compound(command, randomUUID(), owner.email.toUpperCase())).status).toBe(409);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(accounts)).toHaveLength(0);
    expect(await countSources()).toBe(0);
  });
  it('admits one of two concurrent verified subjects using the same original flow', async () => {
    const command = await intent();
    const responses = await Promise.all([compound(command), compound({ ...command, attemptId: randomUUID() })]);
    expect(responses.map((response) => response.status).sort((first, second) => first - second)).toEqual([200, 409]);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await countSources()).toBe(1);
  });
  it('serializes the same subject across different flows/emails without creating two UIDs', async () => {
    const subject = randomUUID();
    const first = await intent();
    const second = await intent();
    const [one, two] = await Promise.all([compound(first, subject), compound(second, subject)]);
    const results = await Promise.all([outcome(one), outcome(two)]);
    expect(new Set(results.map((result) => result.user.id)).size).toBe(1);
    expect(results.filter((result) => result.createdUser)).toHaveLength(1);
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await countSources()).toBe(2);
  });
  it('binds initiation to exact source SID, rejecting a same-user different device without burning the original flow', async () => {
    const user = await seed();
    const subject = await link(user.id);
    const actor = await service!.issueSource(user.id);
    const other = await service!.issueSource(user.id);
    const command = await intent('google', actor.cookie);
    expect((await compound({ ...command, actorCookie: other.cookie }, subject)).status).toBe(403);
    expect(await terminal(command.flow)).toHaveLength(0);
    const result = await outcome(await compound(command, subject));
    expect(result.user.id).toBe(user.id);
    expect(await countSources()).toBe(3);
  });
  it('never treats missing callback cookie as anonymous actor initiation', async () => {
    const user = await seed();
    const subject = await link(user.id);
    const actor = await service!.issueSource(user.id);
    const command = await intent('google', actor.cookie);
    expect((await compound({ ...command, actorCookie: null }, subject)).status).toBe(403);
    expect(await countSources()).toBe(1);
    expect(await terminal(command.flow)).toHaveLength(0);
  });
  it('preserves explicit anonymous initiation and does not accept a later signed-in actor', async () => {
    const user = await seed();
    const subject = await link(user.id);
    const actor = await service!.issueSource(user.id);
    const command = await intent();
    expect((await compound({ ...command, actorCookie: actor.cookie }, subject)).status).toBe(403);
    expect(await countSources()).toBe(1);
  });
  it('does not use an authenticated actor to implicitly link an unknown subject', async () => {
    const user = await seed();
    const actor = await service!.issueSource(user.id);
    const command = await intent('google', actor.cookie);
    expect((await compound(command)).status).toBe(403);
    expect(await db.select().from(accounts)).toHaveLength(0);
    expect(await db.select().from(users)).toHaveLength(1);
  });
  it('rejects a linked subject owned by a different initiating actor', async () => {
    const first = await seed();
    const second = await seed();
    const actor = await service!.issueSource(first.id);
    const subject = await link(second.id);
    expect((await compound(await intent('google', actor.cookie), subject)).status).toBe(403);
    expect(await countSources()).toBe(1);
  });
  it('rejects reset generation and raw owner deletion after a valid intent', async () => {
    const first = await seed();
    const subject = await link(first.id);
    const actor = await service!.issueSource(first.id);
    const command = await intent('google', actor.cookie);
    await db.transaction((transaction) =>
      recordSecurityMutation(transaction, {
        ...authority,
        operationId: randomUUID(),
        userId: first.id,
        expectedGeneration: 0,
        kind: 'password-reset',
        domains: ['first-party', 'partner'],
      }),
    );
    expect((await compound(command, subject)).status).toBe(403);
    expect((await request('/validate', { actorCookie: actor.cookie })).status).toBe(403);
    const second = await seed();
    const another = await service!.issueSource(second.id);
    const anotherCommand = await intent('google', another.cookie);
    await db.delete(users).where(eq(users.id, second.id));
    expect((await compound(anotherCommand)).status).toBe(403);
    expect(await terminal(anotherCommand.flow)).toHaveLength(0);
  });
  it('preserves unknown/historical authentication age independently of fresh JWE issue time', async () => {
    const user = await seed();
    const historical = Date.now() - 8 * 86400000;
    const actor = await service!.issueSource(user.id, historical);
    const validated = await request('/validate', { actorCookie: actor.cookie });
    expect(((await validated.json()) as { originalAuthenticatedAt: number }).originalAuthenticatedAt).toBe(historical);
    const unknown = await service!.issueSource(user.id);
    expect(
      (
        (await (await request('/validate', { actorCookie: unknown.cookie })).json()) as {
          originalAuthenticatedAt: null;
        }
      ).originalAuthenticatedAt,
    ).toBeNull();
    await expect(service!.issueSource(user.id, Date.now() + 86400000)).rejects.toThrow(
      'Synthetic compound admission denied',
    );
  });
  it('rejects signed-cookie identity/SID mismatch and a genuinely expired NextAuth JWE', async () => {
    const result = await outcome(await compound(await intent()));
    for (const token of [
      { sub: randomUUID(), authSessionId: result.sourceSid, sourceProof: result.sourceProof },
      { sub: result.user.id, authSessionId: randomUUID(), sourceProof: result.sourceProof },
    ]) {
      const forged = await jwt.encode({ secret: signingKey, token, maxAge: 3600 });
      expect((await request('/validate', { actorCookie: forged })).status).toBe(403);
    }
    expect((await request('/validate', { actorCookie: await cookie(result, -120) })).status).toBe(403);
  });
  it('pre-aborts only one attempt of a valid existing intent while another attempt remains eligible', async () => {
    const command = await intent();
    expect((await request('/abort', command)).status).toBe(200);
    expect((await compound(command)).status).toBe(409);
    expect(await countSources()).toBe(0);
    expect(await db.select().from(users)).toHaveLength(0);
    const markerId = `ba03-flow:app-router-aborted:${command.flow}:${command.attemptId}`;
    const marker = await db.select().from(verificationTokens).where(eq(verificationTokens.identifier, markerId));
    expect(marker).toHaveLength(1);
    expect(await terminal(command.flow)).toHaveLength(0);
    await db.delete(verificationTokens).where(sql`${verificationTokens.expires} <= clock_timestamp()`);
    expect(await db.select().from(verificationTokens).where(eq(verificationTokens.identifier, markerId))).toEqual(
      marker,
    );
    expect((await compound({ ...command, attemptId: randomUUID() })).status).toBe(200);
    expect((await compound(command)).status).toBe(409);
    const missing = { ...command, flow: flow() };
    expect((await request('/abort', missing)).status).toBe(403);
    expect(await terminal(missing.flow)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(verificationTokens)
        .where(eq(verificationTokens.identifier, `ba03-flow:app-router-aborted:${missing.flow}:${missing.attemptId}`)),
    ).toHaveLength(0);
  });
  it('keeps A active after B discards its definitive 409 then sends an uncertain-completion abort', async () => {
    const commandA = await intent();
    const winner = await outcome(await compound(commandA));
    const commandB = { ...commandA, attemptId: randomUUID() };
    const loser = await compound(commandB);
    expect(loser.status).toBe(409);
    await loser.body?.cancel();
    const originalRows = await db.select().from(sessions);
    expect(originalRows).toHaveLength(1);
    expect(originalRows[0].sessionToken).toBe(`ba03-lineage:app-router:${hash(winner.sourceProof)}`);
    expect((await request('/abort', commandB)).status).toBe(200);
    expect(await countSources()).toBe(1);
    expect(await db.select().from(sessions)).toEqual(originalRows);
    const validated = await request('/validate', { actorCookie: await cookie(winner) });
    expect(validated.status).toBe(200);
    expect(await validated.json()).toMatchObject({
      userId: winner.user.id,
      sourceSid: winner.sourceSid,
      generation: winner.generation,
    });
    expect((await request('/abort', commandA)).status).toBe(200);
    expect(await countSources()).toBe(0);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await terminal(commandA.flow)).toHaveLength(1);
  });
  it('serializes preabort B against compound A without canceling A or reopening B', async () => {
    const commandA = await intent();
    const commandB = { ...commandA, attemptId: randomUUID() };
    const [winner, canceled] = await Promise.all([compound(commandA), request('/abort', commandB)]);
    expect(winner.status).toBe(200);
    expect(canceled.status).toBe(200);
    expect(await countSources()).toBe(1);
    expect((await compound(commandB)).status).toBe(409);
    expect((await request('/validate', { actorCookie: await cookie(await outcome(winner)) })).status).toBe(200);
  });
  it('flow-aborts a committed outcome without reading its proof and preserves identity/tombstone', async () => {
    const command = await intent();
    const committed = await compound(command);
    expect(committed.status).toBe(200);
    await committed.body?.cancel();
    expect(await countSources()).toBe(1);
    expect((await request('/abort', command)).status).toBe(200);
    expect(await countSources()).toBe(0);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await terminal(command.flow)).toHaveLength(1);
    expect((await compound(command)).status).toBe(409);
  });
  it('repeats an acknowledged or discarded-body abort without touching a newer issuance', async () => {
    const firstCommand = await intent();
    const first = await outcome(await compound(firstCommand));
    const secondCommand = await intent();
    const second = await outcome(
      await compound(secondCommand, (await db.select().from(accounts))[0].providerAccountId),
    );
    const aborted = await request('/abort', firstCommand);
    expect(aborted.status).toBe(200);
    await aborted.body?.cancel();
    expect((await request('/abort', firstCommand)).status).toBe(200);
    expect(await countSources()).toBe(1);
    expect((await request('/validate', { actorCookie: await cookie(second) })).status).toBe(200);
    expect((await request('/validate', { actorCookie: await cookie(first) })).status).toBe(403);
  });
  it('wrong or same-user different actor cannot flow-abort another exact issuance', async () => {
    const user = await seed();
    const subject = await link(user.id);
    const actor = await service!.issueSource(user.id);
    const sibling = await service!.issueSource(user.id);
    const command = await intent('google', actor.cookie);
    const result = await outcome(await compound(command, subject));
    expect((await request('/abort', { ...command, actorCookie: sibling.cookie })).status).toBe(403);
    expect((await request('/abort', { ...command, actorCookie: null })).status).toBe(403);
    expect((await request('/validate', { actorCookie: await cookie(result) })).status).toBe(200);
    expect((await request('/abort', { sourceProof: result.sourceProof })).status).toBe(200);
    expect(await countSources()).toBe(2);
    expect((await request('/validate', { actorCookie: sibling.cookie })).status).toBe(200);
  });
  it('allows only the originally captured expired JWE to abort its exact flow as negative authority', async () => {
    const user = await seed();
    const subject = await link(user.id);
    const actor = await service!.issueSource(user.id);
    // Real public decoder allows 15 seconds of expiry tolerance. Enter while
    // still within that policy, then cross it without faking DB/app clocks.
    const short = await jwt.encode({
      secret: signingKey,
      token: { sub: user.id, authSessionId: actor.sourceSid, sourceProof: actor.sourceProof },
      maxAge: -10,
    });
    const command = await intent('google', short);
    const committed = await compound(command, subject);
    expect(committed.status).toBe(200);
    await committed.body?.cancel();
    const newer = await service!.issueSource(user.id);
    await new Promise((resolve) => setTimeout(resolve, 6500));
    expect((await request('/validate', { actorCookie: short })).status).toBe(403);
    expect((await request('/intent', { provider: 'google', flow: flow(), actorCookie: short })).status).toBe(403);
    expect((await request('/abort', { ...command, actorCookie: newer.cookie })).status).toBe(403);
    expect((await request('/abort', command)).status).toBe(200);
    expect(await countSources()).toBe(2);
    expect((await request('/validate', { actorCookie: newer.cookie })).status).toBe(200);
    expect((await request('/abort', command)).status).toBe(200);
  });
  it('denies retargeted sealed initiation metadata before minting or aborting a source', async () => {
    const user = await seed();
    const subject = await link(user.id);
    const actor = await service!.issueSource(user.id);
    const newer = await service!.issueSource(user.id);
    const command = await intent('google', actor.cookie);
    const identifier = `ba03-flow:app-router-intent:${command.flow}`;
    const [stored] = await db.select().from(verificationTokens).where(eq(verificationTokens.identifier, identifier));
    const binding = JSON.parse(stored.token) as { actor: { sid: string }; actorCookieHash: string };
    binding.actor.sid = newer.sourceSid;
    binding.actorCookieHash = hash(newer.cookie);
    await db
      .update(verificationTokens)
      .set({ token: JSON.stringify(binding) })
      .where(eq(verificationTokens.identifier, identifier));
    expect((await compound({ ...command, actorCookie: newer.cookie }, subject)).status).toBe(503);
    expect((await request('/abort', { ...command, actorCookie: newer.cookie })).status).toBe(503);
    expect(await countSources()).toBe(2);
    expect(await terminal(command.flow)).toHaveLength(0);
  });
  it('rejects rewritten flow/intent metadata rather than retargeting a newer source', async () => {
    const command = await intent();
    const first = await outcome(await compound(command));
    const second = await service!.issueSource(first.user.id);
    const [stored] = await terminal(command.flow);
    const receipt = JSON.parse(stored.token) as { issuance: { sourceHash: string; userId: string; sid: string } };
    receipt.issuance = { sourceHash: hash(second.sourceProof), userId: first.user.id, sid: second.sourceSid };
    await db
      .update(verificationTokens)
      .set({ token: JSON.stringify(receipt) })
      .where(and(eq(verificationTokens.identifier, stored.identifier), eq(verificationTokens.token, stored.token)));
    expect((await request('/abort', command)).status).toBe(503);
    expect((await request('/validate', { actorCookie: second.cookie })).status).toBe(200);
    expect(await countSources()).toBe(2);
  });
  it('rejects edited generation/deadline lineage even when current cutoff/session metadata agrees', async () => {
    const user = await seed();
    const actor = await service!.issueSource(user.id);
    const identifier = `ba03-lineage:app-router:${hash(actor.sourceProof)}`;
    const [stored] = await db.select().from(verificationTokens).where(eq(verificationTokens.identifier, identifier));
    const receipt = JSON.parse(stored.token) as { generation: number; expires: number };
    receipt.generation = 1;
    receipt.expires += 1000;
    await db
      .update(verificationTokens)
      .set({ token: JSON.stringify(receipt), expires: new Date(receipt.expires) })
      .where(eq(verificationTokens.identifier, identifier));
    await db
      .update(sessions)
      .set({ expires: new Date(receipt.expires) })
      .where(eq(sessions.sessionToken, identifier));
    await db
      .insert(authSubjectCutoffs)
      .values({ userId: user.id, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
    expect((await request('/validate', { actorCookie: actor.cookie })).status).toBe(403);
  });
  it('reports missing historical intent evidence as unavailable without deleting its known flow issuance', async () => {
    const command = await intent();
    const result = await outcome(await compound(command));
    const [stored] = await db
      .select()
      .from(verificationTokens)
      .where(eq(verificationTokens.identifier, `ba03-flow:app-router-intent:${command.flow}`));
    const binding = JSON.parse(stored.token) as { expires: number };
    expect(stored.expires.getTime() - binding.expires).toBe(3600000);
    await db.delete(verificationTokens).where(eq(verificationTokens.identifier, stored.identifier));
    expect((await request('/abort', command)).status).toBe(503);
    expect(await countSources()).toBe(1);
    expect((await request('/validate', { actorCookie: await cookie(result) })).status).toBe(200);
  });
  it('rolls reservation/user/profile/link/source/flow back on real profile CHECK failure, leaving valid intent retryable', async () => {
    const command = await intent();
    const constraint = 'owned_router_profile_failure';
    await admin(
      sql`ALTER TABLE ${userProfiles} ADD CONSTRAINT ${sql.identifier(constraint)} CHECK(display_name IS NULL)`,
    );
    try {
      expect((await compound(command)).status).toBe(503);
      expect(service!.facts.databaseFailure).toEqual({ code: '23514', constraint });
      expect(await db.select().from(users)).toHaveLength(0);
      expect(await db.select().from(authEmailReservations)).toHaveLength(0);
      expect(await db.select().from(accounts)).toHaveLength(0);
      expect(await countSources()).toBe(0);
      expect(await terminal(command.flow)).toHaveLength(0);
    } finally {
      await admin(sql`ALTER TABLE ${userProfiles} DROP CONSTRAINT ${sql.identifier(constraint)}`);
    }
    expect((await compound(command)).status).toBe(200);
  });
  it('requires authenticated strict transport and rejects body-selected owner or source fields', async () => {
    const command = await intent();
    expect(
      (
        await request('/compound', {
          ...command,
          subject: randomUUID(),
          email: 'free@example.test',
          userId: randomUUID(),
        })
      ).status,
    ).toBe(400);
    expect(
      (await request('/intent', { provider: 'google', flow: flow(), actorCookie: null }, 'incorrect-private-secret'))
        .status,
    ).toBe(401);
    expect((await request('/abort', { sourceProof: 'arbitrary', flow: command.flow })).status).toBe(400);
    expect(await countSources()).toBe(0);
    expect(await db.select().from(users)).toHaveLength(0);
  });
});
