import { randomUUID } from 'node:crypto';
import { IncomingMessage, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { getTableName, like, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  mobileRefreshTokens,
  userCredentials,
  userProfiles,
  users,
} from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import { handleNativeAuthRegister, __resetNativeAuthStateForTests } from '../handlers/native-auth';
import {
  AUTHORITY_GATE_KEY,
  AUTHORITY_GATE_NAMESPACE,
  CURRENT_EMAIL_NORMALIZER_VERSION,
  lockAuthorityGateExclusively,
} from '../auth/current-store/foundation-context';

// BA-03 (#6977): legacy native registration checks the authority gate before
// bcrypt, then again inside the transaction that writes users, credentials and
// the refresh row, holding the shared gate until that commits. An authority
// switch landing after the first check must be seen by the second: the
// registration is refused (503) and nothing is written. Real PostgreSQL, the
// switch on its own connection, the real handler. Synthetic addresses only.

const hashing = vi.hoisted(() => ({ afterRealHash: undefined as (() => Promise<void>) | undefined }));
vi.mock('bcryptjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('bcryptjs')>();
  return {
    ...original,
    hash: async (contents: string, cost: number | string) => {
      const hashed = await original.hash(contents, cost);
      // Runs after the pre-bcrypt check and before the write transaction opens.
      await hashing.afterRealHash?.();
      return hashed;
    },
  };
});

const domain = `gate-${randomUUID().slice(0, 8)}.example.test`;
const openSwitches: AuthoritySwitch[] = [];

interface AuthoritySwitch {
  /** Resolves once the switch holds the gate exclusively and has written its manifest. */
  readonly held: Promise<void>;
  readonly settled: Promise<'committed' | 'rolled-back'>;
  commit(): void;
  rollBack(): void;
}

/** An authority switch: the exclusive gate, then a current manifest naming Better Auth as the writer. */
function openAuthoritySwitch(): AuthoritySwitch {
  const projectionId = `ba03-native-gate-${randomUUID()}`;
  let gateHeld = () => {};
  const held = new Promise<void>((resolve) => {
    gateHeld = resolve;
  });
  let decide: (commit: boolean) => void = () => {};
  const decision = new Promise<boolean>((resolve) => {
    decide = resolve;
  });
  const rolledBack = new Error('switch rolled back');
  const settled = db
    .transaction(async (transaction) => {
      await lockAuthorityGateExclusively(transaction);
      await transaction.insert(authEmailProjection).values({
        projectionId,
        normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
        phase: 'enforced',
        writerEpoch: 2,
        writerAuthority: 'better-auth',
        preparedAt: new Date(),
      });
      gateHeld();
      if (!(await decision)) throw rolledBack;
    })
    .then(
      () => 'committed' as const,
      (error: unknown) => {
        if (error === rolledBack) return 'rolled-back' as const;
        throw error;
      },
    );
  const handle = { held, settled, commit: () => decide(true), rollBack: () => decide(false) };
  openSwitches.push(handle);
  return handle;
}

async function register(email: string) {
  const request = new IncomingMessage(new Socket());
  request.method = 'POST';
  request.url = '/auth/native/register';
  request.headers = {};
  const captured = {
    statusCode: 0,
    body: '',
    writeHead(status: number) {
      this.statusCode = status;
    },
    setHeader() {},
    end(text?: string) {
      this.body = text ?? '';
    },
  };
  try {
    const handling = handleNativeAuthRegister(request, captured as unknown as ServerResponse);
    request.emit('data', Buffer.from(JSON.stringify({ email, password: 'synthetic-password' })));
    request.emit('end');
    await handling;
    const parsed: unknown = captured.body ? JSON.parse(captured.body) : null;
    return { status: captured.statusCode, body: parsed as Record<string, unknown> };
  } finally {
    request.destroy();
  }
}

async function rowCounts(email: string) {
  const [counted] = await db.execute<{ users: number; credentials: number; profiles: number; refresh: number }>(
    sql`SELECT
      (SELECT count(*)::int FROM ${users} WHERE ${users.email} = ${email}) AS users,
      (SELECT count(*)::int FROM ${userCredentials}) AS credentials,
      (SELECT count(*)::int FROM ${userProfiles}) AS profiles,
      (SELECT count(*)::int FROM ${mobileRefreshTokens}) AS refresh`,
  );
  return counted;
}

/**
 * Waits until a transaction in this worker's database queues for the shared
 * gate, then returns the identity tables that transaction already holds a lock
 * on. Empty means it reached the gate before touching any of them.
 */
