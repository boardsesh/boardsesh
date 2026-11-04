import { createHash, randomBytes } from 'node:crypto';
import { APIError } from 'better-auth/api';
import type { BetterAuthOptions } from 'better-auth';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import * as schema from '@boardsesh/db/auth-prototype';
import { createPrototypeAuthority, type PrototypeDatabase } from './authority';
import { revokePrototypeUser } from './legacy-bridge';
import { normalizeAccountEmail } from '../normalize-email';
import { prototypeSessionPassesRevocation } from './session-revocation';

const ACCESS_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const REFRESH_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export interface PrototypeNativeTokenPair {
  userId: string;
  jwt: string;
  refreshToken: string;
  expiresAt: string;
}

export class PrototypeNativeCredentialError extends Error {
  readonly status = 401;
  constructor() {
    super('Invalid credentials');
    this.name = 'PrototypeNativeCredentialError';
  }
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

type PrototypeTransaction = Parameters<Parameters<PrototypeDatabase['transaction']>[0]>[0];

/**
 * BA-01 disposable protocol proof only. Credential verification is delegated to
 * the same Better Auth authority; sidecars contain no passwords/provider links.
 * No production router mounts this facade or trusts its synthetic signing key.
 */
export function createPrototypeNativeFacade(
  database: PrototypeDatabase,
  signingKey: Uint8Array,
  authorityOverrides: BetterAuthOptions = {},
) {
  async function lockLifecycle(transaction: PrototypeTransaction) {
    // Shared with the disposable bridge/OAuth wrappers and mutation cutoff hook.
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975, 1)`);
  }

  async function lockedSession(transaction: PrototypeTransaction, userId: string, sessionId: string) {
    // One lock order shared by issuance, refresh and revocation: user → session.
    const [user] = await transaction.select().from(schema.user).where(eq(schema.user.id, userId)).for('update');
    if (!user) throw new PrototypeNativeCredentialError();
    const [session] = await transaction
      .select()
      .from(schema.session)
      .where(and(eq(schema.session.id, sessionId), eq(schema.session.userId, userId)))
      .for('update');
    if (!session || session.expiresAt.getTime() <= Date.now()) throw new PrototypeNativeCredentialError();
    const [cutoff] = await transaction
      .select()
      .from(schema.prototypeUserCutoff)
      .where(eq(schema.prototypeUserCutoff.userId, userId));
    if (!prototypeSessionPassesRevocation(session, cutoff)) throw new PrototypeNativeCredentialError();
    return session;
  }

  async function issue(
    transaction: PrototypeTransaction,
    session: typeof schema.session.$inferSelect,
  ): Promise<PrototypeNativeTokenPair> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ACCESS_LIFETIME_SECONDS * 1000);
    const refreshExpiresAt = new Date(now.getTime() + REFRESH_LIFETIME_MS);
    const originalAuthenticatedAt = session.legacyLineageId ? session.originalAuthenticatedAt : session.createdAt;
    const jwt = await new SignJWT({
      sub: session.userId,
      sid: session.id,
      ...(originalAuthenticatedAt ? { auth_time: Math.floor(originalAuthenticatedAt.getTime() / 1000) } : {}),
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setIssuer('boardsesh')
      .setAudience('boardsesh-mobile')
      .setExpirationTime(Math.floor(now.getTime() / 1000) + ACCESS_LIFETIME_SECONDS)
      .sign(signingKey);
    const refreshToken = randomBytes(32).toString('hex');
    await transaction.insert(schema.prototypeNativeRefresh).values({
      tokenHash: tokenHash(refreshToken),
      userId: session.userId,
      sessionId: session.id,
      createdAt: now,
      expiresAt: refreshExpiresAt,
    });
    // Native refresh is a long-lived accepted contract. Extending expiry must
    // never change the original authentication time used for sensitive actions.
    await transaction
      .update(schema.session)
      .set({ expiresAt: refreshExpiresAt, updatedAt: now })
      .where(eq(schema.session.id, session.id));
    return { userId: session.userId, jwt, refreshToken, expiresAt: expiresAt.toISOString() };
  }

  async function pairForCanonicalToken(
    transaction: PrototypeTransaction,
    canonicalToken: string,
  ): Promise<PrototypeNativeTokenPair> {
    const [session] = await transaction.select().from(schema.session).where(eq(schema.session.token, canonicalToken));
    if (!session) throw new PrototypeNativeCredentialError();
    return issue(transaction, await lockedSession(transaction, session.userId, session.id));
  }

  async function credentials(email: string, password: string) {
    try {
      return await database.transaction(async (transaction) => {
        await lockLifecycle(transaction);
        const authority = createPrototypeAuthority(transaction, authorityOverrides);
        const authenticated = await authority.api.signInEmail({
          body: { email: normalizeAccountEmail(email), password },
        });
        return pairForCanonicalToken(transaction, authenticated.token);
      });
    } catch (error) {
      if (error instanceof APIError && [400, 401, 403].includes(error.statusCode))
        throw new PrototypeNativeCredentialError();
      throw error;
    }
  }

  async function social(provider: 'google' | 'apple', idToken: { token: string; nonce?: string }) {
    return database.transaction(async (transaction) => {
      await lockLifecycle(transaction);
      const authority = createPrototypeAuthority(transaction, authorityOverrides);
      const authenticated = await authority.api.signInSocial({ body: { provider, idToken } });
      if (!('token' in authenticated) || !authenticated.token) throw new PrototypeNativeCredentialError();
      return pairForCanonicalToken(transaction, authenticated.token);
    });
  }

  /** Trusted internal service only: callers must prove this binding, never accept request user IDs. */
  async function issueForVerifiedSession(userId: string, sessionId: string): Promise<PrototypeNativeTokenPair> {
    return database.transaction(async (transaction) => {
      await lockLifecycle(transaction);
      return issue(transaction, await lockedSession(transaction, userId, sessionId));
    });
  }

  /**
   * Trusted internal adapters only. Verify source proof before supplying an
   * owner/session binding; never pass public request user IDs directly here.
   * Proof consumption and the existing native issuer share one transaction.
   */
  async function withIssuanceTransaction<Result>(
    operation: (
      transaction: PrototypeTransaction,
      issueForSession: (userId: string, sessionId: string) => Promise<PrototypeNativeTokenPair>,
    ) => Promise<Result>,
  ): Promise<Result> {
    return database.transaction(async (transaction) => {
      await lockLifecycle(transaction);
      return operation(transaction, async (userId, sessionId) =>
        issue(transaction, await lockedSession(transaction, userId, sessionId)),
      );
    });
  }

  async function refresh(refreshToken: string) {
    const hash = tokenHash(refreshToken);
    const [candidate] = await database
      .select()
      .from(schema.prototypeNativeRefresh)
      .where(eq(schema.prototypeNativeRefresh.tokenHash, hash));
    if (!candidate) throw new PrototypeNativeCredentialError();
    return database.transaction(async (transaction) => {
      await lockLifecycle(transaction);
      const session = await lockedSession(transaction, candidate.userId, candidate.sessionId);
      const now = new Date();
      const consumed = await transaction
        .update(schema.prototypeNativeRefresh)
        .set({ revokedAt: now })
        .where(and(eq(schema.prototypeNativeRefresh.tokenHash, hash), isNull(schema.prototypeNativeRefresh.revokedAt)))
        .returning();
      if (!consumed[0] || consumed[0].expiresAt.getTime() <= now.getTime()) throw new PrototypeNativeCredentialError();
      return issue(transaction, session);
    });
  }

  async function revoke(refreshToken: string) {
    const [candidate] = await database
      .select()
      .from(schema.prototypeNativeRefresh)
      .where(eq(schema.prototypeNativeRefresh.tokenHash, tokenHash(refreshToken)));
    if (!candidate) throw new PrototypeNativeCredentialError();
    await database.transaction(async (transaction) => {
      await lockLifecycle(transaction);
      // Re-read after acquiring the fence: a delayed logout must not retain
      // authority after another logout removed this session and a new login won.
      const [current] = await transaction
        .select()
        .from(schema.prototypeNativeRefresh)
        .where(eq(schema.prototypeNativeRefresh.tokenHash, candidate.tokenHash));
      if (!current || current.expiresAt.getTime() <= Date.now()) throw new PrototypeNativeCredentialError();
      await lockedSession(transaction, current.userId, current.sessionId);
      // Deliberate prototype policy extension: an unexpired consumed ancestor
      // can sign out the account, preventing a refresh race from escaping logout.
      // Old production status for that edge is 401; full contract equivalence
      // and push-device cleanup are still outstanding migration gates.
      await revokePrototypeUser(transaction, current.userId, false);
    });
  }

  async function validateAccessToken(token: string): Promise<{ userId: string; sessionId: string } | null> {
    let claims;
    try {
      claims = (
        await jwtVerify(token, signingKey, {
          issuer: 'boardsesh',
          audience: 'boardsesh-mobile',
          algorithms: ['HS256'],
          requiredClaims: ['sub', 'sid', 'iat', 'exp'],
        })
      ).payload;
    } catch {
      return null;
    }
    if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string') return null;
    const matched = await database
      .select({ session: schema.session, cutoff: schema.prototypeUserCutoff })
      .from(schema.session)
      .innerJoin(schema.user, eq(schema.user.id, schema.session.userId))
      .leftJoin(schema.prototypeUserCutoff, eq(schema.prototypeUserCutoff.userId, schema.session.userId))
      .where(and(eq(schema.session.id, claims.sid), eq(schema.session.userId, claims.sub)));
    const current = matched[0];
    if (!current || current.session.expiresAt.getTime() <= Date.now()) return null;
    if (!prototypeSessionPassesRevocation(current.session, current.cutoff)) return null;
    return { userId: current.session.userId, sessionId: current.session.id };
  }

  return {
    credentials,
    social,
    issueForVerifiedSession,
    withIssuanceTransaction,
    refresh,
    revoke,
    validateAccessToken,
  };
}
