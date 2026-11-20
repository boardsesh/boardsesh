// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { mintDeviceToken } from '@boardsesh/auth-protocol/device-token';
vi.mock('server-only', () => ({}));
import {
  admitLegacyWebPasswordGuess,
  createWebGuessLimitClient,
  readRequestDeviceToken,
} from '../guess-limit-client.server';

const deviceSecret = 'test-browser-device-secret-distinct-32bytes';
const reservation = {
  id: randomUUID(),
  bucket: 'email',
  windows: [{ kind: 'hour', start: '2026-11-19T01:00:00.000Z' }],
};
const environment = {
  NODE_ENV: 'test',
  AUTH_ACCOUNT_GUESS_LIMIT_MODE: 'observe',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'https://backend.example.test',
  CURRENT_STORE_AUTH_RPC_SECRET: 'test-browser-private-rpc-secret-32bytes',
};
const commands: Record<string, unknown>[] = [];
let reply: Record<string, unknown>;
const transport = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
  if (typeof init?.body !== 'string') throw new Error('Expected a serialized command');
  const command = JSON.parse(init.body) as Record<string, unknown>;
  commands.push(command);
  return Response.json(command.operation === 'reserve' ? reply : { outcome: 'done' });
});

beforeEach(() => {
  commands.length = 0;
  vi.clearAllMocks();
  reply = { outcome: 'proceed', reservation };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const [name, configured] of Object.entries(environment)) vi.stubEnv(name, configured);
  vi.stubEnv('AUTH_DEVICE_TOKEN_SECRET', deviceSecret);
  vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
  vi.stubGlobal('fetch', transport);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([undefined, '', 'off'])('does not create a transport or reserve when the mode is %s', async (mode) => {
  vi.stubEnv('AUTH_ACCOUNT_GUESS_LIMIT_MODE', mode);
  expect(createWebGuessLimitClient()).toBeNull();
  const admission = await admitLegacyWebPasswordGuess({ email: 'a@example.test', accounts: [], cookieHeader: '' });
  await admission.settle('accepted');
  expect(transport).not.toHaveBeenCalled();
});

it('uses a private fixed route, no cookie or password, and settles a right password once', async () => {
  const admission = await admitLegacyWebPasswordGuess({
    email: 'Climber@example.test',
    accounts: [],
    cookieHeader: 'next-auth.session-token=private',
  });
  await admission.settle('accepted');
  await admission.settle('no_verdict');
  expect(commands.map(({ operation }) => operation)).toEqual(['reserve', 'give-back']);
  expect(commands[0]).toMatchObject({ version: 1, operation: 'reserve', email: 'Climber@example.test' });
  expect(commands[1]).toMatchObject({ verdict: 'accepted', reservation });
  const [destination, init] = transport.mock.calls[0];
  expect(destination).toBe('https://backend.example.test/api/internal/auth/guess-limit/v1/reserve');
  expect(init?.headers).toMatchObject({ Authorization: `Bearer ${environment.CURRENT_STORE_AUTH_RPC_SECRET}` });
  expect(JSON.stringify(commands)).not.toContain('next-auth.session-token');
  expect(JSON.stringify(commands)).not.toContain('password');
});

it('leaves rejected guesses charged and returns unfinished comparisons', async () => {
  const rejected = await admitLegacyWebPasswordGuess({ email: 'a@example.test', accounts: [], cookieHeader: '' });
  await rejected.settle('rejected');
  await rejected.settle('no_verdict');
  expect(commands).toHaveLength(1);
  const unfinished = await admitLegacyWebPasswordGuess({ email: 'a@example.test', accounts: [], cookieHeader: '' });
  await unfinished.settle('no_verdict');
  expect(commands.at(-1)).toMatchObject({ operation: 'give-back', verdict: 'no_verdict' });
});

it('preserves observe would-refuse verdicts even without a reservation', async () => {
  reply = { outcome: 'proceed', wouldRefuse: true };
  const admission = await admitLegacyWebPasswordGuess({ email: 'a@example.test', accounts: [], cookieHeader: '' });
  await admission.settle('accepted');
  expect(commands[1]).toMatchObject({ operation: 'give-back', wouldRefuse: true, verdict: 'accepted' });
});

it('refuses before bcrypt can run when the authoritative counter refuses', async () => {
  reply = { outcome: 'refused', retryAfterSeconds: 37 };
  await expect(
    admitLegacyWebPasswordGuess({ email: 'a@example.test', accounts: [], cookieHeader: '' }),
  ).rejects.toMatchObject({ retryAfterSeconds: 37 });
  expect(commands).toHaveLength(1);
});

it('verifies recognition for the account before sending its cookie', async () => {
  const { token } = await mintDeviceToken({ userId: 'owner', secret: deviceSecret });
  const input = { email: 'a@example.test', accounts: [{ id: 'owner' }], cookieHeader: `boardsesh.device=${token}` };
  await admitLegacyWebPasswordGuess(input);
  expect(commands[0]).toMatchObject({ deviceToken: token, candidateUserId: 'owner' });
  await admitLegacyWebPasswordGuess({ ...input, accounts: [{ id: 'someone-else' }] });
  expect(commands[1]).not.toHaveProperty('deviceToken');
  await admitLegacyWebPasswordGuess({ ...input, cookieHeader: 'boardsesh.device=forged' });
  expect(commands[2]).not.toHaveProperty('deviceToken');
});

it('never selects one of two cookie copies', () => {
  expect(readRequestDeviceToken('boardsesh.device=a; boardsesh.device=b')).toBeUndefined();
  expect(readRequestDeviceToken('boardsesh.device=a; another=b')).toBe('a');
  expect(readRequestDeviceToken(['boardsesh.device=a'])).toBeUndefined();
});

it('fails open on malformed, failed and timed-out counter replies', async () => {
  const client = createWebGuessLimitClient({ environment, fetch: async () => Response.json({ unexpected: true }) });
  expect(await client?.reserve('a@example.test')).toBeNull();
  const failed = createWebGuessLimitClient({
    environment,
    fetch: async () => {
      throw new Error('private backend error');
    },
  });
  expect(await failed?.reserve('a@example.test')).toBeNull();
  vi.useFakeTimers();
  try {
    const hung = createWebGuessLimitClient({
      environment,
      fetch: () => new Promise<Response>(() => {}),
      timeoutMs: 400,
    });
    const pending = hung?.reserve('a@example.test');
    await vi.advanceTimersByTimeAsync(401);
    expect(await pending).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('clears only through the fixed authenticated backend command', async () => {
  await createWebGuessLimitClient()?.clear('a@example.test');
  expect(commands[0]).toMatchObject({ operation: 'clear', email: 'a@example.test' });
  expect(transport.mock.calls[0][0]).toBe('https://backend.example.test/api/internal/auth/guess-limit/v1/clear');
});
