import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vite-plus/test';
import {
  createRehearsalSecrets,
  assertLocalDockerIdentity,
  connectOwnedPostgres,
  assertOwnedDatabaseName,
  keyedReference,
  ownedLocalEndpoint,
  rehearsalArguments,
  rehearsalChildEnvironment,
  type ExpectedOwnedContainer,
  type OwnedContainerProof,
} from '../target-guard';

const identity = { context: 'local-test', endpoint: 'unix:///var/run/docker.sock', daemonId: 'local-daemon-6975' };
const runNonce = 'a'.repeat(32);
const expected: ExpectedOwnedContainer = {
  service: 'postgres',
  identity,
  containerId: 'b'.repeat(64),
  imageId: `sha256:${'c'.repeat(64)}`,
  runNonce,
  networkId: 'd'.repeat(64),
};
const container: OwnedContainerProof = {
  containerId: expected.containerId,
  imageId: expected.imageId,
  containerName: `/boardsesh-auth-rehearsal-postgres-${runNonce}`,
  runLabel: runNonce,
  running: true,
  networkId: expected.networkId,
  internalNetwork: true,
  networkCount: 1,
  hostIp: '127.0.0.1',
  hostPort: '35432',
  bindingCount: 1,
  hasHostBindMount: false,
};

it('accepts only the inspected owned loopback endpoint', () => {
  expect(ownedLocalEndpoint(identity, container, expected)).toEqual({
    host: '127.0.0.1',
    port: 35432,
    service: 'postgres',
  });
  expect(() => assertOwnedDatabaseName(`boardsesh_auth_rehearsal_${runNonce}`, runNonce)).not.toThrow();
});
it.each([
  { hostIp: '0.0.0.0' },
  { hostIp: '::' },
  { bindingCount: 2 },
  { hostPort: '5432/other' },
  { runLabel: undefined },
  { runLabel: 'unowned' },
  { containerName: '/backend-db-1' },
  { containerId: 'e'.repeat(64) },
  { imageId: `sha256:${'f'.repeat(64)}` },
  { running: false },
  { internalNetwork: false },
  { networkId: '0'.repeat(64) },
  { networkCount: 2 },
  { hasHostBindMount: true },
])('refuses an unowned or externally routed target before client/network construction: %j', (mutation) => {
  const connect = vi.fn();
  expect(() => {
    const endpoint = ownedLocalEndpoint(identity, { ...container, ...mutation }, expected);
    connect(endpoint);
  }).toThrow();
  expect(connect).not.toHaveBeenCalled();
});
it.each(['tcp://unreachable.invalid:2376', 'ssh://unreachable.invalid', 'unix:///tmp/forwarded-docker.sock'])(
  'refuses a remote/proxy Docker context before SQL: %s',
  (endpoint) => {
    const connect = vi.fn();
    expect(() => {
      ownedLocalEndpoint({ ...identity, endpoint }, container, expected);
      connect();
    }).toThrow();
    expect(connect).not.toHaveBeenCalled();
  },
);
it('refuses a daemon identity change and arbitrary main/local/tunnel database names before SQL', () => {
  const connect = vi.fn();
  expect(() => {
    ownedLocalEndpoint({ ...identity, daemonId: 'another-daemon' }, container, expected);
    connect();
  }).toThrow();
  for (const database of ['main', 'postgres', 'boardsesh_backend_test', 'boardsesh_auth_rehearsal_other']) {
    expect(() => {
      assertOwnedDatabaseName(database, runNonce);
      connect();
    }).toThrow();
  }
  expect(connect).not.toHaveBeenCalled();
});
it.each(
  [
    ['--database-url', 'postgres://unreachable.invalid/main'],
    ['--database-url', 'postgres://127.0.0.1:5432/main'],
    ['--operator-url', 'postgres://127.0.0.1:55432/main'],
    ['--target-file', '/not-read'],
    ['--force'],
    ['--skip-guard'],
  ].map((arguments_) => ({ arguments_ })),
)('refuses target/bypass CLI inputs without invoking any I/O: %j', ({ arguments_ }) => {
  const io = vi.fn();
  expect(() => {
    rehearsalArguments(arguments_);
    io();
  }).toThrow();
  expect(io).not.toHaveBeenCalled();
});
it('builds a fresh child environment without inherited operator secrets or telemetry destinations', () => {
  const postgres = ownedLocalEndpoint(identity, container, expected);
  const redisExpected = { ...expected, service: 'redis' as const, containerId: '1'.repeat(64) };
  const redis = ownedLocalEndpoint(
    identity,
    {
      ...container,
      containerId: redisExpected.containerId,
      containerName: `/boardsesh-auth-rehearsal-redis-${runNonce}`,
      hostPort: '36379',
    },
    redisExpected,
  );
  const secrets = createRehearsalSecrets();
  expect(() => rehearsalChildEnvironment({ postgres, redis, runNonce }, { ...secrets })).toThrow(
    'FRESH_FIXTURE_SECRETS_REQUIRED',
  );
  expect(() => rehearsalChildEnvironment({ postgres: { ...postgres }, redis, runNonce }, secrets)).toThrow(
    'INSPECTED_TARGET_CAPABILITY_REQUIRED',
  );
  vi.stubEnv('AUTH_OPERATOR_DATABASE_URL', 'postgres://unreachable.invalid/operator');
  vi.stubEnv('READ_REPLICA_URL', 'postgres://unreachable.invalid/replica');
  const child = rehearsalChildEnvironment({ postgres, redis, runNonce }, secrets, '/owned/bin');
  const sibling = rehearsalChildEnvironment({ postgres, redis, runNonce }, secrets, '/owned/bin');
  expect(child.NEXTAUTH_SECRET).toBe(sibling.NEXTAUTH_SECRET);

  expect(child.AUTH_OPERATOR_DATABASE_URL).toBeUndefined();
  expect(child.READ_REPLICA_URL).toBeUndefined();
  expect(child.SMTP_HOST).toBe('');
  expect(child.SENTRY_DSN).toBe('');
  expect(child.AUTH_NATIVE_REVOCATION_MODE).toBe('legacy');
  expect(child.NEXTAUTH_SECRET).toHaveLength(64);
  expect(keyedReference(randomBytes(32), 'synthetic-account-reference')).toMatch(/^[a-f0-9]{64}$/);
  vi.unstubAllEnvs();
});

it('refuses a forged or serialized local endpoint before SQL/network factory use', () => {
  const createClient = vi.fn();
  const inspected = ownedLocalEndpoint(identity, container, expected);
  const credentials = { runNonce, username: 'auth_rehearsal', password: 'e'.repeat(64) };
  expect(() => connectOwnedPostgres({ ...inspected }, credentials, createClient)).toThrow(
    'INSPECTED_TARGET_CAPABILITY_REQUIRED',
  );
  expect(() => connectOwnedPostgres(inspected, { ...credentials, runNonce: 'f'.repeat(32) }, createClient)).toThrow(
    'INSPECTED_TARGET_CAPABILITY_REQUIRED',
  );
  expect(createClient).not.toHaveBeenCalled();
  connectOwnedPostgres(inspected, credentials, createClient);
  expect(createClient).toHaveBeenCalledOnce();
  expect(createClient.mock.calls[0][0].database).toBe(`boardsesh_auth_rehearsal_${runNonce}`);
});

it('rejects a noncanonical Unix proxy even when its context and daemon match', () => {
  expect(() => assertLocalDockerIdentity({ ...identity, endpoint: 'unix:///tmp/forwarded-docker.sock' })).toThrow(
    'LOCAL_DOCKER_REQUIRED',
  );
});
