import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rejection = 'Development authentication seeds require an unambiguous local development PostgreSQL URL';
const secretMarker = 'auth-seed-synthetic-secret';
const constructionMarker = 'AUTH_SEED_CLIENT_CONSTRUCTION_FORBIDDEN';
const networkMarker = 'AUTH_SEED_NETWORK_ATTEMPT_FORBIDDEN';
const forbiddenDriver = `export default function postgres() {
  process.stderr.write('${constructionMarker}\\n');
  throw new Error('${constructionMarker}');
}`;
const driverUrl = `data:text/javascript,${encodeURIComponent(forbiddenDriver)}`;
const preload = `
  import { registerHooks } from 'node:module';
  import { Socket } from 'node:net';
  import { tmpdir, userInfo } from 'node:os';
  import { join } from 'node:path';
  // tsx 4.23 uses this exact current-parent pipe for loader notifications.
  // Its local bootstrap IPC is independent of a seed database connection.
  const pipeFile = join(tmpdir(), 'tsx-' + (process.geteuid ? process.geteuid() : userInfo().username), process.ppid + '.pipe');
  const parentPipe = process.platform === 'win32' ? ${JSON.stringify('\\\\?\\pipe\\')} + pipeFile : pipeFile;
  const originalConnect = Socket.prototype.connect;
  Socket.prototype.connect = function (...args) {
    const firstArgument = Array.isArray(args[0]) ? args[0][0] : args[0];
    const socketPath = typeof firstArgument === 'string' ? firstArgument : firstArgument?.path;
    if (socketPath === parentPipe && (typeof firstArgument === 'string' || (firstArgument.port === undefined && firstArgument.host === undefined))) {
      return Reflect.apply(originalConnect, this, args);
    }
    process.stderr.write('${networkMarker}\\n');
    throw new Error('${networkMarker}');
  };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'postgres') return { url: ${JSON.stringify(driverUrl)}, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
`;

function rejectedChildEnvironment(target: string): Record<string, string> & { NODE_ENV: 'test' } {
  const environment: Record<string, string> = {};
  for (const name of [
    'PATH',
    'HOME',
    'SHELL',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'TZ',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'SYSTEMROOT',
    'WINDIR',
  ]) {
    const contents = process.env[name];
    if (contents !== undefined) environment[name] = contents;
  }
  return {
    ...environment,
    NODE_ENV: 'test',
    VERCEL: '',
    DOTENV_CONFIG_QUIET: 'true',
    // Populate every resolver input before dotenv runs. An inherited file
    // cannot supply a higher-priority URL or turn a negative CLI into a seed.
    DB_URL: target,
    DATABASE_URL: `postgresql://probe:${secretMarker}@reserved.invalid:1/seed_denied`,
    POSTGRES_URL: `postgresql://probe:${secretMarker}@reserved.invalid:1/seed_denied`,
    PGHOST: 'reserved.invalid',
    PGPORT: '1',
    PGDATABASE: 'seed_denied',
    PGUSER: 'seed_probe',
    PGPASSWORD: secretMarker,
  };
}

async function runRejectedSeed(entryPoint: string, target: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      `data:text/javascript,${encodeURIComponent(preload)}`,
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL(entryPoint, import.meta.url)),
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: rejectedChildEnvironment(target),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let overflow = false;
  let timedOut = false;
  let spawnFailed = false;
  const capture = (chunk: Buffer) => {
    if (overflow) return;
    output += chunk.toString('utf8');
    if (Buffer.byteLength(output) > 65536) {
      overflow = true;
      output = '';
      child.kill('SIGKILL');
    }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', () => {
    spawnFailed = true;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 8000);
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  // Only fixed diagnostics leave this child boundary; never print its output.
  assert.equal(spawnFailed, false, 'negative seed child must start');
  assert.equal(timedOut, false, 'negative seed child must close within its deadline');
  assert.equal(overflow, false, 'negative seed child output must remain bounded');
  assert.equal(outcome.signal, null, 'negative seed child must close without a signal');
  assert.equal(outcome.code, 1, 'negative seed child must reject the target');
  assert.equal(output.includes(rejection), true, 'negative seed child must report the safe target error');
  assert.equal(output.includes(secretMarker), false, 'negative seed child must not print credentials');
  assert.equal(output.includes(constructionMarker), false, 'target rejection must precede client construction');
  assert.equal(
    output.includes(networkMarker),
    false,
    'target rejection must precede database or unexpected socket I/O',
  );
  assert.equal(output.includes('Creating test user on:'), false, 'target rejection must precede the user target log');
  assert.equal(
    output.includes('Seeding social data to:'),
    false,
    'target rejection must precede the social target log',
  );
}

for (const entryPoint of ['./create-test-user.ts', './seed-social.ts']) {
  void test(
    `${entryPoint} rejects unsafe real CLI targets before client construction`,
    { timeout: 45000 },
    async (context) => {
      for (const [name, target] of [
        ['remote host', `postgresql://probe:${secretMarker}@reserved.invalid:1/seed_denied`],
        ['startup database override', `postgresql://probe:${secretMarker}@127.0.0.1:1/seed_denied?database=other`],
        [
          'encoded multi-host route',
          `postgresql://probe:${secretMarker}@reserved.invalid%2Cdev.localtest.me:1/seed_denied`,
        ],
        ['malformed secret encoding', `postgresql://probe:${secretMarker}%ZZ@127.0.0.1:1/seed_denied`],
      ]) {
        await context.test(name, () => runRejectedSeed(entryPoint, target));
      }
    },
  );
}
