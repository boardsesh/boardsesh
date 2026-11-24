import { randomBytes, randomUUID } from 'node:crypto';
import { createDbOnPool, createDedicatedPoolFromUrl } from '@boardsesh/db/client';
import { authPasswordGuessWindows } from '@boardsesh/db/schema/auth';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getWorkerDatabaseUrl } from '../../__tests__/worker-db';
import { db } from '../../db/client';
import { logger } from '../../utils/logger';
import {
  __passwordGuessTransactionLifetimesForTests,
  __resetPasswordGuessStateForTests,
  clearPasswordGuesses,
  giveBackPasswordGuess,
  giveBackPasswordGuessOnce,
  PASSWORD_GUESS_EMAIL_KEY_ENV,
  PASSWORD_GUESS_TRANSACTION_CAP,
  passwordGuessEmailSubject,
  passwordGuessMetrics,
  prunePasswordGuessWindows,
  readPasswordGuessAccounts,
  reservePasswordGuess,
  type PasswordGuessStore,
  type ReservedPasswordGuess,
} from '../password-guess-windows';

const environment = { [PASSWORD_GUESS_EMAIL_KEY_ENV]: randomBytes(32).toString('hex') };
const now = new Date('2026-11-17T10:15:00.000Z');
const cleanup: (() => Promise<void>)[] = [];

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function freshReservation(): ReservedPasswordGuess {
  const subject = passwordGuessEmailSubject(`${randomUUID()}@lifetime.test`, environment);
  if (!subject) throw new Error('Expected a configured counter subject');
  return {
    subject,
    windows: [
      { kind: 'hour', start: new Date('2026-11-17T10:00:00.000Z') },
      { kind: 'day', start: new Date('2026-11-17T00:00:00.000Z') },
    ],
  };
}

function isolatedCounter() {
  const pool = createDedicatedPoolFromUrl(getWorkerDatabaseUrl(), 1);
  cleanup.push(() => pool.end({ timeout: 2 }));
  return createDbOnPool(pool, { logger: false });
}

