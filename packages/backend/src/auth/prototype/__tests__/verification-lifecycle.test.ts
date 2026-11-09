import { randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { APIError, createEmailVerificationToken } from 'better-auth/api';
import { decodeJwt, jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { PROTOTYPE_CONFIGURATION } from '../configuration';
import { createPrototypeLegacyHandler, revokePrototypeUser } from '../legacy-bridge';
import { createPrototypeLifecycleMutations, PROTOTYPE_LIFECYCLE_PATHS } from '../lifecycle-mutations';
import { PROTOTYPE_ISSUER } from '../oauth-options';
import {
  createPrototypeVerificationLifecycle,
  PROTOTYPE_VERIFICATION_PATHS,
  type PrototypeVerificationMessage,
} from '../verification-lifecycle';
import { parsePrototypeVerificationBinding, PROTOTYPE_CANONICAL_VERIFICATION_PREFIX } from '../verification-state';

const password = 'verification-fixture-password';
type VerificationOptions = Parameters<typeof createPrototypeVerificationLifecycle>[1];

describe('canonical new-link verification and resend lifecycle', () => {
  let environment: Awaited<ReturnType<typeof createPrototypeEnvironment>>;
  let authority: ReturnType<typeof environment.createAuthority>;
  let passwordHash: string;
  const delivered: PrototypeVerificationMessage[] = [];
  const stockDelivered: { userId: string; email: string; token: string }[] = [];

  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    passwordHash = await hash(password, 4);
    authority = environment.createAuthority({
      emailVerification: {
        expiresIn: 3600,
        async sendVerificationEmail({ user, token }) {
          stockDelivered.push({ userId: user.id, email: user.email, token });
        },
      },
    });
    await authority.$context;
  });
  beforeEach(() => {
    delivered.length = 0;
    stockDelivered.length = 0;
  });
  afterAll(async () => environment?.close());

  function facade(options: Partial<VerificationOptions> = {}) {
    return createPrototypeVerificationLifecycle(environment.database, {
      onVerificationIssued: (message) => {
        delivered.push(message);
      },
      ...options,
    });
  }

  async function fixture(
    options: { email?: string; verified?: boolean; verifiedAt?: Date | null; session?: 'fresh' | 'unknown' } = {},
  ) {
    const userId = randomUUID();
    const email = options.email ?? `verify-${userId}@example.test`;
    await environment.database.insert(environment.schema.user).values({
      id: userId,
      email,
      name: 'Verification fixture',
      emailVerified: options.verified ?? false,
      legacyEmailVerifiedAt: options.verifiedAt ?? null,
    });
    await environment.database
      .insert(environment.schema.account)
      .values({ id: randomUUID(), userId, providerId: 'credential', accountId: userId, password: passwordHash });
    let cookie = '';
    let sessionId: string | undefined;
    if (options.session) {
      const signedIn = await authority.api.signInEmail({ body: { email, password }, asResponse: true });
      expect(signedIn.status).toBe(200);
      cookie = signedIn.headers
        .getSetCookie()
        .filter((header) => header.includes('better-auth.session_token='))
        .map((header) => header.split(';')[0])
        .join('; ');
      const active = await authority.api.getSession({ headers: new Headers({ cookie }) });
      sessionId = active!.session.id;
      if (options.session === 'unknown')
        await environment.database
          .update(environment.schema.session)
          .set({
            createdAt: new Date(0),
            originalAuthenticatedAt: null,
            legacyLineageId: `credential:unknown-${userId}`,
          })
          .where(eq(environment.schema.session.id, sessionId));
    }
    return { userId, email, cookie, sessionId };
  }

  function sendRequest(email: string, cookie = '') {
    return new Request(`${PROTOTYPE_ISSUER}${PROTOTYPE_VERIFICATION_PATHS.send}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://www.boardsesh.test',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ email }),
    });
  }

  function verifyRequest(message: PrototypeVerificationMessage, cookie = '', changes: Record<string, string> = {}) {
    const url = new URL(message.url);
    for (const [key, changed] of Object.entries(changes)) url.searchParams.set(key, changed);
    return new Request(url, { headers: cookie ? { cookie } : {} });
  }

  async function issue(identity: { email: string; cookie?: string }, instance = facade()) {
    const beforeCount = delivered.length;
    const response = await instance.handler(sendRequest(identity.email, identity.cookie));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true });
    expect(delivered).toHaveLength(beforeCount + 1);
    return delivered[delivered.length - 1];
  }

  async function bindings(userId: string) {
    const records = await environment.database.select().from(environment.schema.verification);
    return records
      .map((record) => ({ record, binding: parsePrototypeVerificationBinding(record.value) }))
      .filter((entry) => entry.binding?.userId === userId);
  }

  async function user(userId: string) {
    return (
      await environment.database.select().from(environment.schema.user).where(eq(environment.schema.user.id, userId))
    )[0];
  }

  it('records actual stock delivery userId binding and stateless verification replay', async () => {
    const identity = await fixture();
    expect(
      (await authority.api.sendVerificationEmail({ body: { email: identity.email }, asResponse: true })).status,
    ).toBe(200);
    const emitted = stockDelivered[0];
    const claims = await jwtVerify(emitted.token, new TextEncoder().encode(PROTOTYPE_CONFIGURATION.secret), {
      algorithms: ['HS256'],
    });
    expect(claims.payload).toMatchObject({ userId: identity.userId, email: identity.email });
    expect((await authority.api.verifyEmail({ query: { token: emitted.token }, asResponse: true })).status).toBe(200);
    await environment.database
      .update(environment.schema.user)
      .set({ emailVerified: false })
      .where(eq(environment.schema.user.id, identity.userId));
    expect((await authority.api.verifyEmail({ query: { token: emitted.token }, asResponse: true })).status).toBe(200);
    expect((await user(identity.userId)).emailVerified).toBe(true);
  });

  it('records that actual same-second stock resend can emit the same signed JWT', async () => {
    const identity = await fixture({ session: 'fresh' });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now());
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(
          (
            await authority.api.sendVerificationEmail({
              headers: new Headers({ cookie: identity.cookie }),
              body: { email: identity.email },
              asResponse: true,
            })
          ).status,
        ).toBe(200);
      }
      expect(stockDelivered).toHaveLength(2);
      expect(stockDelivered[1].token).toBe(stockDelivered[0].token);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records that current stock user-bound tokens reject reassignment but optional email-only tokens do not', async () => {
    const original = await fixture();
    await authority.api.sendVerificationEmail({ body: { email: original.email } });
    const currentToken = stockDelivered[0].token;
    const emailOnlyToken = await createEmailVerificationToken(PROTOTYPE_CONFIGURATION.secret, original.email);
    await environment.database
      .update(environment.schema.user)
      .set({ email: `moved-${randomUUID()}@example.test` })
      .where(eq(environment.schema.user.id, original.userId));
    const reassigned = await fixture({ email: original.email });
    expect((await authority.api.verifyEmail({ query: { token: currentToken }, asResponse: true })).status).toBe(401);
    expect((await user(reassigned.userId)).emailVerified).toBe(false);
    expect((await authority.api.verifyEmail({ query: { token: emailOnlyToken }, asResponse: true })).status).toBe(200);
    expect((await user(reassigned.userId)).emailVerified).toBe(true);
    expect((await user(original.userId)).emailVerified).toBe(false);
  });

  it('records that the stock auto-sign-in option can create a fresh session from verification alone', async () => {
    const identity = await fixture({ session: 'unknown' });
    await authority.api.sendVerificationEmail({ body: { email: identity.email } });
    const stock = environment.createAuthority({ emailVerification: { autoSignInAfterVerification: true } });
    const verified = await stock.api.verifyEmail({ query: { token: stockDelivered[0].token }, asResponse: true });
    expect(verified.status).toBe(200);
    expect(verified.headers.getSetCookie().some((cookie) => cookie.includes('better-auth.session_token='))).toBe(true);
    const sessions = await environment.database
      .select()
      .from(environment.schema.session)
      .where(eq(environment.schema.session.userId, identity.userId));
    expect(sessions).toHaveLength(2);
    expect(sessions.some((session) => session.createdAt.getTime() > 0)).toBe(true);
  });

  it('binds a real delivered JWT and unique nonce to the original user, address, purpose and exact expiry', async () => {
    const identity = await fixture();
    const message = await issue(identity);
    const signed = await jwtVerify(message.token, new TextEncoder().encode(PROTOTYPE_CONFIGURATION.secret), {
      algorithms: ['HS256'],
    });
    expect(signed.payload).toMatchObject({ userId: identity.userId, email: identity.email });
    const [stored] = await bindings(identity.userId);
    expect(stored.binding).toMatchObject({
      userId: identity.userId,
      intendedEmail: identity.email,
      purpose: 'verify-current-email',
      consumedAt: null,
      supersededAt: null,
    });
    expect(stored.record.expiresAt.getTime()).toBe((signed.payload.exp as number) * 1000);
    expect(stored.record.identifier.startsWith(PROTOTYPE_CANONICAL_VERIFICATION_PREFIX)).toBe(true);
    expect(stored.record.value + stored.record.identifier).not.toContain(message.token);
    expect(stored.record.value + stored.record.identifier).not.toContain(message.nonce);
    const result = await facade().handler(verifyRequest(message));
    expect(result.status).toBe(200);
    expect(result.headers.getSetCookie()).toEqual([]);
    expect((await user(identity.userId)).emailVerified).toBe(true);
    expect((await user(identity.userId)).legacyEmailVerifiedAt).toBeNull();
    expect((await bindings(identity.userId))[0].binding?.consumedAt).not.toBeNull();
    expect((await facade().handler(verifyRequest(message))).status).toBe(400);
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, identity.userId)),
    ).toEqual([]);
  });

  it('retains an imported historical verification timestamp rather than rewriting its meaning', async () => {
    const historical = new Date('2024-02-03T04:05:06Z');
    const identity = await fixture({ verifiedAt: historical });
    const message = await issue(identity);
    expect((await facade().handler(verifyRequest(message))).status).toBe(200);
    expect((await user(identity.userId)).legacyEmailVerifiedAt).toEqual(historical);
  });

  it.each([1, 60])(
    'accepts actual issuer output with a %s-second clock-read pause without extending signed expiry',
    async (pause) => {
      const identity = await fixture();
      const issuedAt = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      let restoreExpiryClock: (() => void) | undefined;
      try {
        vi.setSystemTime(issuedAt);
        // The real public issuer uses jose's new Date() for iat, then reads
        // Date.now independently for exp. Only those clock reads are controlled.
        const expiryClock = vi.spyOn(Date, 'now').mockReturnValue(issuedAt + pause * 1000);
        restoreExpiryClock = () => expiryClock.mockRestore();
        const message = await issue(identity);
        expiryClock.mockRestore();
        restoreExpiryClock = undefined;
        const claims = decodeJwt(message.token);
        expect(claims.exp! - claims.iat!).toBe(3600 + pause);
        const exactExpiry = claims.exp! * 1000;
        expect((await bindings(identity.userId))[0].record.expiresAt.getTime()).toBe(exactExpiry);
        vi.setSystemTime(exactExpiry + 1);
        expect((await facade().handler(verifyRequest(message))).status).toBe(400);
        expect((await user(identity.userId)).emailVerified).toBe(false);
      } finally {
        restoreExpiryClock?.();
        vi.useRealTimers();
      }
    },
  );

  it('rejects actual issuer output beyond the bounded 60-second encoder-read allowance', async () => {
    const identity = await fixture();
    const issuedAt = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    const expiryClock = vi.spyOn(Date, 'now').mockReturnValue(issuedAt + 61_000);
    try {
      vi.setSystemTime(issuedAt);
      expect((await facade().handler(sendRequest(identity.email))).status).toBe(500);
      expect(delivered).toEqual([]);
      expect(await bindings(identity.userId)).toEqual([]);
    } finally {
      expiryClock.mockRestore();
      vi.useRealTimers();
    }
  });

  it('normalizes an unambiguous historical address with the exact shared JavaScript policy', async () => {
    const storedEmail = `\t\u00a0MiXeD-${randomUUID()}@Example.Test\u00a0\t`;
    const identity = await fixture({ email: storedEmail });
    const message = await issue({ email: storedEmail });
    expect(message.email).toBe(storedEmail.trim().toLowerCase());
    expect((await facade().handler(verifyRequest(message))).status).toBe(200);
    expect((await user(identity.userId)).email).toBe(storedEmail);
    expect((await user(identity.userId)).emailVerified).toBe(true);
  });

  it.each(['case', 'tab', 'nbsp'] as const)(
    'refuses arbitrary owner selection when sending to a %s-normalized collision',
    async (variant) => {
      const original = await fixture();
      const collisionEmail =
        variant === 'case'
          ? original.email.toUpperCase()
          : variant === 'tab'
            ? `\t${original.email}\t`
            : `\u00a0${original.email}\u00a0`;
      const collision = await fixture({ email: collisionEmail });
      const result = await facade().handler(sendRequest(original.email));
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ status: true });
      expect(delivered).toEqual([]);
      expect(await bindings(original.userId)).toEqual([]);
      expect(await bindings(collision.userId)).toEqual([]);
    },
  );

  it.each(['case', 'tab', 'nbsp'] as const)(
    'fails closed when a %s-normalized collision appears before redemption',
    async (variant) => {
      const original = await fixture();
      const message = await issue(original);
      const collisionEmail =
        variant === 'case'
          ? original.email.toUpperCase()
          : variant === 'tab'
            ? `\t${original.email}\t`
            : `\u00a0${original.email}\u00a0`;
      const collision = await fixture({ email: collisionEmail });
      expect((await facade().handler(verifyRequest(message))).status).toBe(400);
      expect((await user(original.userId)).emailVerified).toBe(false);
      expect((await user(collision.userId)).emailVerified).toBe(false);
    },
  );

  it('returns the same anonymous success shape for unknown and already-verified addresses', async () => {
    const verified = await fixture({ verified: true, verifiedAt: new Date('2024-01-01T00:00:00Z') });
    for (const email of ['unknown-verification@example.test', verified.email]) {
      const result = await facade().handler(sendRequest(email));
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ status: true });
    }
    expect(delivered).toEqual([]);
  });

  it('rejects another signed-in account without consuming the mailbox proof or switching sessions', async () => {
    const original = await fixture();
    const another = await fixture({ session: 'fresh' });
    const message = await issue(original);
    expect((await facade().handler(verifyRequest(message, another.cookie))).status).toBe(403);
    expect((await user(original.userId)).emailVerified).toBe(false);
    expect((await bindings(original.userId))[0].binding?.consumedAt).toBeNull();
    expect((await facade().handler(verifyRequest(message))).status).toBe(200);
    expect((await authority.api.getSession({ headers: new Headers({ cookie: another.cookie }) }))?.user.id).toBe(
      another.userId,
    );
    const unknown = await facade().handler(sendRequest('unknown-foreign-address@example.test', another.cookie));
    const known = await facade().handler(sendRequest(original.email, another.cookie));
    expect(unknown.status).toBe(400);
    expect(known.status).toBe(400);
    expect(await unknown.json()).toEqual(await known.json());
  });

  it.each(['changed-address', 'deleted-owner', 'reassigned-address'] as const)(
    'does not verify a different owner after %s',
    async (change) => {
      const original = await fixture();
      const message = await issue(original);
      if (change === 'deleted-owner')
        await environment.database
          .delete(environment.schema.user)
          .where(eq(environment.schema.user.id, original.userId));
      else
        await environment.database
          .update(environment.schema.user)
          .set({ email: `changed-${randomUUID()}@example.test` })
          .where(eq(environment.schema.user.id, original.userId));
      const newOwner = change === 'changed-address' ? undefined : await fixture({ email: original.email });
      expect((await facade().handler(verifyRequest(message))).status).toBe(400);
      if (change !== 'deleted-owner') expect((await user(original.userId)).emailVerified).toBe(false);
      if (newOwner) expect((await user(newOwner.userId)).emailVerified).toBe(false);
    },
  );

  it('preserves unknown authentication age and disables auto-sign-in even when supplied as an override', async () => {
    const identity = await fixture({ session: 'unknown' });
    const guarded = facade({ authority: { emailVerification: { autoSignInAfterVerification: true } } });
    const message = await issue(identity, guarded);
    const verified = await guarded.handler(verifyRequest(message, identity.cookie));
    expect(verified.status).toBe(200);
    expect(verified.headers.getSetCookie()).toEqual([]);
    const sessions = await environment.database
      .select()
      .from(environment.schema.session)
      .where(eq(environment.schema.session.userId, identity.userId));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(identity.sessionId);
    expect(sessions[0].createdAt).toEqual(new Date(0));
    expect(sessions[0].originalAuthenticatedAt).toBeNull();
    expect(
      (
        await authority.handler(
          new Request(`${PROTOTYPE_ISSUER}/list-sessions`, { headers: { cookie: identity.cookie } }),
        )
      ).status,
    ).toBe(403);
  });

  it('supersedes an older receipt even when two real issuer tokens are identical in one second', async () => {
    const identity = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now());
      const first = await issue(identity);
      const second = await issue(identity, facade());
      expect(second.token).toBe(first.token);
      expect(second.nonce).not.toBe(first.nonce);
      expect((await facade().handler(verifyRequest(first))).status).toBe(400);
      expect((await facade().handler(verifyRequest(second))).status).toBe(200);
      expect((await bindings(identity.userId)).filter((entry) => entry.binding?.supersededAt !== null)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows one concurrent redemption across independent authorities and retains the tombstone after recreation', async () => {
    const identity = await fixture();
    const message = await issue(identity);
    const results = await Promise.all([
      facade().handler(verifyRequest(message)),
      facade().handler(verifyRequest(message)),
    ]);
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(results.filter((result) => result.status === 400)).toHaveLength(1);
    await environment.database
      .update(environment.schema.user)
      .set({ emailVerified: false })
      .where(eq(environment.schema.user.id, identity.userId));
    expect((await facade().handler(verifyRequest(message))).status).toBe(400);
    expect((await user(identity.userId)).emailVerified).toBe(false);
  });

  it('serializes concurrent resends and only the latest committed receipt remains usable', async () => {
    const identity = await fixture();
    const results = await Promise.all([
      facade().handler(sendRequest(identity.email)),
      facade().handler(sendRequest(identity.email)),
    ]);
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(delivered).toHaveLength(2);
    const stored = await bindings(identity.userId);
    const latest = stored.find((entry) => entry.binding?.supersededAt === null)!;
    const candidates = await Promise.all(delivered.map((message) => facade().handler(verifyRequest(message))));
    expect(candidates.filter((result) => result.status === 200)).toHaveLength(1);
    expect(candidates.filter((result) => result.status === 400)).toHaveLength(1);
    expect(
      (await bindings(identity.userId)).find((entry) => entry.record.id === latest.record.id)?.binding?.consumedAt,
    ).not.toBeNull();
  });

  it('rejects wrong nonces, signed tokens for another purpose, email-only tokens and malformed receipt metadata', async () => {
    const identity = await fixture();
    const message = await issue(identity);
    expect((await facade().handler(verifyRequest(message, '', { nonce: '0'.repeat(64) }))).status).toBe(400);
    const emailOnly = await createEmailVerificationToken(PROTOTYPE_CONFIGURATION.secret, identity.email);
    expect((await facade().handler(verifyRequest(message, '', { token: emailOnly }))).status).toBe(400);
    const otherPurpose = await createEmailVerificationToken(
      PROTOTYPE_CONFIGURATION.secret,
      identity.email,
      undefined,
      3600,
      { userId: identity.userId, purpose: 'password-reset' },
    );
    expect((await facade().handler(verifyRequest(message, '', { token: otherPurpose }))).status).toBe(400);
    const [stored] = await bindings(identity.userId);
    await environment.database
      .update(environment.schema.verification)
      .set({ value: JSON.stringify({ ...stored.binding, purpose: 'password-reset' }) })
      .where(eq(environment.schema.verification.id, stored.record.id));
    expect((await facade().handler(verifyRequest(message))).status).toBe(400);
    expect((await user(identity.userId)).emailVerified).toBe(false);
  });

  it('does not extend the exact signed expiry through delivery mutation or a later request', async () => {
    const identity = await fixture();
    const message = await issue(identity);
    const originalExpiry = Number(decodeJwt(message.token).exp) * 1000;
    message.expiresAt.setTime(originalExpiry + 24 * 60 * 60 * 1000);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(originalExpiry + 1);
      expect((await facade().handler(verifyRequest(message))).status).toBe(400);
      expect((await bindings(identity.userId))[0].record.expiresAt.getTime()).toBe(originalExpiry);
      expect((await user(identity.userId)).emailVerified).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a nonce collision without overwriting the first receipt', async () => {
    const identity = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now());
      const first = await issue(identity, facade({ createNonce: () => 'a'.repeat(64) }));
      const nonces = ['a'.repeat(64), 'b'.repeat(64)];
      const second = await issue(identity, facade({ createNonce: () => nonces.shift()! }));
      expect(second.nonce).toBe('b'.repeat(64));
      expect(await bindings(identity.userId)).toHaveLength(2);
      expect((await facade().handler(verifyRequest(first))).status).toBe(400);
      expect((await facade().handler(verifyRequest(second))).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['nonce-collision', 'false-receipt-create'] as const)(
    'rolls back %s issuance and delivers no uncommitted replacement link',
    async (failure) => {
      const identity = await fixture();
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now());
        const first = await issue(identity, facade({ createNonce: () => 'a'.repeat(64) }));
        const failing =
          failure === 'nonce-collision'
            ? facade({ createNonce: () => 'a'.repeat(64) })
            : facade({
                authority: {
                  databaseHooks: {
                    verification: {
                      create: {
                        async before() {
                          return false;
                        },
                      },
                    },
                  },
                },
              });
        const result = await failing.handler(sendRequest(identity.email));
        expect(result.status).toBe(500);
        expect(delivered).toHaveLength(1);
        expect(await bindings(identity.userId)).toHaveLength(1);
        expect((await bindings(identity.userId))[0].binding?.supersededAt).toBeNull();
        expect((await facade().handler(verifyRequest(first))).status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('rolls back verification and receipt consumption on a post-update failure', async () => {
    const identity = await fixture();
    const message = await issue(identity);
    const failing = facade({
      authority: {
        emailVerification: {
          async afterEmailVerification() {
            throw new Error('Synthetic verification commit failure');
          },
        },
      },
    });
    const result = await failing.handler(verifyRequest(message));
    expect(result.status).toBe(500);
    expect(result.headers.getSetCookie()).toEqual([]);
    expect((await user(identity.userId)).emailVerified).toBe(false);
    expect((await bindings(identity.userId))[0].binding?.consumedAt).toBeNull();
    expect((await facade().handler(verifyRequest(message))).status).toBe(200);
  });

  it('rolls back receipt consumption when the supported authority update is cancelled', async () => {
    const identity = await fixture();
    const message = await issue(identity);
    const cancelled = facade({
      authority: {
        databaseHooks: {
          user: {
            update: {
              async before() {
                return false;
              },
            },
          },
        },
      },
    });
    expect((await cancelled.handler(verifyRequest(message))).status).toBe(500);
    expect((await user(identity.userId)).emailVerified).toBe(false);
    expect((await bindings(identity.userId))[0].binding?.consumedAt).toBeNull();
    expect((await facade().handler(verifyRequest(message))).status).toBe(200);
  });

  it('runs configured verification policy hooks for the immutable owner inside the receipt transaction', async () => {
    const identity = await fixture();
    const message = await issue(identity);
    const observed: string[] = [];
    const guarded = facade({
      authority: {
        emailVerification: {
          async beforeEmailVerification(selected) {
            observed.push(`before:${selected.id}`);
          },
          async afterEmailVerification(selected) {
            observed.push(`after:${selected.id}`);
          },
        },
      },
    });
    expect((await guarded.handler(verifyRequest(message))).status).toBe(200);
    expect(observed).toEqual([`before:${identity.userId}`, `after:${identity.userId}`]);
    expect((await bindings(identity.userId))[0].binding?.consumedAt).not.toBeNull();
  });

  it('rolls back receipt consumption when the public verification policy hook rejects the operation', async () => {
    const identity = await fixture();
    const message = await issue(identity);
    const rejected = facade({
      authority: {
        emailVerification: {
          async beforeEmailVerification() {
            throw new APIError('FORBIDDEN', { code: 'SYNTHETIC_VERIFICATION_POLICY' });
          },
        },
      },
    });
    expect((await rejected.handler(verifyRequest(message))).status).toBe(403);
    expect((await user(identity.userId)).emailVerified).toBe(false);
    expect((await bindings(identity.userId))[0].binding?.consumedAt).toBeNull();
    expect((await facade().handler(verifyRequest(message))).status).toBe(200);
  });

  it('does not let mutable policy-hook user snapshots reassign the receipt owner or address', async () => {
    const original = await fixture();
    const another = await fixture();
    const message = await issue(original);
    const observed: string[] = [];
    const guarded = facade({
      authority: {
        emailVerification: {
          async beforeEmailVerification(selected) {
            selected.id = another.userId;
            selected.email = another.email;
          },
          async afterEmailVerification(selected) {
            observed.push(selected.id);
            selected.id = another.userId;
            selected.email = another.email;
          },
        },
      },
    });
    expect((await guarded.handler(verifyRequest(message))).status).toBe(200);
    expect(observed).toEqual([original.userId]);
    expect((await user(original.userId)).email).toBe(original.email);
    expect((await user(original.userId)).emailVerified).toBe(true);
    expect((await user(another.userId)).email).toBe(another.email);
    expect((await user(another.userId)).emailVerified).toBe(false);
    expect((await bindings(original.userId))[0].binding?.consumedAt).not.toBeNull();
  });

  it('captures request headers before waiting for the shared lifecycle fence', async () => {
    const identity = await fixture();
    const other = await fixture({ session: 'fresh' });
    const message = await issue(identity);
    let announceEntered!: () => void;
    let releaseFence!: () => void;
    const entered = new Promise<void>((resolve) => {
      announceEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const held = environment.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975, 1)`);
      announceEntered();
      await released;
    });
    await Promise.race([entered, held]);
    const request = verifyRequest(message);
    const verifying = facade().handler(request);
    // The in-flight operation must retain its original unauthenticated context;
    // changing this caller-owned Request cannot inject another account later.
    request.headers.set('cookie', other.cookie);
    releaseFence();
    const [, response] = await Promise.all([held, verifying]);
    expect(response.status).toBe(200);
    expect((await user(identity.userId)).emailVerified).toBe(true);
    expect((await user(other.userId)).emailVerified).toBe(false);
    expect((await authority.api.getSession({ headers: new Headers({ cookie: other.cookie }) }))?.user.id).toBe(
      other.userId,
    );
  });

  it('publishes a receipt only after commit, so another instance can immediately consume it', async () => {
    const identity = await fixture();
    let deliveredStatus = 0;
    const receiving = facade();
    const sending = facade({
      async onVerificationIssued(message) {
        deliveredStatus = (await receiving.handler(verifyRequest(message))).status;
      },
    });
    expect((await sending.handler(sendRequest(identity.email))).status).toBe(200);
    expect(deliveredStatus).toBe(200);
    expect((await user(identity.userId)).emailVerified).toBe(true);
  });

  it('keeps anonymous response generic if post-commit fixture delivery fails and permits resend', async () => {
    const identity = await fixture();
    const failingDelivery = facade({
      onVerificationIssued() {
        throw new Error('Synthetic external delivery failure');
      },
    });
    const result = await failingDelivery.handler(sendRequest(identity.email));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ status: true });
    const replacement = await issue(identity);
    expect((await facade().handler(verifyRequest(replacement))).status).toBe(200);
  });

  it('supersedes canonical receipts during actual password change while allowing a new post-mutation link', async () => {
    const identity = await fixture({ session: 'fresh' });
    const message = await issue(identity);
    const changed = await createPrototypeLifecycleMutations(environment.database).handler(
      new Request(`${PROTOTYPE_ISSUER}${PROTOTYPE_LIFECYCLE_PATHS.changePassword}`, {
        method: 'POST',
        headers: { cookie: identity.cookie, origin: 'https://www.boardsesh.test', 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: password, newPassword: 'new-canonical-verification-password' }),
      }),
    );
    expect(changed.status).toBe(200);
    expect((await facade().handler(verifyRequest(message))).status).toBe(400);
    const next = await issue({ email: identity.email });
    expect((await facade().handler(verifyRequest(next))).status).toBe(200);
  });

  it('supersedes canonical receipts during actual forgotten reset without creating a login session', async () => {
    const identity = await fixture();
    const message = await issue(identity);
    let resetToken = '';
    const resetAuthority = environment.createAuthority({
      emailAndPassword: {
        ...PROTOTYPE_CONFIGURATION.emailAndPassword,
        async sendResetPassword({ token }) {
          resetToken = token;
        },
      },
    });
    await resetAuthority.api.requestPasswordReset({ body: { email: identity.email } });
    const reset = await createPrototypeLegacyHandler(environment.database)(
      new Request(`${PROTOTYPE_ISSUER}/reset-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://www.boardsesh.test' },
        body: JSON.stringify({ token: resetToken, newPassword: 'forgotten-reset-verification-password' }),
      }),
    );
    expect(reset.status).toBe(200);
    expect((await facade().handler(verifyRequest(message))).status).toBe(400);
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, identity.userId)),
    ).toEqual([]);
  });

  it('preserves an issued mailbox proof across ordinary account signout', async () => {
    const identity = await fixture({ session: 'fresh' });
    const message = await issue(identity);
    await environment.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975, 1)`);
      await revokePrototypeUser(transaction, identity.userId, false);
    });
    expect((await facade().handler(verifyRequest(message))).status).toBe(200);
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, identity.userId)),
    ).toEqual([]);
  });
});
