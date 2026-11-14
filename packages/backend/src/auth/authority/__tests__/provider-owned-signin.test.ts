import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import postgres from 'postgres';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authBrowserIntents,
  authBrowserBindings,
  authEmailProjection,
  authSession,
  authSubjectCutoffs,
  authWebOAuthIntents,
} from '@boardsesh/db/schema/auth';
import type { ProviderSecurityProvider } from '@boardsesh/auth-protocol';
import { createProviderSecurityEnvironment } from './provider-security-fixture';
import {
  abortOwnedProviderSignin,
  beginOwnedProviderSignin,
  finalizeOwnedProviderSignin,
  prepareOwnedProviderSignin,
} from '../provider-owned-signin';
import { providerTokenHash } from '../provider-security-context';
import { readBrowserBinding } from '../browser-binding';
import * as browserAuthority from '../browser-binding';
import * as sessionReader from '../session-reader';
import { readFirstPartySession, requireFreshAuthentication } from '../session-reader';
import { readLockedWebSubjectState } from '../../current-store/web-credential-state';

const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = requireWeb('next-auth/jwt') as {
  encode(input: { secret: string; token: Record<string, unknown>; maxAge: number }): Promise<string>;
};
let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKey: Awaited<ReturnType<typeof exportJWK>>;
let duringVerification: (() => Promise<void>) | undefined;

async function start(
  selected: 'current-store' | 'better-auth',
  kind: 'canonical-token' | 'legacy-jwe',
  provider: ProviderSecurityProvider = 'apple',
  sameOwner = false,
) {
  const subject = randomUUID();
  const actor = await environment.actor(selected, kind, sameOwner ? { provider, subject } : {});
  const target = sameOwner ? actor : await environment.actor(selected, kind, { provider, subject, password: false });
  const nonce = randomBytes(32).toString('base64url');
  const flowHash = randomBytes(32).toString('hex');
  const intent = await beginOwnedProviderSignin(environment.database, environment.runtime, {
    actor: actor.actor,
    provider,
    flowHash,
    nonceHash: providerTokenHash(nonce),
  });
  const bound = {
    actor: actor.actor,
    intentToken: intent.intentToken,
    browserIntentToken: intent.browserIntentToken,
    flowHash,
    nonceHash: providerTokenHash(nonce),
  };
  return { actor, target, subject, nonce, intent, bound, provider };
}
async function assertion(subject: string, nonce: string, authTime: number | null) {
  const seconds = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: 'https://accounts.google.com',
    aud: 'owned-google-client',
    sub: subject,
    nonce,
    iat: seconds,
    exp: seconds + 600,
    ...(authTime === null ? {} : { auth_time: authTime }),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'owned-signin-real-google-key' })
    .sign(signingKey.privateKey);
}
function providerKeys() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const address = input instanceof Request ? input.url : String(input);
    if (address !== 'https://www.googleapis.com/oauth2/v3/certs') throw new Error('Unexpected provider I/O');
    await duringVerification?.();
    return Response.json({ keys: [{ ...publicKey, alg: 'RS256', kid: 'owned-signin-real-google-key', use: 'sig' }] });
  });
}
async function prepare(pending: Awaited<ReturnType<typeof start>>, idToken: string | null = null) {
  const prepared = await prepareOwnedProviderSignin(environment.database, environment.runtime, {
    ...pending.bound,
    providerProof: { provider: pending.provider, subject: pending.subject, idToken, nonce: pending.nonce },
  });
  if (prepared.outcome !== 'prepared') throw new Error('Expected distinct owned-account preparation');
  return prepared;
}
async function candidate(prepared: Awaited<ReturnType<typeof prepare>>, kind: 'canonical-token' | 'legacy-jwe') {
  if (kind === 'canonical-token') {
    if (!prepared.proposedCanonicalToken) throw new Error('Missing private canonical proposal');
    return { kind, credential: prepared.proposedCanonicalToken };
  }
  const proof = prepared.preparation.credentialProof;
  return {
    kind,
    credential: await jwt.encode({
      secret: environment.secret,
      maxAge: Date.parse(prepared.preparation.credentialExpiresAt) / 1000 - Math.floor(Date.now() / 1000),
      token: {
        sub: proof.userId,
        authSessionId: proof.authSessionId,
        gen: proof.generation,
        ...(proof.authenticatedAt ? { auth_time: Date.parse(proof.authenticatedAt) / 1000, link_guarded: true } : {}),
      },
    }),
  };
}
async function flows() {
  return environment.database.select().from(authWebOAuthIntents);
}
async function inventory() {
  return {
    sessions: await environment.database.select().from(authSession).orderBy(authSession.id),
    bindings: await environment.database.select().from(authBrowserBindings).orderBy(authBrowserBindings.id),
    browserIntents: await environment.database.select().from(authBrowserIntents).orderBy(authBrowserIntents.id),
    flows: await environment.database.select().from(authWebOAuthIntents).orderBy(authWebOAuthIntents.intentHash),
  };
}
/** Observe BOTH real user-row waiters before releasing the holder. No clock
 * delay or test double selects the winner, and all command timeouts stay real. */
