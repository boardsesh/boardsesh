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
  saveNotificationDevice,
  type NotificationDeviceInput,
} from '../../../services/notification-device-registration';

/**
 * Issue #7645: push-device registration (saveNotificationDevice) against native
 * sign-out (revokeNativeCredentials) and against itself, each on its own
 * PostgreSQL connection. Registration takes the token lock, then `users` FOR
 * KEY SHARE for the climber and every owner of a row it touches, by id, then the
 * device rows by installation id. Sign-out takes `users` FOR UPDATE before the
 * climber's devices, so whichever starts second queues on the `users` row. Each
 * order parks the first command before COMMIT holding every lock it took and
 * proves where the second waits. Controls replay the order registration used
 * before the fix and get a real 40P01.
 */
const REGISTER_APPLICATION = '7645-lock-order-register';
const SECOND_REGISTER_APPLICATION = '7645-lock-order-register-second';
const REVOKE_APPLICATION = '7645-lock-order-revoke';
const SIGN_OUT_USERS_LOCK = /from "users" where "users"\."id" = \$1 for update/i;
const REGISTRATION_USERS_LOCK = /order by "users"\."id" asc for key share of "users"$/i;
const REGISTRATION_DEVICE_LOCK = /^with "locked_devices" as/i;
const MODES = ['legacy', 'generation'] as const satisfies readonly NativeRevocationMode[];

let environment: Awaited<ReturnType<typeof createEnvironment>>;
let registerClient: ReturnType<typeof postgres>;
let secondRegisterClient: ReturnType<typeof postgres>;
let revokeClient: ReturnType<typeof postgres>;
let observer: ReturnType<typeof postgres>;
let registerDatabase: typeof environment.database;
let secondRegisterDatabase: typeof environment.database;
let revokeDatabase: typeof environment.database;

const pushToken = () => `ExpoPushToken[${randomUUID()}]`;
const installation = () => `installation-${randomUUID()}`;
const lease = () => new Date(Date.now() + 3600000);
const device = (installationId: string, token: string): NotificationDeviceInput => ({
  installationId,
  token,
  platform: 'ios',
  locale: 'en-US',
});

