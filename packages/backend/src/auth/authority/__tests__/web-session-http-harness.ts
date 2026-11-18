/**
 * One owned command server over real HTTP and a suite-owned PostgreSQL
 * database, for the web-session bridge suites (#7596 B2a). Each suite mocks
 * the admission pool onto `harnessDatabase()` itself, since `vi.mock` is
 * hoisted per test file.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { hash } from 'bcryptjs';
import { hkdf } from '@panva/hkdf';
import { EncryptJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { expect, vi } from 'vite-plus/test';
import {
  AUTH_COMMAND_PATHS,
  AUTH_PROTOCOL_VERSION,
  WEB_SESSION_COMMAND_PATHS,
  WEB_CREDENTIAL_PROOF_VERSION,
  WEB_SESSION_PROTOCOL_VERSION,
  passwordReplySchema,
  webCredentialProofMode,
  webSessionBridgeReplySchema,
  type PresentedWebSession,
} from '@boardsesh/auth-protocol';
import {
  authCredentialLineage,
  authEmailProjection,
  authSession,
  authSessionDenials,
  authSubjectCutoffs,
  userCredentials,
  users,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { createPasswordCompareGate } from '../../current-store/password-compare-gate';
import { createPasswordLoginLimiter } from '../../current-store/password-login-limits';
import { handleCurrentStoreWebAuth } from '../../../handlers/current-store-web-auth';
import { handleCurrentStoreWebSession } from '../../../handlers/current-store-web-session';

const PASSWORD = 'web session bridge password';
export const rpcSecret = randomBytes(32).toString('base64url');
export const nextAuthSecret = 'synthetic-web-session-bridge-nextauth-secret';
export const bridgeSecret = 'synthetic-web-session-bridge-token-secret-6975';
export const accessTokenSecret = 'synthetic-web-session-browser-access-token-secret';
export const projectionId = 'web-session-bridge-projection';

let environment: Awaited<ReturnType<typeof createEnvironment>> | undefined;
let server: Server | undefined;
let origin = '';
let passwordHash = '';
const sockets = new Set<Socket>();

export function harnessDatabase() {
  if (!environment) throw new Error('Harness not started');
  return environment.database;
}

/**
 * `prepareProjection` builds the manifest the way the operator does (for
 * suites whose writers reserve email addresses); otherwise a bare enforced
 * manifest row is enough.
 */
export async function startHarness(options: { readonly prepareProjection?: boolean } = {}): Promise<void> {
  environment = await createEnvironment();
  passwordHash = await hash(PASSWORD, 4);
  if (options.prepareProjection)
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
  else
    await environment.database.insert(authEmailProjection).values({
      projectionId,
      normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      writerEpoch: 1,
      phase: 'enforced',
      preparedAt: new Date(),
    });
  const database = environment.database;
  const guards = { limits: createPasswordLoginLimiter({ redis: () => null }), gate: createPasswordCompareGate() };
  const owned = createServer((request, response) => {
    const handled = request.url?.startsWith('/api/internal/auth/current-store/web-session/v1/')
      ? handleCurrentStoreWebSession(request, response, database)
      : handleCurrentStoreWebAuth(request, response, database, guards);
    void handled.catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  owned.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => owned.listen(0, '127.0.0.1', resolve));
  const address = owned.address();
  if (!address || typeof address === 'string') throw new Error('Owned command server failed to bind');
  server = owned;
  origin = `http://127.0.0.1:${address.port}`;
}

/** Every switch the commands need, exactly as production reads it. No gate is forced. */
export function stubCommandEnvironment(): void {
  vi.unstubAllEnvs();
  for (const [name, content] of Object.entries({
    CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
    CURRENT_STORE_WEB_SESSION_MODE: 'backend-staging',
    CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
    CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
    CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
    CURRENT_STORE_DELETED_EMAIL_KEY: 'synthetic-web-session-bridge-retired-mailbox-key',
    // A session is never issued without its proof (#7793 review, M1): the backend side of `required`.
    CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'compatible',
    AUTH_CUTOFF_ENFORCEMENT: 'enforce',
    // Web bridging never reads the native bridge switch.
    AUTH_LEGACY_BRIDGE_MODE: 'off',
    AUTH_BRIDGE_TOKEN_SECRET: bridgeSecret,
    AUTH_BROWSER_ACCESS_TOKEN_SECRET: accessTokenSecret,
    // The bridge needs an end date in every mode; cutover plus 30 days, as the runbook sets it.
    AUTH_LEGACY_BRIDGE_UNTIL: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    EMAIL_VERIFICATION_ENABLED: 'false',
    NEXTAUTH_SECRET: nextAuthSecret,
    DEBUG_SQL: 'false',
  }))
    vi.stubEnv(name, content);
}

export async function stopHarness(): Promise<void> {
  vi.unstubAllEnvs();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await environment?.close();
}

export async function climber() {
  const id = randomUUID();
  const email = `web-session-bridge-${id}@example.test`;
  await harnessDatabase().insert(users).values({ id, email, name: 'Account Name', emailVerified: new Date() });
  await harnessDatabase().insert(userCredentials).values({ userId: id, passwordHash });
  return { id, email };
}

/** No reply may set a cookie: www owns it. */
export async function post(path: string, body: unknown, authorization = `Bearer ${rpcSecret}`) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  expect(response.headers.get('set-cookie')).toBeNull();
  return { status: response.status, body: (await response.json()) as unknown };
}

