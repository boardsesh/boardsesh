import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { authCredentialLineage, authSession, mobileRefreshTokens, users } from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { bindNativeRefreshSession } from '../native-session';
import { cleanupNativeRefreshRows } from '../native-refresh-retention';
import { requireHumanSubjectForIssuance } from '../../human-admission';

describe('additive native refresh lineage and ancestor retention', () => {
  let environment: Awaited<ReturnType<typeof createEnvironment>>;
  beforeAll(async () => {
    environment = await createEnvironment();
  });
  afterAll(async () => environment?.close());
  afterEach(() => vi.unstubAllEnvs());
  async function fixture() {
    const userId = randomUUID();
    await environment.database.insert(users).values({ id: userId, email: `session-${userId}@example.com` });
    return userId;
  }
  it('defaults off; on creates one canonical session without refreshing source age or initial expiry', async () => {
    const userId = await fixture();
    const proof = { sessionId: randomUUID(), subjectGeneration: 0, authenticatedAt: null };
    const firstExpiry = new Date(Date.now() + 86400000);
    const bind = (expiresAt: Date) =>
      environment.database.transaction(async (transaction) => {
        await requireHumanSubjectForIssuance(transaction, userId);
        await bindNativeRefreshSession(transaction, userId, proof, expiresAt, new Date(), 'generation');
      });
    vi.stubEnv('AUTH_LEGACY_BRIDGE_MODE', 'off');
    await bind(firstExpiry);
    expect(await environment.database.select().from(authSession).where(eq(authSession.userId, userId))).toHaveLength(0);
    vi.stubEnv('AUTH_LEGACY_BRIDGE_MODE', 'on');
    await Promise.all([bind(firstExpiry), bind(firstExpiry)]);
    const laterExpiry = new Date(firstExpiry.getTime() + 86400000);
    await bind(laterExpiry);
    const sessions = await environment.database.select().from(authSession).where(eq(authSession.userId, userId));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: proof.sessionId, originalAuthenticatedAt: null, revocationGeneration: 0 });
    expect(sessions[0].createdAt.getTime()).toBe(0);
    expect(sessions[0].expiresAt.getTime()).toBe(laterExpiry.getTime());
    const [lineage] = await environment.database
      .select()
      .from(authCredentialLineage)
      .where(eq(authCredentialLineage.userId, userId));
    expect(lineage.originalExpiresAt.getTime()).toBe(firstExpiry.getTime());
    await environment.database
      .update(authCredentialLineage)
      .set({ revokedAt: new Date() })
      .where(eq(authCredentialLineage.id, lineage.id));
    await expect(bind(laterExpiry)).rejects.toThrow('Authentication is required');
  });
  it('retains an expired consumed parent with no family ID while a descendant lives', async () => {
    const userId = await fixture();
    const now = new Date();
    const old = new Date(now.getTime() - 10 * 86400000);
    const parentHash = randomUUID();
    const childHash = randomUUID();
    await environment.database.insert(mobileRefreshTokens).values([
      { userId, tokenHash: parentHash, expiresAt: old, revokedAt: old },
      { userId, tokenHash: childHash, expiresAt: new Date(now.getTime() + 86400000) },
    ]);
    expect(await cleanupNativeRefreshRows(environment.database, now)).toBe(0);
    expect(
      await environment.database.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, userId)),
    ).toHaveLength(2);
    await environment.database
      .update(mobileRefreshTokens)
      .set({ revokedAt: old })
      .where(eq(mobileRefreshTokens.tokenHash, childHash));
    expect(await cleanupNativeRefreshRows(environment.database, now)).toBe(2);
  });
});
