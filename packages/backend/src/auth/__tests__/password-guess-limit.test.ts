import { randomBytes, randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { userCredentials, users } from '@boardsesh/db/schema/auth';
import { DEVICE_TOKEN_SECRET_ENV, mintDeviceToken } from '@boardsesh/auth-protocol/device-token';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { db } from '../../db/client';
import { logger } from '../../utils/logger';
import {
  __resetPasswordGuessLimitStateForTests,
  ACCOUNT_GUESS_LIMIT_ENFORCE_BLOCKERS,
  ACCOUNT_GUESS_LIMIT_MODE_ENV,
  accountGuessLimitMode,
  assertAccountGuessLimitConfiguration,
  createPasswordGuessLimiter,
  parseAccountGuessLimitMode,
  passwordGuessLimitMetrics,
  type AccountGuessLimitMode,
  type PasswordGuessAdmission,
} from '../password-guess-limit';
import { PASSWORD_GUESS_POOL_MAX_ENV } from '../password-guess-pool';
import {
  __resetPasswordGuessStateForTests,
  PASSWORD_GUESS_EMAIL_KEY_ENV,
  passwordGuessMetrics,
  type PasswordGuessStore,
} from '../password-guess-windows';

const DEVICE_SECRET = randomBytes(32).toString('hex');
const environment = {
  [PASSWORD_GUESS_EMAIL_KEY_ENV]: randomBytes(32).toString('hex'),
  [DEVICE_TOKEN_SECRET_ENV]: DEVICE_SECRET,
};
const createdUserIds: string[] = [];

/** Mid-hour, so a run never straddles an hour edge. */
const MID_HOUR = () => new Date('2026-11-17T10:15:00.000Z');

function limiter(mode: AccountGuessLimitMode, store: PasswordGuessStore = db) {
  // A loaded test machine must not turn a counting test into a fail-open one; the fail-open tests use failing stores.
  return createPasswordGuessLimiter({ mode, store: () => store, environment, now: MID_HOUR, deadlineMs: 5_000 });
}

async function createAccount(passwordChangedAt = new Date()) {
  const userId = randomUUID();
  const email = `guess-limit-${userId}@example.test`;
  await db.insert(users).values({ id: userId, email, name: 'Guess limit' });
  await db.insert(userCredentials).values({ userId, passwordHash: 'not-compared-here', updatedAt: passwordChangedAt });
  createdUserIds.push(userId);
  return { userId, email };
}

async function deviceTokenFor(userId: string, issuedAt = new Date()) {
  return (await mintDeviceToken({ userId, secret: DEVICE_SECRET, now: issuedAt })).token;
}

/** One sign-in with a wrong password: admit, then settle as rejected. */
async function wrongPassword(
  guard: ReturnType<typeof limiter>,
  email: string,
  deviceToken?: string,
): Promise<PasswordGuessAdmission['outcome']> {
  const admission = await guard.admit({ email, deviceToken });
  if (admission.outcome === 'proceed') await admission.settle('rejected');
  return admission.outcome;
}

describe('account guess limit mode (#7656)', () => {
  it('reads unset and empty as off, and refuses an unknown value', () => {
    expect(parseAccountGuessLimitMode({})).toBe('off');
    expect(parseAccountGuessLimitMode({ [ACCOUNT_GUESS_LIMIT_MODE_ENV]: '' })).toBe('off');
    expect(parseAccountGuessLimitMode({ [ACCOUNT_GUESS_LIMIT_MODE_ENV]: 'off' })).toBe('off');
    expect(parseAccountGuessLimitMode({ [ACCOUNT_GUESS_LIMIT_MODE_ENV]: 'observe' })).toBe('observe');
    for (const typo of ['Observe', 'on', 'true', ' enforce'])
      expect(() => parseAccountGuessLimitMode({ [ACCOUNT_GUESS_LIMIT_MODE_ENV]: typo })).toThrow(
        'Invalid AUTH_ACCOUNT_GUESS_LIMIT_MODE',
      );
  });

  it('keeps enforce behind a code gate no environment value opens', () => {
    expect(ACCOUNT_GUESS_LIMIT_ENFORCE_BLOCKERS).toEqual([
      'FORCED_FAIL_OPEN_CLOSURE_UNPROVEN_IN_PRODUCTION_OBSERVE',
      'RESET_DOES_NOT_RESCUE_NATIVE_OWNER',
      'PASSWORD_CHANGE_TIME_IGNORES_AUTHORITY',
      'CROSS_SUBJECT_POOL_SATURATION',
    ]);
    expect(() => accountGuessLimitMode({ [ACCOUNT_GUESS_LIMIT_MODE_ENV]: 'enforce' })).toThrow(
      'ACCOUNT_GUESS_LIMIT_ENFORCE_BLOCKED',
    );
    expect(() => assertAccountGuessLimitConfiguration({ [ACCOUNT_GUESS_LIMIT_MODE_ENV]: 'enforce' })).toThrow();
    expect(accountGuessLimitMode({ [ACCOUNT_GUESS_LIMIT_MODE_ENV]: 'enforce' }, [])).toBe('enforce');
    expect(() => assertAccountGuessLimitConfiguration({ [ACCOUNT_GUESS_LIMIT_MODE_ENV]: 'observe' })).not.toThrow();
  });

  it('refuses a pool size that is not 1 to 4', () => {
    expect(() => assertAccountGuessLimitConfiguration({ [PASSWORD_GUESS_POOL_MAX_ENV]: '3' })).not.toThrow();
    for (const size of ['0', '5', 'two', '2.5', '-1'])
      expect(() => assertAccountGuessLimitConfiguration({ [PASSWORD_GUESS_POOL_MAX_ENV]: size })).toThrow(
        'Invalid AUTH_ACCOUNT_GUESS_LIMIT_POOL_MAX',
      );
  });
});

describe('account guess limit against Postgres (#7656)', () => {
  beforeEach(() => {
    __resetPasswordGuessLimitStateForTests();
    __resetPasswordGuessStateForTests();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  });

  it('touches nothing when off', async () => {
    const store = { transaction: vi.fn() } as unknown as PasswordGuessStore;
    const admission = await limiter('off', store).admit({ email: 'anyone@example.test' });
    expect(admission.outcome).toBe('proceed');
    expect(store.transaction).not.toHaveBeenCalled();
  });

  it('refuses the 11th wrong password in an hour in enforce, the same for a known and an unknown address', async () => {
    const guard = limiter('enforce');
    const { email: known } = await createAccount();
    const unknown = `nobody-${randomUUID()}@example.test`;
    for (const email of [known, unknown]) {
      const outcomes = [];
      for (let attempt = 0; attempt < 11; attempt += 1) outcomes.push(await wrongPassword(guard, email));
      expect(outcomes).toEqual([...Array(10).fill('proceed'), 'refused']);
      const refused = await guard.admit({ email });
      expect(refused).toMatchObject({ outcome: 'refused' });
      if (refused.outcome === 'refused') {
        expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(refused.retryAfterSeconds).toBeLessThanOrEqual(3600);
      }
    }
  });

  it('never refuses in observe, and counts a would-be refusal that then succeeds without a line per attempt', async () => {
    const guard = limiter('observe');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const { email } = await createAccount();
    for (let attempt = 0; attempt < 15; attempt += 1) expect(await wrongPassword(guard, email)).toBe('proceed');
    expect(passwordGuessLimitMetrics().wouldRefuse).toBe(5);
    const owner = await guard.admit({ email });
    expect(owner.outcome).toBe('proceed');
    if (owner.outcome === 'proceed') await owner.settle('accepted');
    expect(passwordGuessLimitMetrics().wouldRefuseThenAccepted).toBe(1);
    // An account holder repeating "10 wrong, then right" adds to a count, never a log line each.
    for (let round = 0; round < 3; round += 1) {
      const again = await guard.admit({ email });
      if (again.outcome === 'proceed') await again.settle('accepted');
    }
    expect(passwordGuessLimitMetrics().wouldRefuseThenAccepted).toBe(4);
    expect(warn).not.toHaveBeenCalled();
    // The once-a-minute activity line carries the counts.
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ type: 'password_guess_limit' }));
  });

  it('gives a right password back, so the owner never uses up the budget', async () => {
    const guard = limiter('enforce');
    const { email } = await createAccount();
    for (let attempt = 0; attempt < 9; attempt += 1) await wrongPassword(guard, email);
    for (let signIn = 0; signIn < 5; signIn += 1) {
      const admission = await guard.admit({ email });
      expect(admission.outcome).toBe('proceed');
      if (admission.outcome === 'proceed') await admission.settle('accepted');
    }
    expect(await wrongPassword(guard, email)).toBe('proceed');
    expect(await wrongPassword(guard, email)).toBe('refused');
  });

  it('lets the owner with a device token sign in while an attacker holds the email at its cap', async () => {
    const guard = limiter('enforce');
    const { userId, email } = await createAccount();
    for (let attempt = 0; attempt < 12; attempt += 1) await wrongPassword(guard, email);
    expect((await guard.admit({ email })).outcome).toBe('refused');
    const owner = await guard.admit({ email, deviceToken: await deviceTokenFor(userId) });
    expect(owner.outcome).toBe('proceed');
    if (owner.outcome === 'proceed') await owner.settle('accepted');
    expect(passwordGuessLimitMetrics().deviceRecognised).toBe(1);
    // The owner's own typo on a recognised device is not refused for the email either.
    expect(await wrongPassword(guard, email, await deviceTokenFor(userId))).toBe('proceed');
  });

  it('ignores a token minted for another account, a forged one, and one older than the last password change', async () => {
    const guard = limiter('enforce');
    const { email } = await createAccount();
    const other = await createAccount();
    for (let attempt = 0; attempt < 10; attempt += 1) await wrongPassword(guard, email);
    expect((await guard.admit({ email, deviceToken: await deviceTokenFor(other.userId) })).outcome).toBe('refused');
    expect(
      (await guard.admit({ email, deviceToken: `v1.${'A'.repeat(22)}.1795000000.${'B'.repeat(43)}` })).outcome,
    ).toBe('refused');

    const changedAt = new Date(Date.now() - 60_000);
    const reset = await createAccount(changedAt);
    for (let attempt = 0; attempt < 10; attempt += 1) await wrongPassword(guard, reset.email);
    const beforeChange = await deviceTokenFor(reset.userId, new Date(changedAt.getTime() - 10_000));
    expect((await guard.admit({ email: reset.email, deviceToken: beforeChange })).outcome).toBe('refused');
    // Within 5 s of the change counts as after it (clock difference between services).
    const atChange = await deviceTokenFor(reset.userId, new Date(changedAt.getTime() - 3_000));
    expect((await guard.admit({ email: reset.email, deviceToken: atChange })).outcome).toBe('proceed');
  });

  it('treats a token as absent when the account has no password timestamp to check it against', async () => {
    const guard = limiter('enforce');
    const userId = randomUUID();
    const email = `guess-limit-${userId}@example.test`;
    await db.insert(users).values({ id: userId, email, name: 'No password row' });
    createdUserIds.push(userId);
    for (let attempt = 0; attempt < 10; attempt += 1) await wrongPassword(guard, email);
    expect((await guard.admit({ email, deviceToken: await deviceTokenFor(userId) })).outcome).toBe('refused');
  });

  it('bounds the delay a sign-in can add by one deadline, however many store calls it makes', async () => {
    const { userId, email } = await createAccount();
    // Every transaction is slow but succeeds: an accounts read, then an account reserve.
    const slow = {
      transaction: async (work: Parameters<PasswordGuessStore['transaction']>[0]) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return db.transaction(work);
      },
    } as unknown as PasswordGuessStore;
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const guard = createPasswordGuessLimiter({
      mode: 'enforce',
      store: () => slow,
      environment,
      now: MID_HOUR,
      deadlineMs: 400,
    });
    const startedAt = Date.now();
    const admission = await guard.admit({ email, deviceToken: await deviceTokenFor(userId) });
    const elapsed = Date.now() - startedAt;
    // One call of 300 ms fits the 400 ms budget, the second cannot: it fails open at the
    // shared deadline instead of getting a fresh 400 ms of its own (which would take 600+).
    expect(admission.outcome).toBe('proceed');
    expect(elapsed).toBeLessThan(520);
    expect(passwordGuessLimitMetrics().failOpen).toBe(1);
  });

  it("suspends an account's recognised devices after 20 wrong passwords in an hour, then counts the email", async () => {
    const guard = limiter('enforce');
    const { userId, email } = await createAccount();
    // Every refresh mints a new token id; the bucket is the account's, not the token's.
    for (let attempt = 0; attempt < 20; attempt += 1)
      expect(await wrongPassword(guard, email, await deviceTokenFor(userId))).toBe('proceed');
    expect(passwordGuessLimitMetrics().deviceRecognised).toBe(20);
    for (let attempt = 0; attempt < 10; attempt += 1)
      expect(await wrongPassword(guard, email, await deviceTokenFor(userId))).toBe('proceed');
    expect(passwordGuessLimitMetrics().deviceSuspended).toBe(10);
    expect(await wrongPassword(guard, email, await deviceTokenFor(userId))).toBe('refused');
  });

  it('holds a parallel burst of 300 at one email under the cap', async () => {
    const guard = limiter('enforce');
    const email = `burst-${randomUUID()}@example.test`;
    const outcomes = await Promise.all(Array.from({ length: 300 }, () => wrongPassword(guard, email)));
    const proceeded = outcomes.filter((outcome) => outcome === 'proceed').length;
    expect(proceeded).toBeGreaterThan(0);
    expect(proceeded).toBeLessThanOrEqual(10);
    expect(passwordGuessLimitMetrics().inFlightCapped).toBeGreaterThanOrEqual(300 - 10 - 4);
    expect(passwordGuessLimitMetrics().failOpen).toBe(0);
    // A second burst finds the store's cap too.
    const later = [];
    for (let attempt = 0; attempt < 15; attempt += 1) later.push(await wrongPassword(guard, email));
    expect(later.filter((outcome) => outcome === 'proceed').length).toBe(10 - proceeded);
  });

  it('keeps the fifth concurrent reserve off the store, refusing it in enforce and only counting it in observe', async () => {
    for (const mode of ['enforce', 'observe'] as const) {
      __resetPasswordGuessLimitStateForTests();
      vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const hung = { transaction: vi.fn(() => new Promise(() => {})) } as unknown as PasswordGuessStore;
      // The production deadline: the four held reserves fail open at 250 ms.
      const guard = createPasswordGuessLimiter({ mode, store: () => hung, environment, now: MID_HOUR });
      const email = `inflight-${randomUUID()}@example.test`;
      const pending = Array.from({ length: 4 }, () => guard.admit({ email }));
      const fifth = await guard.admit({ email });
      expect(fifth.outcome).toBe(mode === 'enforce' ? 'refused' : 'proceed');
      expect(hung.transaction).toHaveBeenCalledTimes(4);
      expect(passwordGuessLimitMetrics().inFlightCapped).toBe(1);
      expect(passwordGuessLimitMetrics().wouldRefuse).toBe(mode === 'observe' ? 1 : 0);
      if (fifth.outcome === 'proceed') {
        expect(fifth.wouldRefuse).toBe(true);
        await fifth.settle('accepted');
        expect(passwordGuessLimitMetrics().wouldRefuseThenAccepted).toBe(1);
      }
      // The four held ones fail open at the deadline.
      expect((await Promise.all(pending)).map(({ outcome }) => outcome)).toEqual(Array(4).fill('proceed'));
    }
  });

  it('bounds genuine and forged device recognition before touching the store and retains observe verdicts', async () => {
    const realToken = await deviceTokenFor('recognition-owner');
    for (const mode of ['enforce', 'observe'] as const) {
      for (const deviceToken of [realToken, 'forged-token']) {
        __resetPasswordGuessLimitStateForTests();
        const hung = { transaction: vi.fn(() => new Promise(() => {})) } as unknown as PasswordGuessStore;
        const guard = createPasswordGuessLimiter({ mode, store: () => hung, environment, now: MID_HOUR });
        const email = `recognition-${randomUUID()}@example.test`;
        const pending = Array.from({ length: 4 }, () => guard.admit({ email, deviceToken }));
        const fifth = await guard.admit({ email: email.toUpperCase(), deviceToken });
        expect(fifth.outcome).toBe(mode === 'enforce' ? 'refused' : 'proceed');
        expect(hung.transaction).toHaveBeenCalledTimes(4);
        expect(passwordGuessLimitMetrics().inFlightCapped).toBe(1);
        if (fifth.outcome === 'proceed') {
          expect(fifth.wouldRefuse).toBe(true);
          await fifth.settle('accepted');
          expect(passwordGuessLimitMetrics().wouldRefuseThenAccepted).toBe(1);
        }
        await Promise.all(pending);
      }
    }
  });

  it('lets sign-in proceed when the store is down, and counts the fail-open', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const down = {
      transaction: () => Promise.reject(new Error('connection refused')),
    } as unknown as PasswordGuessStore;
    const guard = limiter('enforce', down);
    const { userId, email } = await createAccount();
    expect((await guard.admit({ email })).outcome).toBe('proceed');
    expect((await guard.admit({ email, deviceToken: await deviceTokenFor(userId) })).outcome).toBe('proceed');
    expect(passwordGuessLimitMetrics().failOpen).toBe(2);
    expect(passwordGuessMetrics().unavailable.reserve.store_error).toBe(2);
  });

  it('opens the email again after a completed reset', async () => {
    const guard = limiter('enforce');
    const { email } = await createAccount();
    for (let attempt = 0; attempt < 10; attempt += 1) await wrongPassword(guard, email);
    expect((await guard.admit({ email })).outcome).toBe('refused');
    await guard.clearEmail(email.toUpperCase());
    expect((await guard.admit({ email })).outcome).toBe('proceed');
  });
});
