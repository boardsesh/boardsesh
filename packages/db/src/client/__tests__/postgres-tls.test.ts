import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPool, createReadPool, closePool, closeReadPool } from '../postgres';

const runFile = promisify(execFile);

// White-box tests of the installed driver's resolved options complement the
// observable TLS handshake tests below; they protect legacy pool defaults.
void describe('resolved pool TLS policy', () => {
  for (const poolKind of ['primary', 'replica'] as const) {
    for (const [url, expected] of [
      ['postgres://user:secret@remote.example/db?sslmode=verify-full', { rejectUnauthorized: true }],
      ['postgres://user:secret@remote.example/db?sslmode=verify-ca', 'require'],
      ['postgres://user:secret@localhost/db?sslmode=verify-full', { rejectUnauthorized: true }],
      ['postgres://user:secret@remote.example/db?sslmode=require', 'require'],
      ['postgres://user:secret@remote.example/db', 'require'],
      ['postgres://user:secret@localhost/db', false],
    ] as const) {
      void it(`${poolKind}: ${url.split('@')[1]}`, async () => {
        const previousPrimary = process.env.DATABASE_URL;
        const previousReplica = process.env.READ_REPLICA_URL;
        process.env.DATABASE_URL = url;
        process.env.READ_REPLICA_URL = url;
        try {
          const pool = poolKind === 'primary' ? createPool() : createReadPool();
          assert.deepEqual(pool.options.ssl, expected);
        } finally {
          await closeReadPool();
          await closePool();
          if (previousPrimary === undefined) delete process.env.DATABASE_URL;
          else process.env.DATABASE_URL = previousPrimary;
          if (previousReplica === undefined) delete process.env.READ_REPLICA_URL;
          else process.env.READ_REPLICA_URL = previousReplica;
        }
      });
    }
    void it(`${poolKind} rejects duplicate sslmode rather than choosing one`, async () => {
      const previousPrimary = process.env.DATABASE_URL;
      const previousReplica = process.env.READ_REPLICA_URL;
      process.env.DATABASE_URL = 'postgres://user:secret@remote.example/db?sslmode=verify-full&sslmode=require';
      process.env.READ_REPLICA_URL = process.env.DATABASE_URL;
      try {
        assert.throws(() => (poolKind === 'primary' ? createPool() : createReadPool()), /must not repeat sslmode/);
      } finally {
        await closeReadPool();
        await closePool();
        if (previousPrimary === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousPrimary;
        if (previousReplica === undefined) delete process.env.READ_REPLICA_URL;
        else process.env.READ_REPLICA_URL = previousReplica;
      }
    });
  }
});

// Real TLS handshakes, without Docker, production credentials, or a database.
// After verified TLS, the stub rejects PostgreSQL startup with a distinct SQLSTATE.
// Receiving that code proves the driver completed TLS; no password is requested.
void describe('database driver TLS handshakes', { timeout: 60_000 }, () => {
  let fixtureDirectory: string;
  before(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-tls-test-'));
    for (const hostname of ['localhost', 'wrong.example']) {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '2',
          '-subj',
          `/CN=${hostname}`,
          '-addext',
          `subjectAltName=DNS:${hostname}`,
          '-keyout',
          join(fixtureDirectory, `${hostname}.key`),
          '-out',
          join(fixtureDirectory, `${hostname}.pem`),
        ],
        { stdio: 'pipe' },
      );
    }
  });
  after(() => rmSync(fixtureDirectory, { recursive: true, force: true }));

  for (const poolKind of ['primary', 'replica', 'queue'] as const) {
    for (const scenario of ['trusted', 'untrusted', 'wrong-host', 'untrusted-bypass'] as const) {
      // Detector config rejects this global override before starting pg-boss.
      // The shared data pools additionally enforce verification themselves.
      // PgBoss constructed outside the detector does not have that guard;
      // those callers must not set NODE_TLS_REJECT_UNAUTHORIZED=0 either.
      if (poolKind === 'queue' && scenario === 'untrusted-bypass') continue;
      void it(`${poolKind} ${scenario}`, async () => {
        const certificateName = scenario === 'wrong-host' ? 'wrong.example' : 'localhost';
        const certificatePath = join(fixtureDirectory, `${certificateName}.pem`);
        const context = createSecureContext({
          key: readFileSync(join(fixtureDirectory, `${certificateName}.key`)),
          cert: readFileSync(certificatePath),
        });
        const sockets = new Set<Socket>();
        const server = createServer((socket) => {
          sockets.add(socket);
          socket.on('close', () => sockets.delete(socket));
          socket.on('error', () => {});
          socket.once('data', () => {
            socket.write('S'); // PostgreSQL SSLRequest accepted.
            const secured = new TLSSocket(socket, { isServer: true, secureContext: context });
            secured.on('error', () => secured.destroy());
            secured.once('data', () => {
              const fields = Buffer.from('SFATAL\0C28000\0MTLS_TEST_AUTH_REACHED\0\0');
              const header = Buffer.alloc(5);
              header[0] = 69; // ErrorResponse
              header.writeInt32BE(fields.length + 4, 1);
              secured.end(Buffer.concat([header, fields]));
            });
          });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const connectionString = `postgres://test:test@localhost:${address.port}/test?sslmode=verify-full`;
        const script = `
          import { createPool, createReadPool, closePool, closeReadPool } from ${JSON.stringify(new URL('../postgres.ts', import.meta.url).href)};
          import { PgBoss } from 'pg-boss';
          const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, migrate: false, supervise: false, schedule: false, connectionTimeoutMillis: 3000 });
          boss.on('error', () => {});
          try {
            if (${JSON.stringify(poolKind)} === 'queue') await boss.start();
            else await (${JSON.stringify(poolKind)} === 'primary' ? createPool() : createReadPool()).unsafe('SELECT 1');
            throw new Error('UNEXPECTED_QUERY_SUCCESS');
          } catch (error) { console.log(JSON.stringify({ code: error?.code ?? 'NO_CODE' })); }
          finally { await boss.stop({ graceful: false }); await closeReadPool(); await closePool(); }
        `;
        try {
          const environment: NodeJS.ProcessEnv = {
            ...process.env,
            DATABASE_URL: connectionString,
            READ_REPLICA_URL: connectionString,
          };
          delete environment.NODE_TLS_REJECT_UNAUTHORIZED;
          if (scenario === 'untrusted-bypass') environment.NODE_TLS_REJECT_UNAUTHORIZED = '0';
          if (scenario.startsWith('untrusted')) delete environment.NODE_EXTRA_CA_CERTS;
          else environment.NODE_EXTRA_CA_CERTS = certificatePath;
          const { stdout } = await runFile(
            process.execPath,
            ['--dns-result-order=ipv4first', '--import', 'tsx', '--input-type=module', '-e', script],
            {
              cwd: fileURLToPath(new URL('../../../', import.meta.url)),
              env: environment,
              timeout: 10_000,
            },
          );
          const outcome = JSON.parse(stdout.trim()) as { code: string };
          assert.equal(
            outcome.code,
            scenario === 'trusted'
              ? '28000'
              : scenario.startsWith('untrusted')
                ? 'DEPTH_ZERO_SELF_SIGNED_CERT'
                : 'ERR_TLS_CERT_ALTNAME_INVALID',
          );
        } finally {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      });
    }
  }
});
