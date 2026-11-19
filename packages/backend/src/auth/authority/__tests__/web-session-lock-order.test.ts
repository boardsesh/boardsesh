import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AUTH_PROTOCOL_VERSION, type ResetPasswordCommand } from '@boardsesh/auth-protocol';
import * as schema from '@boardsesh/db/schema';
import { authEmailProjection, userCredentials, users } from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { barrier, blockedStatement, bounded, connectAs, parkBeforeCommit } from './lock-order-harness';
import { denyFirstPartySession } from '../lineage';
import { captureIdentityAuthority } from '../router';
import { readFirstPartySession, type FirstPartySession } from '../session-reader';
import { issueWebSession, type IssuedWebSession } from '../web-session';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { consumePasswordRecovery, requestPasswordRecovery } from '../../current-store/password-recovery';
import { authenticateWebPassword } from '../../current-store/web-password';
import { getPostgresErrorCode } from '../../../utils/postgres-errors';

/**
 * A login (`issueWebSession` presenting a session) against the two writers that
 * end that climber's sessions: web sign-out (`denyFirstPartySession`) and a
 * staged password reset. Each takes the shared gate and then the climber's
 * `users` row FOR UPDATE before any other row of theirs, so whichever starts
 * second queues on that row. Two logins that present each other's sessions
 * lock both `users` rows in id order and queue instead of deadlocking.
 */
const ISSUE_APPLICATION = 'web-session-lock-order-issue';
const OTHER_APPLICATION = 'web-session-lock-order-other';
const NEXT_PASSWORD = 'web session lock order replacement';
const USERS_FOR_UPDATE = /from "users" where "users"\."id" = \$1 for update/i;

let environment: Awaited<ReturnType<typeof createEnvironment>>;
let issueClient: ReturnType<typeof postgres>;
let otherClient: ReturnType<typeof postgres>;
let observer: ReturnType<typeof postgres>;
let issueDatabase: typeof environment.database;
let otherDatabase: typeof environment.database;
const projectionId = randomUUID();
const authority = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
  expectedWriterEpoch: 1,
  emailVerificationEnabled: false,
};
vi.mock('../../admission-pool', () => ({
  readOnAdmissionConnection: async (
    mark: () => void,
    read: (database: typeof environment.database) => PromiseLike<unknown>,
  ) => {
    mark();
    return read(environment.database);
  },
}));

const isIssued = (result: unknown) => typeof result === 'object' && result !== null && 'token' in result;
const isResetReply = (result: unknown) =>
  typeof result === 'object' && result !== null && 'operation' in result && result.operation === 'reset-password';
const isPasswordReply = (result: unknown) =>
  typeof result === 'object' && result !== null && 'operation' in result && result.operation === 'password';
const ORIGINAL_PASSWORD = 'web session lock original';

async function climber() {
  const userId = randomUUID();
  const email = `web-session-lock-${userId}@example.com`;
  await environment.database.insert(users).values({ id: userId, email });
  await environment.database.transaction(async (transaction) => {
    await reserveEnforcedEmail(transaction, { ...authority, rawEmail: email, requestedUserId: userId });
    await transaction.insert(userCredentials).values({ userId, passwordHash: await bcrypt.hash(ORIGINAL_PASSWORD, 4) });
  });
  return { userId, email };
}

/** The staged password command asking for a web session, presenting `token`. */
async function passwordLogin(database: typeof environment.database, email: string, token: string) {
  const reply = await authenticateWebPassword(database, authority, {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    webSession: { presented: { kind: 'canonical-token', token } },
    credentialProofVersion: 1,
    payload: { email, password: ORIGINAL_PASSWORD },
  });
  if (reply.outcome !== 'authenticated' || !reply.webSession) throw new Error('No web session issued');
  return reply.webSession;
}

async function login(database: typeof environment.database, userId: string, presented?: FirstPartySession) {
  const receipt = await environment.database.transaction((transaction) =>
    captureIdentityAuthority(transaction, authority),
  );
  const now = new Date();
  return database.transaction((transaction) =>
    issueWebSession(transaction, { userId, presented, authority: receipt, now, authenticatedAt: now }),
  );
}

async function session(issued: IssuedWebSession): Promise<FirstPartySession> {
  const outcome = await readFirstPartySession(environment.database, { kind: 'canonical-token', token: issued.token });
  if (outcome.status !== 'admitted') throw new Error('Synthetic session refused');
  return outcome.session;
}

async function status({ token }: { readonly token: string }) {
  return (await readFirstPartySession(environment.database, { kind: 'canonical-token', token })).status;
}

async function resetCommand(email: string): Promise<ResetPasswordCommand> {
  const reply = await requestPasswordRecovery(environment.database, authority, {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'forgot-password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { email },
  });
  if (reply.outcome !== 'accepted' || !reply.mailPlan) throw new Error('Missing owned recovery fixture');
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'reset-password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { token: reply.mailPlan.token, password: NEXT_PASSWORD, confirmPassword: NEXT_PASSWORD },
  };
}

