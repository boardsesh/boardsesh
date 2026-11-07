import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { hash, compare } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { PROTOTYPE_LEGACY_KEY, PROTOTYPE_LEGACY_WEB_SECRET } from '../legacy-bridge';
import { validateProcessFixtureDatabaseUrl } from '../process-fixture';

const webRequire = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const { encode } = webRequire('next-auth/jwt') as {
  encode: (options: { token: Record<string, unknown>; secret: string; maxAge: number }) => Promise<string>;
};
const PROCESS_FIXTURE = fileURLToPath(new URL('../process-fixture.ts', import.meta.url));
const CHECKOUT_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const ORIGINAL_PASSWORD = 'original-process-password-山';
type Environment = Awaited<ReturnType<typeof createPrototypeEnvironment>>;
type LegacyTransport = 'native-jwt' | 'nextauth-cookie';
type ExitOutcome = { code: number | null; signal: NodeJS.Signals | null };
type Worker = {
  child: ChildProcess;
  pid: number;
  origin: string;
  exited: Promise<ExitOutcome>;
  mutationBarrier: Promise<void>;
};

let environment: Environment;
let firstWorker: Worker;
let secondWorker: Worker;
let originalHash: string;
const ownedChildren = new Map<ChildProcess, Promise<ExitOutcome>>();

function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
}

async function startWorker(
  mode: 'standard' | 'fail-after-reset' | 'pause-after-reset' = 'standard',
  databaseUrl = environment.databaseUrl,
): Promise<Worker> {
  const child = fork(PROCESS_FIXTURE, [], {
    cwd: CHECKOUT_ROOT,
    execPath: process.execPath,
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      TZ: 'UTC',
      AUTH_PROTOTYPE_PROCESS_DATABASE_URL: databaseUrl,
      AUTH_PROTOTYPE_PROCESS_MODE: mode,
    },
  });
  // Drain stderr without copying provider errors or credential bytes into test
  // output. A failed startup is reported through a fixed IPC error below.
  child.stderr?.resume();
  const exited = new Promise<ExitOutcome>((resolve) => {
    child.once('exit', (code, signal) => {
      ownedChildren.delete(child);
      resolve({ code, signal });
    });
    child.once('error', () => {
      ownedChildren.delete(child);
      resolve({ code: null, signal: null });
    });
  });
  // Own the process immediately, including before readiness. Cleanup must not
  // depend on a slow sibling reaching its ready message after another failed.
  ownedChildren.set(child, exited);
  let reachedMutation: () => void = () => {};
  const mutationBarrier = new Promise<void>((resolve) => {
    reachedMutation = resolve;
  });
  const ready = new Promise<{ pid: number; port: number }>((resolve, reject) => {
    child.once('error', () => reject(new Error('The disposable auth worker could not start.')));
    child.once('exit', () => reject(new Error('The disposable auth worker exited before readiness.')));
    child.on('message', (message: unknown) => {
      if (!isRecord(message)) return;
      if (message.type === 'after-password-mutation') reachedMutation();
      if (message.type === 'startup-error') reject(new Error('The disposable auth worker rejected its startup.'));
      if (message.type !== 'ready') return;
      if (
        typeof message.pid !== 'number' ||
        message.pid !== child.pid ||
        typeof message.port !== 'number' ||
        !Number.isInteger(message.port) ||
        message.port < 1 ||
        message.port > 65535
      ) {
        reject(new Error('The disposable auth worker returned invalid readiness.'));
        return;
      }
      resolve({ pid: message.pid, port: message.port });
    });
  });
  try {
    const readiness = await bounded(ready, 15000, 'The disposable auth worker did not become ready within 15 seconds.');
    const worker = { child, pid: readiness.pid, origin: `http://127.0.0.1:${readiness.port}`, exited, mutationBarrier };
    return worker;
  } catch (error) {
    child.kill('SIGKILL');
    await bounded(exited, 5000, 'Failed to stop an unready disposable auth worker.');
    throw error;
  }
}

async function stopProcess(
  child: ChildProcess,
  exited: Promise<ExitOutcome>,
  signal: NodeJS.Signals = 'SIGTERM',
): Promise<ExitOutcome> {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  try {
    return await bounded(exited, 6000, 'The disposable auth worker did not stop within 6 seconds.');
  } catch (error) {
    child.kill('SIGKILL');
    await bounded(exited, 5000, 'The disposable auth worker did not exit after forced cleanup.');
    throw error;
  }
}

