import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import * as schema from '@boardsesh/db/schema';
import { mobileRefreshTokens, notificationDevices, users } from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { barrier, blockedStatement, bounded, connectAs, parkBeforeCommit } from './lock-order-harness';
import { revokeNativeCredentials } from '../native-revocation';
import type { NativeRevocationMode } from '../native-revocation-configuration';
import { getPostgresErrorCode } from '../../../utils/postgres-errors';
import { NOTIFICATION_DEVICE_TOKEN_LOCK_SEED } from '../../../services/notification-locks';
import {
  NOTIFICATION_DEVICE_LOCK_TIMEOUT,
  saveNotificationDevice,
  type NotificationDeviceInput,
} from '../../../services/notification-device-registration';

/**
 * Issue #7645: push-device registration (saveNotificationDevice) against native
 * sign-out (revokeNativeCredentials), account deletion and itself, each on its
 * own PostgreSQL connection. Registration takes the token lock, then `users`
 * FOR KEY SHARE for the climber and the owners of the rows it touches, by id,
 * then the live device rows by installation id. Sign-out and deletion take
 * `users` FOR UPDATE before the climber's devices, so whichever starts second
 * queues on the `users` row. Each order parks the first command before COMMIT
 * holding every lock it took and proves where the second waits.
 *
 * Run against the statements registration used before the fix, only "same
 * climber, registration first" passes (that insert's foreign key also queued
 * sign-out on `users`); every other case fails. The two controls replay that
 * order and get a real 40P01.
 */
const REGISTER_APPLICATION = '7645-lock-order-register';
const SECOND_REGISTER_APPLICATION = '7645-lock-order-register-second';
const REVOKE_APPLICATION = '7645-lock-order-revoke';
const HOLDER_APPLICATION = '7645-lock-order-holder';
const SIGN_OUT_USERS_LOCK = /from "users" where "users"\."id" = \$1 for update/i;
const REGISTRATION_USERS_LOCK = /order by "users"\."id" asc for key share of "users"$/i;
const REGISTRATION_DEVICE_LOCK = /^with "locked_devices" as/i;
const LOCK_TIMEOUT_MS = Number.parseInt(NOTIFICATION_DEVICE_LOCK_TIMEOUT, 10);
const MODES = ['legacy', 'generation'] as const satisfies readonly NativeRevocationMode[];

let environment: Awaited<ReturnType<typeof createEnvironment>>;
let registerClient: ReturnType<typeof postgres>;
let secondRegisterClient: ReturnType<typeof postgres>;
let revokeClient: ReturnType<typeof postgres>;
let holderClient: ReturnType<typeof postgres>;
let observer: ReturnType<typeof postgres>;
let registerDatabase: typeof environment.database;
let secondRegisterDatabase: typeof environment.database;
let revokeDatabase: typeof environment.database;
let holderDatabase: typeof environment.database;
type Transaction = Parameters<Parameters<typeof environment.database.transaction>[0]>[0];

const pushToken = () => `ExpoPushToken[${randomUUID()}]`;
/** `rank` fixes where the id sorts: rank 0 before rank 1, in any collation. */
const installation = (rank = 0) => `installation-${rank}-${randomUUID()}`;
const lease = () => new Date(Date.now() + 3600000);
const device = (installationId: string, token: string): NotificationDeviceInput => ({
  installationId,
  token,
  platform: 'ios',
  locale: 'en-US',
});

/** A climber signed in on one phone, so a sign-out has a live refresh row to present. */
async function climber(idPrefix = '') {
  const userId = `${idPrefix}${randomUUID()}`;
  const tokenHash = randomUUID();
  await environment.database.insert(users).values({ id: userId, email: `push-lock-${userId}@example.com` });
  await environment.database.insert(mobileRefreshTokens).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + 3600000),
    subjectGeneration: 0,
    nativeGeneration: 0,
  });
  return { userId, tokenHash };
}

async function installed(
  userId: string,
  installationId: string,
  token: string,
  state: { active?: boolean; updatedAt?: Date } = {},
) {
  await environment.database
    .insert(notificationDevices)
    .values({ ...device(installationId, token), userId, expiresAt: lease(), ...state });
}

