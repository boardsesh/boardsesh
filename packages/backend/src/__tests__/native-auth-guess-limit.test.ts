import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hash } from 'bcryptjs';
import { inArray } from 'drizzle-orm';
import { userCredentials, users } from '@boardsesh/db/schema/auth';
import { DEVICE_TOKEN_SECRET_ENV } from '@boardsesh/auth-protocol/device-token';
import { NATIVE_V1_DEVICE_TOKEN_HEADER } from '@boardsesh/auth-protocol/native-v1';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import {
  __resetPasswordGuessLimitStateForTests,
  __setPasswordGuessLimiterForTests,
  createPasswordGuessLimiter,
  passwordGuessLimitMetrics,
  type AccountGuessLimitMode,
} from '../auth/password-guess-limit';
import { PASSWORD_GUESS_EMAIL_KEY_ENV, type PasswordGuessStore } from '../auth/password-guess-windows';

process.env.NEXTAUTH_SECRET ??= 'boardsesh-test-session-identity-secret';
process.env[DEVICE_TOKEN_SECRET_ENV] = randomBytes(32).toString('hex');
process.env[PASSWORD_GUESS_EMAIL_KEY_ENV] = randomBytes(32).toString('hex');

const { handleNativeAuthCredentials, __resetNativeAuthStateForTests } = await import('../handlers/native-auth');

const PASSWORD = 'the-owners-password';
const createdUserIds: string[] = [];

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly retryAfter: string | undefined;
}

/** One native credentials request from `address`, through the real handler. */
async function signIn(address: string, email: string, password: string, deviceToken?: string): Promise<Reply> {
  const request = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: '/auth/native/credentials',
    headers: deviceToken ? { [NATIVE_V1_DEVICE_TOKEN_HEADER]: deviceToken } : {},
    socket: { remoteAddress: address },
    destroy: () => undefined,
  });
  setImmediate(() => {
    request.emit('data', Buffer.from(JSON.stringify({ email, password }), 'utf8'));
    request.emit('end');
  });
  let status = 0;
  let body = '';
  const headers: Record<string, unknown> = {};
  const response = {
    writeHead(code: number, extra?: Record<string, unknown>) {
      status = code;
      if (extra) Object.assign(headers, extra);
    },
    end(text?: string) {
      if (text !== undefined) body = text;
    },
    setHeader(name: string, value: unknown) {
      headers[name] = value;
    },
  };
  await handleNativeAuthCredentials(request as unknown as IncomingMessage, response as unknown as ServerResponse);
  const retryAfter = headers['Retry-After'];
  return {
    status,
    body: JSON.parse(body) as Record<string, unknown>,
    retryAfter: typeof retryAfter === 'string' ? retryAfter : undefined,
  };
}

async function createAccount() {
  const userId = randomUUID();
  const email = `native-guess-${userId}@example.test`;
  await db.insert(users).values({ id: userId, email, name: 'Native guess limit' });
  await db.insert(userCredentials).values({ userId, passwordHash: await hash(PASSWORD, 4) });
  createdUserIds.push(userId);
  return { userId, email };
}

function useLimiter(mode: AccountGuessLimitMode, store: PasswordGuessStore = db) {
  // Mid-hour, so a run never straddles an hour edge.
  const now = () => new Date('2026-11-17T10:15:00.000Z');
  __setPasswordGuessLimiterForTests(createPasswordGuessLimiter({ mode, store: () => store, now, deadlineMs: 5_000 }));
}

/** 25 addresses, each under the per-address limit, together far over the account's. */
const ATTACKER_ADDRESSES = Array.from({ length: 25 }, (_, index) => `203.0.113.${index + 1}`);

async function attack(email: string) {
  const replies: Reply[] = [];
  for (const address of ATTACKER_ADDRESSES) replies.push(await signIn(address, email, 'wrong-guess'));
  return replies;
}