async function waitForGateWaiter(): Promise<string[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const [waiter] = await db.execute<{ pid: number }>(
      sql`SELECT pid FROM pg_catalog.pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
          AND classid = ${AUTHORITY_GATE_NAMESPACE} AND objid = ${AUTHORITY_GATE_KEY} AND objsubid = 2
        LIMIT 1`,
    );
    if (waiter) {
      const held = await db.execute<{ relation: string }>(
        sql`SELECT DISTINCT relation::regclass::text AS relation FROM pg_catalog.pg_locks
          WHERE pid = ${waiter.pid} AND locktype = 'relation'
            AND relation IN (
              to_regclass(${getTableName(users)}),
              to_regclass(${getTableName(userCredentials)}),
              to_regclass(${getTableName(mobileRefreshTokens)})
            )`,
      );
      return [...held].map((row) => row.relation);
    }
    if (Date.now() > deadline) throw new Error('The registration never queued for the authority gate');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const UNAVAILABLE = { error: 'Authentication is temporarily unavailable' };

/** No manifest, which is production today. Another file in this worker may have left one. */
async function clearManifests() {
  await db.delete(authEmailReservationMembers);
  await db.delete(authEmailReservations);
  await db.delete(authEmailProjection);
}

beforeEach(async () => {
  __resetNativeAuthStateForTests();
  hashing.afterRealHash = undefined;
  await clearManifests();
});

afterEach(async () => {
  hashing.afterRealHash = undefined;
  for (const pending of openSwitches.splice(0)) {
    pending.rollBack();
    await pending.settled.catch(() => {});
  }
  await clearManifests();
  await db.delete(users).where(like(users.email, `%@${domain}`));
});

describe('legacy native registration and the authority gate', () => {
  it('with no manifest registers exactly as before', async () => {
    const email = `fresh@${domain}`;
    const before = await rowCounts(email);

    const reply = await register(email);

    expect(reply.status).toBe(201);
    expect(Object.keys(reply.body).sort()).toEqual(['accountCreation', 'expiresAt', 'jwt', 'refreshToken', 'userId']);
    expect(await rowCounts(email)).toEqual({
      users: 1,
      credentials: before.credentials + 1,
      profiles: before.profiles + 1,
      refresh: before.refresh + 1,
    });
  });

  it('refuses when a switch to another writer commits after the pre-bcrypt check, writing nothing', async () => {
    const email = `switched@${domain}`;
    const before = await rowCounts(email);
    hashing.afterRealHash = async () => {
      const authoritySwitch = openAuthoritySwitch();
      await authoritySwitch.held;
      authoritySwitch.commit();
      expect(await authoritySwitch.settled).toBe('committed');
    };

    const reply = await register(email);

    expect(reply).toEqual({ status: 503, body: UNAVAILABLE });
    expect(await rowCounts(email)).toEqual(before);
  });

  it('waits for a switch holding the gate when its write starts, then refuses, writing nothing', async () => {
    const email = `held@${domain}`;
    const before = await rowCounts(email);
    const opened: { switch?: AuthoritySwitch } = {};
    hashing.afterRealHash = async () => {
      opened.switch = openAuthoritySwitch();
      await opened.switch.held;
    };

    const registering = register(email);
    // Queued on the gate before any users, credential or refresh write.
    expect(await waitForGateWaiter()).toEqual([]);
    expect(await rowCounts(email)).toEqual(before);
    opened.switch?.commit();
    expect(await opened.switch?.settled).toBe('committed');

    expect(await registering).toEqual({ status: 503, body: UNAVAILABLE });
    expect(await rowCounts(email)).toEqual(before);
  });

  it('registers normally after waiting out a switch that rolls back', async () => {
    const email = `rolled-back@${domain}`;
    const before = await rowCounts(email);
    const opened: { switch?: AuthoritySwitch } = {};
    hashing.afterRealHash = async () => {
      opened.switch = openAuthoritySwitch();
      await opened.switch.held;
    };

    const registering = register(email);
    expect(await waitForGateWaiter()).toEqual([]);
    opened.switch?.rollBack();
    expect(await opened.switch?.settled).toBe('rolled-back');

    const reply = await registering;
    expect(reply.status).toBe(201);
    expect(await rowCounts(email)).toEqual({
      users: 1,
      credentials: before.credentials + 1,
      profiles: before.profiles + 1,
      refresh: before.refresh + 1,
    });
  });
});