describe('a login and the writers that end its sessions share one lock order', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    const connect = (applicationName: string) => connectAs(environment.client.options.database, applicationName);
    issueClient = connect(ISSUE_APPLICATION);
    otherClient = connect(OTHER_APPLICATION);
    observer = connect('web-session-lock-order-observer');
    issueDatabase = drizzle(issueClient, { schema });
    otherDatabase = drizzle(otherClient, { schema });
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
  });
  beforeEach(() => {
    vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'synthetic-web-session-retired-mailbox-key-6975');
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'compatible');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await Promise.allSettled([issueClient, otherClient, observer].map((client) => client?.end({ timeout: 5 })));
    await environment?.close();
  });

  it('login first: a reset waits on the users row, then ends the new session too', async () => {
    const { userId, email } = await climber();
    const presented = await login(environment.database, userId);
    const command = await resetCommand(email);
    const parked = parkBeforeCommit(issueDatabase, isIssued);
    const pendingLogin = login(issueDatabase, userId, await session(presented));
    let reset: ReturnType<typeof consumePasswordRecovery> | undefined;
    try {
      await bounded(parked.reached);
      reset = consumePasswordRecovery(otherDatabase, authority, command);
      const waiting = await blockedStatement(observer, OTHER_APPLICATION, reset);
      expect(waiting.query).toMatch(USERS_FOR_UPDATE);
      expect(waiting.blockers).toEqual([ISSUE_APPLICATION]);
    } finally {
      parked.release();
    }
    const [issued, resetReply] = await bounded(Promise.all([pendingLogin, reset]));
    expect(resetReply.outcome).toBe('reset');
    expect(issued.generation).toBe(0);
    expect(await status(presented)).toBe('denied');
    // Issued before the reset, so the reset ends it.
    expect(await status(issued)).toBe('denied');
  });

  it('reset first: the login waits on the users row, then stamps the new generation', async () => {
    const { userId, email } = await climber();
    const presented = await login(environment.database, userId);
    const command = await resetCommand(email);
    const parked = parkBeforeCommit(otherDatabase, isResetReply);
    const reset = consumePasswordRecovery(otherDatabase, authority, command);
    let pendingLogin: Promise<IssuedWebSession> | undefined;
    try {
      await bounded(parked.reached);
      pendingLogin = login(issueDatabase, userId, await session(presented));
      const waiting = await blockedStatement(observer, ISSUE_APPLICATION, pendingLogin);
      expect(waiting.query).toMatch(USERS_FOR_UPDATE);
      expect(waiting.blockers).toEqual([OTHER_APPLICATION]);
    } finally {
      parked.release();
    }
    const [resetReply, issued] = await bounded(Promise.all([reset, pendingLogin]));
    expect(resetReply.outcome).toBe('reset');
    expect(issued.generation).toBe(1);
    expect(await status(presented)).toBe('denied');
    expect(await status(issued)).toBe('admitted');
  });

  for (const first of ['login', 'sign-out'] as const)
    it(`${first} first: a sign-out of another device and a login on this one both finish`, async () => {
      const { userId } = await climber();
      const presented = await login(environment.database, userId);
      const otherDevice = await login(environment.database, userId);
      const [presentedSession, otherSession] = [await session(presented), await session(otherDevice)];
      const parked = parkBeforeCommit(first === 'login' ? issueDatabase : otherDatabase, () => true);
      const start = {
        login: () => login(issueDatabase, userId, presentedSession),
        'sign-out': () => denyFirstPartySession(otherDatabase, otherSession),
      };
      const second = first === 'login' ? 'sign-out' : 'login';
      const started = start[first]();
      let waited: Promise<unknown> | undefined;
      try {
        await bounded(parked.reached);
        waited = start[second]();
        const waiting = await blockedStatement(
          observer,
          second === 'login' ? ISSUE_APPLICATION : OTHER_APPLICATION,
          waited,
        );
        expect(waiting.query).toMatch(USERS_FOR_UPDATE);
        expect(waiting.blockers).toEqual([first === 'login' ? ISSUE_APPLICATION : OTHER_APPLICATION]);
      } finally {
        parked.release();
      }
      const outcomes = await bounded(Promise.all([started, waited]));
      const issued = outcomes.find(isIssued) as IssuedWebSession;
      expect(await status(presented)).toBe('denied');
      expect(await status(otherDevice)).toBe('denied');
      expect(await status(issued)).toBe('admitted');
    });

  it('two logins that present each other’s sessions queue in id order and both finish', async () => {
    const [left, right] = [(await climber()).userId, (await climber()).userId];
    const [leftSession, rightSession] = [
      await session(await login(environment.database, left)),
      await session(await login(environment.database, right)),
    ];
    const parked = parkBeforeCommit(issueDatabase, isIssued);
    // Signs in as `right` on the browser holding `left`'s session, and the reverse.
    const crossedRight = login(issueDatabase, right, leftSession);
    let crossedLeft: Promise<IssuedWebSession> | undefined;
    try {
      await bounded(parked.reached);
      crossedLeft = login(otherDatabase, left, rightSession);
      const waiting = await blockedStatement(observer, OTHER_APPLICATION, crossedLeft);
      expect(waiting.query).toMatch(/from "users" where "users"\."id" = \$1 for (update|key share)/i);
      expect(waiting.blockers).toEqual([ISSUE_APPLICATION]);
    } finally {
      parked.release();
    }
    const [asRight, asLeft] = await bounded(Promise.all([crossedRight, crossedLeft]));
    expect((await session(asRight)).userId).toBe(right);
    expect((await session(asLeft)).userId).toBe(left);
    for (const presented of [leftSession, rightSession])
      expect(
        await environment.database
          .select()
          .from(schema.authSession)
          .where(eq(schema.authSession.id, presented.authSessionId)),
      ).toEqual([]);
  });

  it('two password logins presenting each other’s sessions queue in id order and both finish', async () => {
    const [left, right] = [await climber(), await climber()];
    const [leftToken, rightToken] = [
      (await login(environment.database, left.userId)).token,
      (await login(environment.database, right.userId)).token,
    ];
    const parked = parkBeforeCommit(issueDatabase, isPasswordReply);
    const asRight = passwordLogin(issueDatabase, right.email, leftToken);
    let asLeft: ReturnType<typeof passwordLogin> | undefined;
    try {
      await bounded(parked.reached);
      asLeft = passwordLogin(otherDatabase, left.email, rightToken);
      const waiting = await blockedStatement(observer, OTHER_APPLICATION, asLeft);
      expect(waiting.query).toMatch(/from "users" where "users"\."id" = \$1 for (update|key share)/i);
      expect(waiting.blockers).toEqual([ISSUE_APPLICATION]);
    } finally {
      parked.release();
    }
    const issued = await bounded(Promise.all([asRight, asLeft]));
    expect(await Promise.all(issued.map((session) => status(session)))).toEqual(['admitted', 'admitted']);
    for (const token of [leftToken, rightToken])
      expect((await readFirstPartySession(environment.database, { kind: 'canonical-token', token })).status).toBe(
        'denied',
      );
  });

  it('two password logins of one climber presenting the same session never upgrade a lock', async () => {
    const { userId, email } = await climber();
    const presented = (await login(environment.database, userId)).token;
    const parked = parkBeforeCommit(issueDatabase, isPasswordReply);
    const first = passwordLogin(issueDatabase, email, presented);
    let second: ReturnType<typeof passwordLogin> | undefined;
    try {
      await bounded(parked.reached);
      second = passwordLogin(otherDatabase, email, presented);
      // The presented account is locked FOR UPDATE from the start, not KEY SHARE then FOR UPDATE.
      const waiting = await blockedStatement(observer, OTHER_APPLICATION, second);
      expect(waiting.query).toMatch(USERS_FOR_UPDATE);
      expect(waiting.blockers).toEqual([ISSUE_APPLICATION]);
    } finally {
      parked.release();
    }
    const issued = await bounded(Promise.all([first, second]));
    expect(await Promise.all(issued.map((session) => status(session)))).toEqual(['admitted', 'admitted']);
    expect(
      (await readFirstPartySession(environment.database, { kind: 'canonical-token', token: presented })).status,
    ).toBe('denied');
  });

  it('control: an issuer that locked the higher id first deadlocks with a login in id order', async () => {
    const ids = [(await climber()).userId, (await climber()).userId];
    const [lower, higher] = (
      await environment.database.select({ id: users.id }).from(users).where(inArray(users.id, ids)).orderBy(users.id)
    ).map(({ id }) => id);
    const presented = await session(await login(environment.database, lower));
    const higherLocked = barrier();
    const lockLower = barrier();
    // The order issueWebSession must never use: the presented account's row after the other one.
    const reversed = otherDatabase.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock_shared(6975, 2)`);
      await transaction.select({ id: users.id }).from(users).where(eq(users.id, higher)).for('update');
      higherLocked.resolve();
      await lockLower.promise;
      await transaction.select({ id: users.id }).from(users).where(eq(users.id, lower)).for('key share');
    });
    let ordered: Promise<IssuedWebSession> | undefined;
    try {
      await bounded(higherLocked.promise);
      // Signs in as `higher` presenting `lower`'s session: FOR UPDATE on lower, then KEY SHARE on higher.
      ordered = login(issueDatabase, higher, presented);
      const waiting = await blockedStatement(observer, ISSUE_APPLICATION, ordered);
      expect(waiting.query).toMatch(/for key share/i);
      expect(waiting.blockers).toEqual([OTHER_APPLICATION]);
    } finally {
      lockLower.resolve();
    }
    const outcomes = await bounded(Promise.allSettled([ordered, reversed]));
    const deadlocks = outcomes.filter(
      (outcome) => outcome.status === 'rejected' && getPostgresErrorCode(outcome.reason) === '40P01',
    );
    expect(deadlocks).toHaveLength(1);
  });
});
