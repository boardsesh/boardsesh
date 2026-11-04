import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BetterAuthOptions } from 'better-auth';
import {
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  prototypeOAuthConnection,
  prototypeOAuthInteraction,
  prototypeOAuthRefreshAncestor,
  verification,
} from '@boardsesh/db/auth-prototype';
import { createPrototypeAuthority, type PrototypeDatabase } from './authority';
import { PROTOTYPE_ISSUER, PROTOTYPE_OAUTH_OPTIONS } from './oauth-options';
import { prototypeOAuthFamilyGuard } from './oauth-family';
import { PrototypeResponseRollback, rejectPrototypeServerFailure } from './transaction-response';

function connectionId(userId: string, clientId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([userId, clientId]))
    .digest('hex');
}

function interactionDigest(query: string): string {
  return createHash('sha256').update(query).digest('hex');
}

function invalidInteraction(): Response {
  return Response.json(
    { error: 'invalid_request', error_description: 'The consent interaction is no longer valid.' },
    { status: 400, headers: { 'cache-control': 'no-store' } },
  );
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

/**
 * BA-01 proof only: one database advisory lock serializes all prototype auth
 * traffic. This deliberately trades throughput for a decisive transaction
 * boundary across independent provider instances. It is not a rollout design.
 */
export function createSerializedPrototypeOAuthHandler(database: PrototypeDatabase, overrides: BetterAuthOptions = {}) {
  if (overrides.baseURL !== undefined && typeof overrides.baseURL !== 'string') {
    throw new Error('The disposable OAuth transaction proof requires a fixed issuer URL.');
  }
  const issuerPath = new URL(overrides.baseURL ?? PROTOTYPE_ISSUER).pathname;
  return {
    async handler(request: Request): Promise<Response> {
      try {
        return await database.transaction(async (transaction) => {
          // PostgreSQL advisory locks cannot be expressed as a Drizzle mutation.
          await transaction.execute(sql`select pg_advisory_xact_lock(6975, 1)`);
          const authority = createPrototypeAuthority(transaction, {
            ...overrides,
            plugins: [prototypeOAuthFamilyGuard(transaction), ...(overrides.plugins ?? [])],
          });
          const requestUrl = new URL(request.url);
          const isAuthorize = requestUrl.pathname === `${issuerPath}/oauth2/authorize`;
          const isConsent = requestUrl.pathname === `${issuerPath}/oauth2/consent`;
          const authenticated =
            isAuthorize || isConsent ? await authority.api.getSession({ headers: request.headers }) : null;
          let consentInteraction: typeof prototypeOAuthInteraction.$inferSelect | undefined;

          if (isConsent) {
            let body: unknown;
            try {
              body = await request.clone().json();
            } catch {
              return invalidInteraction();
            }
            if (!authenticated || !isRecord(body) || typeof body.oauth_query !== 'string') return invalidInteraction();
            const [interaction] = await transaction
              .select()
              .from(prototypeOAuthInteraction)
              .where(eq(prototypeOAuthInteraction.digest, interactionDigest(body.oauth_query)));
            if (
              !interaction ||
              interaction.userId !== authenticated.user.id ||
              interaction.sessionId !== authenticated.session.id ||
              interaction.consumedAt !== null ||
              interaction.expiresAt <= new Date()
            ) {
              return invalidInteraction();
            }
            const [connection] = await transaction
              .select()
              .from(prototypeOAuthConnection)
              .where(eq(prototypeOAuthConnection.id, connectionId(interaction.userId, interaction.clientId)));
            if (!connection || connection.generation !== interaction.connectionGeneration) return invalidInteraction();
            consentInteraction = interaction;
          }

          // A reconnect always shows a new consent screen, even for a fixture
          // client configured to skip consent during unrelated protocol tests.
          if (isAuthorize && authenticated) {
            // The provider reads form POST parameters from the body only; URL
            // query parameters cannot stand in for its client or prompt fields.
            const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
            const authorizeParameters =
              request.method === 'GET'
                ? requestUrl.searchParams
                : request.method === 'POST' && mediaType === 'application/x-www-form-urlencoded'
                  ? new URLSearchParams(await request.clone().text())
                  : undefined;
            const clientId = authorizeParameters?.get('client_id');
            if (authorizeParameters && clientId) {
              const [connection] = await transaction
                .select()
                .from(prototypeOAuthConnection)
                .where(eq(prototypeOAuthConnection.id, connectionId(authenticated.user.id, clientId)));
              if (connection?.revokedAt) {
                const prompts = new Set((authorizeParameters.get('prompt') ?? '').split(' ').filter(Boolean));
                prompts.add('consent');
                authorizeParameters.set('prompt', [...prompts].join(' '));
                if (request.method === 'POST') {
                  const headers = new Headers(request.headers);
                  headers.delete('content-length');
                  request = new Request(request, { method: 'POST', headers, body: authorizeParameters.toString() });
                } else {
                  request = new Request(requestUrl, request);
                }
              }
            }
          }

          const response = await authority.handler(request);
          // Protocol rejection can intentionally persist replay invalidation.
          // Unexpected provider failures must not commit a partially minted set.
          rejectPrototypeServerFailure(response);

          if (consentInteraction && response.ok) {
            await transaction
              .update(prototypeOAuthInteraction)
              .set({ consumedAt: new Date() })
              .where(eq(prototypeOAuthInteraction.digest, consentInteraction.digest));
            const result: unknown = await response.clone().json();
            if (isRecord(result) && typeof result.url === 'string' && new URL(result.url).searchParams.has('code')) {
              await transaction
                .update(prototypeOAuthConnection)
                .set({ revokedAt: null })
                .where(
                  eq(prototypeOAuthConnection.id, connectionId(consentInteraction.userId, consentInteraction.clientId)),
                );
            }
          }

          const redirectLocation = response.headers.get('location');
          if (isAuthorize && authenticated && redirectLocation) {
            const redirectUrl = new URL(redirectLocation);
            const consentPage = new URL(PROTOTYPE_OAUTH_OPTIONS.consentPage);
            if (redirectUrl.origin === consentPage.origin && redirectUrl.pathname === consentPage.pathname) {
              const clientId = redirectUrl.searchParams.get('client_id');
              const expiresAtSeconds = Number(redirectUrl.searchParams.get('exp'));
              if (!clientId || !Number.isFinite(expiresAtSeconds))
                throw new Error('Provider returned an invalid consent interaction');
              const id = connectionId(authenticated.user.id, clientId);
              await transaction
                .insert(prototypeOAuthConnection)
                .values({ id, userId: authenticated.user.id, clientId })
                .onConflictDoNothing();
              const [connection] = await transaction
                .select()
                .from(prototypeOAuthConnection)
                .where(eq(prototypeOAuthConnection.id, id));
              if (!connection) throw new Error('Missing disposable OAuth connection');
              await transaction
                .insert(prototypeOAuthInteraction)
                .values({
                  digest: interactionDigest(redirectUrl.searchParams.toString()),
                  userId: authenticated.user.id,
                  sessionId: authenticated.session.id,
                  clientId,
                  connectionGeneration: connection.generation,
                  createdAt: new Date(),
                  expiresAt: new Date(expiresAtSeconds * 1000),
                })
                .onConflictDoNothing();
            }
          }
          return response;
        });
      } catch (error) {
        if (error instanceof PrototypeResponseRollback) return error.response;
        throw error;
      }
    },
  };
}

function isConnectionAuthorizationCode(serialized: string, userId: string, clientId: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const record = parsed as Record<string, unknown>;
  if (record.type !== 'authorization_code' || record.userId !== userId) return false;
  if (typeof record.query !== 'object' || record.query === null) return false;
  return (record.query as Record<string, unknown>).client_id === clientId;
}

/**
 * Disposable proof for atomic token/consent/code teardown, never an exposed
 * endpoint. The caller supplies a proven first-party user ID. A production
 * Disconnect also needs workout hooks and a reviewed production locking design.
 */
export async function disconnectPrototypeOAuthConnection(
  database: PrototypeDatabase,
  userId: string,
  clientId: string,
) {
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(6975, 1)`);
    const id = connectionId(userId, clientId);
    await transaction
      .insert(prototypeOAuthConnection)
      .values({ id, userId, clientId, generation: 1, revokedAt: new Date() })
      .onConflictDoUpdate({
        target: prototypeOAuthConnection.id,
        set: { generation: sql`${prototypeOAuthConnection.generation} + 1`, revokedAt: new Date() },
      });
    await transaction
      .delete(oauthAccessToken)
      .where(and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId)));
    await transaction
      .delete(oauthRefreshToken)
      .where(and(eq(oauthRefreshToken.userId, userId), eq(oauthRefreshToken.clientId, clientId)));
    await transaction
      .delete(oauthConsent)
      .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)));
    await transaction
      .delete(prototypeOAuthRefreshAncestor)
      .where(
        and(eq(prototypeOAuthRefreshAncestor.userId, userId), eq(prototypeOAuthRefreshAncestor.clientId, clientId)),
      );

    // This bounded-fixture scan avoids casting non-JSON recovery values. A
    // production implementation needs indexed, explicitly owned interaction rows.
    const pending = await transaction.select({ id: verification.id, value: verification.value }).from(verification);
    const connectionCodeIds = pending
      .filter((record) => isConnectionAuthorizationCode(record.value, userId, clientId))
      .map((record) => record.id);
    if (connectionCodeIds.length > 0) {
      await transaction.delete(verification).where(inArray(verification.id, connectionCodeIds));
    }
  });
}