function stopWorker(worker: Worker, signal: NodeJS.Signals = 'SIGTERM'): Promise<ExitOutcome> {
  return stopProcess(worker.child, worker.exited, signal);
}

async function restartFirst(): Promise<void> {
  const previousPid = firstWorker.pid;
  expect((await stopWorker(firstWorker, 'SIGKILL')).signal).toBe('SIGKILL');
  firstWorker = await startWorker();
  expect(firstWorker.pid).not.toBe(previousPid);
}

async function restartSecond(): Promise<void> {
  const previousPid = secondWorker.pid;
  expect((await stopWorker(secondWorker, 'SIGKILL')).signal).toBe('SIGKILL');
  secondWorker = await startWorker();
  expect(secondWorker.pid).not.toBe(previousPid);
}

function post(worker: Worker, path: string, body: unknown = {}, headers: HeadersInit = {}) {
  return fetch(`${worker.origin}/api/auth${path}`, {
    method: 'POST',
    headers: {
      origin: 'https://www.boardsesh.test',
      'content-type': 'application/json',
      ...Object.fromEntries(new Headers(headers)),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}

function session(worker: Worker, cookie: string) {
  return fetch(`${worker.origin}/api/auth/get-session`, { headers: { cookie }, signal: AbortSignal.timeout(10000) });
}

function canonicalCookie(response: Response): string {
  const header = response.headers.getSetCookie().find((cookie) => cookie.includes('better-auth.session_token='));
  expect(header).toBeDefined();
  return header!.split(';')[0];
}

async function seedUser() {
  const userId = randomUUID();
  const email = `${userId}@example.test`;
  await environment.database
    .insert(environment.schema.user)
    .values({ id: userId, email, name: 'Process fixture', emailVerified: true });
  await environment.database.insert(environment.schema.account).values({
    id: randomUUID(),
    userId,
    providerId: 'credential',
    accountId: userId,
    password: originalHash,
  });
  return { userId, email };
}

async function legacyHeaders(transport: LegacyTransport, userId: string): Promise<HeadersInit> {
  if (transport === 'nextauth-cookie') {
    const token = await encode({
      token: { sub: userId, authSessionId: randomUUID() },
      secret: PROTOTYPE_LEGACY_WEB_SECRET,
      maxAge: 30 * 24 * 60 * 60,
    });
    return { cookie: `__Secure-next-auth.session-token=${token}` };
  }
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now - 60)
    .setIssuer('boardsesh')
    .setAudience('boardsesh-mobile')
    .setExpirationTime(now + 3600)
    .sign(PROTOTYPE_LEGACY_KEY);
  return { authorization: `Bearer ${token}` };
}

async function seedReset(userId: string): Promise<string> {
  const token = randomUUID();
  await environment.database.insert(environment.schema.verification).values({
    id: randomUUID(),
    identifier: `reset-password:${token}`,
    value: userId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return token;
}

describe('real Node processes share durable canonical authentication state', () => {
  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    originalHash = await hash(ORIGINAL_PASSWORD, 4);
    firstWorker = await startWorker();
    secondWorker = await startWorker();
    expect(firstWorker.pid).not.toBe(secondWorker.pid);
    expect(firstWorker.pid).not.toBe(process.pid);
    expect(secondWorker.pid).not.toBe(process.pid);
  });
  afterAll(async () => {
    const outcomes = await Promise.allSettled([...ownedChildren].map(([child, exited]) => stopProcess(child, exited)));
    await environment?.close();
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  });

  it('reaps a rejected startup before returning control to its surviving siblings', async () => {
    const livePids = [...ownedChildren.keys()].map((child) => child.pid);
    await expect(startWorker('standard', 'postgresql://postgres:postgres@127.0.0.1:15475/postgres')).rejects.toThrow(
      'The disposable auth worker rejected its startup.',
    );
    expect([...ownedChildren.keys()].map((child) => child.pid)).toEqual(livePids);
    const healthy = await fetch(`${secondWorker.origin}/__fixture/ready`, { signal: AbortSignal.timeout(10000) });
    expect(await healthy.json()).toMatchObject({ ready: true, pid: secondWorker.pid });
  });

  it.each(['native-jwt', 'nextauth-cookie'] as const)(
    'keeps %s lineage idempotent, usable and non-fresh after an actual process restart',
    async (transport) => {
      const { userId } = await seedUser();
      const headers = await legacyHeaders(transport, userId);
      const responses = await Promise.all([
        post(firstWorker, '/prototype-legacy-bridge', { userId: 'untrusted-body-owner' }, headers),
        post(secondWorker, '/prototype-legacy-bridge', {}, headers),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const cookie = canonicalCookie(responses[0]);
      const bodies = await Promise.all(
        responses.map((response) => response.json() as Promise<{ userId: string; sessionId: string }>),
      );
      expect(bodies[0].userId).toBe(userId);
      expect(bodies[0].sessionId).toBe(bodies[1].sessionId);
      await restartFirst();
      expect(await (await session(firstWorker, cookie)).json()).toMatchObject({
        user: { id: userId },
        session: { id: bodies[0].sessionId, createdAt: new Date(0).toISOString(), originalAuthenticatedAt: null },
      });
      const repeated = await post(firstWorker, '/prototype-legacy-bridge', {}, headers);
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toMatchObject(bodies[0]);
      const sensitive = await fetch(`${firstWorker.origin}/api/auth/list-sessions`, {
        headers: { cookie },
        signal: AbortSignal.timeout(10000),
      });
      expect(sensitive.status).toBe(403);
      expect(await sensitive.json()).toMatchObject({ code: 'SESSION_NOT_FRESH' });
      expect(
        await environment.database
          .select()
          .from(environment.schema.session)
          .where(eq(environment.schema.session.userId, userId)),
      ).toHaveLength(1);
    },
  );

  it.each(['native-jwt', 'nextauth-cookie'] as const)(
    '%s cannot rebridge after sign-out and a process restart',
    async (transport) => {
      const { userId } = await seedUser();
      const headers = await legacyHeaders(transport, userId);
      const bridged = await post(firstWorker, '/prototype-legacy-bridge', {}, headers);
      expect(bridged.status).toBe(200);
      const cookie = canonicalCookie(bridged);
      expect((await post(secondWorker, '/sign-out', {}, { cookie })).status).toBe(200);
      await restartSecond();
      expect((await post(firstWorker, '/prototype-legacy-bridge', {}, headers)).status).toBe(401);
      expect((await post(secondWorker, '/prototype-legacy-bridge', {}, headers)).status).toBe(401);
      expect(await (await session(secondWorker, cookie)).json()).toBeNull();
    },
  );

  it.each(['native-jwt', 'nextauth-cookie'] as const)(
    '%s stays revoked and the changed password survives restart',
    async (transport) => {
      const { userId, email } = await seedUser();
      const headers = await legacyHeaders(transport, userId);
      const bridged = await post(firstWorker, '/prototype-legacy-bridge', {}, headers);
      const cookie = canonicalCookie(bridged);
      const token = await seedReset(userId);
      const changedPassword = 'committed-process-password-山';
      expect((await post(secondWorker, '/reset-password', { token, newPassword: changedPassword })).status).toBe(200);
      await restartFirst();
      expect((await post(firstWorker, '/prototype-legacy-bridge', {}, headers)).status).toBe(401);
      expect(await (await session(firstWorker, cookie)).json()).toBeNull();
      expect((await post(firstWorker, '/sign-in/email', { email, password: changedPassword })).status).toBe(200);
      expect((await post(secondWorker, '/sign-in/email', { email, password: ORIGINAL_PASSWORD })).status).toBe(401);
      const [account] = await environment.database
        .select()
        .from(environment.schema.account)
        .where(eq(environment.schema.account.userId, userId));
      expect(await compare(changedPassword, account.password!)).toBe(true);
      expect(
        await environment.database
          .select()
          .from(environment.schema.verification)
          .where(eq(environment.schema.verification.identifier, `reset-password:${token}`)),
      ).toHaveLength(0);
    },
  );

  it.each(['native-jwt', 'nextauth-cookie'] as const)(
    'rejects a stale %s from another account across process boundaries',
    async (transport) => {
      const departed = await seedUser();
      const current = await seedUser();
      const signIn = await post(secondWorker, '/sign-in/email', { email: current.email, password: ORIGINAL_PASSWORD });
      expect(signIn.status).toBe(200);
      const cookie = canonicalCookie(signIn);
      const headers = new Headers(await legacyHeaders(transport, departed.userId));
      headers.set('cookie', [headers.get('cookie'), cookie].filter(Boolean).join('; '));
      expect((await post(firstWorker, '/prototype-legacy-bridge', { userId: current.userId }, headers)).status).toBe(
        401,
      );
      expect(await (await session(firstWorker, cookie)).json()).toMatchObject({ user: { id: current.userId } });
      expect(
        await environment.database
          .select()
          .from(environment.schema.session)
          .where(eq(environment.schema.session.userId, departed.userId)),
      ).toHaveLength(0);
    },
  );

  it('rolls back a reset when SIGKILL lands at the proven post-mutation transaction barrier', async () => {
    const { userId, email } = await seedUser();
    const token = await seedReset(userId);
    const pausedWorker = await startWorker('pause-after-reset');
    const pendingReset = post(pausedWorker, '/reset-password', {
      token,
      newPassword: 'must-not-survive-process-kill',
    }).then(
      () => false,
      () => true,
    );
    await bounded(
      pausedWorker.mutationBarrier,
      10000,
      'The reset never reached the post-mutation transaction barrier.',
    );
    expect((await stopWorker(pausedWorker, 'SIGKILL')).signal).toBe('SIGKILL');
    expect(await pendingReset).toBe(true);
    expect((await post(secondWorker, '/sign-in/email', { email, password: ORIGINAL_PASSWORD })).status).toBe(200);
    const [account] = await environment.database
      .select()
      .from(environment.schema.account)
      .where(eq(environment.schema.account.userId, userId));
    expect(account.password).toBe(originalHash);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, userId)),
    ).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(environment.schema.verification)
        .where(eq(environment.schema.verification.identifier, `reset-password:${token}`)),
    ).toHaveLength(1);
    expect(
      (await post(firstWorker, '/reset-password', { token, newPassword: 'retry-after-process-rollback' })).status,
    ).toBe(200);
    await restartFirst();
    expect(
      (await post(firstWorker, '/sign-in/email', { email, password: 'retry-after-process-rollback' })).status,
    ).toBe(200);
    expect((await post(firstWorker, '/sign-in/email', { email, password: ORIGINAL_PASSWORD })).status).toBe(401);
  });

  it('rolls back a provider-translated server failure before a new process reads the authority', async () => {
    const { userId, email } = await seedUser();
    const token = await seedReset(userId);
    const failingWorker = await startWorker('fail-after-reset');
    const response = await post(failingWorker, '/reset-password', {
      token,
      newPassword: 'must-not-survive-response-failure',
    });
    expect(response.status).toBe(500);
    await bounded(failingWorker.mutationBarrier, 1000, 'The injected post-mutation hook was not reached.');
    await stopWorker(failingWorker);
    await restartSecond();
    expect((await post(secondWorker, '/sign-in/email', { email, password: ORIGINAL_PASSWORD })).status).toBe(200);
    const [account] = await environment.database
      .select()
      .from(environment.schema.account)
      .where(eq(environment.schema.account.userId, userId));
    expect(account.password).toBe(originalHash);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, userId)),
    ).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(environment.schema.verification)
        .where(eq(environment.schema.verification.identifier, `reset-password:${token}`)),
    ).toHaveLength(1);
  });
});

describe('subprocess target boundary', () => {
  it.each([
    undefined,
    'postgresql://postgres:postgres@production.example/postgres',
    'postgresql://postgres:postgres@127.0.0.1/postgres',
    'postgresql://postgres:postgres@127.0.0.1/boardsesh_backend_test',
    'postgresql://postgres:postgres@127.0.0.1/boardsesh_ba01_not-generated',
    `postgresql://postgres:postgres@127.0.0.1/boardsesh_ba01_${'a'.repeat(32)}?host=production.example`,
    `postgresql://postgres:postgres@127.0.0.1/boardsesh_ba01_${'a'.repeat(32)}#unexpected`,
  ])('rejects a missing, remote or non-owned database target', (candidate) => {
    expect(() => validateProcessFixtureDatabaseUrl(candidate)).toThrow();
  });
});
