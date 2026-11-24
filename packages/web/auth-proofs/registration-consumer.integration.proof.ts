import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AUTH_PROTOCOL_VERSION, REGISTRATION_COMMAND_PATHS, registerReplySchema } from '@boardsesh/auth-protocol';
import { authEmailVerificationTokens, users } from '@boardsesh/db/schema/auth';
import {
  createCredentialWriterEnvironment,
  ownedCredentialProofUrl,
} from '../../backend/src/auth/authority/__tests__/fixtures/credential-writer-environment';
import { closeCredentialDatabase } from '../../backend/src/auth/credential-database';
import { handleCurrentStoreRegistration } from '../../backend/src/handlers/current-store-registration';
import { createRegistrationCommandGuards } from '../../backend/src/auth/current-store/registration-command-limits';
import { resetAllRateLimits } from '../../backend/src/utils/rate-limiter';
import { CLOUDFLARE_ORIGIN_PROOF_HEADER } from '../app/lib/auth/trusted-client-ip.server';
import { emailVerificationTokenHash } from '../../backend/src/auth/current-store/verification-receipts';

const holder = vi.hoisted(() => {
  process.env.EMAIL_VERIFICATION_ENABLED = 'true';
  return { database: undefined as unknown, allowLegacySql: false, sql: vi.fn(), mail: vi.fn() };
});
vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@boardsesh/email', () => ({ sendVerificationEmail: holder.mail }));
vi.mock('@/app/lib/db/db', () => ({
  getDb: () => {
    holder.sql();
    if (!holder.allowLegacySql) throw new Error('CONSUMER_WEB_SQL_FORBIDDEN');
    return holder.database;
  },
}));
import { POST as oldIssuer } from './fixtures/registration-old-issuer';
import { GET as oldReader } from './fixtures/registration-old-reader';
import { GET as consumer } from '../app/api/auth/verify-email/route';

const secret = 'owned-consumer-only-registration-rpc-secret';
const copyName = `epic6975_identity_import_${randomUUID().replaceAll('-', '')}`;
let admin: postgres.Sql;
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let server: Server;
let origin = '';
let sequence = 0;
let guards = createRegistrationCommandGuards({ redis: () => null });
const request = (token: string, email?: string) =>
  new NextRequest(
    `http://localhost/api/auth/verify-email?token=${encodeURIComponent(token)}${email ? `&email=${encodeURIComponent(email)}` : ''}`,
    { headers: { 'X-Forwarded-For': `192.0.2.${++sequence}`, Cookie: 'next-auth.session-token=existing-login' } },
  );

