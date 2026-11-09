import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@boardsesh/db/auth-prototype';
import { createPrototypeAuthority } from './authority';
import { createPrototypeLegacyHandler } from './legacy-bridge';
import { createSerializedPrototypeOAuthHandler } from './oauth-transaction';
import { PROTOTYPE_ISSUER } from './oauth-options';

type FixtureMode = 'standard' | 'fail-after-reset' | 'pause-after-reset';

/** The fixture cannot select an existing product database or inherit DATABASE_URL. */
export function validateProcessFixtureDatabaseUrl(candidate: string | undefined): string {
  let databaseUrl: URL;
  try {
    if (!candidate) throw new Error('Missing fixture URL');
    databaseUrl = new URL(candidate);
  } catch {
    throw new Error('The auth process fixture requires an explicit disposable local database URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname) ||
    !/^\/boardsesh_ba01_[0-9a-f]{32}$/.test(databaseUrl.pathname) ||
    databaseUrl.search.length > 0 ||
    databaseUrl.hash.length > 0
  ) {
    throw new Error('The auth process fixture refuses a non-disposable database target.');
  }
  return databaseUrl.toString();
}

function fixtureMode(candidate: string | undefined): FixtureMode {
  if (candidate === undefined || candidate === 'standard') return 'standard';
  if (candidate === 'fail-after-reset' || candidate === 'pause-after-reset') return candidate;
  throw new Error('Unknown disposable auth process mode.');
}

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
}

/** Synthetic subprocess transport only. No application module starts this server. */
async function main(): Promise<void> {
  if (!process.send) throw new Error('The disposable auth fixture requires its test-owned IPC channel.');
  const databaseUrl = validateProcessFixtureDatabaseUrl(process.env.AUTH_PROTOTYPE_PROCESS_DATABASE_URL);
  const mode = fixtureMode(process.env.AUTH_PROTOTYPE_PROCESS_MODE);
  const client = postgres(databaseUrl, {
    max: 4,
    connect_timeout: 5,
    connection: { application_name: 'boardsesh-disposable-auth-process' },
    onnotice: () => {},
  });
  const database = drizzle(client, { schema });
  let server: Server | undefined;
  let closing = false;
  try {
    // The parent owns schema generation/migrations. Initialization only seeds
    // the same configured resource rows as every other real authority instance.
    await createPrototypeAuthority(database).$context;
    const legacy = createPrototypeLegacyHandler(
      database,
      mode === 'standard'
        ? undefined
        : async () => {
            process.send?.({ type: 'after-password-mutation' });
            if (mode === 'fail-after-reset') throw new Error('Synthetic post-mutation process failure');
            // This IPC barrier is reached after the password and revocation writes
            // inside the open transaction. The test deliberately kills this process.
            await new Promise<void>(() => {});
          },
    );
    const oauth = createSerializedPrototypeOAuthHandler(database);
    server = createServer(async (incoming, outgoing) => {
      try {
        const requestUrl = new URL(incoming.url ?? '/', PROTOTYPE_ISSUER);
        if (requestUrl.pathname === '/__fixture/ready') {
          outgoing.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          outgoing.end(JSON.stringify({ ready: true, pid: process.pid }));
          return;
        }
        if (!requestUrl.pathname.startsWith('/api/auth/') && !requestUrl.pathname.startsWith('/.well-known/')) {
          outgoing.writeHead(404);
          outgoing.end();
          return;
        }
        const chunks: Buffer[] = [];
        let bodyLength = 0;
        for await (const chunk of incoming) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bodyLength += bytes.byteLength;
          if (bodyLength > 64 * 1024) {
            outgoing.writeHead(413);
            outgoing.end();
            return;
          }
          chunks.push(bytes);
        }
        const headers = new Headers();
        for (const [name, header] of Object.entries(incoming.headers)) {
          if (typeof header === 'string') headers.set(name, header);
          else if (header) for (const part of header) headers.append(name, part);
        }
        const request = new Request(requestUrl, {
          method: incoming.method,
          headers,
          ...(['GET', 'HEAD'].includes(incoming.method ?? 'GET')
            ? {}
            : { body: Buffer.concat(chunks).toString('utf8') }),
        });
        const response =
          requestUrl.pathname.startsWith('/api/auth/oauth2/') || requestUrl.pathname.startsWith('/.well-known/')
            ? await oauth.handler(request)
            : await legacy(request);
        for (const [name, header] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, header);
        const cookies = response.headers.getSetCookie();
        if (cookies.length > 0) outgoing.setHeader('set-cookie', cookies);
        outgoing.writeHead(response.status);
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        // Request exceptions can include SQL parameters or credentials. Neither
        // the worker's IPC messages nor its transport errors copy those bytes.
        if (!outgoing.headersSent) outgoing.writeHead(500);
        outgoing.end('Disposable auth process request failed');
      }
    });
    const activeServer = server;
    await new Promise<void>((resolve, reject) => {
      activeServer.once('error', reject);
      activeServer.listen(0, '127.0.0.1', resolve);
    });
    const address = activeServer.address();
    if (!address || typeof address === 'string') throw new Error('The auth process fixture has no loopback port.');

    const shutdown = async () => {
      if (closing) return;
      closing = true;
      const deadline = setTimeout(() => process.exit(1), 5000);
      deadline.unref();
      try {
        await closeServer(activeServer);
        await client.end({ timeout: 2 });
        clearTimeout(deadline);
        process.disconnect?.();
        process.exit(0);
      } catch {
        process.exit(1);
      }
    };
    process.once('SIGTERM', () => {
      void shutdown();
    });
    process.once('SIGINT', () => {
      void shutdown();
    });
    process.once('disconnect', () => {
      void shutdown();
    });
    process.send({ type: 'ready', pid: process.pid, port: address.port });
  } catch (error) {
    if (server) await closeServer(server);
    await client.end({ timeout: 2 });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    if (!process.send || !process.connected) process.exit(1);
    const deadline = setTimeout(() => process.exit(1), 1000);
    deadline.unref();
    process.send({ type: 'startup-error' }, () => {
      clearTimeout(deadline);
      process.exit(1);
    });
  });
}
