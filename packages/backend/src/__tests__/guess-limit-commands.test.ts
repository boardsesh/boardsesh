import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { inArray } from 'drizzle-orm';
import {
  GUESS_LIMIT_PATHS,
  GUESS_LIMIT_VERSION,
  guessDoneReplySchema,
  guessReserveReplySchema,
  type GuessReservation,
} from '@boardsesh/auth-protocol';
import { DEVICE_TOKEN_SECRET_ENV, mintDeviceToken } from '@boardsesh/auth-protocol/device-token';
import { userCredentials, users } from '@boardsesh/db/schema/auth';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { db } from '../db/client';
import {
  __resetPasswordGuessLimitStateForTests,
  createPasswordGuessLimiter,
  type AccountGuessLimitMode,
  type PasswordGuessLimiter,
} from '../auth/password-guess-limit';
import { PASSWORD_GUESS_EMAIL_KEY_ENV } from '../auth/password-guess-windows';
import { handleGuessLimitCommand } from '../handlers/guess-limit-commands';

const rpcSecret = randomBytes(32).toString('base64url');
const deviceSecret = randomBytes(32).toString('hex');
const environment = {
  [PASSWORD_GUESS_EMAIL_KEY_ENV]: randomBytes(32).toString('hex'),
  [DEVICE_TOKEN_SECRET_ENV]: deviceSecret,
};
const createdUserIds: string[] = [];
let limiter: PasswordGuessLimiter;
let server: Server;
let origin: string;

function useMode(mode: AccountGuessLimitMode) {
  limiter = createPasswordGuessLimiter({
    mode,
    store: () => db,
    environment,
    now: () => new Date('2026-11-17T10:15:00.000Z'),
    deadlineMs: 5_000,
  });
}

async function command(
  operation: keyof typeof GUESS_LIMIT_PATHS,
  fields: Record<string, unknown>,
  options: { bearer?: string; issuedAt?: number } = {},
) {
  const response = await fetch(`${origin}${GUESS_LIMIT_PATHS[operation]}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.bearer ?? rpcSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      version: GUESS_LIMIT_VERSION,
      requestId: randomUUID(),
      issuedAt: options.issuedAt ?? Date.now(),
      operation,
      ...fields,
    }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

async function reserve(fields: Record<string, unknown>) {
  const { status, body } = await command('reserve', fields);
  expect(status).toBe(200);
  return guessReserveReplySchema.parse(body);
}

async function createAccount() {
  const userId = randomUUID();
  const email = `guess-command-${userId}@example.test`;
  await db.insert(users).values({ id: userId, email, name: 'Guess command' });
  await db.insert(userCredentials).values({ userId, passwordHash: 'not-compared-here' });
  createdUserIds.push(userId);
  return { userId, email };
}

describe('guess limit private command (#7656)', () => {
  beforeAll(async () => {
    server = createServer((request, response) => {
      void handleGuessLimitCommand(request, response, limiter);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No listener');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    __resetPasswordGuessLimitStateForTests();
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', rpcSecret);
    useMode('enforce');
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  });

  it('is dark while the limit is off or the RPC secret is unset, and refuses a wrong bearer', async () => {
    useMode('off');
    expect((await command('reserve', { email: 'a@example.test' })).status).toBe(404);
    useMode('enforce');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', '');
    expect((await command('reserve', { email: 'a@example.test' })).status).toBe(404);
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', rpcSecret);
    expect((await command('reserve', { email: 'a@example.test' }, { bearer: 'x'.repeat(43) })).status).toBe(401);
    expect((await command('reserve', { email: 'a@example.test' }, { issuedAt: Date.now() - 600_000 })).status).toBe(
      400,
    );
    expect((await command('reserve', { email: 'a@example.test', extra: true })).status).toBe(400);
  });

  it('counts the web legacy compare like native, the same for a known and an unknown address', async () => {
    const { email: known } = await createAccount();
    const unknown = `nobody-${randomUUID()}@example.test`;
    for (const email of [known, unknown]) {
      const outcomes = [];
      for (let attempt = 0; attempt < 11; attempt += 1) outcomes.push((await reserve({ email })).outcome);
      expect(outcomes).toEqual([...Array(10).fill('proceed'), 'refused']);
    }
  });

  it('gives a right password back from its reported reservation', async () => {
    const { email } = await createAccount();
    for (let attempt = 0; attempt < 9; attempt += 1) await reserve({ email });
    const right = await reserve({ email });
    if (right.outcome !== 'proceed' || !right.reservation) throw new Error('Expected a reservation');
    const giveBack = await command('give-back', { email, verdict: 'accepted', reservation: right.reservation });
    expect(giveBack.status).toBe(200);
    guessDoneReplySchema.parse(giveBack.body);
    expect((await reserve({ email })).outcome).toBe('proceed');
    expect((await reserve({ email })).outcome).toBe('refused');
  });

  it('uncounts a reservation at most once, however often its give-back is retried or replayed', async () => {
    const { email } = await createAccount();
    for (let attempt = 0; attempt < 9; attempt += 1) await reserve({ email });
    const right = await reserve({ email });
    if (right.outcome !== 'proceed' || !right.reservation) throw new Error('Expected a reservation');
    for (let retry = 0; retry < 3; retry += 1)
      expect((await command('give-back', { email, verdict: 'accepted', reservation: right.reservation })).status).toBe(
        200,
      );
    // One slot came back, not three.
    expect((await reserve({ email })).outcome).toBe('proceed');
    expect((await reserve({ email })).outcome).toBe('refused');
  });

  it('refuses a give-back without the reservation id the reserve handed out', async () => {
    const { email } = await createAccount();
    const counted = await reserve({ email });
    if (counted.outcome !== 'proceed' || !counted.reservation) throw new Error('Expected a reservation');
    const { id: _id, ...withoutId } = counted.reservation;
    expect((await command('give-back', { email, verdict: 'accepted', reservation: withoutId })).status).toBe(400);
  });

  it('charges the account bucket for a device token valid for the candidate account only', async () => {
    const { userId, email } = await createAccount();
    for (let attempt = 0; attempt < 10; attempt += 1) await reserve({ email });
    const { token } = await mintDeviceToken({ userId, secret: deviceSecret });
    const recognised = await reserve({ email, deviceToken: token, candidateUserId: userId });
    expect(recognised).toMatchObject({ outcome: 'proceed', reservation: { bucket: 'account', userId } });
    // The same token with a different candidate account is not recognised.
    expect((await reserve({ email, deviceToken: token, candidateUserId: randomUUID() })).outcome).toBe('refused');
    const reservation = (recognised as { reservation: GuessReservation }).reservation;
    expect((await command('give-back', { email, verdict: 'no_verdict', reservation })).status).toBe(200);
  });

  it('clears an address after a completed reset', async () => {
    const { email } = await createAccount();
    for (let attempt = 0; attempt < 10; attempt += 1) await reserve({ email });
    expect((await reserve({ email })).outcome).toBe('refused');
    expect((await command('clear', { email })).status).toBe(200);
    expect((await reserve({ email })).outcome).toBe('proceed');
  });

  it('reports a would-be refusal in observe and refuses nothing', async () => {
    useMode('observe');
    const { email } = await createAccount();
    for (let attempt = 0; attempt < 10; attempt += 1) await reserve({ email });
    expect(await reserve({ email })).toEqual({ outcome: 'proceed', wouldRefuse: true });
  });
});