async function deviceRows(installationIds: string[]) {
  const rows = await environment.database
    .select({
      installationId: notificationDevices.installationId,
      userId: notificationDevices.userId,
      token: notificationDevices.token,
      active: notificationDevices.active,
    })
    .from(notificationDevices)
    .where(inArray(notificationDevices.installationId, installationIds));
  return Object.fromEntries(rows.map(({ installationId, ...row }) => [installationId, row]));
}

async function liveRefreshRows(userId: string): Promise<number> {
  const rows = await environment.database
    .select({ tokenHash: mobileRefreshTokens.tokenHash })
    .from(mobileRefreshTokens)
    .where(and(eq(mobileRefreshTokens.userId, userId), isNull(mobileRefreshTokens.revokedAt)));
  return rows.length;
}

/**
 * Another writer on the holder connection: runs `lock`, reports `locked`, keeps
 * every lock until `release`, then runs `finish` (if any) and commits.
 */
function holdLocks(
  lock: (transaction: Transaction) => Promise<unknown>,
  finish?: (transaction: Transaction) => Promise<unknown>,
) {
  const locked = barrier();
  const release = barrier();
  const done = holderDatabase.transaction(async (transaction) => {
    await lock(transaction);
    locked.resolve();
    await release.promise;
    if (finish) await finish(transaction);
  });
  return { locked: locked.promise, release: release.resolve, done };
}

const lockUserForUpdate = (userId: string) => (transaction: Transaction) =>
  transaction.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');

const lockDeviceRow = (installationId: string, strength: 'no key update' | 'key share') => (transaction: Transaction) =>
  transaction
    .select({ installationId: notificationDevices.installationId })
    .from(notificationDevices)
    .where(eq(notificationDevices.installationId, installationId))
    .for(strength);

/** Account deletion's shape: the climber's `users` row FOR UPDATE, then the delete that cascades to devices. */
const accountDeletion = (userId: string) =>
  holdLocks(lockUserForUpdate(userId), (transaction) => transaction.delete(users).where(eq(users.id, userId)));

/**
 * The statements registration ran before #7645, in that order: the token lock,
 * the other rows holding the token, then the upsert whose foreign key takes
 * KEY SHARE on `users`. `between` runs after the rows are locked.
 */
