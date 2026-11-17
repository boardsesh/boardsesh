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
  passwordGuessDeviceSubject,
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

    it('accepts only a 16-byte base64url device token id', () => {
      const tokenId = randomBytes(16).toString('base64url');
      expect(passwordGuessDeviceSubject(tokenId)).toEqual({ kind: 'device_token', key: tokenId });
      expect(() => passwordGuessDeviceSubject('not a token')).toThrow();
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

  describe('device tokens', () => {
    it('suspends a device after 20 rejected passwords in an hour, for that hour only', async () => {
      const device = passwordGuessDeviceSubject(randomBytes(16).toString('base64url'));
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
      expect(await prunePasswordGuessWindows(db, { now: atHour(10, 30) })).toBe('done');
      expect((await windowRows(subject)).map(({ windowKind, windowStart }) => `${windowKind} ${windowStart}`)).toEqual([
        'day 2026-11-17T00:00:00.000Z',
        'hour 2026-11-17T10:00:00.000Z',
      ]);
      await prunePasswordGuessWindows(db, { now: new Date('2026-11-18T00:00:00.000Z') });
      expect(await windowRows(subject)).toEqual([]);
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

    it('answers unavailable within the 250 ms deadline when the store hangs', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const hung = { transaction: () => new Promise(() => {}) } as unknown as PasswordGuessStore;
      const startedAt = Date.now();
      expect(await reservePasswordGuess(hung, freshEmailSubject())).toEqual({
        outcome: 'unavailable',
        reason: 'deadline',
      });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(240);
      expect(elapsed).toBeLessThan(1_000);
      expect(passwordGuessMetrics().unavailable.reserve.deadline).toBe(1);
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
      expect(result).toEqual({ outcome: 'unavailable', reason: 'deadline' });
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