async function holdConnection(database: ReturnType<typeof isolatedCounter>) {
  const entered = deferred();
  const released = deferred();
  const holder = database.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT 1`);
    entered.resolve();
    await released.promise;
  });
  const release = async () => {
    released.resolve();
    await holder;
  };
  cleanup.push(release);
  await entered.promise;
  return release;
}

async function countedFailures(reservation: ReservedPasswordGuess) {
  const rows = await db
    .select({ failures: authPasswordGuessWindows.failures })
    .from(authPasswordGuessWindows)
    .where(
      and(
        eq(authPasswordGuessWindows.subjectKind, reservation.subject.kind),
        eq(authPasswordGuessWindows.subjectKey, reservation.subject.key),
      ),
    );
  return rows.map(({ failures }) => failures);
}

describe('password counter transaction lifetime (#7656)', () => {
  beforeEach(() => {
    __resetPasswordGuessStateForTests();
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  });
  afterEach(async () => {
    for (const release of cleanup.splice(0).reverse()) await release();
    await vi.waitFor(() => expect(__passwordGuessTransactionLifetimesForTests()).toBe(0), { timeout: 5_000 });
    vi.restoreAllMocks();
  });

  it('bounds mixed work across many subjects beyond caller deadlines on one PostgreSQL connection', async () => {
    const counter = isolatedCounter();
    const releaseConnection = await holdConnection(counter);
    const transactions = vi.spyOn(counter, 'transaction');
    const reservations = Array.from({ length: PASSWORD_GUESS_TRANSACTION_CAP }, freshReservation);
    const timing = { deadlineMs: 50, now };
    const operations: (() => Promise<string>)[] = [
      ...reservations
        .slice(0, 16)
        .map((reservation) => async () => (await reservePasswordGuess(counter, reservation.subject, timing)).outcome),
      ...reservations
        .slice(16, 22)
        .map(
          (_reservation, index) => async () =>
            (await readPasswordGuessAccounts(counter, `lookup-${index}@lifetime.test`, timing)) === 'unavailable'
              ? 'unavailable'
              : 'read',
        ),
      ...reservations
        .slice(22, 26)
        .map((reservation) => async () => clearPasswordGuesses(counter, reservation.subject, timing)),
      ...reservations
        .slice(26, 28)
        .map((reservation) => async () => giveBackPasswordGuess(counter, { ...reservation }, timing)),
      ...reservations
        .slice(28, 30)
        .map((reservation) => async () => giveBackPasswordGuessOnce(counter, reservation, randomUUID(), timing)),
      ...reservations
        .slice(30)
        .map((_reservation) => async () => (await prunePasswordGuessWindows(counter, { now, budgetMs: 50 })).result),
    ];
    expect(operations).toHaveLength(PASSWORD_GUESS_TRANSACTION_CAP);
    expect(await Promise.all(operations.map((operation) => operation()))).toEqual(
      Array(PASSWORD_GUESS_TRANSACTION_CAP).fill('unavailable'),
    );
    expect(transactions).toHaveBeenCalledTimes(PASSWORD_GUESS_TRANSACTION_CAP);
    // Caller deadlines release no queued PostgreSQL work or capacity.
    expect(__passwordGuessTransactionLifetimesForTests()).toBe(PASSWORD_GUESS_TRANSACTION_CAP);

    for (let wave = 0; wave < 3; wave += 1) {
      const burst = await Promise.all(
        Array.from({ length: 50 }, () => reservePasswordGuess(counter, freshReservation().subject, timing)),
      );
      expect(burst).toEqual(Array(50).fill({ outcome: 'unavailable', reason: 'capacity' }));
    }
    expect(await Promise.all(operations.map((operation) => operation()))).toEqual(
      Array(PASSWORD_GUESS_TRANSACTION_CAP).fill('unavailable'),
    );
    expect(transactions).toHaveBeenCalledTimes(PASSWORD_GUESS_TRANSACTION_CAP);
    expect(passwordGuessMetrics().unavailable.reserve.capacity).toBe(172);
    expect(passwordGuessMetrics().unavailable.give_back.capacity).toBe(4);
    expect(passwordGuessMetrics().unavailable.clear.capacity).toBe(4);
    expect(passwordGuessMetrics().unavailable.prune.capacity).toBe(2);

    await releaseConnection();
    await vi.waitFor(() => expect(__passwordGuessTransactionLifetimesForTests()).toBe(0), { timeout: 5_000 });
    for (const reservation of reservations) expect(await countedFailures(reservation)).toEqual([]);
    const recovered = await reservePasswordGuess(counter, reservations[0].subject, { now, deadlineMs: 5_000 });
    expect(recovered.outcome).toBe('reserved');
    if (recovered.outcome !== 'reserved') throw new Error('Expected recovered counter');
    expect(await giveBackPasswordGuess(counter, recovered.reservation, { deadlineMs: 5_000 })).toBe('done');
    expect(await countedFailures(reservations[0])).toEqual([0, 0]);
  });

  it('keeps a late committed reservation in capacity through compensation when every slot is occupied', async () => {
    const counter = isolatedCounter();
    const committed = deferred();
    const deliverCommit = deferred();
    cleanup.push(async () => {
      deliverCommit.resolve();
    });
    let firstReply = true;
    const delayedCommit: PasswordGuessStore = {
      transaction: async (work, configuration) => {
        const result = await counter.transaction(work, configuration);
        if (firstReply) {
          firstReply = false;
          committed.resolve();
          await deliverCommit.promise;
        }
        return result;
      },
    };
    const transactions = vi.spyOn(delayedCommit, 'transaction');
    const reservation = freshReservation();
    const admission = reservePasswordGuess(delayedCommit, reservation.subject, { now, deadlineMs: 200 });
    await committed.promise;
    expect(await countedFailures(reservation)).toEqual([1, 1]);
    const releaseConnection = await holdConnection(counter);

    let releaseOtherTransactions = () => {};
    const held = new Promise<never>((_resolve, reject) => {
      releaseOtherTransactions = () => reject(new Error('Test transactions released'));
    });
    cleanup.push(async () => {
      releaseOtherTransactions();
    });
    const otherStore = { transaction: vi.fn(() => held) } as unknown as PasswordGuessStore;
    const others = Array.from({ length: PASSWORD_GUESS_TRANSACTION_CAP - 1 }, () =>
      reservePasswordGuess(otherStore, freshReservation().subject, { now, deadlineMs: 20 }),
    );
    await Promise.all(others);
    expect(await admission).toEqual({ outcome: 'unavailable', reason: 'deadline' });
    expect(__passwordGuessTransactionLifetimesForTests()).toBe(PASSWORD_GUESS_TRANSACTION_CAP);

    deliverCommit.resolve();
    await vi.waitFor(() => expect(transactions).toHaveBeenCalledTimes(2));
    // The compensating transaction queues on the real one-connection pool and
    // retains the original slot, so capacity cannot grow or prevent the undo.
    expect(__passwordGuessTransactionLifetimesForTests()).toBe(PASSWORD_GUESS_TRANSACTION_CAP);
    expect(await clearPasswordGuesses(delayedCommit, reservation.subject)).toBe('unavailable');
    expect(transactions).toHaveBeenCalledTimes(2);
    await releaseConnection();
    await vi.waitFor(async () => {
      expect(await countedFailures(reservation)).toEqual([0, 0]);
      expect(__passwordGuessTransactionLifetimesForTests()).toBe(PASSWORD_GUESS_TRANSACTION_CAP - 1);
    });
    releaseOtherTransactions();
    await vi.waitFor(() => expect(__passwordGuessTransactionLifetimesForTests()).toBe(0));
    expect((await reservePasswordGuess(counter, reservation.subject, { now, deadlineMs: 5_000 })).outcome).toBe(
      'reserved',
    );
  });

  it('deduplicates a timed-out give-back until its real commit reply arrives', async () => {
    const counter = isolatedCounter();
    const reservation = freshReservation();
    const first = await reservePasswordGuess(counter, reservation.subject, { now, deadlineMs: 5_000 });
    expect(first.outcome).toBe('reserved');
    if (first.outcome !== 'reserved') throw new Error('Expected a counted reservation');
    expect((await reservePasswordGuess(counter, reservation.subject, { now, deadlineMs: 5_000 })).outcome).toBe(
      'reserved',
    );
    const committed = deferred();
    const deliverCommit = deferred();
    cleanup.push(async () => {
      deliverCommit.resolve();
    });
    let firstReply = true;
    const delayedCommit: PasswordGuessStore = {
      transaction: async (work, configuration) => {
        const result = await counter.transaction(work, configuration);
        if (firstReply) {
          firstReply = false;
          committed.resolve();
          await deliverCommit.promise;
        }
        return result;
      },
    };
    const transactions = vi.spyOn(delayedCommit, 'transaction');
    const givenBack = giveBackPasswordGuess(delayedCommit, first.reservation, { deadlineMs: 200 });
    await committed.promise;
    expect(await givenBack).toBe('unavailable');
    expect(__passwordGuessTransactionLifetimesForTests()).toBe(1);
    expect(await giveBackPasswordGuess(delayedCommit, first.reservation)).toBe('unavailable');
    expect(transactions).toHaveBeenCalledOnce();
    expect(await countedFailures(reservation)).toEqual([1, 1]);
    deliverCommit.resolve();
    await vi.waitFor(() => expect(__passwordGuessTransactionLifetimesForTests()).toBe(0));
    expect(await giveBackPasswordGuess(delayedCommit, first.reservation)).toBe('done');
    expect(transactions).toHaveBeenCalledOnce();
    expect(await countedFailures(reservation)).toEqual([1, 1]);
  });
});