async function queuedActorCommands<First, Second>(
  userId: string,
  first: () => Promise<First>,
  second: () => Promise<Second>,
) {
  const address = new URL(
    process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
  );
  address.pathname = `/${environment.client.options.database}`;
  const observer = postgres(address.toString(), { max: 2, onnotice: () => {} });
  let release = () => {};
  let ready = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const holding = observer.begin(async (transaction) => {
    await transaction`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    ready();
    await released;
  });
  const settle = <Result>(pending: Promise<Result>): Promise<PromiseSettledResult<Result>> =>
    pending.then(
      (value) => ({ status: 'fulfilled', value }),
      (reason: unknown) => ({ status: 'rejected', reason }),
    );
  let firstResult: Promise<PromiseSettledResult<First>> | undefined;
  let secondResult: Promise<PromiseSettledResult<Second>> | undefined;
  async function waitFor(count: number) {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const [state] = await observer<{ waiting: number }[]>`SELECT count(*)::integer AS waiting
        FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query ILIKE '%for update%'`;
      if (state.waiting >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Expected ${count} actual queued actor-row commands`);
  }
  try {
    await started;
    firstResult = settle(first());
    await waitFor(1);
    secondResult = settle(second());
    await waitFor(2);
    release();
    await holding;
    return await Promise.all([firstResult, secondResult]);
  } finally {
    release();
    await holding;
    await Promise.all([firstResult, secondResult]);
    await observer.end({ timeout: 5 });
  }
}