describe('native credentials and the per-account guess limit (#7656)', () => {
  beforeEach(() => {
    __resetNativeAuthStateForTests();
    __resetPasswordGuessLimitStateForTests();
  });
  afterEach(() => {
    __setPasswordGuessLimiterForTests(undefined);
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  });

  it('enforce: holds an attacker on 25 addresses at the cap while the owner with a device token signs in', async () => {
    useLimiter('enforce');
    const { userId, email } = await createAccount();
    // The owner signed in on this phone before the attack and kept its token.
    const earlier = await signIn('198.51.100.7', email, PASSWORD);
    expect(earlier.status).toBe(200);
    const deviceToken = earlier.body.deviceToken;
    if (typeof deviceToken !== 'string') throw new Error('Expected a device token');

    const replies = await attack(email);
    expect(replies.slice(0, 10).map(({ status }) => status)).toEqual(Array(10).fill(401));
    expect(replies.slice(10).map(({ status }) => status)).toEqual(Array(15).fill(429));
    const refused = replies[24];
    // The shape released apps already handle for the per-address limit.
    expect(refused.body).toEqual({ error: `Rate limit exceeded. Try again in ${refused.retryAfter} seconds.` });
    expect(Number(refused.retryAfter)).toBeGreaterThanOrEqual(1);

    const owner = await signIn('198.51.100.7', email, PASSWORD, deviceToken);
    expect(owner.status).toBe(200);
    expect(typeof owner.body.jwt).toBe('string');
    expect(passwordGuessLimitMetrics().deviceRecognised).toBe(1);

    // The same owner on a new phone has no token and waits like everyone else.
    expect((await signIn('198.51.100.8', email, PASSWORD)).status).toBe(429);
    // A token for this account names this account only.
    const stranger = await createAccount();
    const strangerToken = (await signIn('198.51.100.9', stranger.email, PASSWORD)).body.deviceToken;
    expect(typeof strangerToken).toBe('string');
    expect((await signIn('198.51.100.9', email, PASSWORD, String(strangerToken))).status).toBe(429);
    expect(userId).not.toBe(stranger.userId);
  });

  it('observe: refuses nobody, counts what it would have refused', async () => {
    useLimiter('observe');
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { email } = await createAccount();
    // The right password at first uses no guess.
    expect((await signIn('198.51.100.9', email, PASSWORD)).status).toBe(200);
    const replies = await attack(email);
    expect(replies.map(({ status }) => status)).toEqual(Array(25).fill(401));
    expect(passwordGuessLimitMetrics().wouldRefuse).toBe(15);
    // The owner on a new phone is not refused in observe.
    expect((await signIn('198.51.100.10', email, PASSWORD)).status).toBe(200);
    expect(passwordGuessLimitMetrics().wouldRefuseThenAccepted).toBe(1);
  });

  it('answers a known and an unknown address with the same statuses, bodies and headers', async () => {
    useLimiter('enforce');
    const { email: known } = await createAccount();
    const unknown = `nobody-${randomUUID()}@example.test`;
    const summarize = (replies: Reply[]) =>
      replies.map(({ status, body, retryAfter }) => ({ status, body, retryAfter: retryAfter !== undefined }));
    const knownReplies = await attack(known);
    __resetNativeAuthStateForTests();
    const unknownReplies = await attack(unknown);
    expect(summarize(unknownReplies)).toEqual(summarize(knownReplies));
  });

  it('lets sign-in proceed when the counter store is down', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    useLimiter('enforce', {
      transaction: () => Promise.reject(new Error('connection refused')),
    } as unknown as PasswordGuessStore);
    const { email } = await createAccount();
    for (let attempt = 0; attempt < 12; attempt += 1)
      expect((await signIn(`192.0.2.${attempt + 1}`, email, 'wrong-guess')).status).toBe(401);
    expect((await signIn('192.0.2.100', email, PASSWORD)).status).toBe(200);
    expect(passwordGuessLimitMetrics().failOpen).toBe(13);
  });

  it('off: no counter, no change', async () => {
    useLimiter('off', { transaction: vi.fn() } as unknown as PasswordGuessStore);
    const { email } = await createAccount();
    const replies = await attack(email);
    expect(replies.map(({ status }) => status)).toEqual(Array(25).fill(401));
  });
});
