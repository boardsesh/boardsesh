import { randomUUID } from 'node:crypto';
import { compare } from 'bcryptjs';
import { eq, sql, type SQL } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  accounts,
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  sessions,
  userCredentials,
  userProfiles,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { db } from '../../../db/client';
import { prepareProjectionUnderUsersTableLock } from '../email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION, type ExpectedCurrentStoreAuthority } from '../foundation-context';
import { startLocalOidcFixture, type LocalOidcIdentity } from './fixtures/local-oidc';
import { ProofBrowser, startNextAuthPublicHandlerProof, type ProofControls } from './fixtures/nextauth-public-handler';

const roleSalt = randomUUID().replaceAll('-', '');
const legacyRole = `ba03_web_legacy_${roleSalt}`;
const writerRole = `ba03_web_writer_${roleSalt}`;
const trackedRoles: string[] = [];
const originalTrustHost = process.env.AUTH_TRUST_HOST;
const originalNextAuthUrl = process.env.NEXTAUTH_URL;

async function boundedAdmin(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout = '4000ms'`);
    return transaction.execute(statement);
  });
}

describe('unmounted public NextAuth4 callback with atomic backend compound identity', () => {
  let authority: ExpectedCurrentStoreAuthority;
  const resources: { close(): Promise<void> }[] = [];
  beforeAll(async () => {
    // Public NextAuth host detection, confined to this test worker. The fixture
    // overwrites forwarded headers with its own bound loopback listener.
    delete process.env.NEXTAUTH_URL;
    process.env.AUTH_TRUST_HOST = '1';
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      await transaction.execute(sql`SET LOCAL lock_timeout = '4000ms'`);
      await transaction.execute(sql`CREATE ROLE ${sql.identifier(legacyRole)} NOLOGIN`);
      trackedRoles.push(legacyRole);
      await transaction.execute(sql`CREATE ROLE ${sql.identifier(writerRole)} NOLOGIN`);
      trackedRoles.push(writerRole);
    });
  });
  beforeEach(async () => {
    const closing = await Promise.allSettled(resources.splice(0).map((resource) => resource.close()));
    if (closing.some((result) => result.status === 'rejected')) throw new Error('Owned proof cleanup failed');
    await db.delete(verificationTokens);
    await db.delete(sessions);
    await db.delete(authEmailReservationMembers);
    await db.delete(authEmailReservations);
    await db.delete(authSecurityMutationEvents);
    await db.delete(authSubjectCutoffs);
    await db.delete(authEmailProjection);
    await db.delete(users);
    const projectionId = randomUUID();
    authority = {
      expectedProjectionId: projectionId,
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      expectedWriterEpoch: 1,
    };
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      await transaction.execute(sql`SET LOCAL lock_timeout = '4000ms'`);
      // A real test-only operator transfer, not an assertion that an enforced
      // marker by itself proves a database or legacy issuer fence.
      await transaction.execute(
        sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(legacyRole)}, ${sql.identifier(writerRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${users}, ${accounts}, ${userCredentials}, ${userProfiles} TO ${sql.identifier(legacyRole)}`,
      );
      await transaction.execute(
        sql`LOCK TABLE ${users}, ${accounts}, ${userCredentials}, ${userProfiles} IN ACCESS EXCLUSIVE MODE`,
      );
      await transaction.execute(
        sql`REVOKE ALL PRIVILEGES ON TABLE ${users}, ${accounts}, ${userCredentials}, ${userProfiles} FROM ${sql.identifier(legacyRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${users}, ${accounts}, ${userCredentials}, ${userProfiles}, ${sessions}, ${verificationTokens}, ${authEmailProjection}, ${authEmailReservations}, ${authEmailReservationMembers}, ${authSubjectCutoffs} TO ${sql.identifier(writerRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT ON TABLE ${authSecurityMutationEvents} TO ${sql.identifier(writerRole)}`,
      );
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
  });
  afterAll(async () => {
    const failures: Error[] = [];
    const closing = await Promise.allSettled(resources.splice(0).map((resource) => resource.close()));
    if (closing.some((result) => result.status === 'rejected')) failures.push(new Error('Owned HTTP cleanup failed'));
    for (const role of trackedRoles) {
      try {
        const existing = await boundedAdmin(
          sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS present`,
        );
        if (existing[0]?.present === false) continue;
      } catch {
        failures.push(new Error('Owned role cleanup catalog lookup failed'));
      }
      try {
        await boundedAdmin(
          sql`REVOKE ALL PRIVILEGES ON TABLE ${users}, ${accounts}, ${userCredentials}, ${userProfiles}, ${sessions}, ${verificationTokens}, ${authEmailProjection}, ${authEmailReservations}, ${authEmailReservationMembers}, ${authSubjectCutoffs}, ${authSecurityMutationEvents} FROM ${sql.identifier(role)}`,
        );
      } catch {
        failures.push(new Error('Owned table grant cleanup failed'));
      }
      try {
        await boundedAdmin(sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned schema grant cleanup failed'));
      }
      try {
        await boundedAdmin(sql`DROP ROLE IF EXISTS ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned role cleanup failed'));
      }
    }
    if (originalTrustHost === undefined) delete process.env.AUTH_TRUST_HOST;
    else process.env.AUTH_TRUST_HOST = originalTrustHost;
    if (originalNextAuthUrl === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = originalNextAuthUrl;
    if (failures.length) throw new AggregateError(failures, 'Owned public-handler fixture cleanup failed');
  });

  async function fixture(
    controls: ProofControls = {},
    existingOidc?: Awaited<ReturnType<typeof startLocalOidcFixture>>,
  ) {
    const oidc = existingOidc ?? (await startLocalOidcFixture());
    if (!existingOidc) resources.push(oidc);
    const proof = await startNextAuthPublicHandlerProof({ oidc, authority, writerRole, controls });
    resources.push(proof);
    return { oidc, proof, browser: new ProofBrowser(proof.origin) };
  }
  function identity(subject = randomUUID()): LocalOidcIdentity {
    return { subject, email: `${subject}@example.test`, emailVerified: true, name: 'Synthetic Climber' };
  }
  async function signIn(current: Awaited<ReturnType<typeof fixture>>, profile = identity()) {
    const authorization = await current.browser.start();
    const callback = await current.oidc.authorize(authorization, profile);
    const destination = callback.headers.get('location');
    if (!destination) throw new Error('No synthetic callback');
    const response = await current.browser.request(destination);
    return { response, authorization, destination, profile };
  }
  async function token(browser: ProofBrowser, proof: Awaited<ReturnType<typeof startNextAuthPublicHandlerProof>>) {
    const cookie = browser
      .sessionHeader()
      .split('; ')
      .map((entry) => entry.slice(entry.indexOf('=') + 1))
      .join('');
    return proof.decodeCookie(decodeURIComponent(cookie));
  }

  it('uses the public provider handler and creates user/profile/link atomically before the read-only adapter sees it', async () => {
    const current = await fixture();
    const result = await signIn(current);
    expect(result.response.status).toBe(302);
    expect(result.response.headers.get('location')).toBe(`${current.proof.origin}/signed-in`);
    const [user] = await db.select().from(users);
    expect(await db.select({ userId: userProfiles.userId }).from(userProfiles)).toEqual([{ userId: user.id }]);
    expect(await db.select({ userId: accounts.userId, subject: accounts.providerAccountId }).from(accounts)).toEqual([
      { userId: user.id, subject: result.profile.subject },
    ]);
    expect(user.emailVerified).toBeNull();
    expect(current.proof.observations.stockIsNewUser).toEqual([false]);
    expect(current.proof.observations.mutationsDenied).toEqual([]);
    expect(current.proof.observations.hookUsers).toEqual([result.profile.subject]);
    expect(await token(current.browser, current.proof)).toMatchObject({
      sub: user.id,
      accountCreated: true,
      originalAuthenticatedAt: null,
    });
    expect((await current.proof.protected(current.browser.sessionHeader())).status).toBe(200);
    expect(current.oidc.requests()).toEqual(
      expect.arrayContaining([
        { method: 'GET', path: '/.well-known/openid-configuration' },
        { method: 'POST', path: '/token' },
        { method: 'GET', path: '/jwks' },
      ]),
    );
    await expect(
      db.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL ROLE ${sql.identifier(legacyRole)}`);
        await transaction.insert(users).values({ id: randomUUID(), email: 'denied@example.test' });
      }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('retains the linked owner, canonical email and verification despite changed provider claims', async () => {
    const current = await fixture();
    const first = await signIn(current);
    const [owner] = await db.select().from(users);
    const verifiedAt = new Date('2025-01-02T03:04:05.000Z');
    await db.update(users).set({ emailVerified: verifiedAt }).where(eq(users.id, owner.id));
    const second = await signIn(current, {
      ...first.profile,
      email: 'provider-change@example.test',
      emailVerified: false,
    });
    expect(second.response.status).toBe(302);
    expect(await token(current.browser, current.proof)).toMatchObject({ sub: owner.id, accountCreated: false });
    expect(await db.select({ id: users.id, email: users.email, verified: users.emailVerified }).from(users)).toEqual([
      { id: owner.id, email: first.profile.email, verified: verifiedAt },
    ]);
    expect(current.proof.observations.hookUsers).toEqual([first.profile.subject, owner.id]);
    expect(current.proof.observations.mutationsDenied).toEqual([]);
    await signIn(current, { ...first.profile, email: undefined, emailVerified: undefined });
    expect(await token(current.browser, current.proof)).toMatchObject({ sub: owner.id, accountCreated: false });
    expect((await current.proof.protected(current.browser.sessionHeader())).status).toBe(200);
  });

  it('rejects email takeover by an unlinked provider without changing identity or creating a receipt', async () => {
    const current = await fixture();
    const first = await signIn(current);
    const another = new ProofBrowser(current.proof.origin);
    current.browser = another;
    const result = await signIn(current, { ...identity(), email: first.profile.email?.toUpperCase() });
    expect(result.response.headers.get('location')).toContain('AccessDenied');
    expect(another.sessionHeader()).toBe('');
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await db.select().from(sessions)).toHaveLength(1);
  });

  it('rejects a different current-cookie owner before creating an account or consuming the callback flow', async () => {
    const current = await fixture();
    await signIn(current);
    const originalCookie = current.browser.sessionHeader();
    const result = await signIn(current);
    expect(result.response.headers.get('location')).toContain('AccessDenied');
    expect(current.browser.sessionHeader()).toBe(originalCookie);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await db.select().from(verificationTokens)).toHaveLength(1);
    expect((await current.proof.protected(originalCookie)).status).toBe(200);
  });

  it('rejects an already-linked other subject without reassigning either known owner or consuming a new issuance', async () => {
    const current = await fixture();
    await signIn(current);
    const firstBrowser = current.browser;
    const firstCookie = firstBrowser.sessionHeader();
    current.browser = new ProofBrowser(current.proof.origin);
    const second = await signIn(current);
    const secondCookie = current.browser.sessionHeader();
    const before = await db.select().from(accounts).orderBy(accounts.userId);
    current.browser = firstBrowser;
    expect((await signIn(current, second.profile)).response.headers.get('location')).toContain('AccessDenied');
    expect(await db.select().from(accounts).orderBy(accounts.userId)).toEqual(before);
    expect(await db.select().from(users)).toHaveLength(2);
    expect(await db.select().from(sessions)).toHaveLength(2);
    expect(await db.select().from(verificationTokens)).toHaveLength(2);
    expect((await current.proof.protected(firstCookie)).status).toBe(200);
    expect((await current.proof.protected(secondCookie)).status).toBe(200);
  });

  it('keeps simultaneous users and creation outcomes request-local on one public HTTP listener', async () => {
    const current = await fixture();
    const second = new ProofBrowser(current.proof.origin);
    const profiles = [identity(), identity()];
    const starts = await Promise.all([current.browser.start(), second.start()]);
    const redirects = await Promise.all(starts.map((start, index) => current.oidc.authorize(start, profiles[index])));
    const responses = await Promise.all([
      current.browser.request(redirects[0].headers.get('location')!),
      second.request(redirects[1].headers.get('location')!),
    ]);
    expect(responses.map((response) => response.status)).toEqual([302, 302]);
    const tokens = await Promise.all([token(current.browser, current.proof), token(second, current.proof)]);
    expect(tokens.map((decoded) => decoded?.email)).toEqual(profiles.map((profile) => profile.email));
    expect(new Set(tokens.map((decoded) => decoded?.sub)).size).toBe(2);
    expect(tokens.map((decoded) => decoded?.accountCreated)).toEqual([true, true]);
    expect((await current.proof.protected(current.browser.sessionHeader())).status).toBe(200);
    expect((await current.proof.protected(second.sessionHeader())).status).toBe(200);
  });

  it('consumes one verified state flow once even with two independently valid provider codes and public callbacks', async () => {
    const current = await fixture();
    const authorization = await current.browser.start();
    const second = new ProofBrowser(current.proof.origin);
    for (const [name, cookie] of current.browser.cookies) second.cookies.set(name, cookie);
    const redirects = await Promise.all([
      current.oidc.authorize(authorization, identity()),
      current.oidc.authorize(authorization, identity()),
    ]);
    await Promise.all([
      current.browser.request(redirects[0].headers.get('location')!),
      second.request(redirects[1].headers.get('location')!),
    ]);
    expect(current.oidc.stats().redeemedCodes).toBe(2);
    expect(current.proof.observations.compoundCalls).toBe(2);
    expect([current.browser, second].filter((browser) => browser.sessionHeader())).toHaveLength(1);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(sessions)).toHaveLength(1);
    expect(await db.select().from(verificationTokens)).toHaveLength(1);
  });

  it('keeps a consumed flow closed after user deletion removes its session receipt', async () => {
    const current = await fixture();
    const authorization = await current.browser.start();
    const second = new ProofBrowser(current.proof.origin);
    for (const [name, cookie] of current.browser.cookies) second.cookies.set(name, cookie);
    const firstCallback = await current.oidc.authorize(authorization, identity());
    const secondCallback = await current.oidc.authorize(authorization, identity());
    await current.browser.request(firstCallback.headers.get('location')!);
    const [owner] = await db.select().from(users);
    await current.proof.reset(owner.id, true);
    expect(await db.select().from(sessions)).toEqual([]);
    expect(await db.select().from(verificationTokens)).toHaveLength(1);
    await second.request(secondCallback.headers.get('location')!);
    expect(current.oidc.stats().redeemedCodes).toBe(2);
    expect(second.sessionHeader()).toBe('');
    expect(await db.select().from(users)).toEqual([]);
    expect(await db.select().from(accounts)).toEqual([]);
  });

  it('keeps new-user versus existing-user creation receipts independent during simultaneous callbacks', async () => {
    const current = await fixture();
    const original = await signIn(current);
    const [owner] = await db.select().from(users);
    const existingBrowser = new ProofBrowser(current.proof.origin);
    const newBrowser = new ProofBrowser(current.proof.origin);
    const starts = await Promise.all([existingBrowser.start(), newBrowser.start()]);
    const callbacks = await Promise.all([
      current.oidc.authorize(starts[0], original.profile),
      current.oidc.authorize(starts[1], identity()),
    ]);
    await Promise.all([
      existingBrowser.request(callbacks[0].headers.get('location')!),
      newBrowser.request(callbacks[1].headers.get('location')!),
    ]);
    expect(await token(existingBrowser, current.proof)).toMatchObject({ sub: owner.id, accountCreated: false });
    const createdToken = await token(newBrowser, current.proof);
    expect(createdToken).toMatchObject({ accountCreated: true });
    expect(createdToken?.sub).not.toBe(owner.id);
    expect(current.proof.observations.stockIsNewUser).toEqual([false, false, false]);
  });

  it.each([{ cancel: true }, { wrongNonce: true }, { rejectToken: true }])(
    'rejects provider failure before the compound identity hook: %j',
    async (controls) => {
      const current = await fixture();
      const start = await current.browser.start();
      const callback = await current.oidc.authorize(start, identity(), controls);
      await current.browser.request(callback.headers.get('location')!);
      expect(current.proof.observations.compoundCalls).toBe(0);
      expect(current.browser.sessionHeader()).toBe('');
      expect(await db.select().from(users)).toEqual([]);
      expect(await db.select().from(verificationTokens)).toEqual([]);
    },
  );

  it('rolls back identity, profile, provider, reservation and both receipts together on a real compound fault', async () => {
    const current = await fixture({ failBeforeCommit: true });
    await signIn(current);
    expect(current.browser.sessionHeader()).toBe('');
    for (const table of [
      users,
      userProfiles,
      accounts,
      sessions,
      verificationTokens,
      authEmailReservations,
      authEmailReservationMembers,
    ])
      expect(await db.select().from(table)).toEqual([]);
    expect(current.proof.observations.compoundCalls).toBe(1);
  });

  it('publishes no cookie after a lost committed RPC reply and leaves a retryable identity', async () => {
    const current = await fixture({ loseReply: true });
    const result = await signIn(current);
    expect(current.browser.sessionHeader()).toBe('');
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await db.select().from(verificationTokens)).toHaveLength(1);
    const retry = await fixture({}, current.oidc);
    const retried = await signIn(retry, result.profile);
    expect(retried.response.status).toBe(302);
    expect(await token(retry.browser, retry.proof)).toMatchObject({ accountCreated: false });
    expect((await retry.proof.protected(retry.browser.sessionHeader())).status).toBe(200);
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it('revokes only the exact issuance on encode failure while retaining consumed flow and identity', async () => {
    const current = await fixture({ failEncode: true });
    expect((await signIn(current)).response.status).toBe(503);
    expect(current.browser.sessionHeader()).toBe('');
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await db.select().from(sessions)).toEqual([]);
    expect(await db.select().from(verificationTokens)).toHaveLength(1);
  });

  it('does not revoke a previously issued sibling session when a later encode fails', async () => {
    const current = await fixture();
    const first = await signIn(current);
    const originalCookie = current.browser.sessionHeader();
    const failing = await fixture({ failEncode: true }, current.oidc);
    await signIn(failing, first.profile);
    expect(failing.browser.sessionHeader()).toBe('');
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(sessions)).toHaveLength(1);
    expect(await db.select().from(verificationTokens)).toHaveLength(2);
    expect((await current.proof.protected(originalCookie)).status).toBe(200);
  });

  it('revokes issuance when an awaited pre-encode hook throws inside the public handler', async () => {
    const current = await fixture({
      beforeEncode: async () => {
        throw new Error('Injected awaited encode barrier failure');
      },
    });
    expect((await signIn(current)).response.status).toBe(503);
    expect(current.proof.observations.logCodes).toContain('OAUTH_CALLBACK_HANDLER_ERROR');
    expect(current.browser.sessionHeader()).toBe('');
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(sessions)).toEqual([]);
    expect(await db.select().from(verificationTokens)).toHaveLength(1);
  });

  it('characterizes stock swallowed late-event failure: a successful redirect and usable cookie remain', async () => {
    const current = await fixture({ failLateEvent: true, stockLateEventFailure: true });
    const result = await signIn(current);
    expect(result.response.status).toBe(302);
    expect(result.response.headers.get('location')).toBe(`${current.proof.origin}/signed-in`);
    expect(current.proof.observations.eventFailures).toBe(1);
    expect(current.proof.observations.logCodes).toContain('SIGN_IN_EVENT_ERROR');
    expect(current.browser.sessionHeader()).not.toBe('');
    expect((await current.proof.protected(current.browser.sessionHeader())).status).toBe(200);
  });

  it('blocks publication and revokes the captured cookie after observed late-event failure', async () => {
    const current = await fixture({ failLateEvent: true });
    expect((await signIn(current)).response.status).toBe(503);
    expect(current.browser.sessionHeader()).toBe('');
    const cookie = current.proof.observations.bufferedSessionCookies.map((line) => line.split(';')[0]).join('; ');
    expect(cookie).toContain('next-auth.session-token');
    expect((await current.proof.protected(cookie)).status).toBe(401);
    expect(await db.select().from(sessions)).toEqual([]);
    expect(await db.select().from(verificationTokens)).toHaveLength(1);
  });

  it.each([false, true])(
    'denies a cryptographically valid new cookie when %s deletion occurs after backend commit before encode',
    async (deletion) => {
      let current: Awaited<ReturnType<typeof fixture>>;
      current = await fixture({
        beforeEncode: async (outcome) => {
          await current.proof.reset(outcome.user.id, deletion);
        },
      });
      const result = await signIn(current);
      expect(result.response.status).toBe(302);
      expect(await token(current.browser, current.proof)).toMatchObject({ accountCreated: true });
      expect((await current.proof.protected(current.browser.sessionHeader())).status).toBe(401);
      expect(await db.select().from(authSecurityMutationEvents)).toHaveLength(1);
      const [cutoff] = await db.select().from(authSubjectCutoffs);
      expect(cutoff.generation).toBe(1);
      expect(await db.select().from(verificationTokens)).toHaveLength(1);
      if (deletion) expect(await db.select().from(sessions)).toEqual([]);
      else {
        const [credential] = await db.select().from(userCredentials);
        expect(await compare('proof-reset-replacement-password', credential.passwordHash)).toBe(true);
      }
    },
  );

  it('accepts a fresh verified flow after reset while retaining rejection of the old encoded source', async () => {
    let current: Awaited<ReturnType<typeof fixture>>;
    let shouldReset = true;
    current = await fixture({
      beforeEncode: async (outcome) => {
        if (shouldReset) {
          shouldReset = false;
          await current.proof.reset(outcome.user.id);
        }
      },
    });
    const first = await signIn(current);
    const staleCookie = current.browser.sessionHeader();
    expect((await current.proof.protected(staleCookie)).status).toBe(401);
    current.browser = new ProofBrowser(current.proof.origin);
    await signIn(current, first.profile);
    const decoded = await token(current.browser, current.proof);
    expect(decodeJwt(decoded!.sourceProof as string).generation).toBe(1);
    expect((await current.proof.protected(current.browser.sessionHeader())).status).toBe(200);
    expect((await current.proof.protected(staleCookie)).status).toBe(401);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(authSecurityMutationEvents)).toHaveLength(1);
  });

  it('preserves signed historical authentication age without deriving fresh age from cookie issuance', async () => {
    const current = await fixture();
    const authTimeSeconds = Math.floor(Date.now() / 1000) - 86_400;
    await signIn(current, { ...identity(), authTimeSeconds });
    const decoded = await token(current.browser, current.proof);
    expect(decoded).toMatchObject({ originalAuthenticatedAt: authTimeSeconds * 1000 });
    expect(decoded?.iat).toBeGreaterThan(authTimeSeconds);
    expect(await (await current.proof.protected(current.browser.sessionHeader())).json()).toMatchObject({
      originalAuthenticatedAt: authTimeSeconds * 1000,
    });
  });

  it('retains an exact hashed source deadline and rejects source expiry after an awaited encode barrier', async () => {
    const current = await fixture({
      sourceLifetimeSeconds: 1,
      beforeEncode: async (outcome) => {
        const expires = decodeJwt(outcome.sourceProof).exp! * 1000;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, expires - Date.now() + 40)));
      },
    });
    await signIn(current);
    const decoded = await token(current.browser, current.proof);
    // Public NextAuth JWT decoder permits clock tolerance. Backend proof and
    // persisted millisecond deadline must still deny this valid outer cookie.
    expect(decoded?.sourceProof).toBeTypeOf('string');
    const sourceProof = decoded!.sourceProof as string;
    const source = decodeJwt(sourceProof);
    const [receipt] = await db.select().from(sessions);
    const [flow] = await db.select().from(verificationTokens);
    expect(receipt.expires.getTime()).toBe(source.exp! * 1000);
    expect(flow.expires.getTime()).toBeGreaterThan(receipt.expires.getTime());
    expect(receipt.sessionToken).toMatch(/^ba03-lineage:[a-f0-9]{64}$/);
    expect(flow.identifier).toMatch(/^ba03-flow:[a-f0-9]{64}$/);
    expect(flow.token).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify([receipt, flow])).not.toContain(sourceProof);
    expect((await current.proof.protected(current.browser.sessionHeader())).status).toBe(401);
  });

  it('rejects tampered receipt ownership and expiry independently from the signed cookie', async () => {
    const current = await fixture();
    await signIn(current);
    const [receipt] = await db.select().from(sessions);
    const otherUser = randomUUID();
    await db.insert(users).values({ id: otherUser, email: 'receipt-owner@example.test' });
    await db.update(sessions).set({ userId: otherUser }).where(eq(sessions.sessionToken, receipt.sessionToken));
    expect((await current.proof.protected(current.browser.sessionHeader())).status).toBe(401);
    await db
      .update(sessions)
      .set({ userId: receipt.userId, expires: new Date(receipt.expires.getTime() + 1000) })
      .where(eq(sessions.sessionToken, receipt.sessionToken));
    expect((await current.proof.protected(current.browser.sessionHeader())).status).toBe(401);
  });

  it('keeps backend source JWT purpose and key separate from public OIDC and outer NextAuth access', async () => {
    const current = await fixture();
    await signIn(current);
    const decoded = await token(current.browser, current.proof);
    const sourceProof = decoded!.sourceProof as string;
    expect((await current.proof.protected(`next-auth.session-token=${sourceProof}`)).status).toBe(401);
    expect(
      (await current.proof.trustedRpc({ idToken: sourceProof, flow: 'b'.repeat(64), actorCookie: null })).status,
    ).toBe(500);
    expect(await db.select().from(sessions)).toHaveLength(1);
    expect(await db.select().from(verificationTokens)).toHaveLength(1);
  });

  it('rejects direct unauthenticated compound HTTP calls without trusting body-selected owners', async () => {
    const current = await fixture();
    const response = await fetch(`${current.proof.backendOrigin}/compound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'victim', email: 'victim@example.test' }),
      signal: AbortSignal.timeout(3000),
    });
    expect(response.status).toBe(401);
    expect(await db.select().from(users)).toEqual([]);
    expect(current.proof.observations.compoundCalls).toBe(0);
    expect(
      (
        await current.proof.trustedRpc({
          idToken: 'untrusted',
          flow: 'a'.repeat(64),
          actorCookie: null,
          userId: 'victim',
        })
      ).status,
    ).toBe(400);
    expect(
      (await current.proof.trustedRpc({ idToken: 'untrusted', flow: 'a'.repeat(64), actorCookie: null })).status,
    ).toBe(500);
    expect(await db.select().from(users)).toEqual([]);
  });
});
