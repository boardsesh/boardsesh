import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { accountConsolidationMembers, accountConsolidationSessionProofs, users } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import { decryptLegacyWebJwe } from '../auth/legacy-web-jwe';
import { validateToken } from '../middleware/auth';
import { currentStoreRpcSecret } from '../auth/current-store/authority-configuration';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';
import {
  consolidationWebCredentialId,
  exchangeVerifiedConsolidationWebSession,
} from '../auth/consolidation-session/web';
import { ConsolidationExchangeError } from '../auth/consolidation-session/exchange';

const commandSchema = z
  .object({
    operation: z.enum(['enroll', 'exchange', 'revoke']),
    credential: z.string().min(1).max(12000),
  })
  .strict();

/** Only a trusted web server sends these commands. A cookie alone cannot enroll itself. */
export async function handleConsolidationWeb(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const secret = currentStoreRpcSecret(process.env);
    if (!authenticatesPrivateAuth(request.headers.authorization, secret) || request.headers.origin !== undefined) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      sendJson(response, 400, { error: 'invalid_request' });
      return;
    }
    const command = commandSchema.safeParse(await readPrivateAuthCommand(request));
    if (!command.success) {
      sendJson(response, 400, { error: 'invalid_request' });
      return;
    }
    if (command.data.operation !== 'revoke' && process.env.ACCOUNT_CONSOLIDATION_BRIDGE_MODE !== 'enabled') {
      sendJson(response, 404, { error: 'disabled' });
      return;
    }
    const [consolidationSchema] = await db.execute<{ available: boolean }>(
      sql`SELECT pg_catalog.to_regclass('public.account_consolidation_session_proofs') IS NOT NULL AS available`,
    );
    if (!consolidationSchema?.available) {
      sendJson(response, 200, { outcome: 'recorded' });
      return;
    }
    const signingSecret = process.env.NEXTAUTH_SECRET;
    if (!signingSecret) throw new Error('Cookie authority unavailable');
    const { payload } = await decryptLegacyWebJwe(command.data.credential, signingSecret, 0);
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.authSessionId !== 'string' ||
      !payload.authSessionId ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      typeof payload.gen !== 'number' ||
      !Number.isSafeInteger(payload.gen) ||
      payload.gen < 0
    ) {
      sendJson(response, 401, { outcome: 'ineligible' });
      return;
    }
    const userId = payload.sub;
    const sessionId = payload.authSessionId;
    const credentialId = consolidationWebCredentialId(userId, sessionId);
    if (command.data.operation === 'exchange') {
      const replacement = await db.transaction((transaction) =>
        exchangeVerifiedConsolidationWebSession(
          transaction,
          {
            kind: 'web-session',
            credentialId,
            userId,
            sessionId,
            sourceGeneration: payload.gen as number,
            issuedAtMs: ((payload.auth_time as number | undefined) ?? (payload.iat as number)) * 1000,
            expiresAtMs: (payload.exp as number) * 1000,
            authenticatedAtMs: typeof payload.auth_time === 'number' ? payload.auth_time * 1000 : null,
            revoked: false,
            revocationLineageVerified: true,
          },
          async (decision, canonicalSessionId) => {
            const [canonical] = await transaction
              .select({ name: users.name, email: users.email, image: users.image })
              .from(users)
              .where(eq(users.id, decision.toUserId));
            if (!canonical) throw new ConsolidationExchangeError('INELIGIBLE');
            return {
              ...canonical,
              sub: decision.toUserId,
              generation: decision.targetGeneration,
              expiresAt: Math.floor(decision.originalExpiresAtMs / 1000),
              issuedAt: payload.iat,
              sessionId: canonicalSessionId,
              receipt: { mergeId: decision.mergeId, fromUserId: decision.fromUserId, toUserId: decision.toUserId },
            };
          },
        ),
      );
      sendJson(response, 200, { outcome: 'transferred', ...replacement });
      return;
    }
    if (command.data.operation === 'enroll') {
      // Called only for a just-completed sign-in response, never a session read.
      if (
        typeof payload.auth_time !== 'number' ||
        Math.abs(Date.now() / 1000 - payload.auth_time) > 30 ||
        !(await validateToken(command.data.credential))
      ) {
        sendJson(response, 401, { outcome: 'ineligible' });
        return;
      }
      await db.transaction(async (transaction) => {
        // Lock the same subjects as the finalizer, so enrollment cannot race retirement.
        await transaction.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
        const retired = await transaction
          .select()
          .from(accountConsolidationMembers)
          .where(eq(accountConsolidationMembers.sourceUserId, userId));
        if (retired.length) throw new ConsolidationExchangeError('INELIGIBLE');
        await transaction
          .insert(accountConsolidationSessionProofs)
          .values({
            credentialId,
            sourceUserId: userId,
            mergeId: 'pending-web-login',
            kind: 'web-session',
            canonicalSessionId: randomUUID(),
            expiresAt: new Date((payload.exp as number) * 1000),
          })
          .onConflictDoNothing();
      });
    } else {
      // Insert a tombstone even if a response enrollment is still in flight.
      await db
        .insert(accountConsolidationSessionProofs)
        .values({
          credentialId,
          sourceUserId: userId,
          mergeId: 'pending-web-login',
          kind: 'web-session',
          canonicalSessionId: randomUUID(),
          expiresAt: new Date(payload.exp * 1000),
          revokedAt: new Date(),
        })
        .onConflictDoNothing();
      await db
        .update(accountConsolidationSessionProofs)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(accountConsolidationSessionProofs.kind, 'web-session'),
            or(
              eq(accountConsolidationSessionProofs.credentialId, credentialId),
              eq(accountConsolidationSessionProofs.canonicalSessionId, sessionId),
            ),
          ),
        );
    }
    sendJson(response, 200, { outcome: 'recorded' });
  } catch (error) {
    if (
      error instanceof ConsolidationExchangeError ||
      (error instanceof Error && /JWT|JWE|claim|expired/i.test(error.name))
    ) {
      sendJson(response, 401, { outcome: 'ineligible' });
    } else {
      sendJson(response, 503, { error: 'unavailable' });
    }
  }
}
