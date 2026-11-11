import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { connect } from 'node:net';
import postgres from 'postgres';
import { createRehearsalSecrets, RehearsalSafetyError, type RehearsalSecrets } from './target-guard';

export interface RuntimeReceipt {
  readonly runNonce: string;
  readonly networkNamespace: string;
  readonly postgresPassword: string;
  readonly redisPassword: string;
}
export interface RuntimeFixture {
  readonly runNonce: string;
  readonly networkNamespace: string;
  readonly secrets: RehearsalSecrets;
  revalidate(): Promise<void>;
}
const fixtures = new WeakSet<object>();

export function assertRuntimeIsolation(receipt: Pick<RuntimeReceipt, 'runNonce' | 'networkNamespace'>): void {
  if (
    !/^[a-f0-9]{32}$/.test(receipt.runNonce) ||
    !/^net:\[[0-9]+\]$/.test(receipt.networkNamespace) ||
    !existsSync('/.dockerenv') ||
    readlinkSync('/proc/self/ns/net') !== receipt.networkNamespace
  )
    throw new RehearsalSafetyError('ISOLATED_RUNTIME_NAMESPACE_REQUIRED');
  const routes = readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
  if (
    routes.some((line) => {
      const fields = line.trim().split(/\s+/);
      return fields[1] === '00000000' && (Number.parseInt(fields[3], 16) & 1) !== 0;
    })
  )
    throw new RehearsalSafetyError('ISOLATED_RUNTIME_DEFAULT_ROUTE_FORBIDDEN');
  const ipv6Routes = readFileSync('/proc/net/ipv6_route', 'utf8').trim().split('\n');
  if (
    ipv6Routes.some((line) => {
      const fields = line.trim().split(/\s+/);
      return fields[0] === '0'.repeat(32) && fields[1] === '00' && (Number.parseInt(fields[8], 16) & 1) !== 0;
    })
  )
    throw new RehearsalSafetyError('ISOLATED_RUNTIME_DEFAULT_ROUTE_FORBIDDEN');
  const resolvers = readFileSync('/etc/resolv.conf', 'utf8')
    .split('\n')
    .filter((line) => /^nameserver\s/.test(line));
  if (resolvers.some((line) => !/^nameserver\s+127\.[0-9.]+\s*$/.test(line)))
    throw new RehearsalSafetyError('ISOLATED_RUNTIME_DNS_REFUSED');
}
async function proveNoExternalRoute(): Promise<void> {
  // Reserved TEST-NET address, never a production or real remote target.
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: '203.0.113.1', port: 443 });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      reject(new RehearsalSafetyError('ISOLATED_RUNTIME_EGRESS_REFUSED'));
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new RehearsalSafetyError('ISOLATED_RUNTIME_EGRESS_UNPROVEN'));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ENETUNREACH' || error.code === 'EHOSTUNREACH') resolve();
      else reject(new RehearsalSafetyError('ISOLATED_RUNTIME_EGRESS_UNPROVEN'));
    });
  });
}
export async function enterIsolatedRuntime(receipt: RuntimeReceipt): Promise<RuntimeFixture> {
  assertRuntimeIsolation(receipt);
  if (!/^[a-f0-9]{64}$/.test(receipt.postgresPassword) || !/^[a-f0-9]{64}$/.test(receipt.redisPassword))
    throw new RehearsalSafetyError('ISOLATED_RUNTIME_CREDENTIALS_REQUIRED');
  await proveNoExternalRoute();
  const secrets = Object.freeze({
    ...createRehearsalSecrets(),
    postgresPassword: receipt.postgresPassword,
    redisPassword: receipt.redisPassword,
  });
  const fixture = Object.freeze({
    runNonce: receipt.runNonce,
    networkNamespace: receipt.networkNamespace,
    secrets,
    async revalidate() {
      assertRuntimeIsolation(receipt);
    },
  });
  fixtures.add(fixture);
  return fixture;
}
export function openRuntimePostgres(fixture: RuntimeFixture, phase: 'admin-create' | 'owned-database') {
  if (!fixtures.has(fixture)) throw new RehearsalSafetyError('ISOLATED_RUNTIME_RECEIPT_REQUIRED');
  assertRuntimeIsolation(fixture);
  return postgres({
    host: '127.0.0.1',
    port: 5432,
    username: 'auth_rehearsal',
    password: fixture.secrets.postgresPassword,
    database: phase === 'admin-create' ? 'postgres' : `boardsesh_auth_rehearsal_${fixture.runNonce}`,
    max: 2,
    connect_timeout: 5,
    idle_timeout: 5,
    onnotice: () => {},
    connection: { application_name: 'boardsesh-isolated-auth-rehearsal' },
  });
}
export function runtimeChildEnvironment(fixture: RuntimeFixture): NodeJS.ProcessEnv {
  if (!fixtures.has(fixture)) throw new RehearsalSafetyError('ISOLATED_RUNTIME_RECEIPT_REQUIRED');
  assertRuntimeIsolation(fixture);
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    TZ: 'UTC',
    NODE_ENV: 'test',
    DATABASE_URL: `postgres://auth_rehearsal:${fixture.secrets.postgresPassword}@127.0.0.1:5432/boardsesh_auth_rehearsal_${fixture.runNonce}`,
    REDIS_URL: `redis://:${fixture.secrets.redisPassword}@127.0.0.1:6379`,
    NEXTAUTH_SECRET: fixture.secrets.signingSecret,
    AUTH_REHEARSAL_RUN_NONCE: fixture.runNonce,
    AUTH_REHEARSAL_NETWORK_NAMESPACE: fixture.networkNamespace,
    AUTH_LEGACY_BRIDGE_MODE: 'off',
    AUTH_NATIVE_REVOCATION_MODE: 'legacy',
    AUTH_IDENTITY_MIRROR: 'off',
    KILTER_LIVE_SYNC_ENABLED: '0',
    SMTP_HOST: '',
    SMTP_USER: '',
    SMTP_PASSWORD: '',
    RESEND_API_KEY: '',
    SENTRY_DSN: '',
    NEXT_PUBLIC_SENTRY_DSN: '',
    POSTHOG_API_KEY: '',
    NEXT_PUBLIC_POSTHOG_KEY: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    APPLE_CLIENT_ID: '',
    APPLE_CLIENT_SECRET: '',
  };
}
