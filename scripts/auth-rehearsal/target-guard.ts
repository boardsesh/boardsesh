import { createHmac, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const REHEARSAL_POSTGRES_IMAGE =
  'postgres:18.6-bookworm@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af';
export const REHEARSAL_CONTAINER_LABEL = 'org.boardsesh.auth-rehearsal.run';

export class RehearsalSafetyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RehearsalSafetyError';
  }
}
export interface LocalDockerIdentity {
  readonly context: string;
  readonly endpoint: string;
  readonly daemonId: string;
}
export interface OwnedContainerProof {
  readonly containerId: string;
  readonly imageId: string;
  readonly containerName: string;
  readonly runLabel: string | undefined;
  readonly running: boolean;
  readonly networkId: string;
  readonly internalNetwork: boolean;
  readonly networkCount: number;
  readonly hostIp: string;
  readonly hostPort: string;
  readonly bindingCount: number;
  readonly hasHostBindMount: boolean;
}
export interface ExpectedOwnedContainer {
  readonly service: 'postgres' | 'redis';
  readonly identity: LocalDockerIdentity;
  readonly containerId: string;
  readonly imageId: string;
  readonly runNonce: string;
  readonly networkId: string;
}
const verifiedEndpoints = new WeakMap<object, { runNonce: string; service: 'postgres' | 'redis' }>();

export interface OwnedLocalEndpoint {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly service: 'postgres' | 'redis';
}

/** Only the canonical local Docker sockets; SSH/TCP contexts are not local proof. */
export function assertLocalDockerIdentity(identity: LocalDockerIdentity): void {
  let endpoint: URL;
  try {
    endpoint = new URL(identity.endpoint);
  } catch {
    throw new RehearsalSafetyError('LOCAL_DOCKER_REQUIRED');
  }
  const allowedSockets = new Set([
    '/var/run/docker.sock',
    '/run/docker.sock',
    resolve(homedir(), '.docker/run/docker.sock'),
  ]);
  if (
    endpoint.protocol !== 'unix:' ||
    endpoint.hostname ||
    endpoint.search ||
    endpoint.hash ||
    !allowedSockets.has(endpoint.pathname) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(identity.context) ||
    !/^[A-Za-z0-9:-]{8,200}$/.test(identity.daemonId)
  )
    throw new RehearsalSafetyError('LOCAL_DOCKER_REQUIRED');
}

