import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { authPasswordGuessWindows } from '@boardsesh/db/schema/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { db } from '../../db/client';
import { logger } from '../../utils/logger';
import {
  __resetPasswordGuessStateForTests,
  clearPasswordGuesses,
  giveBackPasswordGuess,
  PASSWORD_GUESS_EMAIL_KEY_ENV,
  passwordGuessAccountSubject,
  passwordGuessEmailKey,
  passwordGuessEmailSubject,
  passwordGuessMetrics,
  prunePasswordGuessWindows,
  reservePasswordGuess,
  type PasswordGuessReservation,
  type PasswordGuessStore,
  type PasswordGuessSubject,
} from '../password-guess-windows';

const EMAIL_KEY = randomBytes(32).toString('hex');
const environment = { [PASSWORD_GUESS_EMAIL_KEY_ENV]: EMAIL_KEY };
/** A deadline no healthy local database misses, for tests about counting rather than time. */
const PATIENT = { deadlineMs: 10_000 } as const;
/** 10:15 UTC, well inside one hour and one day. */
const MORNING = new Date('2026-11-17T10:15:00.000Z');
const atHour = (hour: number, minute = 0) =>
  new Date(`2026-11-17T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);

function freshEmailSubject(): PasswordGuessSubject {
  const subject = passwordGuessEmailSubject(`${randomUUID()}@guess.test`, environment);
  if (!subject) throw new Error('Expected an email subject');
  return subject;
}

async function windowRows(subject: PasswordGuessSubject) {
  const rows = await db
    .select({
      windowKind: authPasswordGuessWindows.windowKind,
      windowStart: authPasswordGuessWindows.windowStart,
      failures: authPasswordGuessWindows.failures,
    })
    .from(authPasswordGuessWindows)
    .where(
      and(eq(authPasswordGuessWindows.subjectKind, subject.kind), eq(authPasswordGuessWindows.subjectKey, subject.key)),
    );
  return rows
    .map((row) => ({ ...row, windowStart: row.windowStart.toISOString() }))
    .sort((left, right) =>
      `${left.windowKind}${left.windowStart}`.localeCompare(`${right.windowKind}${right.windowStart}`),
    );
}

async function reserveMany(subject: PasswordGuessSubject, count: number, now: Date) {
  const results: PasswordGuessReservation[] = [];
  for (let attempt = 0; attempt < count; attempt += 1)
    results.push(await reservePasswordGuess(db, subject, { now, ...PATIENT }));
  return results;
}

const outcomes = (results: readonly PasswordGuessReservation[]) =>
  results.reduce<Record<string, number>>(
    (counts, { outcome }) => ({ ...counts, [outcome]: (counts[outcome] ?? 0) + 1 }),
    {},
  );

describe('password guess windows (#7656)', () => {
  beforeEach(() => __resetPasswordGuessStateForTests());
  afterEach(() => vi.restoreAllMocks());

  describe('subjects', () => {
    it('digests the normalised email under the key and never stores the address', () => {
      const subject = passwordGuessEmailSubject('  Climber@Example.COM ', environment);
      expect(subject).toEqual(passwordGuessEmailSubject('climber@example.com', environment));
      expect(subject?.kind).toBe('email_digest');
      expect(subject?.key).toMatch(/^[0-9a-f]{64}$/);
      expect(subject?.key).not.toContain('climber');
      const otherKey = { [PASSWORD_GUESS_EMAIL_KEY_ENV]: randomBytes(32).toString('hex') };
      expect(passwordGuessEmailSubject('climber@example.com', otherKey)?.key).not.toBe(subject?.key);
    });

    it('is off, never a crash, when the key is unset, short, padded or another secret', () => {
      const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => logger);
      expect(passwordGuessEmailKey({})).toBeNull();
      expect(errorLog).not.toHaveBeenCalled();
      expect(passwordGuessEmailKey({ [PASSWORD_GUESS_EMAIL_KEY_ENV]: 'short' })).toBeNull();
      expect(passwordGuessEmailKey({ [PASSWORD_GUESS_EMAIL_KEY_ENV]: ` ${EMAIL_KEY}` })).toBeNull();
      expect(
        passwordGuessEmailKey({ [PASSWORD_GUESS_EMAIL_KEY_ENV]: EMAIL_KEY, NEXTAUTH_SECRET: EMAIL_KEY }),
      ).toBeNull();
      expect(
        passwordGuessEmailKey({
          [PASSWORD_GUESS_EMAIL_KEY_ENV]: EMAIL_KEY,
          CURRENT_STORE_DELETED_EMAIL_KEY: EMAIL_KEY,
        }),
      ).toBeNull();
      expect(passwordGuessEmailSubject('climber@example.com', {})).toBeNull();
      // One line naming the variable, never its value.
      expect(errorLog).toHaveBeenCalledOnce();
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(EMAIL_KEY);
      expect(passwordGuessEmailKey(environment)).toBe(EMAIL_KEY);
    });

    it('keys recognised devices by a digest of the account, never colliding with an email digest', () => {
      const account = passwordGuessAccountSubject('user-1', environment);
      expect(account?.kind).toBe('account_digest');
      expect(account?.key).toMatch(/^[0-9a-f]{64}$/);
      expect(account?.key).not.toContain('user-1');
      expect(passwordGuessAccountSubject('user-1', environment)).toEqual(account);
      expect(passwordGuessAccountSubject('user-2', environment)?.key).not.toBe(account?.key);
      // The same text as an email and as a user id digests differently.
      expect(passwordGuessEmailSubject('user-1', environment)?.key).not.toBe(account?.key);
      expect(passwordGuessAccountSubject('user-1', {})).toBeNull();
    });
  });

  describe('reserve', () => {
    it('gives a parallel burst of 30 exactly the 10 hourly slots', async () => {
      const subject = freshEmailSubject();
      const results = await Promise.all(
        Array.from({ length: 30 }, () => reservePasswordGuess(db, subject, { now: MORNING, ...PATIENT })),
      );
      expect(outcomes(results)).toEqual({ reserved: 10, refused: 20 });
      for (const result of results)
        if (result.outcome === 'refused') {
          expect(result.window).toBe('hour');
          // Until 11:00 UTC.
          expect(result.retryAfterSeconds).toBe(45 * 60);
        }
      expect(await windowRows(subject)).toEqual([
        { windowKind: 'day', windowStart: '2026-11-17T00:00:00.000Z', failures: 10 },
        { windowKind: 'hour', windowStart: '2026-11-17T10:00:00.000Z', failures: 10 },
      ]);
    });

    it('gives a burst only the slots that are left', async () => {
      const subject = freshEmailSubject();
      await reserveMany(subject, 4, MORNING);
      const results = await Promise.all(
        Array.from({ length: 30 }, () => reservePasswordGuess(db, subject, { now: MORNING, ...PATIENT })),
      );
      expect(outcomes(results)).toEqual({ reserved: 6, refused: 24 });
    });

    it('caps a day at 20 across hours, refusing without counting', async () => {
      const subject = freshEmailSubject();
      expect(outcomes(await reserveMany(subject, 11, atHour(1)))).toEqual({ reserved: 10, refused: 1 });
      expect(outcomes(await reserveMany(subject, 10, atHour(2)))).toEqual({ reserved: 10 });
      const refused = await reservePasswordGuess(db, subject, { now: atHour(3, 30), ...PATIENT });
      expect(refused).toEqual({ outcome: 'refused', window: 'day', retryAfterSeconds: 20.5 * 3600 });
      // The day refusal rolled back the hour it had already counted.
      expect(await windowRows(subject)).toEqual([
        { windowKind: 'day', windowStart: '2026-11-17T00:00:00.000Z', failures: 20 },
        { windowKind: 'hour', windowStart: '2026-11-17T01:00:00.000Z', failures: 10 },
        { windowKind: 'hour', windowStart: '2026-11-17T02:00:00.000Z', failures: 10 },
      ]);
    });

    it('opens again when the windows roll over', async () => {
      const subject = freshEmailSubject();
      await reserveMany(subject, 10, atHour(10));
      expect((await reservePasswordGuess(db, subject, { now: atHour(10, 59), ...PATIENT })).outcome).toBe('refused');
      expect((await reservePasswordGuess(db, subject, { now: atHour(11), ...PATIENT })).outcome).toBe('reserved');
      await reserveMany(subject, 9, atHour(12));
      // 20 today: the day refuses until midnight, then the next day opens.
      expect(await reservePasswordGuess(db, subject, { now: atHour(13), ...PATIENT })).toMatchObject({
        outcome: 'refused',
        window: 'day',
      });
      const tomorrow = new Date('2026-11-18T00:00:00.000Z');
      expect((await reservePasswordGuess(db, subject, { now: tomorrow, ...PATIENT })).outcome).toBe('reserved');
    });

    it('counts one email the same whoever owns it, and separate emails separately', async () => {
      const first = freshEmailSubject();
      const second = freshEmailSubject();
      await reserveMany(first, 10, MORNING);
      expect((await reservePasswordGuess(db, first, { now: MORNING, ...PATIENT })).outcome).toBe('refused');
      expect((await reservePasswordGuess(db, second, { now: MORNING, ...PATIENT })).outcome).toBe('reserved');
    });
  });

  describe('give back', () => {
    it('never leaves a right password counted, and is safe to call twice', async () => {
      const subject = freshEmailSubject();
      await reserveMany(subject, 9, MORNING);
      const right = await reservePasswordGuess(db, subject, { now: MORNING, ...PATIENT });
      if (right.outcome !== 'reserved') throw new Error('Expected a reservation');
      expect(await giveBackPasswordGuess(db, right.reservation, PATIENT)).toBe('done');
      expect(await giveBackPasswordGuess(db, right.reservation, PATIENT)).toBe('done');
      expect(await windowRows(subject)).toEqual([
        { windowKind: 'day', windowStart: '2026-11-17T00:00:00.000Z', failures: 9 },
        { windowKind: 'hour', windowStart: '2026-11-17T10:00:00.000Z', failures: 9 },
      ]);
      // The slot the right password used is open again.
      expect((await reservePasswordGuess(db, subject, { now: MORNING, ...PATIENT })).outcome).toBe('reserved');
      expect((await reservePasswordGuess(db, subject, { now: MORNING, ...PATIENT })).outcome).toBe('refused');
    });

    it('retries for real after a failed give-back, then stays given back', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const subject = freshEmailSubject();
      await reserveMany(subject, 2, MORNING);
      const right = await reservePasswordGuess(db, subject, { now: MORNING, ...PATIENT });
      if (right.outcome !== 'reserved') throw new Error('Expected a reservation');
      const broken = {
        transaction: () => Promise.reject(new Error('connection refused')),
      } as unknown as PasswordGuessStore;
      expect(await giveBackPasswordGuess(broken, right.reservation, PATIENT)).toBe('unavailable');
      expect((await windowRows(subject)).map(({ failures }) => failures)).toEqual([3, 3]);
      expect(await giveBackPasswordGuess(db, right.reservation, PATIENT)).toBe('done');
      expect((await windowRows(subject)).map(({ failures }) => failures)).toEqual([2, 2]);
      expect(await giveBackPasswordGuess(db, right.reservation, PATIENT)).toBe('done');
      expect((await windowRows(subject)).map(({ failures }) => failures)).toEqual([2, 2]);
    });

    it('runs one write for two give-backs in flight at once', async () => {
      const subject = freshEmailSubject();
      await reserveMany(subject, 2, MORNING);
      const right = await reservePasswordGuess(db, subject, { now: MORNING, ...PATIENT });
      if (right.outcome !== 'reserved') throw new Error('Expected a reservation');
      expect(
        await Promise.all([
          giveBackPasswordGuess(db, right.reservation, PATIENT),
          giveBackPasswordGuess(db, right.reservation, PATIENT),
        ]),
      ).toEqual(['done', 'done']);
      expect((await windowRows(subject)).map(({ failures }) => failures)).toEqual([2, 2]);
    });

    it('uncounts the windows it counted after the clock moves on', async () => {
      const subject = freshEmailSubject();
      const early = await reservePasswordGuess(db, subject, { now: atHour(10, 59), ...PATIENT });
      await reserveMany(subject, 3, atHour(11));
      if (early.outcome !== 'reserved') throw new Error('Expected a reservation');
      await giveBackPasswordGuess(db, early.reservation, PATIENT);
      expect(await windowRows(subject)).toEqual([
        { windowKind: 'day', windowStart: '2026-11-17T00:00:00.000Z', failures: 3 },
        { windowKind: 'hour', windowStart: '2026-11-17T10:00:00.000Z', failures: 0 },
        { windowKind: 'hour', windowStart: '2026-11-17T11:00:00.000Z', failures: 3 },
      ]);
    });
  });

  describe('clear', () => {
    it('forgets the email after a completed reset and touches no other subject', async () => {
      const subject = freshEmailSubject();
      const bystander = freshEmailSubject();
      await reserveMany(subject, 10, MORNING);
      await reserveMany(bystander, 2, MORNING);
      expect(await clearPasswordGuesses(db, subject, PATIENT)).toBe('done');
      expect(await windowRows(subject)).toEqual([]);
      expect((await reservePasswordGuess(db, subject, { now: MORNING, ...PATIENT })).outcome).toBe('reserved');
      expect(await windowRows(bystander)).toHaveLength(2);
    });
  });

  describe('recognised devices', () => {
    it('share 20 rejected passwords an hour per account, however many token ids they hold', async () => {
      // Refresh and exchange mint a new token id on every reply, so the bucket is the account's.
      const device = passwordGuessAccountSubject(randomUUID(), environment);
      if (!device) throw new Error('Expected an account subject');
      const results = await Promise.all(
        Array.from({ length: 30 }, () => reservePasswordGuess(db, device, { now: MORNING, ...PATIENT })),
      );
      expect(outcomes(results)).toEqual({ reserved: 20, refused: 10 });
      expect(await windowRows(device)).toEqual([
        { windowKind: 'hour', windowStart: '2026-11-17T10:00:00.000Z', failures: 20 },
      ]);
      expect((await reservePasswordGuess(db, device, { now: atHour(11), ...PATIENT })).outcome).toBe('reserved');
    });
  });

  describe('prune', () => {
    it('deletes windows that have ended and keeps the live ones', async () => {
      const subject = freshEmailSubject();
      await reserveMany(subject, 1, atHour(9));
      await reserveMany(subject, 1, atHour(10));
      expect(await prunePasswordGuessWindows(db, { now: atHour(10, 30) })).toMatchObject({
        result: 'done',
        drained: true,
      });
      expect((await windowRows(subject)).map(({ windowKind, windowStart }) => `${windowKind} ${windowStart}`)).toEqual([
        'day 2026-11-17T00:00:00.000Z',
        'hour 2026-11-17T10:00:00.000Z',
      ]);
      await prunePasswordGuessWindows(db, { now: new Date('2026-11-18T00:00:00.000Z') });
      expect(await windowRows(subject)).toEqual([]);
    });

    it('deletes in bounded batches until nothing has ended, so a flood cannot stall it', async () => {
      // Unknown emails create rows too, so a flood of addresses is many small subjects.
      const flood = Array.from({ length: 25 }, () => freshEmailSubject());
      await db.insert(authPasswordGuessWindows).values(
        flood.map((subject) => ({
          subjectKind: subject.kind,
          subjectKey: subject.key,
          windowKind: 'hour' as const,
          windowStart: new Date('2020-01-01T00:00:00.000Z'),
          failures: 1,
        })),
      );
      const live = freshEmailSubject();
      await reserveMany(live, 1, MORNING);
      const pruned = await prunePasswordGuessWindows(db, { now: atHour(10, 30), batchSize: 10 });
      expect(pruned).toMatchObject({ result: 'done', drained: true });
      expect(pruned.batches).toBeGreaterThanOrEqual(3);
      expect(pruned.deleted).toBeGreaterThanOrEqual(25);
      for (const subject of flood) expect(await windowRows(subject)).toEqual([]);
      expect(await windowRows(live)).toHaveLength(2);
    });

    it('stops at its time budget and leaves the rest for the next tick', async () => {
      const flood = Array.from({ length: 5 }, () => freshEmailSubject());
      await db.insert(authPasswordGuessWindows).values(
        flood.map((subject) => ({
          subjectKind: subject.kind,
          subjectKey: subject.key,
          windowKind: 'hour' as const,
          windowStart: new Date('2020-01-01T00:00:00.000Z'),
          failures: 1,
        })),
      );
      expect(await prunePasswordGuessWindows(db, { now: atHour(10, 30), budgetMs: 0 })).toEqual({
        result: 'done',
        deleted: 0,
        batches: 0,
        drained: false,
      });
      expect(await prunePasswordGuessWindows(db, { now: atHour(10, 30) })).toMatchObject({ drained: true });
      for (const subject of flood) expect(await windowRows(subject)).toEqual([]);
    });
  });

  describe('fail open', () => {
    it('answers unavailable for an unset key without warning', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      expect(await reservePasswordGuess(db, null)).toEqual({ outcome: 'unavailable', reason: 'not_configured' });
      expect(await clearPasswordGuesses(db, null)).toBe('unavailable');
      expect(passwordGuessMetrics().unavailable.reserve.not_configured).toBe(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('answers unavailable for a broken store, counts it and warns once a minute', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const broken = {
        transaction: () => Promise.reject(new Error('connection refused to secret-host')),
      } as unknown as PasswordGuessStore;
      const subject = freshEmailSubject();
      expect(await reservePasswordGuess(broken, subject)).toEqual({ outcome: 'unavailable', reason: 'store_error' });
      expect(await reservePasswordGuess(broken, subject)).toEqual({ outcome: 'unavailable', reason: 'store_error' });
      expect(await clearPasswordGuesses(broken, subject)).toBe('unavailable');
      expect(passwordGuessMetrics().unavailable.reserve.store_error).toBe(2);
      expect(passwordGuessMetrics().unavailable.clear.store_error).toBe(1);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[PasswordGuess]'),
        expect.objectContaining({ type: 'password_guess_metrics', reserveStoreError: 1 }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-host');
    });

    it('answers unavailable within the 250 ms deadline when no connection comes free', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const hung = { transaction: () => new Promise(() => {}) } as unknown as PasswordGuessStore;
      const startedAt = Date.now();
      // The transaction never began, so this reads as a pool wait, not a slow statement.
      expect(await reservePasswordGuess(hung, freshEmailSubject())).toEqual({
        outcome: 'unavailable',
        reason: 'pool_wait',
      });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(240);
      expect(elapsed).toBeLessThan(1_000);
      expect(passwordGuessMetrics().unavailable.reserve.pool_wait).toBe(1);
    });

    it('leaves nothing counted when a locked row makes a real reservation miss the deadline', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const subject = freshEmailSubject();
      await reserveMany(subject, 1, MORNING);
      let release = () => {};
      let locked = () => {};
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = db.transaction(async (transaction) => {
        await transaction
          .select()
          .from(authPasswordGuessWindows)
          .where(
            and(
              eq(authPasswordGuessWindows.subjectKind, subject.kind),
              eq(authPasswordGuessWindows.subjectKey, subject.key),
            ),
          )
          .for('update');
        locked();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      await lockTaken;
      const startedAt = Date.now();
      const result = await reservePasswordGuess(db, subject, { now: MORNING });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      // Postgres's lock timeout ends before the caller's deadline, so contention reads as contention.
      expect(result).toEqual({ outcome: 'unavailable', reason: 'lock_wait' });
      expect(passwordGuessMetrics().unavailable.reserve.lock_wait).toBe(1);
      release();
      await holder;
      // Postgres cancelled the waiting statement, or the late reservation was given back.
      await vi.waitFor(
        async () => expect((await windowRows(subject)).map(({ failures }) => failures)).toEqual([1, 1]),
        {
          timeout: 2_000,
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await windowRows(subject)).map(({ failures }) => failures)).toEqual([1, 1]);
    });
  });
});
