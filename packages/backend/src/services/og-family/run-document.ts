import { randomUUID } from 'node:crypto';
import { execute, type DocumentNode, type GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { schema } from '../../graphql/index';
import { PlaylistAccessDeniedError } from '../../graphql/resolvers/playlists/helpers/enrichment';
import { InputValidationError } from '../../validation/schemas/primitives';

/**
 * Every share-card read runs a real GraphQL document through the real schema, as
 * an anonymous caller, so the same field-level privacy a stranger would get still
 * applies. Calling root resolvers directly would skip masks like the session roster's.
 */

/**
 * An anonymous caller for one card request.
 *
 * Fresh `connectionId` on purpose: with no user and no `clientIp`, it is the only
 * key `applyRateLimit` has to bucket an anonymous HTTP caller, so a constant id
 * would be one global bucket for every share card on the service. The per-IP and
 * peer limits are enforced by the handler instead.
 */
export function createAnonymousOgContext(): ConnectionContext {
  return { connectionId: `og-family-${randomUUID()}`, transport: 'http', isAuthenticated: false };
}

/**
 * Resolver errors that mean "not yours to see" rather than "something broke".
 * Every one of them is the same answer to a stranger, so they all become the
 * identical 404 a missing row gets.
 */
export const OG_FAMILY_NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'BAD_USER_INPUT',
]);

/** A resolver refused in a way that maps to the card's 404. */
export class OgFamilyNotFoundError extends Error {
  constructor() {
    super('Not found');
    this.name = 'OgFamilyNotFoundError';
  }
}

function isNotFoundError(error: GraphQLError): boolean {
  const code = error.extensions?.code;
  if (typeof code === 'string' && OG_FAMILY_NOT_FOUND_CODES.has(code)) return true;
  // The two refusals that have no code. Matched by type and never by message, so
  // a database failure can only ever reach the 500.
  return (
    error.originalError instanceof PlaylistAccessDeniedError || error.originalError instanceof InputValidationError
  );
}

/**
 * Run one document and hand back its data.
 *
 * @throws OgFamilyNotFoundError when a resolver refused with an allow-listed code.
 * Anything else is rethrown so the handler answers 500.
 */
export async function runOgDocument<T>(
  document: DocumentNode,
  variableValues: Record<string, unknown>,
  contextValue: ConnectionContext,
): Promise<T> {
  const result = await execute({ schema, document, variableValues, contextValue });
  if (result.errors && result.errors.length > 0) {
    if (result.errors.every(isNotFoundError)) throw new OgFamilyNotFoundError();
    throw result.errors[0];
  }
  return result.data as T;
}