async function privateReceipt() {
  const response = await fetch(`${origin}${REGISTRATION_COMMAND_PATHS.register}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'register',
      requestId: randomUUID(),
      issuedAt: Date.now(),
      payload: { email: `${randomUUID()}@example.test`, password: 'owned consumer password' },
    }),
  });
  const created = registerReplySchema.parse(await response.json());
  if (created.outcome !== 'created' || !created.requiresVerification)
    throw new Error('Owned backend receipt unavailable');
  return created;
}

describe('consumer-only adoption while released issuers remain', () => {
  beforeAll(async () => {
    const target = ownedCredentialProofUrl();
    const template = target.pathname.slice(1);
    target.pathname = '/postgres';
    admin = postgres(target.toString(), { max: 2, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${copyName}" TEMPLATE "${template}"`);
    environment = await createCredentialWriterEnvironment('private-registration-v1', { copyDatabase: copyName });
    holder.database = environment.ownerDatabase;
    server = createServer((incoming, response) => {
      void handleCurrentStoreRegistration(incoming, response, undefined, guards);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned consumer binding failed');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    await closeCredentialDatabase();
    await environment.owner`DELETE FROM public.users`;
    await environment.owner.unsafe(
      'TRUNCATE auth_email_projection,auth_email_verification_state,auth_subject_cutoffs,"verificationTokens" CASCADE',
    );
    for (const [name, content] of Object.entries({
      DATABASE_URL: environment.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: 'private-registration-v1',
      CURRENT_STORE_WEB_AUTH_MODE: 'legacy',
      CURRENT_STORE_AUTH_BACKEND_ORIGIN: origin,
      CURRENT_STORE_AUTH_RPC_SECRET: secret,
      EMAIL_VERIFICATION_ENABLED: 'true',
      BASE_URL: 'http://localhost',
      NEXTAUTH_URL: '',
      NODE_ENV: 'test',
      DEBUG_SQL: 'false',
    }))
      vi.stubEnv(name, content);
    guards = createRegistrationCommandGuards({ redis: () => null });
    resetAllRateLimits();
    vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_SECRET', 'owned-consumer-origin-proof-secret-at-least-32');
    vi.stubEnv('CLOUDFLARE_ORIGIN_PROOF_SECRET_NEXT', '');
    holder.allowLegacySql = false;
    holder.sql.mockClear();
    holder.mail.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await closeCredentialDatabase();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await environment?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${copyName}"`);
      await admin.end();
    }
  });
  it('consumes a UUID from the actual released issuer without moving its owner or importing provenance', async () => {
    holder.allowLegacySql = true;
    const issued = await oldIssuer(
      new NextRequest('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'Old.Issuer@Example.test', password: 'owned consumer password' }),
      }),
    );
    expect(issued.status).toBe(201);
    const [email, token] = holder.mail.mock.calls[0] as [string, string];
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    const [before] = await environment.ownerDatabase.select().from(users);
    holder.allowLegacySql = false;
    holder.sql.mockClear();
    const response = await consumer(request(token, email));
    expect(response.headers.get('Location')).toContain('verified=true');
    expect(response.headers.getSetCookie()).toEqual([]);
    const [after] = await environment.ownerDatabase.select().from(users);
    expect(after.id).toBe(before.id);
    expect(after.emailVerified).not.toBeNull();
    expect(await environment.ownerDatabase.select().from(authEmailVerificationTokens)).toHaveLength(0);
    expect(holder.sql).not.toHaveBeenCalled();
  });
  it('retains the backend proof on the released reader503, then consumes it on the capable reader', async () => {
    const created = await privateReceipt();
    expect((await oldReader(request(created.mailPlan.token))).status).toBe(503);
    const [retained] = await environment.ownerDatabase
      .select()
      .from(authEmailVerificationTokens)
      .where(eq(authEmailVerificationTokens.tokenHash, emailVerificationTokenHash(created.mailPlan.token)));
    expect(retained.consumedAt).toBeNull();
    expect((await consumer(request(created.mailPlan.token))).headers.get('Location')).toContain('verified=true');
    expect(holder.mail).not.toHaveBeenCalled();
    expect(holder.sql).not.toHaveBeenCalled();
  });
  it('keeps a vouched public reader available after the unvouched fallback fills', async () => {
    const created = await privateReceipt();
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const missing = `ev1_${randomBytes(32).toString('base64url')}`;
      const response = await consumer(
        new NextRequest(`http://localhost/api/auth/verify-email?token=${missing}`, {
          headers: { 'X-Forwarded-For': `${attempt}, 198.51.100.${Math.floor(attempt / 20) + 20}` },
        }),
      );
      expect(response.headers.get('Location')).toContain('error=InvalidToken');
    }
    const link = `http://localhost/api/auth/verify-email?token=${created.mailPlan.token}&clientAddress=203.0.113.99`;
    const forged = await consumer(
      new NextRequest(link, {
        headers: { 'X-Forwarded-For': '198.51.100.200, 172.70.1.2', 'CF-Connecting-IP': '203.0.113.99' },
      }),
    );
    expect(forged.headers.get('Location')).toContain('error=TooManyAttempts');
    const [retained] = await environment.ownerDatabase
      .select()
      .from(authEmailVerificationTokens)
      .where(eq(authEmailVerificationTokens.tokenHash, emailVerificationTokenHash(created.mailPlan.token)));
    expect(retained.consumedAt).toBeNull();
    const response = await consumer(
      new NextRequest(link, {
        headers: {
          'X-Forwarded-For': '198.51.100.201, 172.70.1.2',
          'CF-Connecting-IP': '203.0.113.99',
          [CLOUDFLARE_ORIGIN_PROOF_HEADER]: 'owned-consumer-origin-proof-secret-at-least-32',
        },
      }),
    );
    expect(response.headers.get('Location')).toContain('verified=true');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(holder.sql).not.toHaveBeenCalled();
    expect(holder.mail).not.toHaveBeenCalled();
  });
  it('keeps a supported proof retryable at its original URL when RPC configuration is unavailable', async () => {
    const created = await privateReceipt();
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', '');
    const response = await consumer(request(created.mailPlan.token));
    expect(response.status).toBe(503);
    expect(response.headers.get('Location')).toBeNull();
    const [retained] = await environment.ownerDatabase
      .select()
      .from(authEmailVerificationTokens)
      .where(eq(authEmailVerificationTokens.tokenHash, emailVerificationTokenHash(created.mailPlan.token)));
    expect(retained.consumedAt).toBeNull();
    expect(holder.sql).not.toHaveBeenCalled();
  });
});