/** A climber signed in on one phone, so a sign-out has a live refresh row to present. */
async function climber() {
  const userId = randomUUID();
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

async function installed(userId: string, installationId: string, token: string) {
  await environment.database
    .insert(notificationDevices)
    .values({ ...device(installationId, token), userId, expiresAt: lease() });
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
    observer = connect('7645-lock-order-observer');
    registerDatabase = drizzle(registerClient, { schema });
    secondRegisterDatabase = drizzle(secondRegisterClient, { schema });
    revokeDatabase = drizzle(revokeClient, { schema });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await Promise.allSettled(
      [registerClient, secondRegisterClient, revokeClient, observer].map((client) => client?.end({ timeout: 5 })),
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
      // A's phone was reinstalled once, so two of A's rows hold the token B now registers.
      async function movingToken() {
        const previousOwner = await climber();
        const nextOwner = await climber();
        const token = pushToken();
        const previousInstalls = [installation(), installation()];
        for (const installationId of previousInstalls) await installed(previousOwner.userId, installationId, token);
        return { previousOwner, nextOwner, token, previousInstalls, nextInstall: installation() };
      }

      async function expectMoved(subject: Awaited<ReturnType<typeof movingToken>>) {
        const [firstInstall, secondInstall] = subject.previousInstalls;
        expect(await deviceRows([...subject.previousInstalls, subject.nextInstall])).toEqual({
          [firstInstall]: { userId: subject.previousOwner.userId, token: subject.token, active: false },
          [secondInstall]: { userId: subject.previousOwner.userId, token: subject.token, active: false },
          [subject.nextInstall]: { userId: subject.nextOwner.userId, token: subject.token, active: true },
        });
        expect(await liveRefreshRows(subject.previousOwner.userId)).toBe(0);
        expect(await liveRefreshRows(subject.nextOwner.userId)).toBe(1);
      }

      it("registration first: A's sign-out waits on A's users row, then both finish", async () => {
        const subject = await movingToken();
        const parked = parkBeforeCommit(registerDatabase, () => true);
        const registering = saveNotificationDevice(
          registerDatabase,
          subject.nextOwner.userId,
          device(subject.nextInstall, subject.token),
          lease(),
        );
        let revoke: Promise<boolean> | undefined;
        try {
          // Registration holds KEY SHARE on both climbers and every row holding the token.
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
        await expectMoved(subject);
      });

      it("sign-out first: B's registration waits on A's users row, then both finish", async () => {
        const subject = await movingToken();
        const parked = parkBeforeCommit(revokeDatabase, () => true);
        const revoke = revokeNativeCredentials(revokeDatabase, subject.previousOwner.tokenHash, mode);
        let registering: Promise<void> | undefined;
        try {
          await bounded(parked.reached);
          registering = saveNotificationDevice(
            registerDatabase,
            subject.nextOwner.userId,
            device(subject.nextInstall, subject.token),
            lease(),
          );
          const waiting = await blockedStatement(observer, REGISTER_APPLICATION, registering);
          expect(waiting.query).toMatch(REGISTRATION_USERS_LOCK);
          expect(waiting.blockers).toEqual([REVOKE_APPLICATION]);
        } finally {
          parked.release();
        }
        const [revoked] = await bounded(Promise.all([revoke, registering]));
        expect(revoked).toBe(true);
        await expectMoved(subject);
      });
    });
  }

  describe('two registrations swapping tokens between two climbers', () => {
    // Each installation's new token is the one the other installation holds now.
    async function swap() {
      const first = await climber();
      const second = await climber();
      const firstToken = pushToken();
      const secondToken = pushToken();
      const firstInstall = installation();
      const secondInstall = installation();
      await installed(first.userId, firstInstall, secondToken);
      await installed(second.userId, secondInstall, firstToken);
      return { first, second, firstToken, secondToken, firstInstall, secondInstall };
    }

    for (const parkedFirst of ['first', 'second'] as const) {
      it(`the ${parkedFirst} registration first: the other waits on the device rows, then both finish`, async () => {
        const subject = await swap();
        const runFirst = () =>
          saveNotificationDevice(
            registerDatabase,
            subject.first.userId,
            device(subject.firstInstall, subject.firstToken),
            lease(),
          );
        const runSecond = () =>
          saveNotificationDevice(
            secondRegisterDatabase,
            subject.second.userId,
            device(subject.secondInstall, subject.secondToken),
            lease(),
          );
        const [leadDatabase, leadApplication, trailApplication] =
          parkedFirst === 'first'
            ? [registerDatabase, REGISTER_APPLICATION, SECOND_REGISTER_APPLICATION]
            : [secondRegisterDatabase, SECOND_REGISTER_APPLICATION, REGISTER_APPLICATION];
        const parked = parkBeforeCommit(leadDatabase, () => true);
        const lead = parkedFirst === 'first' ? runFirst() : runSecond();
        let trail: Promise<void> | undefined;
        try {
          // The lead holds both installations' rows; KEY SHARE on the climbers does not block.
          await bounded(parked.reached);
          trail = parkedFirst === 'first' ? runSecond() : runFirst();
          const waiting = await blockedStatement(observer, trailApplication, trail);
          expect(waiting.query).toMatch(REGISTRATION_DEVICE_LOCK);
          expect(waiting.blockers).toEqual([leadApplication]);
        } finally {
          parked.release();
        }
        await bounded(Promise.all([lead, trail]));
        expect(await deviceRows([subject.firstInstall, subject.secondInstall])).toEqual({
          [subject.firstInstall]: { userId: subject.first.userId, token: subject.firstToken, active: true },
          [subject.secondInstall]: { userId: subject.second.userId, token: subject.secondToken, active: true },
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
      const first = await climber();
      const second = await climber();
      const firstToken = pushToken();
      const secondToken = pushToken();
      const firstInstall = installation();
      const secondInstall = installation();
      await installed(first.userId, firstInstall, secondToken);
      await installed(second.userId, secondInstall, firstToken);
      const firstLocked = barrier();
      const secondLocked = barrier();
      const upsert = barrier();
      // Each locks the other's row, then upserts its own: a crosswise wait.
      const firstRegistration = registerInPreFixOrder(
        registerDatabase,
        first.userId,
        device(firstInstall, firstToken),
        async () => {
          firstLocked.resolve();
          await upsert.promise;
        },
      );
      const secondRegistration = registerInPreFixOrder(
        secondRegisterDatabase,
        second.userId,
        device(secondInstall, secondToken),
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
