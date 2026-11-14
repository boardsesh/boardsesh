import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authAccount,
  authBrowserBindings,
  authBrowserIntents,
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authSession,
  authWebOAuthIntents,
  userProfiles,
  users,
} from '@boardsesh/db/schema/auth';
import { createProviderSecurityEnvironment } from './provider-security-fixture';
import {
  abortAnonymousProviderSignin,
  beginAnonymousProviderSignin,
  finalizeAnonymousProviderSignin,
  prepareAnonymousProviderSignin,
} from '../anonymous-provider-signin';
import {
  beginBrowserIntent,
  commitBrowserLogin,
  createUnpublishedBrowserBinding,
  readBrowserBinding,
  readAnonymousBrowserBindingInTransaction,
  acknowledgeAnonymousBrowserLoginInTransaction,
} from '../browser-binding';
import { captureIdentityAuthority } from '../router';
import { providerTokenHash } from '../provider-security-context';
import { reserveEnforcedEmail } from '../../current-store/email-reservations';
import { getPostgresErrorCode } from '../../../utils/postgres-errors';

type Provider = 'google' | 'apple';
type Kind = 'legacy-jwe' | 'canonical-token';
type Authority = 'current-store' | 'better-auth';
const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = requireWeb('next-auth/jwt') as {
  encode(input: { secret: string; maxAge: number; token: Record<string, unknown> }): Promise<string>;
};
let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKey: Awaited<ReturnType<typeof exportJWK>>;
async function authority() {
  const [manifest] = await environment.database.select().from(authEmailProjection);
  return { ...environment.qualification, expectedWriterEpoch: manifest.writerEpoch };
}
async function identities() {
  return {
    users: await environment.database.select().from(users).orderBy(users.id),
    current: await environment.database.select().from(accounts).orderBy(accounts.provider, accounts.providerAccountId),
    primary: await environment.database.select().from(authAccount).orderBy(authAccount.id),
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
  };
}
async function allRows() {
  return {
    ...(await identities()),
    bindings: await environment.database.select().from(authBrowserBindings).orderBy(authBrowserBindings.id),
    intents: await environment.database.select().from(authBrowserIntents).orderBy(authBrowserIntents.id),
    flows: await environment.database.select().from(authWebOAuthIntents).orderBy(authWebOAuthIntents.intentHash),
  };
}
async function token(subject: string, nonce: string, age: 'recent' | 'missing' | 'old' = 'missing') {
  const seconds = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: 'https://accounts.google.com',
    aud: 'owned-google-client',
    sub: subject,
    nonce,
    iat: seconds,
    exp: seconds + 600,
    ...(age === 'missing' ? {} : { auth_time: seconds - (age === 'recent' ? 60 : 600) }),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'owned-anonymous-google-key' })
    .sign(signingKey.privateKey);
}
async function start(
  selected: Authority,
  kind: Kind,
  provider: Provider = 'apple',
  existing = false,
  bindingLifetime?: number,
) {
  await environment.selectAuthority(selected);
  const subject = randomUUID();
  let ownerId: string | undefined;
  if (existing) {
    const owner = await environment.actor(selected, kind, { provider, subject, password: false });
    ownerId = owner.userId;
    const expected = await authority();
    const [stored] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
    await environment.database.transaction((transaction) =>
      reserveEnforcedEmail(transaction, { ...expected, rawEmail: stored.email, requestedUserId: stored.id }),
    );
  }
  const binding = await createUnpublishedBrowserBinding(
    environment.database,
    environment.qualification,
    bindingLifetime === undefined ? undefined : new Date(Date.now() + bindingLifetime),
  );
  if (binding.status !== 'created') throw new Error('Owned anonymous binding fixture failed');
  const browser = { bindingToken: binding.token, expectedVersion: binding.cursor.version };
  const nonce = provider === 'google' ? randomBytes(32).toString('base64url') : null;
  const flowHash = randomBytes(32).toString('hex');
  const nonceHash = nonce ? providerTokenHash(nonce) : null;
  const intent = await beginAnonymousProviderSignin(environment.database, environment.runtime, {
    browser,
    provider,
    credentialKind: kind,
    flowHash,
    nonceHash,
  });
  const bound = {
    browser,
    flowHash,
    nonceHash,
    intentToken: intent.intentToken,
    browserIntentToken: intent.browserIntentToken,
  };
  const identity = {
    sub: subject,
    email: ` Anonymous-${randomUUID()}@Example.Test `,
    emailVerified: true,
    name: 'Verified provider name',
    image: 'https://owned.example.test/provider-avatar',
  };
  return { bound, kind, provider, nonce, identity, ownerId, intent };
}
async function prepare(pending: Awaited<ReturnType<typeof start>>, age: 'recent' | 'missing' | 'old' = 'missing') {
  return prepareAnonymousProviderSignin(environment.database, environment.runtime, {
    ...pending.bound,
    credentialKind: pending.kind,
    providerProof: {
      provider: pending.provider,
      identity: pending.identity,
      nonce: pending.nonce,
      idToken: pending.provider === 'google' ? await token(pending.identity.sub, pending.nonce!, age) : null,
    },
  });
}
async function candidate(prepared: Awaited<ReturnType<typeof prepare>>) {
  const kind = prepared.preparation.credentialKind;
  if (kind === 'canonical-token') {
    if (!prepared.proposedCanonicalToken) throw new Error('Owned canonical proposal missing');
    return { kind, credential: prepared.proposedCanonicalToken };
  }
  const proof = prepared.preparation.credentialProof;
  const milliseconds = Math.floor(Date.now() / 1000) * 1000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(milliseconds);
  try {
    return {
      kind,
      credential: await jwt.encode({
        secret: environment.secret,
        maxAge: Date.parse(prepared.preparation.credentialExpiresAt) / 1000 - milliseconds / 1000,
        token: {
          sub: proof.userId,
          authSessionId: proof.authSessionId,
          gen: proof.generation,
          ...(proof.authenticatedAt ? { auth_time: Date.parse(proof.authenticatedAt) / 1000, link_guarded: true } : {}),
        },
      }),
    };
  } finally {
    clock.mockRestore();
  }
}
function finalize(
  pending: Awaited<ReturnType<typeof start>>,
  prepared: Awaited<ReturnType<typeof prepare>>,
  exact: Awaited<ReturnType<typeof candidate>>,
) {
  return finalizeAnonymousProviderSignin(environment.database, environment.runtime, {
    ...pending.bound,
    preparationToken: prepared.preparationToken,
    preparation: prepared.preparation,
    candidate: exact,
  });
}