function registerInPreFixOrder(
  database: typeof environment.database,
  userId: string,
  registration: NotificationDeviceInput,
  between: () => Promise<void>,
) {
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${registration.token}, ${NOTIFICATION_DEVICE_TOKEN_LOCK_SEED}))`,
    );
    await transaction
      .update(notificationDevices)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(notificationDevices.token, registration.token),
          ne(notificationDevices.installationId, registration.installationId),
        ),
      );
    await between();
    const expiresAt = lease();
    await transaction
      .insert(notificationDevices)
      .values({ ...registration, userId, expiresAt })
      .onConflictDoUpdate({
        target: notificationDevices.installationId,
        set: { ...registration, userId, active: true, expiresAt, updatedAt: new Date() },
      });
  });
}

function deadlocks(outcomes: PromiseSettledResult<unknown>[]) {
  return outcomes.filter(
    (outcome) => outcome.status === 'rejected' && getPostgresErrorCode(outcome.reason) === '40P01',
  );
}

describe('push-device registration shares the users-first lock order with sign-out', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    const connect = (applicationName: string) => connectAs(environment.client.options.database, applicationName);
    registerClient = connect(REGISTER_APPLICATION);
    secondRegisterClient = connect(SECOND_REGISTER_APPLICATION);
    revokeClient = connect(REVOKE_APPLICATION);
    holderClient = connect(HOLDER_APPLICATION);
    observer = connect('7645-lock-order-observer');
    registerDatabase = drizzle(registerClient, { schema });
    secondRegisterDatabase = drizzle(secondRegisterClient, { schema });
    revokeDatabase = drizzle(revokeClient, { schema });
    holderDatabase = drizzle(holderClient, { schema });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await Promise.allSettled(
      [registerClient, secondRegisterClient, revokeClient, holderClient, observer].map((client) =>
        client?.end({ timeout: 5 }),
      ),
    );
    await environment?.close();
  });

  for (const mode of MODES) {
    describe(`a reinstall registering its kept token while the same climber signs out (${mode})`, () => {
      it('registration first: the sign-out waits on the users row, then retires both installations', async () => {
        const subject = await climber();
        const token = pushToken();
        const previousInstall = installation();
        const reinstall = installation();
        await installed(subject.userId, previousInstall, token);
        const parked = parkBeforeCommit(registerDatabase, () => true);
        const registering = saveNotificationDevice(registerDatabase, subject.userId, device(reinstall, token), lease());
        let revoke: Promise<boolean> | undefined;
        try {
          // Registration holds the token lock, the users row and both device rows.
          await bounded(parked.reached);
          revoke = revokeNativeCredentials(revokeDatabase, subject.tokenHash, mode);
          const waiting = await blockedStatement(observer, REVOKE_APPLICATION, revoke);
          expect(waiting.query).toMatch(SIGN_OUT_USERS_LOCK);
          expect(waiting.blockers).toEqual([REGISTER_APPLICATION]);
        } finally {
          parked.release();
        }
        const [, revoked] = await bounded(Promise.all([registering, revoke]));
        expect(revoked).toBe(true);
        expect(await deviceRows([previousInstall, reinstall])).toEqual({
          [previousInstall]: { userId: subject.userId, token, active: false },
          [reinstall]: { userId: subject.userId, token, active: false },
        });
        expect(await liveRefreshRows(subject.userId)).toBe(0);
      });

      it('sign-out first: the registration waits on the users row, then saves the reinstall', async () => {
        const subject = await climber();
        const token = pushToken();
        const previousInstall = installation();
        const reinstall = installation();
        await installed(subject.userId, previousInstall, token);
        const parked = parkBeforeCommit(revokeDatabase, () => true);
        const revoke = revokeNativeCredentials(revokeDatabase, subject.tokenHash, mode);
        let registering: Promise<void> | undefined;
        try {
          // The sign-out holds the gate, the users row, every refresh row and the device row.
          await bounded(parked.reached);
          registering = saveNotificationDevice(registerDatabase, subject.userId, device(reinstall, token), lease());
          const waiting = await blockedStatement(observer, REGISTER_APPLICATION, registering);
          expect(waiting.query).toMatch(REGISTRATION_USERS_LOCK);
          expect(waiting.blockers).toEqual([REVOKE_APPLICATION]);
        } finally {
          parked.release();
        }
        const [revoked] = await bounded(Promise.all([revoke, registering]));
        expect(revoked).toBe(true);
        // The sign-out retired the installation it found. The registration was
        // authenticated before it and lands after it, as it would one at a time.
        expect(await deviceRows([previousInstall, reinstall])).toEqual({
          [previousInstall]: { userId: subject.userId, token, active: false },
          [reinstall]: { userId: subject.userId, token, active: true },
        });
        expect(await liveRefreshRows(subject.userId)).toBe(0);
      });
    });

    describe(`a token moving from climber A to climber B while A signs out (${mode})`, () => {
      it("registration first: A's sign-out waits on A's users row, then both finish", async () => {
        const subject = await movingToken();
        const parked = parkBeforeCommit(registerDatabase, () => true);
        const registering = registerNextOwner(subject);
        let revoke: Promise<boolean> | undefined;
        try {
          // Registration holds KEY SHARE on both climbers and every live row holding the token.
          await bounded(parked.reached);
          revoke = revokeNativeCredentials(revokeDatabase, subject.previousOwner.tokenHash, mode);
          const waiting = await blockedStatement(observer, REVOKE_APPLICATION, revoke);
          expect(waiting.query).toMatch(SIGN_OUT_USERS_LOCK);
          expect(waiting.blockers).toEqual([REGISTER_APPLICATION]);
        } finally {
          parked.release();
        }
        const [, revoked] = await bounded(Promise.all([registering, revoke]));
        expect(revoked).toBe(true);
        await expectMoved(subject, 'kept');
      });

      it("sign-out first: B's registration waits on A's users row, then both finish", async () => {
        const subject = await movingToken();
        const parked = parkBeforeCommit(revokeDatabase, () => true);
        const revoke = revokeNativeCredentials(revokeDatabase, subject.previousOwner.tokenHash, mode);
        let registering: Promise<void> | undefined;
        try {
          await bounded(parked.reached);
          registering = registerNextOwner(subject);
          const waiting = await blockedStatement(observer, REGISTER_APPLICATION, registering);
          expect(waiting.query).toMatch(REGISTRATION_USERS_LOCK);
          expect(waiting.blockers).toEqual([REVOKE_APPLICATION]);
        } finally {
          parked.release();
        }
        const [revoked] = await bounded(Promise.all([revoke, registering]));
        expect(revoked).toBe(true);
        await expectMoved(subject, 'kept');
      });
    });
  }

  describe("a token moving from climber A to climber B while A's account is deleted", () => {
    it("deletion first: B's registration waits on A's users row, then both finish", async () => {
      const subject = await movingToken();
      const deletion = accountDeletion(subject.previousOwner.userId);
      let registering: Promise<void> | undefined;
      try {
        await bounded(deletion.locked);
        registering = registerNextOwner(subject);
        const waiting = await blockedStatement(observer, REGISTER_APPLICATION, registering);
        expect(waiting.query).toMatch(REGISTRATION_USERS_LOCK);
        expect(waiting.blockers).toEqual([HOLDER_APPLICATION]);
      } finally {
        deletion.release();
      }
      await bounded(Promise.all([deletion.done, registering]));
      await expectMoved(subject, 'deleted');
    });

    it("registration first: the deletion waits on A's users row, then both finish", async () => {
      const subject = await movingToken();
      const parked = parkBeforeCommit(registerDatabase, () => true);
      const registering = registerNextOwner(subject);
      let deletion: ReturnType<typeof accountDeletion> | undefined;
      try {
        await bounded(parked.reached);
        deletion = accountDeletion(subject.previousOwner.userId);
        const waiting = await blockedStatement(observer, HOLDER_APPLICATION, deletion.locked);
        expect(waiting.query).toMatch(SIGN_OUT_USERS_LOCK);
        expect(waiting.blockers).toEqual([REGISTER_APPLICATION]);
      } finally {
        parked.release();
        // Lets the deletion delete as soon as it holds the row.
        deletion?.release();
      }
      await bounded(Promise.all([registering, deletion.done]));
      await expectMoved(subject, 'deleted');
    });
  });

  it('gives up within the lock timeout behind a held users row, writes nothing, and its climber can still sign out', async () => {
    // The registering climber's id sorts first, so the registration holds KEY
    // SHARE on its own row while it waits for the previous owner's.
    const registering = await climber('0');
    const previousOwner = await climber('f');
    const token = pushToken();
    const previousInstall = installation();
    const reinstall = installation();
    await installed(previousOwner.userId, previousInstall, token);
    // A long account deletion holding the previous owner's users row.
    const deletion = holdLocks(lockUserForUpdate(previousOwner.userId));
    try {
      await bounded(deletion.locked);
      const registrationStarted = Date.now();
      const registration = saveNotificationDevice(
        registerDatabase,
        registering.userId,
        device(reinstall, token),
        lease(),
      );
      const outcome = registration.then(
        () => ({ code: 'saved', elapsed: Date.now() - registrationStarted }),
        (error: unknown) => ({ code: getPostgresErrorCode(error), elapsed: Date.now() - registrationStarted }),
      );
      const waiting = await blockedStatement(observer, REGISTER_APPLICATION, registration);
      expect(waiting.query).toMatch(REGISTRATION_USERS_LOCK);
      expect(waiting.blockers).toEqual([HOLDER_APPLICATION]);
      const signOutStarted = Date.now();
      const revoke = revokeNativeCredentials(revokeDatabase, registering.tokenHash, 'legacy');
      const signOutWaiting = await blockedStatement(observer, REVOKE_APPLICATION, revoke);
      expect(signOutWaiting.query).toMatch(SIGN_OUT_USERS_LOCK);
      expect(signOutWaiting.blockers).toEqual([REGISTER_APPLICATION]);
      const gaveUp = await bounded(outcome);
      expect(gaveUp.code).toBe('55P03');
      expect(gaveUp.elapsed).toBeLessThan(LOCK_TIMEOUT_MS + 1000);
      // Sign-out waits at most for the registration's limit, well inside its own 4 s.
      expect(await bounded(revoke)).toBe(true);
      expect(Date.now() - signOutStarted).toBeLessThan(LOCK_TIMEOUT_MS + 1000);
    } finally {
      deletion.release();
    }
    await bounded(deletion.done);
    // Nothing of the registration landed: the previous row is still live and the reinstall has none.
    expect(await deviceRows([previousInstall, reinstall])).toEqual({
      [previousInstall]: { userId: previousOwner.userId, token, active: true },
    });
    expect(await liveRefreshRows(registering.userId)).toBe(0);
  });

  it('leaves inactive rows for the token alone, so their owners never wait on it', async () => {
    const registering = await climber();
    const previousOwner = await climber();
    const formerOwner = await climber();
    const token = pushToken();
    const retiredAt = new Date('2026-01-01T00:00:00Z');
    const liveInstall = installation();
    const reinstall = installation();
    // Every earlier install of this phone left a row behind; only one is live.
    const previousInactive = [installation(), installation()];
    const formerInactive = [installation(), installation(), installation()];
    await installed(previousOwner.userId, liveInstall, token);
    for (const installationId of previousInactive)
      await installed(previousOwner.userId, installationId, token, { active: false, updatedAt: retiredAt });
    for (const installationId of formerInactive)
      await installed(formerOwner.userId, installationId, token, { active: false, updatedAt: retiredAt });
    const parked = parkBeforeCommit(registerDatabase, () => true);
    const registration = saveNotificationDevice(
      registerDatabase,
      registering.userId,
      device(reinstall, token),
      lease(),
    );
    try {
      await bounded(parked.reached);
      // The registration holds neither the former owner's users row nor its rows.
      expect(await bounded(revokeNativeCredentials(revokeDatabase, formerOwner.tokenHash, 'legacy'), 3000)).toBe(true);
    } finally {
      parked.release();
    }
    await bounded(registration);
    expect(await deviceRows([liveInstall, reinstall, ...previousInactive])).toEqual({
      [liveInstall]: { userId: previousOwner.userId, token, active: false },
      [reinstall]: { userId: registering.userId, token, active: true },
      ...Object.fromEntries(
        previousInactive.map((installationId) => [
          installationId,
          { userId: previousOwner.userId, token, active: false },
        ]),
      ),
    });
    const untouched = await environment.database
      .select({ updatedAt: notificationDevices.updatedAt })
      .from(notificationDevices)
      .where(inArray(notificationDevices.installationId, previousInactive));
    expect(untouched.map((row) => row.updatedAt.toISOString())).toEqual(
      previousInactive.map(() => retiredAt.toISOString()),
    );
  });

  it('re-registers its own row without waiting for a delivery that holds it', async () => {
    const subject = await climber();
    const token = pushToken();
    const ownInstall = installation();
    await installed(subject.userId, ownInstall, token);
    // A delivery insert holds KEY SHARE on its device row through the foreign key.
    const delivery = holdLocks(lockDeviceRow(ownInstall, 'key share'));
    try {
      await bounded(delivery.locked);
      await bounded(
        saveNotificationDevice(
          registerDatabase,
          subject.userId,
          { ...device(ownInstall, token), locale: 'fr' },
          lease(),
        ),
        3000,
      );
    } finally {
      delivery.release();
    }
    await bounded(delivery.done);
    const [saved] = await environment.database
      .select({ locale: notificationDevices.locale, active: notificationDevices.active })
      .from(notificationDevices)
      .where(eq(notificationDevices.installationId, ownInstall));
    expect(saved).toEqual({ locale: 'fr', active: true });
  });

  it("locks its own row after it changed hands, and the new owner's sign-out waits for it", async () => {
    const registering = await climber();
    const firstOwner = await climber();
    const nextOwner = await climber();
    const token = pushToken();
    const otherToken = pushToken();
    // The live row for the token sorts before the registering installation.
    const tokenInstall = installation(0);
    const ownInstall = installation(1);
    await installed(firstOwner.userId, tokenInstall, token);
    await installed(firstOwner.userId, ownInstall, pushToken());
    // A push retirement in flight holds the token row, so the registration
    // stops between its owner read (registering climber + first owner) and
    // its own row.
    const retirement = holdLocks(lockDeviceRow(tokenInstall, 'no key update'));
    const parked = parkBeforeCommit(registerDatabase, () => true);
    let registration: Promise<void> | undefined;
    let revoke: Promise<boolean> | undefined;
    try {
      await bounded(retirement.locked);
      registration = saveNotificationDevice(registerDatabase, registering.userId, device(ownInstall, token), lease());
      const stopped = await blockedStatement(observer, REGISTER_APPLICATION, registration);
      expect(stopped.query).toMatch(REGISTRATION_DEVICE_LOCK);
      expect(stopped.blockers).toEqual([HOLDER_APPLICATION]);
      // Meanwhile the installation registers for a third climber with a new token.
      await bounded(
        saveNotificationDevice(secondRegisterDatabase, nextOwner.userId, device(ownInstall, otherToken), lease()),
        3000,
      );
      retirement.release();
      await bounded(retirement.done);
      // The registration now holds the third climber's row without that climber's users row.
      await bounded(parked.reached);
      revoke = revokeNativeCredentials(revokeDatabase, nextOwner.tokenHash, 'legacy');
      const waiting = await blockedStatement(observer, REVOKE_APPLICATION, revoke);
      expect(waiting.query).toMatch(/update "notification_devices"/i);
      expect(waiting.blockers).toEqual([REGISTER_APPLICATION]);
    } finally {
      retirement.release();
      parked.release();
    }
    const [, revoked] = await bounded(Promise.all([registration, revoke]));
    expect(revoked).toBe(true);
    expect(await deviceRows([tokenInstall, ownInstall])).toEqual({
      [tokenInstall]: { userId: firstOwner.userId, token, active: false },
      [ownInstall]: { userId: registering.userId, token, active: true },
    });
  });

  describe('two registrations swapping tokens between two climbers', () => {
    for (const lead of ['first', 'second'] as const) {
      it(`${lead} registration first: both wait for the lowest installation id, holding nothing after it`, async () => {
        const subject = await swap();
        // Holding the lowest row stops both registrations at their first device lock.
        const retirement = holdLocks(lockDeviceRow(subject.lowInstall, 'no key update'));
        const runFirst = () =>
          saveNotificationDevice(
            registerDatabase,
            subject.first.userId,
            device(subject.lowInstall, subject.firstToken),
            lease(),
          );
        const runSecond = () =>
          saveNotificationDevice(
            secondRegisterDatabase,
            subject.second.userId,
            device(subject.highInstall, subject.secondToken),
            lease(),
          );
        const [leadApplication, trailApplication] =
          lead === 'first'
            ? [REGISTER_APPLICATION, SECOND_REGISTER_APPLICATION]
            : [SECOND_REGISTER_APPLICATION, REGISTER_APPLICATION];
        let leading: Promise<void> | undefined;
        let trailing: Promise<void> | undefined;
        try {
          await bounded(retirement.locked);
          leading = lead === 'first' ? runFirst() : runSecond();
          expect((await blockedStatement(observer, leadApplication, leading)).query).toMatch(REGISTRATION_DEVICE_LOCK);
          trailing = lead === 'first' ? runSecond() : runFirst();
          expect((await blockedStatement(observer, trailApplication, trailing)).query).toMatch(
            REGISTRATION_DEVICE_LOCK,
          );
          // Locking in scan order would have taken the higher row (stored first) before waiting.
          const free = await observer<{ installation_id: string }[]>`
            SELECT installation_id FROM notification_devices
            WHERE installation_id = ${subject.highInstall}
            FOR NO KEY UPDATE SKIP LOCKED`;
          expect(free.map((row) => row.installation_id)).toEqual([subject.highInstall]);
        } finally {
          retirement.release();
        }
        await bounded(Promise.all([retirement.done, leading, trailing]));
        expect(await deviceRows([subject.lowInstall, subject.highInstall])).toEqual({
          [subject.lowInstall]: { userId: subject.first.userId, token: subject.firstToken, active: true },
          [subject.highInstall]: { userId: subject.second.userId, token: subject.secondToken, active: true },
        });
      });
    }
  });

  describe('controls: the order registration used before #7645', () => {
    it('deadlocks with a sign-out of the same climber', async () => {
      const subject = await climber();
      const token = pushToken();
      const reinstall = installation();
      await installed(subject.userId, installation(), token);
      const rowsLocked = barrier();
      const upsert = barrier();
      const preFix = registerInPreFixOrder(registerDatabase, subject.userId, device(reinstall, token), async () => {
        rowsLocked.resolve();
        await upsert.promise;
      });
      let revoke: Promise<boolean> | undefined;
      try {
        await bounded(rowsLocked.promise);
        revoke = revokeNativeCredentials(revokeDatabase, subject.tokenHash, 'legacy');
        // The sign-out now holds the users row and waits for the device row.
        const waiting = await blockedStatement(observer, REVOKE_APPLICATION, revoke);
        expect(waiting.query).toMatch(/update "notification_devices"/i);
        expect(waiting.blockers).toEqual([REGISTER_APPLICATION]);
      } finally {
        // The upsert's foreign key now asks for KEY SHARE on the users row the sign-out holds.
        upsert.resolve();
      }
      expect(deadlocks(await bounded(Promise.allSettled([revoke, preFix])))).toHaveLength(1);
    });

    it('deadlocks two registrations swapping tokens', async () => {
      const subject = await swap();
      const firstLocked = barrier();
      const secondLocked = barrier();
      const upsert = barrier();
      // Each locks the other's row, then upserts its own: a crosswise wait.
      const firstRegistration = registerInPreFixOrder(
        registerDatabase,
        subject.first.userId,
        device(subject.lowInstall, subject.firstToken),
        async () => {
          firstLocked.resolve();
          await upsert.promise;
        },
      );
      const secondRegistration = registerInPreFixOrder(
        secondRegisterDatabase,
        subject.second.userId,
        device(subject.highInstall, subject.secondToken),
        async () => {
          secondLocked.resolve();
          await upsert.promise;
        },
      );
      try {
        await bounded(Promise.all([firstLocked.promise, secondLocked.promise]));
      } finally {
        upsert.resolve();
      }
      expect(deadlocks(await bounded(Promise.allSettled([firstRegistration, secondRegistration])))).toHaveLength(1);
    });
  });
});

/** A's phone was reinstalled once, so two of A's live rows hold the token B now registers. */
async function movingToken() {
  const previousOwner = await climber();
  const nextOwner = await climber();
  const token = pushToken();
  const previousInstalls = [installation(), installation()];
  for (const installationId of previousInstalls) await installed(previousOwner.userId, installationId, token);
  return { previousOwner, nextOwner, token, previousInstalls, nextInstall: installation() };
}

function registerNextOwner(subject: Awaited<ReturnType<typeof movingToken>>) {
  return saveNotificationDevice(
    registerDatabase,
    subject.nextOwner.userId,
    device(subject.nextInstall, subject.token),
    lease(),
  );
}

/** A's rows are retired (or deleted with the account); B's installation holds the token. */
async function expectMoved(subject: Awaited<ReturnType<typeof movingToken>>, previousRows: 'kept' | 'deleted') {
  const retired = { userId: subject.previousOwner.userId, token: subject.token, active: false };
  expect(await deviceRows([...subject.previousInstalls, subject.nextInstall])).toEqual({
    ...(previousRows === 'kept'
      ? Object.fromEntries(subject.previousInstalls.map((installationId) => [installationId, retired]))
      : {}),
    [subject.nextInstall]: { userId: subject.nextOwner.userId, token: subject.token, active: true },
  });
  expect(await liveRefreshRows(subject.nextOwner.userId)).toBe(1);
}

/**
 * Two climbers whose installations trade tokens: each installation's new token
 * is the one the other holds now. The higher installation id is stored first,
 * so scanning the table meets it before the lower one.
 */
async function swap() {
  const first = await climber();
  const second = await climber();
  const firstToken = pushToken();
  const secondToken = pushToken();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const lowInstall = installation(0);
    const highInstall = installation(1);
    await installed(second.userId, highInstall, firstToken);
    await installed(first.userId, lowInstall, secondToken);
    const stored = await environment.client<{ installation_id: string }[]>`
      SELECT installation_id FROM notification_devices
      WHERE installation_id IN (${lowInstall}, ${highInstall})
      ORDER BY ctid`;
    if (stored[0]?.installation_id === highInstall)
      return { first, second, firstToken, secondToken, lowInstall, highInstall };
    await environment.database
      .delete(notificationDevices)
      .where(inArray(notificationDevices.installationId, [lowInstall, highInstall]));
  }
  throw new Error('Could not store the higher installation id before the lower one');
}
