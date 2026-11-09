import { describe, expect, it, vi } from 'vite-plus/test';
import {
  FixedSystemOwnerOrderError,
  lockCooperativeFixedSystemOwnerTransaction,
  lockFixedSystemOwnerTransaction,
  lockSharedFixedSystemOwnerTransaction,
  type FixedSystemOwnerTransaction,
} from '@boardsesh/db/fixed-system-owner-order';
import { db } from '../db/client';
import { startServer } from '../server';

type Acquire = (transaction: FixedSystemOwnerTransaction) => Promise<void>;

/** Holds the key in a real transaction until released, so PostgreSQL decides the conflict. */
async function holdKey(acquire: Acquire) {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reportAcquired = () => {};
  let reportFailed = (_error: unknown) => {};
  const acquired = new Promise<void>((resolve, reject) => {
    reportAcquired = resolve;
    reportFailed = reject;
  });
  const finished = db
    .transaction(async (transaction) => {
      try {
        await acquire(transaction as unknown as FixedSystemOwnerTransaction);
      } catch (error) {
        reportFailed(error);
        throw error;
      }
      reportAcquired();
      await released;
    })
    .catch(() => undefined);
  await acquired;
  return async () => {
    release();
    await finished;
  };
}

const cooperativeContent: Acquire = (transaction) =>
  lockCooperativeFixedSystemOwnerTransaction(transaction, 'cooperative-staging');

async function expectBusy(acquire: Acquire) {
  await expect(holdKey(acquire)).rejects.toMatchObject({ code: 'busy' });
  await expect(holdKey(acquire)).rejects.toBeInstanceOf(FixedSystemOwnerOrderError);
}

describe('fixed system-owner key under real advisory locks', () => {
  it('lets adopted content writers and account deletion overlap', async () => {
    const releaseFirst = await holdKey(cooperativeContent);
    try {
      const releaseSecond = await holdKey(cooperativeContent);
      const releaseDeletion = await holdKey(lockSharedFixedSystemOwnerTransaction);
      await releaseSecond();
      await releaseDeletion();
    } finally {
      await releaseFirst();
    }
  });

  it('refuses an identity authority while a content writer holds the key', async () => {
    const release = await holdKey(cooperativeContent);
    try {
      await expectBusy(lockFixedSystemOwnerTransaction);
    } finally {
      await release();
    }
  });

  it('refuses content writers and deletion while an identity authority holds the key', async () => {
    const release = await holdKey(lockFixedSystemOwnerTransaction);
    try {
      await expectBusy(cooperativeContent);
      await expectBusy(lockSharedFixedSystemOwnerTransaction);
    } finally {
      await release();
    }
  });
});

describe('fixed system-owner order mode at boot', () => {
  it('refuses to start on an unrecognised mode', async () => {
    vi.stubEnv('CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE', 'cooperative-stagin');
    try {
      await expect(startServer()).rejects.toMatchObject({ code: 'invalid_mode' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