describe('strict anonymous provider preparation and atomic browser publication', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
    signingKey = await generateKeyPair('RS256');
    publicKey = await exportJWK(signingKey.publicKey);
  });
  beforeEach(() => {
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
    vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'owned-anonymous-provider-retired-email-key-6975');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const address = input instanceof Request ? input.url : String(input);
      if (address !== 'https://www.googleapis.com/oauth2/v3/certs') throw new Error('Unowned provider I/O');
      return Response.json({ keys: [{ ...publicKey, alg: 'RS256', kid: 'owned-anonymous-google-key', use: 'sig' }] });
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  afterAll(async () => environment?.close());

  for (const selected of ['current-store', 'better-auth'] as const) {
    for (const provider of ['google', 'apple'] as const) {
      for (const kind of ['legacy-jwe', 'canonical-token'] as const) {
        it.each([false, true])(
          `${selected}/${provider}/${kind}: existing=%s fixes owner before issuance, commits once and ACKs exact held bytes`,
          async (existing) => {
            const pending = await start(selected, kind, provider, existing);
            const before = await identities();
            const prepared = await prepare(pending);
            expect(await identities()).toEqual(before);
            expect(prepared.preparation.identityPlan.kind).toBe(existing ? 'existing' : 'new');
            if (existing) expect(prepared.preparation.credentialProof.userId).toBe(pending.ownerId);
            else expect(prepared.preparation.identityPlan.user.email).toBe(pending.identity.email.trim().toLowerCase());
            expect(prepared.preparation.credentialProof.authenticatedAt).toBeNull();
            expect(prepared.preparation.credentialProof.linkGuarded).toBe(false);
            const exact = await candidate(prepared);
            expect((await finalize(pending, prepared, exact)).outcome).toBe('committed');
            const committed = await allRows();
            expect((await finalize(pending, prepared, exact)).outcome).toBe('recovered');
            expect(await allRows()).toEqual(committed);
            const credential =
              kind === 'legacy-jwe'
                ? { kind, credential: exact.credential, secret: environment.secret }
                : { kind, token: exact.credential };
            const selectedBrowser = await readBrowserBinding(
              environment.database,
              environment.qualification,
              pending.bound.browser.bindingToken,
              { version: pending.bound.browser.expectedVersion + 1, credential },
            );
            expect(selectedBrowser.status).toBe('admitted');
            if (selectedBrowser.status !== 'admitted') throw new Error('Owned committed candidate not admitted');
            expect(selectedBrowser.session.userId).toBe(prepared.preparation.identityPlan.user.id);
            const changed =
              kind === 'legacy-jwe'
                ? await candidate(prepared)
                : { kind, credential: randomBytes(32).toString('base64url') };
            expect(changed.credential).not.toBe(exact.credential);
            await expect(finalize(pending, prepared, changed)).rejects.toThrow();
            expect(await allRows()).toEqual(committed);
          },
        );
      }
    }
    it.each(['recent', 'missing', 'old'] as const)(
      `${selected}: only owned verified recent Google auth_time supplies age (%s)`,
      async (age) => {
        const pending = await start(selected, 'canonical-token', 'google');
        const prepared = await prepare(pending, age);
        expect(prepared.preparation.credentialProof.authenticatedAt !== null).toBe(age === 'recent');
        expect(prepared.preparation.credentialProof.linkGuarded).toBe(age === 'recent');
      },
    );
    it(`${selected}: lost prepare response cancellation is terminal without advancing anonymous selection`, async () => {
      const pending = await start(selected, 'canonical-token');
      const prepared = await prepare(pending);
      const exact = await candidate(prepared);
      expect(
        (
          await abortAnonymousProviderSignin(environment.database, environment.runtime, {
            ...pending.bound,
            credentialKind: pending.kind,
            preparationToken: null,
            preparation: null,
          })
        ).outcome,
      ).toBe('aborted');
      const canceled = await allRows();
      await expect(finalize(pending, prepared, exact)).rejects.toThrow();
      expect(await allRows()).toEqual(canceled);
      const [binding] = await environment.database
        .select()
        .from(authBrowserBindings)
        .where(eq(authBrowserBindings.id, pending.intent.browserCursor.bindingId));
      expect(binding.version).toBe(pending.bound.browser.expectedVersion);
      expect(binding.userId).toBeNull();
    });
    it.each(['UID', 'SID', 'age'] as const)(
      `${selected}: a caller cannot change backend-prepared %s before canonical issuance`,
      async (field) => {
        const pending = await start(selected, 'canonical-token', 'google');
        const prepared = await prepare(pending);
        const exact = await candidate(prepared);
        const forged = structuredClone(prepared);
        if (field === 'UID') {
          const claimedUser = randomUUID();
          forged.preparation.identityPlan.user.id = claimedUser;
          forged.preparation.credentialProof.userId = claimedUser;
        }
        if (field === 'SID') forged.preparation.credentialProof.authSessionId = randomUUID();
        if (field === 'age') {
          forged.preparation.credentialProof.authenticatedAt = new Date(Date.now() - 30_000).toISOString();
          forged.preparation.credentialProof.linkGuarded = true;
        }
        const before = await allRows();
        await expect(finalize(pending, forged, exact)).rejects.toMatchObject({
          outcome: 'denied',
          code: 'invalid_intent',
        });
        expect(await allRows()).toEqual(before);
      },
    );
    it(`${selected}: strict anonymous and exact-ACK readers refuse another selected owner without waiting for their user row`, async () => {
      const selectedOwner = await environment.actor(selected, 'canonical-token');
      const target = await environment.actor(selected, 'canonical-token');
      const address = new URL(
        process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
      );
      address.pathname = `/${environment.client.options.database}`;
      const holder = postgres(address.toString(), { max: 1, onnotice: () => {} });
      let release = () => {};
      let ready = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const parked = holder.begin(async (transaction) => {
        await transaction`SELECT id FROM users WHERE id=${selectedOwner.userId} FOR UPDATE`;
        ready();
        await released;
      });
      try {
        await Promise.race([
          started,
          parked.then(() => {
            throw new Error('Owned user-row holder ended early');
          }),
        ]);
        await environment.database.transaction(async (transaction) => {
          const receipt = await captureIdentityAuthority(transaction, environment.qualification);
          await transaction.execute(sql`SET LOCAL lock_timeout = '150ms'`);
          await transaction.select({ id: users.id }).from(users).where(eq(users.id, target.userId)).for('update');
          expect(
            (
              await readAnonymousBrowserBindingInTransaction(transaction, receipt, {
                bindingToken: selectedOwner.actor.browserBindingToken,
                expectedVersion: selectedOwner.actor.browserVersion,
              })
            ).status,
          ).toBe('conflict');
          expect(
            (
              await acknowledgeAnonymousBrowserLoginInTransaction(transaction, receipt, {
                bindingToken: selectedOwner.actor.browserBindingToken,
                expectedVersion: selectedOwner.actor.browserVersion - 1,
                intentToken: 'A'.repeat(43),
                expectedUserId: target.userId,
                expectedAuthSessionId: target.sid,
                credential: target.credential,
              })
            ).status,
          ).toBe('conflict');
        });
      } finally {
        release();
        try {
          await parked;
        } finally {
          await holder.end({ timeout: 5 });
        }
      }
    });
    it(`${selected}: a concurrent registration taking the prepared email prevents all identity and credential publication`, async () => {
      const pending = await start(selected, 'canonical-token');
      const prepared = await prepare(pending);
      const exact = await candidate(prepared);
      const other = await environment.actor(selected, 'canonical-token');
      await environment.database
        .update(users)
        .set({ email: prepared.preparation.identityPlan.user.email })
        .where(eq(users.id, other.userId));
      const expected = await authority();
      await environment.database.transaction((transaction) =>
        reserveEnforcedEmail(transaction, {
          ...expected,
          rawEmail: prepared.preparation.identityPlan.user.email,
          requestedUserId: other.userId,
        }),
      );
      const before = await allRows();
      await expect(finalize(pending, prepared, exact)).rejects.toThrow();
      expect(await allRows()).toEqual(before);
    });
    it(`${selected}: actual late browser-write failure rolls back the new identity, mirrors and credential`, async () => {
      const pending = await start(selected, 'canonical-token');
      const prepared = await prepare(pending);
      const exact = await candidate(prepared);
      const before = await allRows();
      await environment.client
        .unsafe(`CREATE FUNCTION owned_anonymous_browser_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'owned-late-browser-write-failure'; END $$`);
      await environment.client
        .unsafe(`CREATE TRIGGER owned_anonymous_browser_failure BEFORE UPDATE ON auth_browser_bindings
        FOR EACH ROW EXECUTE FUNCTION owned_anonymous_browser_failure()`);
      try {
        const failure: unknown = await finalize(pending, prepared, exact).catch((error: unknown) => error);
        expect(getPostgresErrorCode(failure)).toBe('P0001');
        expect(failure).toMatchObject({
          cause: expect.objectContaining({ message: 'owned-late-browser-write-failure' }),
        });
        expect(await allRows()).toEqual(before);
      } finally {
        await environment.client.unsafe('DROP TRIGGER owned_anonymous_browser_failure ON auth_browser_bindings');
        await environment.client.unsafe('DROP FUNCTION owned_anonymous_browser_failure()');
      }
    });
    it(`${selected}: the last database deadline rolls back publication after real preparation-consume work`, async () => {
      const pending = await start(selected, 'canonical-token', 'apple', false, 3000);
      const prepared = await prepare(pending);
      const exact = await candidate(prepared);
      const before = await allRows();
      await environment.client.unsafe('CREATE SEQUENCE owned_anonymous_deadline_seen');
      await environment.client
        .unsafe(`CREATE FUNCTION owned_anonymous_deadline_wait() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF clock_timestamp() >= NEW.expires_at THEN RAISE EXCEPTION 'owned-deadline-control-started-too-late'; END IF;
          PERFORM nextval('owned_anonymous_deadline_seen');
          PERFORM pg_sleep(greatest(0, extract(epoch FROM NEW.expires_at - clock_timestamp())) + 0.05);
          RETURN NEW;
        END $$`);
      await environment.client
        .unsafe(`CREATE TRIGGER owned_anonymous_deadline_wait BEFORE UPDATE ON auth_web_oauth_intents
        FOR EACH ROW WHEN (OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL)
        EXECUTE FUNCTION owned_anonymous_deadline_wait()`);
      try {
        await expect(finalize(pending, prepared, exact)).rejects.toThrow('Provider security command refused');
        const [observed] = await environment.client<
          { is_called: boolean }[]
        >`SELECT is_called FROM owned_anonymous_deadline_seen`;
        expect(observed.is_called).toBe(true);
        expect(await allRows()).toEqual(before);
      } finally {
        await environment.client.unsafe('DROP TRIGGER owned_anonymous_deadline_wait ON auth_web_oauth_intents');
        await environment.client.unsafe('DROP FUNCTION owned_anonymous_deadline_wait()');
        await environment.client.unsafe('DROP SEQUENCE owned_anonymous_deadline_seen');
      }
    });
    it(`${selected}: a selected binding is never treated as anonymous or mutated by an old anonymous finalizer`, async () => {
      const pending = await start(selected, 'canonical-token');
      const prepared = await prepare(pending);
      const exact = await candidate(prepared);
      const other = await environment.actor(selected, 'canonical-token');
      const login = await beginBrowserIntent(
        environment.database,
        environment.qualification,
        pending.bound.browser.bindingToken,
        { operation: 'login', expectedVersion: pending.bound.browser.expectedVersion },
      );
      if (login.status !== 'prepared') throw new Error('Owned competing login fixture failed');
      expect(
        (
          await commitBrowserLogin(
            environment.database,
            environment.qualification,
            pending.bound.browser.bindingToken,
            login.intentToken,
            other.credential,
          )
        ).status,
      ).toBe('committed');
      const before = await allRows();
      await expect(finalize(pending, prepared, exact)).rejects.toThrow();
      await expect(
        beginAnonymousProviderSignin(environment.database, environment.runtime, {
          browser: {
            bindingToken: pending.bound.browser.bindingToken,
            expectedVersion: pending.bound.browser.expectedVersion + 1,
          },
          provider: 'apple',
          credentialKind: 'canonical-token',
          flowHash: randomBytes(32).toString('hex'),
          nonceHash: null,
        }),
      ).rejects.toThrow();
      expect(await allRows()).toEqual(before);
    });
  }
});
