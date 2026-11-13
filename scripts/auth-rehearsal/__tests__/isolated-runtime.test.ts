import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import postgres from 'postgres';
import {
  enterIsolatedRuntime,
  openRuntimePostgres,
  runtimeChildEnvironment,
  type RuntimeReceipt,
} from '../isolated-runtime';
const fixtureState = vi.hoisted(() => ({
  namespace: 'net:[12345]',
  container: true,
  routes: 'Iface Destination Gateway Flags\neth0 0010AC 00000000 0001',
  ipv6: '',
  resolver: 'nameserver 127.0.0.11\n',
  egress: 'ENETUNREACH',
}));
vi.mock('node:fs', () => ({
  existsSync: () => fixtureState.container,
  readlinkSync: () => fixtureState.namespace,
  readFileSync: (path: string) =>
    path === '/proc/net/route'
      ? fixtureState.routes
      : path === '/proc/net/ipv6_route'
        ? fixtureState.ipv6
        : fixtureState.resolver,
}));
vi.mock('postgres', () => ({ default: vi.fn() }));
vi.mock('node:net', () => ({
  connect: vi.fn(() => {
    const socket = new EventEmitter();
    Object.assign(socket, { destroy: vi.fn(), setTimeout: vi.fn() });
    queueMicrotask(() => {
      if (fixtureState.egress === 'connect' || fixtureState.egress === 'timeout') socket.emit(fixtureState.egress);
      else socket.emit('error', Object.assign(new Error('synthetic'), { code: fixtureState.egress }));
    });
    return socket;
  }),
}));
const receipt: RuntimeReceipt = {
  runNonce: 'a'.repeat(32),
  networkNamespace: 'net:[12345]',
  postgresPassword: 'b'.repeat(64),
  redisPassword: 'c'.repeat(64),
};
beforeEach(() => {
  vi.clearAllMocks();
  fixtureState.namespace = 'net:[12345]';
  fixtureState.container = true;
  fixtureState.routes = 'Iface Destination Gateway Flags\neth0 0010AC 00000000 0001';
  fixtureState.ipv6 = '';
  fixtureState.resolver = 'nameserver 127.0.0.11\n';
  fixtureState.egress = 'ENETUNREACH';
});
it('constructs fixed namespace-local SQL only from original runtime capability', async () => {
  const fixture = await enterIsolatedRuntime(receipt);
  expect(() => openRuntimePostgres({ ...fixture }, 'owned-database')).toThrow('ISOLATED_RUNTIME_RECEIPT_REQUIRED');
  expect(postgres).not.toHaveBeenCalled();
  openRuntimePostgres(fixture, 'owned-database');
  expect(postgres).toHaveBeenCalledWith(
    expect.objectContaining({
      host: '127.0.0.1',
      port: 5432,
      database: `boardsesh_auth_rehearsal_${receipt.runNonce}`,
      username: 'auth_rehearsal',
    }),
  );
  const environment = runtimeChildEnvironment(fixture);
  expect(environment.READ_REPLICA_URL).toBeUndefined();
  expect(environment.AUTH_OPERATOR_DATABASE_URL).toBeUndefined();
  expect(environment.AUTH_NATIVE_REVOCATION_MODE).toBe('legacy');
});
it.each(['host', 'namespace', 'ipv4', 'ipv6', 'dns'] as const)(
  'refuses unsafe runtime %s before SQL construction',
  async (kind) => {
    if (kind === 'host') fixtureState.container = false;
    if (kind === 'namespace') fixtureState.namespace = 'net:[999]';
    if (kind === 'ipv4') fixtureState.routes += '\neth0 00000000 010010AC 0003';
    if (kind === 'ipv6')
      fixtureState.ipv6 = `${'0'.repeat(32)} 00 ${'0'.repeat(32)} 00 ${'0'.repeat(32)} 00000001 00000000 00000000 00000001 eth0`;
    if (kind === 'dns') fixtureState.resolver = 'nameserver 192.0.2.1\n';
    let refused = false;
    try {
      await enterIsolatedRuntime(receipt);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(postgres).not.toHaveBeenCalled();
  },
);
it('rechecks namespace before every SQL client, refusing changed namespace', async () => {
  const fixture = await enterIsolatedRuntime(receipt);
  fixtureState.namespace = 'net:[999]';
  expect(() => openRuntimePostgres(fixture, 'owned-database')).toThrow('ISOLATED_RUNTIME_NAMESPACE_REQUIRED');
  expect(postgres).not.toHaveBeenCalled();
});

afterEach(() => vi.unstubAllEnvs());
it('refuses copied runtime child capabilities and omits poisoned parent authority credentials', async () => {
  vi.stubEnv('AUTH_OPERATOR_DATABASE_URL', 'postgres://unreachable.invalid/operator');
  vi.stubEnv('READ_REPLICA_URL', 'postgres://unreachable.invalid/replica');
  vi.stubEnv('NEXTAUTH_SECRET', 'inherited-signing-secret');
  const fixture = await enterIsolatedRuntime(receipt);
  expect(() => runtimeChildEnvironment({ ...fixture })).toThrow('ISOLATED_RUNTIME_RECEIPT_REQUIRED');
  const environment = runtimeChildEnvironment(fixture);
  expect('AUTH_OPERATOR_DATABASE_URL' in environment).toBe(false);
  expect('READ_REPLICA_URL' in environment).toBe(false);
  expect(environment.NEXTAUTH_SECRET === 'inherited-signing-secret').toBe(false);
});
it.each(['connect', 'timeout', 'ECONNREFUSED'] as const)(
  'refuses unproven egress result %s before constructing SQL',
  async (kind) => {
    fixtureState.egress = kind;
    let refused = false;
    try {
      await enterIsolatedRuntime(receipt);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(postgres).not.toHaveBeenCalled();
  },
);
