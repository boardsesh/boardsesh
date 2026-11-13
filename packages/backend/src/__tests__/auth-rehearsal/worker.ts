/** Disposable two-process transport. Never mounted by the application. */
import { createServer } from 'node:http';
import { hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import postgres from 'postgres';
import { EncryptJWT, SignJWT } from 'jose';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
const guardUrl = new URL('../../../../../scripts/auth-rehearsal/target-guard.ts', import.meta.url).href;
const runtimeUrl = new URL('../../../../../scripts/auth-rehearsal/isolated-runtime.ts', import.meta.url).href;
interface Initialization {
  type: 'initialize';
  runNonce: string;
  networkNamespace: string;
  marker: string;
}
interface Request {
  type: 'command';
  sequence: number;
  command:
    | 'bridge'
    | 'read'
    | 'canonical-read'
    | 'reset'
    | 'native-revoke'
    | 'refresh'
    | 'cookie'
    | 'native-token'
    | 'native-read'
    | 'close';
  userId?: string;
  authSessionId?: string;
  generation?: number;
  credential?: string;
  tokenHash?: string;
  refreshToken?: string;
}
function initialization(candidate: unknown): candidate is Initialization {
  return !!candidate && typeof candidate === 'object' && 'type' in candidate && candidate.type === 'initialize';
}
function request(candidate: unknown): candidate is Request {
  return !!candidate && typeof candidate === 'object' && 'type' in candidate && candidate.type === 'command';
}

async function initialize(message: Initialization) {
  const { assertRuntimeIsolation } = (await import(runtimeUrl)) as {
    assertRuntimeIsolation: (receipt: { runNonce: string; networkNamespace: string }) => void;
  };
  const { RehearsalSafetyError } = (await import(guardUrl)) as { RehearsalSafetyError: new (code: string) => Error };
  if (!process.send || !/^[a-f0-9]{64}$/.test(message.marker))
    throw new RehearsalSafetyError('OWNED_WORKER_IPC_REQUIRED');
  assertRuntimeIsolation(message);
  if (
    message.runNonce !== process.env.AUTH_REHEARSAL_RUN_NONCE ||
    message.networkNamespace !== process.env.AUTH_REHEARSAL_NETWORK_NAMESPACE
  )
    throw new RehearsalSafetyError('OWNED_WORKER_NONCE_REQUIRED');
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  const redisUrl = new URL(process.env.REDIS_URL ?? '');
  if (
    databaseUrl.protocol !== 'postgres:' ||
    databaseUrl.hostname !== '127.0.0.1' ||
    databaseUrl.port !== '5432' ||
    databaseUrl.username !== 'auth_rehearsal' ||
    databaseUrl.pathname !== `/boardsesh_auth_rehearsal_${message.runNonce}` ||
    databaseUrl.search ||
    databaseUrl.hash ||
    !/^[a-f0-9]{64}$/.test(databaseUrl.password) ||
    redisUrl.protocol !== 'redis:' ||
    redisUrl.hostname !== '127.0.0.1' ||
    redisUrl.port !== '6379' ||
    redisUrl.username ||
    redisUrl.pathname ||
    redisUrl.search ||
    redisUrl.hash ||
    !/^[a-f0-9]{64}$/.test(redisUrl.password) ||
    process.env.READ_REPLICA_URL ||
    process.env.AUTH_ADMISSION_DATABASE_URL
  )
    throw new RehearsalSafetyError('OWNED_WORKER_RUNTIME_TARGET_REQUIRED');
  const client = postgres({
    host: '127.0.0.1',
    port: 5432,
    database: `boardsesh_auth_rehearsal_${message.runNonce}`,
    username: 'auth_rehearsal',
    password: databaseUrl.password,
    max: 2,
    onnotice: () => {},
  });
  const database = drizzle(client, { schema });
  async function marker() {
    assertRuntimeIsolation(message);
    const rows = await client<{ proof: string }[]>`SELECT proof FROM auth_rehearsal_marker WHERE singleton`;
    if (
      rows.length !== 1 ||
      !/^[a-f0-9]{64}$/.test(rows[0].proof) ||
      !timingSafeEqual(Buffer.from(rows[0].proof), Buffer.from(message.marker))
    )
      throw new RehearsalSafetyError('OWNED_DATABASE_MARKER_REQUIRED');
  }
  await marker();
  // Application singletons are imported only AFTER namespace, fixed-target and marker checks.
  const { bridgeLegacyCredential } = await import('../../auth/authority/bridge');
  const { readFirstPartySession } = await import('../../auth/authority/session-reader');
  const { revokeNativeCredentials } = await import('../../auth/authority/native-revocation');
  const { recordSecurityMutation } = await import('../../auth/current-store/security-mutations');
  const { handleNativeAuthRefresh } = await import('../../handlers/native-auth');
  const { setupWebSocketServer } = await import('../../websocket/setup');
  const { validateMobileJwt } = await import('../../middleware/auth');
  const server = createServer((incoming, outgoing) => {
    void marker()
      .then(() => handleNativeAuthRefresh(incoming, outgoing))
      .catch(() => {
        outgoing.writeHead(503);
        outgoing.end();
      });
  });
  const websocket = setupWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new RehearsalSafetyError('OWNED_WORKER_BINDING_REQUIRED');
  process.send({ type: 'ready', port: address.port });
  process.on('message', (candidate: unknown) => {
    if (!request(candidate)) return;
    void (async () => {
      await marker();
      const startedAt = performance.now();
      let result: unknown;
      if (candidate.command === 'native-token') {
        result = {
          jwt: await new SignJWT({ gen: 0, ngen: 0 })
            .setProtectedHeader({ alg: 'HS256' })
            .setSubject(candidate.userId ?? '')
            .setIssuedAt()
            .setIssuer('boardsesh')
            .setAudience('boardsesh-mobile')
            .setExpirationTime('1h')
            .sign(new TextEncoder().encode(process.env.NEXTAUTH_SECRET ?? '')),
        };
      } else if (candidate.command === 'native-read') {
        result = { admitted: (await validateMobileJwt(candidate.credential ?? '')) !== null };
      } else if (candidate.command === 'cookie') {
        const key = new Uint8Array(
          hkdfSync('sha256', process.env.NEXTAUTH_SECRET ?? '', '', 'NextAuth.js Generated Encryption Key', 32),
        );
        result = {
          credential: await new EncryptJWT({ authSessionId: candidate.authSessionId, gen: candidate.generation ?? 0 })
            .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
            .setSubject(candidate.userId ?? '')
            .setIssuedAt()
            .setExpirationTime('1h')
            .encrypt(key),
        };
      } else if (candidate.command === 'bridge') {
        const bridge = await bridgeLegacyCredential(
          database,
          candidate.credential ?? '',
          process.env.NEXTAUTH_SECRET ?? '',
          'on',
        );
        result = {
          status: bridge.status,
          ...(bridge.status === 'bridged' ? { canonicalToken: bridge.session.token } : {}),
        };
      } else if (candidate.command === 'canonical-read') {
        const admitted = await readFirstPartySession(database, {
          kind: 'canonical-token',
          token: candidate.credential ?? '',
        });
        result = {
          status: admitted.status,
          ...(admitted.status === 'admitted' ? { subject: admitted.session.userId } : {}),
        };
      } else if (candidate.command === 'read') {
        const read = await readFirstPartySession(database, {
          kind: 'legacy-jwe',
          credential: candidate.credential ?? '',
          secret: process.env.NEXTAUTH_SECRET ?? '',
        });
        result = { status: read.status, ...(read.status === 'admitted' ? { subject: read.session.userId } : {}) };
      } else if (candidate.command === 'native-revoke') {
        result = { revoked: await revokeNativeCredentials(database, candidate.tokenHash ?? '', 'generation') };
      } else if (candidate.command === 'reset') {
        if (!candidate.userId) throw new RehearsalSafetyError('OWNED_COMMAND_SUBJECT_REQUIRED');
        const userId = candidate.userId;
        await database.transaction(async (transaction) => {
          await transaction.execute(sql`SELECT pg_advisory_xact_lock_shared(6975, 2)`);
          await transaction.select().from(schema.users).where(eq(schema.users.id, userId)).for('update');
          const [manifest] = await transaction
            .select()
            .from(schema.authEmailProjection)
            .where(eq(schema.authEmailProjection.isCurrent, true));
          const [cutoff] = await transaction
            .select()
            .from(schema.authSubjectCutoffs)
            .where(eq(schema.authSubjectCutoffs.userId, userId));
          await transaction
            .update(schema.userCredentials)
            .set({ passwordHash: 'synthetic-rehearsal-replacement' })
            .where(eq(schema.userCredentials.userId, userId));
          await recordSecurityMutation(transaction, {
            expectedProjectionId: manifest.projectionId,
            expectedNormalizerVersion: manifest.normalizerVersion,
            expectedWriterEpoch: manifest.writerEpoch,
            operationId: randomUUID(),
            userId,
            expectedGeneration: cutoff?.generation ?? 0,
            kind: 'password-reset',
            domains: ['first-party', 'partner'],
          });
        });
        result = { status: 'reset' };
      } else if (candidate.command === 'refresh') {
        const response = await fetch(`http://127.0.0.1:${address.port}/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: candidate.refreshToken }),
        });
        const responseBody: unknown = await response.json();
        result = { status: response.status, body: responseBody };
      } else {
        clearInterval(websocket.pingInterval);
        websocket.wss.close();
        server.closeAllConnections();
        server.close();
        await client.end({ timeout: 2 });
        process.send?.({
          type: 'result',
          sequence: candidate.sequence,
          result: { status: 'closed' },
          durationMs: performance.now() - startedAt,
        });
        process.exit(0);
      }
      process.send?.({
        type: 'result',
        sequence: candidate.sequence,
        result,
        durationMs: performance.now() - startedAt,
      });
    })().catch(() =>
      process.send?.({ type: 'result', sequence: candidate.sequence, error: 'OWNED_WORKER_COMMAND_FAILED' }),
    );
  });
}
if (!process.send) throw new Error('OWNED_WORKER_IPC_REQUIRED');
process.once('message', (message: unknown) => {
  if (!initialization(message)) {
    process.exitCode = 1;
    return;
  }
  void initialize(message).catch(() => {
    process.send?.({ type: 'failure', code: 'OWNED_WORKER_INITIALIZATION_FAILED' });
    process.exit(1);
  });
});
