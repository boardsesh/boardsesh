import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';

import { db } from '../db/client';
import { syncDaemonLeases } from '@boardsesh/db/schema';
import { acquireOrRenewDaemonLease, releaseDaemonLease } from '@boardsesh/db/queries';

// ---------------------------------------------------------------------------
// Daemon lease (real DB) — #3539
//
// A best-effort single-active-instance lease so a rolling deploy's overlapping
// containers stop running every sync twice. It is NOT mutual exclusion: there
// is no fencing token, so a holder that stalls past the TTL loses the lease
// while still running. These tests pin both halves of that contract — the
// common case is exclusive, and a stalled holder DOES get taken over (which is
// why the credential claim, the cooldown CAS and the deterministic notification
// uuid each have to stand on their own).
// ---------------------------------------------------------------------------

const DAEMON = 'lease-test-daemon';
const HOLDER_A = 'holder-a';
const HOLDER_B = 'holder-b';
const TTL_MS = 90_000;

async function clearFixtures(): Promise<void> {
  await db.delete(syncDaemonLeases).where(eq(syncDaemonLeases.daemonName, DAEMON));
}

const acquire = (holderId: string, ttlMs = TTL_MS) =>
  acquireOrRenewDaemonLease(db, { daemonName: DAEMON, holderId, hostname: `${holderId}.test`, ttlMs });

/** Age the heartbeat so the lease reads as abandoned, without waiting out a TTL. */
async function backdateHeartbeat(interval: string): Promise<void> {
  await db
    .update(syncDaemonLeases)
    .set({ heartbeatAt: sql`now() - ${sql.raw(interval)}` })
    .where(eq(syncDaemonLeases.daemonName, DAEMON));
}

async function readLease() {
  const rows = await db.select().from(syncDaemonLeases).where(eq(syncDaemonLeases.daemonName, DAEMON));
  return rows[0] ?? null;
}

describe('sync daemon lease (real DB)', () => {
  beforeEach(clearFixtures);
  afterEach(clearFixtures);

  it('the first instance takes the lease and the second is turned away', async () => {
    expect(await acquire(HOLDER_A)).toBe(true);
    expect(await acquire(HOLDER_B)).toBe(false);

    const lease = await readLease();
    expect(lease?.holderId).toBe(HOLDER_A);
    expect(lease?.hostname).toBe(`${HOLDER_A}.test`);
  });

  it('the holder can renew indefinitely while the other instance keeps failing', async () => {
    expect(await acquire(HOLDER_A)).toBe(true);
    const acquiredAt = (await readLease())?.acquiredAt;

    for (let beat = 0; beat < 3; beat++) {
      expect(await acquire(HOLDER_A)).toBe(true);
      expect(await acquire(HOLDER_B)).toBe(false);
    }

    // A renewal must not look like a takeover, or an operator can't tell how
    // long the current holder has actually been in charge.
    expect((await readLease())?.acquiredAt?.getTime()).toBe(acquiredAt?.getTime());
  });

  it('releasing hands over immediately instead of waiting out the TTL', async () => {
    expect(await acquire(HOLDER_A)).toBe(true);
    await releaseDaemonLease(db, { daemonName: DAEMON, holderId: HOLDER_A });

    // This is the rolling-deploy path: the outgoing container releases on
    // SIGTERM so the incoming one starts syncing in milliseconds.
    expect(await readLease()).toBeNull();
    expect(await acquire(HOLDER_B)).toBe(true);
  });

  it('an instance that already lost the lease cannot release the new holder’s row', async () => {
    expect(await acquire(HOLDER_A)).toBe(true);
    await backdateHeartbeat(`interval '5 minutes'`);
    expect(await acquire(HOLDER_B)).toBe(true);

    // A's shutdown must not evict B, or a deploy could leave nobody syncing.
    await releaseDaemonLease(db, { daemonName: DAEMON, holderId: HOLDER_A });
    expect((await readLease())?.holderId).toBe(HOLDER_B);
  });

  it('a stalled holder is taken over once the heartbeat is older than the TTL', async () => {
    expect(await acquire(HOLDER_A)).toBe(true);
    // Still inside the TTL: no takeover.
    await backdateHeartbeat(`interval '30 seconds'`);
    expect(await acquire(HOLDER_B)).toBe(false);

    // Past the TTL: B takes over. This is the lease's fundamental limitation —
    // A may still be running and still believe it holds the lease.
    await backdateHeartbeat(`interval '5 minutes'`);
    expect(await acquire(HOLDER_B)).toBe(true);
    expect((await readLease())?.holderId).toBe(HOLDER_B);
  });

  it("a taken-over holder's next heartbeat reports the loss", async () => {
    expect(await acquire(HOLDER_A)).toBe(true);
    await backdateHeartbeat(`interval '5 minutes'`);
    expect(await acquire(HOLDER_B)).toBe(true);

    // A finds out on its next beat, which is what drives the mid-cycle
    // checkpoint (DaemonLease.assertStillHeld) rather than running to
    // completion alongside B.
    expect(await acquire(HOLDER_A)).toBe(false);
  });

  it('a takeover restarts acquired_at but a renewal does not', async () => {
    expect(await acquire(HOLDER_A)).toBe(true);
    const original = (await readLease())?.acquiredAt;
    await backdateHeartbeat(`interval '5 minutes'`);
    await db
      .update(syncDaemonLeases)
      .set({ acquiredAt: sql`now() - interval '2 hours'` })
      .where(eq(syncDaemonLeases.daemonName, DAEMON));

    expect(await acquire(HOLDER_B)).toBe(true);
    const afterTakeover = (await readLease())?.acquiredAt;
    expect(afterTakeover!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(afterTakeover!.getTime()).not.toBe(original!.getTime());
  });

  it('exactly one of five parallel instances takes a free lease', async () => {
    // A genuine race across five pool connections, nothing serialised by the
    // test: the single-statement ON CONFLICT ... WHERE is the only thing
    // producing one winner.
    const outcomes = await Promise.all(Array.from({ length: 5 }, (_, index) => acquire(`parallel-holder-${index}`)));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it('keeps aurora and kilter leases independent', async () => {
    expect(await acquire(HOLDER_A)).toBe(true);
    // Different daemon name is a different row — kilter must not be blocked by
    // aurora's lease.
    const other = 'lease-test-daemon-2';
    try {
      expect(await acquireOrRenewDaemonLease(db, { daemonName: other, holderId: HOLDER_B, ttlMs: TTL_MS })).toBe(true);
    } finally {
      await db.delete(syncDaemonLeases).where(eq(syncDaemonLeases.daemonName, other));
    }
  });
});