describe('ordinary selected browser login to an already-owned Google/Apple account', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
    signingKey = await generateKeyPair('RS256');
    publicKey = await exportJWK(signingKey.publicKey);
  });
  afterEach(() => {
    duringVerification = undefined;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(async () => environment?.close());
  for (const selected of ['current-store', 'better-auth'] as const) {
    it(`${selected}: wrong expected UID or SID cannot reserve an intent or advance browser revision`, async () => {
      const owner = await environment.actor(selected, 'canonical-token');
      const before = {
        bindings: await environment.database.select().from(authBrowserBindings),
        browserIntents: await environment.database.select().from(authBrowserIntents),
        flows: await flows(),
      };
      for (const changedActor of [
        { ...owner.actor, expectedUserId: randomUUID() },
        { ...owner.actor, expectedAuthSessionId: randomUUID() },
      ])
        await expect(
          beginOwnedProviderSignin(environment.database, environment.runtime, {
            actor: changedActor,
            provider: 'apple',
            flowHash: randomBytes(32).toString('hex'),
            nonceHash: null,
          }),
        ).rejects.toMatchObject({ outcome: 'identity_changed' });
      expect(await environment.database.select().from(authBrowserBindings)).toEqual(before.bindings);
      expect(await environment.database.select().from(authBrowserIntents)).toEqual(before.browserIntents);
      expect(await flows()).toEqual(before.flows);
    });
    for (const kind of ['canonical-token', 'legacy-jwe'] as const) {
      for (const capability of ['null', 'known'] as const)
        it(`${selected}/${kind}: ${capability} abort after prepare permanently cancels the candidate and browser intent`, async () => {
          const pending = await start(selected, kind);
          const prepared = await prepare(pending);
          const exact = await candidate(prepared, kind);
          const beforeSessions = await environment.database.select().from(authSession);
          const beforeBindings = await environment.database.select().from(authBrowserBindings);
          const abort = {
            ...pending.bound,
            preparationToken: capability === 'known' ? prepared.preparationToken : null,
            preparation: capability === 'known' ? prepared.preparation : null,
          };
          expect(await abortOwnedProviderSignin(environment.database, environment.runtime, abort)).toEqual({
            outcome: 'aborted',
          });
          const [canceled] = await environment.database
            .select()
            .from(authBrowserIntents)
            .where(eq(authBrowserIntents.id, providerTokenHash(pending.intent.browserIntentToken)));
          const afterAbort = await inventory();
          expect(await abortOwnedProviderSignin(environment.database, environment.runtime, abort)).toEqual({
            outcome: 'aborted',
          });
          expect(await inventory()).toEqual(afterAbort);
          await expect(
            finalizeOwnedProviderSignin(environment.database, environment.runtime, {
              ...pending.bound,
              preparationToken: prepared.preparationToken,
              preparation: prepared.preparation,
              candidate: exact,
            }),
          ).rejects.toMatchObject({ code: capability === 'null' ? 'invalid_intent' : 'invalid_proof' });
          expect(canceled.consumedAt).toBeInstanceOf(Date);
          expect(canceled.resultVersion).toBe(pending.actor.actor.browserVersion + 1);
          expect(canceled.resultCredentialHash).toBeNull();
          expect(await environment.database.select().from(authSession)).toEqual(beforeSessions);
          expect(await environment.database.select().from(authBrowserBindings)).toEqual(beforeBindings);
          const credential =
            kind === 'canonical-token'
              ? { kind, token: exact.credential }
              : { kind, credential: exact.credential, secret: environment.secret };
          expect(
            await browserAuthority.commitBrowserLogin(
              environment.database,
              environment.qualification,
              pending.actor.actor.browserBindingToken,
              pending.intent.browserIntentToken,
              credential,
              { version: pending.actor.actor.browserVersion, credential: pending.actor.credential },
            ),
          ).toMatchObject({
            status: kind === 'legacy-jwe' ? 'conflict' : 'denied',
          });
          expect(await inventory()).toEqual(afterAbort);
        });
      it(`${selected}/${kind}: B login commits only after exact candidate; replay ACK cannot overwrite a newer selection`, async () => {
        const pending = await start(selected, kind);
        const beforeSessions = await environment.database.select().from(authSession);
        const prepared = await prepare(pending);
        expect(prepared.preparation.credentialProof).toMatchObject({
          userId: pending.target.userId,
          authenticatedAt: null,
          linkGuarded: false,
        });
        expect(prepared.preparation.credentialProof.authSessionId).not.toBe(pending.actor.sid);
        expect(await environment.database.select().from(authSession)).toEqual(beforeSessions);
        const exact = await candidate(prepared, kind);
        const command = {
          ...pending.bound,
          preparationToken: prepared.preparationToken,
          preparation: prepared.preparation,
          candidate: exact,
        };
        const committed = await finalizeOwnedProviderSignin(environment.database, environment.runtime, command);
        expect(committed.outcome).toBe('committed');
        const credential =
          kind === 'canonical-token'
            ? { kind, token: exact.credential }
            : { kind, credential: exact.credential, secret: environment.secret };
        const selectedB = await readBrowserBinding(
          environment.database,
          environment.qualification,
          pending.actor.actor.browserBindingToken,
          { version: committed.browserCursor.version, credential },
        );
        expect(selectedB).toMatchObject({
          status: 'admitted',
          session: { userId: pending.target.userId, authenticatedAt: null, linkGuarded: false },
        });
        if (selectedB.status !== 'admitted') throw new Error('B source did not admit');
        expect(requireFreshAuthentication(selectedB.session)).toBe(false);
        expect(await finalizeOwnedProviderSignin(environment.database, environment.runtime, command)).toMatchObject({
          outcome: 'recovered',
          candidateCredentialHash: committed.candidateCredentialHash,
        });
        const afterCommitted = await inventory();
        await expect(
          abortOwnedProviderSignin(environment.database, environment.runtime, {
            ...pending.bound,
            preparationToken: null,
            preparation: null,
          }),
        ).rejects.toMatchObject({ code: 'invalid_proof' });
        expect(await inventory()).toEqual(afterCommitted);
        expect(await finalizeOwnedProviderSignin(environment.database, environment.runtime, command)).toMatchObject({
          outcome: 'recovered',
          candidateCredentialHash: committed.candidateCredentialHash,
        });
        for (const changedActor of [
          { ...command.actor, expectedUserId: pending.target.userId },
          { ...command.actor, expectedAuthSessionId: prepared.preparation.credentialProof.authSessionId },
        ])
          await expect(
            finalizeOwnedProviderSignin(environment.database, environment.runtime, { ...command, actor: changedActor }),
          ).rejects.toMatchObject({ outcome: 'identity_changed' });
        await environment.database.transaction(async (transaction) => {
          const admittedA = await readFirstPartySession(transaction, pending.actor.credential, new Date(), (userId) =>
            readLockedWebSubjectState(transaction, userId),
          );
          expect(admittedA.status).toBe('admitted');
        });
        await environment.database.execute(
          sql`UPDATE auth_browser_bindings SET version = version + 1 WHERE id = ${committed.browserCursor.bindingId}`,
        );
        await expect(
          finalizeOwnedProviderSignin(environment.database, environment.runtime, command),
        ).rejects.toMatchObject({ outcome: 'identity_changed' });
      });
      it(`${selected}/${kind}: same-owner callback retains exact original SID, age, expiry and source`, async () => {
        const pending = await start(selected, kind, 'google', true);
        const before = await environment.database.select().from(authSession);
        const prepared = await prepareOwnedProviderSignin(environment.database, environment.runtime, {
          ...pending.bound,
          providerProof: { provider: 'google', subject: pending.subject, idToken: null, nonce: pending.nonce },
        });
        expect(prepared).toMatchObject({
          outcome: 'same-owner',
          credentialProof: {
            userId: pending.actor.userId,
            authSessionId: pending.actor.sid,
            generation: 0,
            authenticatedAt: pending.actor.authenticatedAt?.toISOString(),
            linkGuarded: true,
          },
          credentialExpiresAt: pending.actor.sourceExpiresAt,
        });
        expect(await environment.database.select().from(authSession)).toEqual(before);
        expect(
          await readBrowserBinding(
            environment.database,
            environment.qualification,
            pending.actor.actor.browserBindingToken,
            { version: pending.actor.actor.browserVersion, credential: pending.actor.credential },
          ),
        ).toMatchObject({ status: 'admitted', session: { userId: pending.actor.userId } });
      });
    }
    it(`${selected}: an unknown subject, wrong actor or provider cannot consume the ordinary flow`, async () => {
      const pending = await start(selected, 'canonical-token');
      const before = await flows();
      for (const proof of [
        { provider: 'apple' as const, subject: randomUUID(), idToken: null, nonce: pending.nonce },
        { provider: 'google' as const, subject: pending.subject, idToken: null, nonce: pending.nonce },
        { provider: 'apple' as const, subject: pending.subject, idToken: null, nonce: 'wrong-nonce' },
      ])
        await expect(
          prepareOwnedProviderSignin(environment.database, environment.runtime, {
            ...pending.bound,
            providerProof: proof,
          }),
        ).rejects.toThrow();
      const foreign = await environment.actor(selected, 'canonical-token');
      await expect(
        prepareOwnedProviderSignin(environment.database, environment.runtime, {
          ...pending.bound,
          actor: foreign.actor,
          providerProof: { provider: 'apple', subject: pending.subject, idToken: null, nonce: pending.nonce },
        }),
      ).rejects.toThrow();
      expect(await flows()).toEqual(before);
    });
    for (const failedRead of ['selected', 'previous'] as const)
      it(`${selected}: ${failedRead} primary unavailable cannot become an identity denial or a lost-success ACK`, async () => {
        const pending = await start(selected, 'canonical-token');
        const prepared = await prepare(pending);
        const exact = await candidate(prepared, 'canonical-token');
        const command = {
          ...pending.bound,
          preparationToken: prepared.preparationToken,
          preparation: prepared.preparation,
          candidate: exact,
        };
        expect((await finalizeOwnedProviderSignin(environment.database, environment.runtime, command)).outcome).toBe(
          'committed',
        );
        if (failedRead === 'selected')
          vi.spyOn(browserAuthority, 'readBrowserBindingInTransaction').mockResolvedValueOnce({
            status: 'unavailable',
          });
        else {
          const actual = sessionReader.readFirstPartySession;
          vi.spyOn(sessionReader, 'readFirstPartySession').mockImplementation(
            (database, credential, now, readSubject) =>
              credential.kind === 'canonical-token' && credential.token === pending.actor.actor.credential
                ? Promise.resolve({ status: 'unavailable' })
                : actual(database, credential, now, readSubject),
          );
        }
        await expect(
          finalizeOwnedProviderSignin(environment.database, environment.runtime, command),
        ).rejects.toMatchObject({ outcome: 'unavailable', code: 'authority_unavailable' });
        vi.restoreAllMocks();
        expect((await finalizeOwnedProviderSignin(environment.database, environment.runtime, command)).outcome).toBe(
          'recovered',
        );
      });
    for (const age of ['recent', 'old', 'missing', 'Apple'] as const) {
      it(`${selected}: ${age} signed provider evidence never promotes callback time into fresh privilege`, async () => {
        const pending = await start(selected, 'canonical-token', age === 'Apple' ? 'apple' : 'google');
        providerKeys();
        const seconds = Math.floor(Date.now() / 1000);
        const authTime = age === 'missing' ? null : seconds - (age === 'old' ? 3600 : 60);
        const prepared = await prepare(pending, await assertion(pending.subject, pending.nonce, authTime));
        expect(prepared.preparation.credentialProof.authenticatedAt).toBe(
          age === 'recent' ? new Date((seconds - 60) * 1000).toISOString() : null,
        );
        expect(prepared.preparation.credentialProof.linkGuarded).toBe(age === 'recent');
      });
    }
    it(`${selected}: final primary generation drift refuses without minting B or consuming preparation`, async () => {
      const pending = await start(selected, 'canonical-token');
      const prepared = await prepare(pending);
      const exact = await candidate(prepared, 'canonical-token');
      const before = await flows();
      await environment.database.insert(authSubjectCutoffs).values({
        userId: pending.target.userId,
        generation: 1,
        nativeGeneration: 0,
        revokedThrough: new Date(),
        lastOperationId: randomUUID(),
      });
      await expect(
        finalizeOwnedProviderSignin(environment.database, environment.runtime, {
          ...pending.bound,
          preparationToken: prepared.preparationToken,
          preparation: prepared.preparation,
          candidate: exact,
        }),
      ).rejects.toThrow();
      expect(await flows()).toEqual(before);
      expect(
        await environment.database.select().from(authSession).where(eq(authSession.token, exact.credential)),
      ).toHaveLength(0);
    });
    it(`${selected}: an authority switch during actual Google verification cannot select a fallback writer`, async () => {
      const pending = await start(selected, 'canonical-token', 'google');
      const before = await flows();
      providerKeys();
      duringVerification = async () => {
        duringVerification = undefined;
        await environment.selectAuthority(selected === 'current-store' ? 'better-auth' : 'current-store');
      };
      await expect(
        prepare(pending, await assertion(pending.subject, pending.nonce, Math.floor(Date.now() / 1000) - 60)),
      ).rejects.toThrow();
      expect(await flows()).toEqual(before);
    });
    it(`${selected}: waits out an uncommitted provider owner update and rereads before minting B`, async () => {
      const pending = await start(selected, 'canonical-token');
      const prepared = await prepare(pending);
      const foreign = await environment.actor(selected, 'canonical-token');
      const exact = await candidate(prepared, 'canonical-token');
      const address = new URL(
        process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
      );
      address.pathname = `/${environment.client.options.database}`;
      const observer = postgres(address.toString(), { max: 2, onnotice: () => {} });
      let release = () => {};
      let ready = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const holding = observer.begin(async (transaction) => {
        if (selected === 'current-store')
          await transaction`UPDATE accounts SET "userId" = ${foreign.userId}
          WHERE provider = 'apple' AND "providerAccountId" = ${pending.subject}`;
        else
          await transaction`UPDATE auth_account SET user_id = ${foreign.userId}
          WHERE provider_id = 'apple' AND account_id = ${pending.subject}`;
        ready();
        await released;
      });
      await started;
      let completed = false;
      const finalizing = finalizeOwnedProviderSignin(environment.database, environment.runtime, {
        ...pending.bound,
        preparationToken: prepared.preparationToken,
        preparation: prepared.preparation,
        candidate: exact,
      }).then(
        (reply) => {
          completed = true;
          return reply;
        },
        (error: unknown) => {
          completed = true;
          throw error;
        },
      );
      const result = finalizing.catch((error: unknown) => error);
      let observedWait = false;
      try {
        const until = Date.now() + 180;
        while (!observedWait && !completed && Date.now() < until) {
          const [state] = await observer<{ waiting: boolean }[]>`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE '%for update%'
          ) AS waiting`;
          observedWait = state.waiting;
          if (!observedWait) await new Promise((resolve) => setTimeout(resolve, 5));
        }
      } finally {
        release();
        await holding;
      }
      try {
        expect(observedWait).toBe(true);
        expect(await result).toMatchObject({ code: 'ownership_conflict' });
        expect(
          await environment.database.select().from(authSession).where(eq(authSession.token, exact.credential)),
        ).toHaveLength(0);
      } finally {
        await observer.end();
      }
    });
    it(`${selected}: flow expiry during a real credential insert rolls back every write after release`, async () => {
      const pending = await start(selected, 'canonical-token');
      await environment.database
        .execute(sql`UPDATE auth_web_oauth_intents SET expires_at = clock_timestamp() + interval '1 second'
        WHERE actor_user_id = ${pending.actor.userId} AND consumed_at IS NULL`);
      const prepared = await prepare(pending);
      const exact = await candidate(prepared, 'canonical-token');
      const before = await flows();
      await environment.database
        .execute(sql`CREATE FUNCTION hold_owned_signin_credential() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(2); RETURN NEW; END $$`);
      await environment.database.execute(sql`CREATE TRIGGER hold_owned_signin_credential BEFORE INSERT ON auth_session
        FOR EACH ROW EXECUTE FUNCTION hold_owned_signin_credential()`);
      try {
        const finalizing = finalizeOwnedProviderSignin(environment.database, environment.runtime, {
          ...pending.bound,
          preparationToken: prepared.preparationToken,
          preparation: prepared.preparation,
          candidate: exact,
        });
        const result = finalizing.catch((error: unknown) => error);
        let observedSleep = false;
        const until = Date.now() + 900;
        while (!observedSleep && Date.now() < until) {
          const [state] = await environment.client<{ sleeping: boolean }[]>`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep'
          ) AS sleeping`;
          observedSleep = state.sleeping;
          if (!observedSleep) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(observedSleep).toBe(true);
        expect(await result).toMatchObject({ code: 'expired' });
      } finally {
        await environment.database.execute(sql`DROP TRIGGER hold_owned_signin_credential ON auth_session`);
        await environment.database.execute(sql`DROP FUNCTION hold_owned_signin_credential()`);
      }
      expect(await flows()).toEqual(before);
      expect(
        await environment.database.select().from(authSession).where(eq(authSession.token, exact.credential)),
      ).toHaveLength(0);
      const [browserIntent] = await environment.database
        .select()
        .from(authBrowserIntents)
        .where(eq(authBrowserIntents.id, providerTokenHash(pending.intent.browserIntentToken)));
      expect(browserIntent.consumedAt).toBeNull();
    });
    it(`${selected}: a real late authority change rolls back B credential, browser selection and flow consumption`, async () => {
      const pending = await start(selected, 'canonical-token');
      const prepared = await prepare(pending);
      const exact = await candidate(prepared, 'canonical-token');
      const before = await flows();
      const [manifest] = await environment.database.select().from(authEmailProjection);
      await environment.database
        .execute(sql`CREATE FUNCTION drift_owned_signin_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN UPDATE auth_email_projection SET writer_epoch = writer_epoch + 1 WHERE is_current; RETURN NEW; END $$`);
      await environment.database
        .execute(sql`CREATE TRIGGER drift_owned_signin_manifest AFTER UPDATE ON auth_browser_bindings
        FOR EACH ROW EXECUTE FUNCTION drift_owned_signin_manifest()`);
      try {
        await expect(
          finalizeOwnedProviderSignin(environment.database, environment.runtime, {
            ...pending.bound,
            preparationToken: prepared.preparationToken,
            preparation: prepared.preparation,
            candidate: exact,
          }),
        ).rejects.toThrow();
      } finally {
        await environment.database.execute(sql`DROP TRIGGER drift_owned_signin_manifest ON auth_browser_bindings`);
        await environment.database.execute(sql`DROP FUNCTION drift_owned_signin_manifest()`);
      }
      expect(await flows()).toEqual(before);
      expect(
        await environment.database.select().from(authSession).where(eq(authSession.token, exact.credential)),
      ).toHaveLength(0);
      expect((await environment.database.select().from(authEmailProjection))[0]).toEqual(manifest);
      const [browserIntent] = await environment.database
        .select()
        .from(authBrowserIntents)
        .where(eq(authBrowserIntents.id, providerTokenHash(pending.intent.browserIntentToken)));
      expect(browserIntent.consumedAt).toBeNull();
    });
    it(`${selected}: wrong or stale actor cannot cancel a prepared login or consume any receipt`, async () => {
      const pending = await start(selected, 'canonical-token');
      await prepare(pending);
      const before = await inventory();
      for (const actor of [
        { ...pending.bound.actor, expectedUserId: randomUUID() },
        { ...pending.bound.actor, expectedAuthSessionId: randomUUID() },
      ]) {
        await expect(
          abortOwnedProviderSignin(environment.database, environment.runtime, {
            ...pending.bound,
            actor,
            preparationToken: null,
            preparation: null,
          }),
        ).rejects.toMatchObject({ code: 'invalid_proof' });
        expect(await inventory()).toEqual(before);
      }
      await environment.database.insert(authSubjectCutoffs).values({
        userId: pending.actor.userId,
        generation: 1,
        nativeGeneration: 0,
        revokedThrough: new Date(),
        lastOperationId: randomUUID(),
      });
      await expect(
        abortOwnedProviderSignin(environment.database, environment.runtime, {
          ...pending.bound,
          preparationToken: null,
          preparation: null,
        }),
      ).rejects.toMatchObject({ code: 'invalid_proof' });
      expect(await inventory()).toEqual(before);
    });
    for (const winner of ['abort', 'finalize'] as const)
      it(`${selected}: real queued ${winner} wins abort versus finalization without a partial selection`, async () => {
        const pending = await start(selected, 'canonical-token');
        const prepared = await prepare(pending);
        const exact = await candidate(prepared, 'canonical-token');
        const before = await inventory();
        const abort = () =>
          abortOwnedProviderSignin(environment.database, environment.runtime, {
            ...pending.bound,
            preparationToken: null,
            preparation: null,
          });
        const command = {
          ...pending.bound,
          preparationToken: prepared.preparationToken,
          preparation: prepared.preparation,
          candidate: exact,
        };
        const finalize = () => finalizeOwnedProviderSignin(environment.database, environment.runtime, command);
        if (winner === 'abort') {
          const [aborted, finalizing] = await queuedActorCommands(pending.actor.userId, abort, finalize);
          expect(aborted).toMatchObject({ status: 'fulfilled', value: { outcome: 'aborted' } });
          expect(finalizing).toMatchObject({ status: 'rejected', reason: { code: 'invalid_intent' } });
          expect(await environment.database.select().from(authSession).orderBy(authSession.id)).toEqual(
            before.sessions,
          );
          expect(await environment.database.select().from(authBrowserBindings).orderBy(authBrowserBindings.id)).toEqual(
            before.bindings,
          );
          await expect(finalize()).rejects.toMatchObject({ code: 'invalid_intent' });
        } else {
          const [finalizing, aborted] = await queuedActorCommands(pending.actor.userId, finalize, abort);
          expect(finalizing).toMatchObject({ status: 'fulfilled', value: { outcome: 'committed' } });
          expect(aborted).toMatchObject({ status: 'rejected', reason: { code: 'invalid_proof' } });
          const committed = await inventory();
          expect(await finalize()).toMatchObject({ outcome: 'recovered' });
          expect(await inventory()).toEqual(committed);
        }
      });
    it(`${selected}: abort queued behind real preparation cancels a reply the caller did not receive`, async () => {
      const pending = await start(selected, 'canonical-token');
      const before = await inventory();
      const [preparing, aborted] = await queuedActorCommands(
        pending.actor.userId,
        () => prepare(pending),
        () =>
          abortOwnedProviderSignin(environment.database, environment.runtime, {
            ...pending.bound,
            preparationToken: null,
            preparation: null,
          }),
      );
      expect(preparing.status).toBe('fulfilled');
      expect(aborted).toMatchObject({ status: 'fulfilled', value: { outcome: 'aborted' } });
      if (preparing.status !== 'fulfilled') throw new Error('Observed preparation did not complete');
      const exact = await candidate(preparing.value, 'canonical-token');
      await expect(
        finalizeOwnedProviderSignin(environment.database, environment.runtime, {
          ...pending.bound,
          preparationToken: preparing.value.preparationToken,
          preparation: preparing.value.preparation,
          candidate: exact,
        }),
      ).rejects.toMatchObject({ code: 'invalid_intent' });
      expect(await environment.database.select().from(authSession).orderBy(authSession.id)).toEqual(before.sessions);
      expect(await environment.database.select().from(authBrowserBindings).orderBy(authBrowserBindings.id)).toEqual(
        before.bindings,
      );
    });
    it(`${selected}: known cancellation consumes only its qualified flow and leaves all credentials unchanged`, async () => {
      const pending = await start(selected, 'canonical-token');
      const before = await environment.database.select().from(authSession);
      expect(
        await abortOwnedProviderSignin(environment.database, environment.runtime, {
          ...pending.bound,
          preparationToken: null,
          preparation: null,
        }),
      ).toEqual({ outcome: 'aborted' });
      await expect(prepare(pending)).rejects.toThrow();
      expect(await environment.database.select().from(authSession)).toEqual(before);
    });
    it(`${selected}: a primary provider owner changed after preparation cannot be reassigned by finalization`, async () => {
      const pending = await start(selected, 'canonical-token');
      const prepared = await prepare(pending);
      const other = await environment.actor(selected, 'canonical-token');
      if (selected === 'current-store')
        await environment.database
          .update(accounts)
          .set({ userId: other.userId })
          .where(and(eq(accounts.provider, 'apple'), eq(accounts.providerAccountId, pending.subject)));
      else
        await environment.database
          .update(authAccount)
          .set({ userId: other.userId })
          .where(and(eq(authAccount.providerId, 'apple'), eq(authAccount.accountId, pending.subject)));
      const exact = await candidate(prepared, 'canonical-token');
      await expect(
        finalizeOwnedProviderSignin(environment.database, environment.runtime, {
          ...pending.bound,
          preparationToken: prepared.preparationToken,
          preparation: prepared.preparation,
          candidate: exact,
        }),
      ).rejects.toMatchObject({ code: 'ownership_conflict' });
      expect(
        await environment.database.select().from(authSession).where(eq(authSession.token, exact.credential)),
      ).toHaveLength(0);
    });
  }
});