export function command(operation: keyof typeof WEB_SESSION_COMMAND_PATHS, payload: Record<string, unknown>) {
  return {
    webSessionProtocolVersion: WEB_SESSION_PROTOCOL_VERSION,
    operation,
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload,
  };
}

export async function login(email: string, presented?: PresentedWebSession) {
  const { status, body } = await post(AUTH_COMMAND_PATHS.password, {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    webSession: presented ? { presented } : {},
    // With proofs required, every sign-in must ask for one.
    ...(webCredentialProofMode(process.env) === 'off' ? {} : { credentialProofVersion: WEB_CREDENTIAL_PROOF_VERSION }),
    payload: { email, password: PASSWORD },
  });
  expect(status).toBe(200);
  const reply = passwordReplySchema.parse(body);
  if (reply.outcome !== 'authenticated' || !reply.webSession) throw new Error('No web session issued');
  return reply.webSession;
}

/** The bridge command's reply, parsed; the status is checked against the outcome. */
export async function bridge(credential: string) {
  const { status, body } = await post(WEB_SESSION_COMMAND_PATHS.bridge, command('bridge', { credential }));
  const reply = webSessionBridgeReplySchema.parse(body);
  expect(status).toBe(reply.outcome === 'bridged' ? 200 : reply.outcome === 'denied' ? 401 : 503);
  return reply;
}

export const canonical = (token: string): PresentedWebSession => ({ kind: 'canonical-token', token });

export interface LegacyCookieShape {
  readonly claims?: Record<string, unknown>;
  readonly issuedAtSeconds?: number;
  readonly lifetimeSeconds?: number;
  readonly secret?: string;
}

/** A NextAuth v4 session JWE as the web encodes it. */
export async function legacyCookie(userId: string, shape: LegacyCookieShape = {}) {
  const key = await hkdf(
    'sha256',
    new TextEncoder().encode(shape.secret ?? nextAuthSecret),
    '',
    'NextAuth.js Generated Encryption Key',
    32,
  );
  const issuedAt = shape.issuedAtSeconds ?? Math.floor(Date.now() / 1000);
  return new EncryptJWT(shape.claims ?? {})
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setSubject(userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + (shape.lifetimeSeconds ?? 3600))
    .encrypt(key);
}

/** Every row a bridge, sign-out or login could touch for this account. */
export async function rows(userId: string) {
  const database = harnessDatabase();
  return {
    sessions: await database.select().from(authSession).where(eq(authSession.userId, userId)).orderBy(authSession.id),
    lineages: await database
      .select()
      .from(authCredentialLineage)
      .where(eq(authCredentialLineage.userId, userId))
      .orderBy(authCredentialLineage.id),
    denials: await database
      .select()
      .from(authSessionDenials)
      .where(eq(authSessionDenials.userId, userId))
      .orderBy(authSessionDenials.sessionId),
    cutoffs: await database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)),
  };
}

export async function moveGeneration(userId: string, generation: number, deletedAt: Date | null = null) {
  await harnessDatabase().insert(authSubjectCutoffs).values({
    userId,
    generation,
    revokedThrough: new Date(),
    deletedAt,
    lastOperationId: randomUUID(),
  });
}