/** Pure preflight. A refusal here must happen before constructing any SQL client. */
export function ownedLocalEndpoint(
  currentIdentity: LocalDockerIdentity,
  container: OwnedContainerProof,
  expected: ExpectedOwnedContainer,
): OwnedLocalEndpoint {
  assertLocalDockerIdentity(currentIdentity);
  assertLocalDockerIdentity(expected.identity);
  if (
    currentIdentity.context !== expected.identity.context ||
    currentIdentity.endpoint !== expected.identity.endpoint ||
    currentIdentity.daemonId !== expected.identity.daemonId
  )
    throw new RehearsalSafetyError('DOCKER_IDENTITY_CHANGED');
  if (
    !/^[a-f0-9]{64}$/.test(expected.containerId) ||
    !/^sha256:[a-f0-9]{64}$/.test(expected.imageId) ||
    !/^[a-f0-9]{32}$/.test(expected.runNonce) ||
    !/^[a-f0-9]{64}$/.test(expected.networkId) ||
    container.containerId !== expected.containerId ||
    container.imageId !== expected.imageId ||
    container.runLabel !== expected.runNonce ||
    container.containerName !== `/boardsesh-auth-rehearsal-${expected.service}-${expected.runNonce}` ||
    !container.running ||
    container.hasHostBindMount
  )
    throw new RehearsalSafetyError('OWNED_CONTAINER_REQUIRED');
  if (!container.internalNetwork || container.networkCount !== 1 || container.networkId !== expected.networkId)
    throw new RehearsalSafetyError('OWNED_INTERNAL_NETWORK_REQUIRED');
  const port = Number(container.hostPort);
  if (
    container.bindingCount !== 1 ||
    container.hostIp !== '127.0.0.1' ||
    !/^\d{1,5}$/.test(container.hostPort) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    throw new RehearsalSafetyError('OWNED_LOOPBACK_BINDING_REQUIRED');
  const endpoint = Object.freeze({ host: '127.0.0.1' as const, port, service: expected.service });
  verifiedEndpoints.set(endpoint, { runNonce: expected.runNonce, service: expected.service });
  return endpoint;
}

export function assertOwnedDatabaseName(databaseName: string, runNonce: string): void {
  if (!/^[a-f0-9]{32}$/.test(runNonce) || databaseName !== `boardsesh_auth_rehearsal_${runNonce}`)
    throw new RehearsalSafetyError('OWNED_DATABASE_REQUIRED');
}

/** Only an in-memory inspected endpoint can construct a client; copies/files cannot. */
export function connectOwnedPostgres<Client>(
  endpoint: OwnedLocalEndpoint,
  credentials: { readonly runNonce: string; readonly username: string; readonly password: string },
  createClient: (options: {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
  }) => Client,
  phase: 'admin-create' | 'owned-database' = 'owned-database',
): Client {
  if (
    verifiedEndpoints.get(endpoint)?.runNonce !== credentials.runNonce ||
    verifiedEndpoints.get(endpoint)?.service !== 'postgres'
  )
    throw new RehearsalSafetyError('INSPECTED_TARGET_CAPABILITY_REQUIRED');
  const databaseName = `boardsesh_auth_rehearsal_${credentials.runNonce}`;
  assertOwnedDatabaseName(databaseName, credentials.runNonce);
  if (credentials.username !== 'auth_rehearsal' || !/^[a-f0-9]{64}$/.test(credentials.password))
    throw new RehearsalSafetyError('FRESH_FIXTURE_CREDENTIALS_REQUIRED');
  return createClient({
    host: endpoint.host,
    port: endpoint.port,
    database: phase === 'admin-create' ? 'postgres' : databaseName,
    username: credentials.username,
    password: credentials.password,
  });
}

export interface RehearsalSecrets {
  readonly postgresPassword: string;
  readonly redisPassword: string;
  readonly signingSecret: string;
  readonly controlSecret: string;
  readonly reportKey: Uint8Array;
}
const freshSecretSets = new WeakSet<object>();
export function createRehearsalSecrets(): RehearsalSecrets {
  const secrets = Object.freeze({
    postgresPassword: randomBytes(32).toString('hex'),
    redisPassword: randomBytes(32).toString('hex'),
    signingSecret: randomBytes(32).toString('hex'),
    controlSecret: randomBytes(32).toString('hex'),
    reportKey: randomBytes(32),
  });
  freshSecretSets.add(secrets);
  return secrets;
}

/** Fresh secrets and only explicit local targets reach subprocesses. */
export function rehearsalChildEnvironment(
  targets: { postgres: OwnedLocalEndpoint; redis: OwnedLocalEndpoint; runNonce: string },
  secrets: RehearsalSecrets,
  executablePath = process.env.PATH ?? '',
): NodeJS.ProcessEnv {
  if (!freshSecretSets.has(secrets)) throw new RehearsalSafetyError('FRESH_FIXTURE_SECRETS_REQUIRED');
  for (const [endpoint, service] of [
    [targets.postgres, 'postgres'],
    [targets.redis, 'redis'],
  ] as const) {
    const inspected = verifiedEndpoints.get(endpoint);
    if (inspected?.runNonce !== targets.runNonce || inspected.service !== service)
      throw new RehearsalSafetyError('INSPECTED_TARGET_CAPABILITY_REQUIRED');
  }
  const databaseName = `boardsesh_auth_rehearsal_${targets.runNonce}`;
  assertOwnedDatabaseName(databaseName, targets.runNonce);
  const databaseUrl = new URL(`postgres://127.0.0.1:${targets.postgres.port}/${databaseName}`);
  databaseUrl.username = 'auth_rehearsal';
  databaseUrl.password = secrets.postgresPassword;
  const redisUrl = new URL(`redis://127.0.0.1:${targets.redis.port}`);
  redisUrl.password = secrets.redisPassword;
  return {
    PATH: executablePath,
    TZ: 'UTC',
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl.toString(),
    REDIS_URL: redisUrl.toString(),
    NEXTAUTH_SECRET: secrets.signingSecret,
    AUTH_REHEARSAL_RUN_NONCE: targets.runNonce,
    AUTH_REHEARSAL_CONTROL_SECRET: secrets.controlSecret,
    AUTH_LEGACY_BRIDGE_MODE: 'off',
    AUTH_NATIVE_REVOCATION_MODE: 'legacy',
    AUTH_IDENTITY_MIRROR: 'off',
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

export function keyedReference(key: Uint8Array, contents: string): string {
  if (key.byteLength !== 32) throw new RehearsalSafetyError('REHEARSAL_REPORT_KEY_REQUIRED');
  return createHmac('sha256', key).update(contents).digest('hex');
}

/** No database URLs, files, credentials or arbitrary Docker endpoints are CLI inputs. */
export function rehearsalArguments(arguments_: readonly string[]): { command: 'full' | 'synthetic' | 'help' } {
  if (arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === 'full')) return { command: 'full' };
  if (arguments_.length === 1 && arguments_[0] === 'synthetic') return { command: 'synthetic' };
  if (arguments_.length === 1 && ['help', '--help'].includes(arguments_[0])) return { command: 'help' };
  throw new RehearsalSafetyError('REHEARSAL_ARGUMENTS_REFUSED');
}
