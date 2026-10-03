import { execFileSync, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';

export type TestInfraConfig = {
  ci: boolean;
  skip: boolean;
  databaseUrlOverride?: string;
  redisUrl?: string;
  postgresPort: number;
  redisPort: number;
};

export type TestInfraDependencies = {
  isPortOpen: (host: string, port: number) => Promise<boolean>;
  dockerAvailable: () => boolean;
  startCompose: (services: string[]) => void;
};

type RedisEndpoint = { host: string; port: number };

export async function probePort(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function redisEndpoint(redisUrl: string | undefined, fallbackPort: number): RedisEndpoint {
  if (!redisUrl) return { host: '127.0.0.1', port: fallbackPort };

  const url = new URL(redisUrl);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new TypeError(`Cannot check Redis reachability for URL protocol ${url.protocol || '(missing)'}`);
  }
  if (!url.hostname) throw new TypeError('REDIS_URL must include a hostname');

  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  return { host, port: Number(url.port || 6379) };
}

function isComposeRedisEndpoint(redisUrl: string | undefined, endpoint: RedisEndpoint, fallbackPort: number): boolean {
  if (endpoint.port !== fallbackPort) return false;
  if (!['localhost', '127.0.0.1', '::1'].includes(endpoint.host)) return false;
  if (!redisUrl) return true;

  // An explicit local URL can still target the repository's test Redis service.
  // Credentials, TLS, and logical DB selection do not change its TCP endpoint.
  try {
    const url = new URL(redisUrl);
    return url.protocol === 'redis:';
  } catch {
    return false;
  }
}

export function createDefaultTestInfraDependencies(composeFile: string): TestInfraDependencies {
  return {
    isPortOpen: probePort,
    dockerAvailable: () => spawnSync('docker', ['info'], { stdio: 'pipe' }).status === 0,
    startCompose: (services) => {
      execFileSync(
        'docker',
        ['compose', '-f', composeFile, 'up', '-d', '--wait', '--wait-timeout', '45', ...services],
        { stdio: 'inherit' },
      );
    },
  };
}

export async function ensureTestInfrastructure(
  config: TestInfraConfig,
  dependencies: TestInfraDependencies,
): Promise<void> {
  if (config.ci) return;
  if (config.skip) {
    console.info('[test-infra] SKIP_TEST_INFRA=1 — skipping docker orchestration');
    return;
  }

  const redis = redisEndpoint(config.redisUrl, config.redisPort);
  const [postgresUp, redisUp] = await Promise.all([
    config.databaseUrlOverride ? Promise.resolve(true) : dependencies.isPortOpen('127.0.0.1', config.postgresPort),
    dependencies.isPortOpen(redis.host, redis.port),
  ]);

  const composeServices: string[] = [];
  if (!config.databaseUrlOverride && !postgresUp) composeServices.push('db');
  if (!redisUp) {
    if (!isComposeRedisEndpoint(config.redisUrl, redis, config.redisPort)) {
      throw new Error(
        `[test-infra] Configured Redis endpoint ${redis.host}:${redis.port} is unreachable. ` +
          'Start that Redis service yourself; refusing to start the shared local test Redis.',
      );
    }
    composeServices.push('redis');
  }

  if (composeServices.length === 0) {
    console.info(
      config.databaseUrlOverride
        ? '[test-infra] Redis endpoint is reachable; leaving the Postgres override to its caller'
        : '[test-infra] configured postgres + redis endpoints are reachable — skipping docker',
    );
    return;
  }

  if (!dependencies.dockerAvailable()) {
    throw new Error(
      '[test-infra] Docker is not running. Start Docker Desktop (or the docker daemon), ' +
        'or set SKIP_TEST_INFRA=1 to skip orchestration (DB-dependent tests will then fail).',
    );
  }

  const services = composeServices.join('+');
  console.info(`[test-infra] starting ${services} via docker compose (first run may pull images)…`);
  try {
    dependencies.startCompose(composeServices);
  } catch (error) {
    throw new Error(
      `[test-infra] Failed to start test containers for ${services}. ` +
        'Check Docker Compose v2 is installed (`docker compose version`).\n' +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
