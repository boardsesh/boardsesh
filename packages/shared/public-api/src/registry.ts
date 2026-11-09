/**
 * The OpenAPI registry for the public /v1 API: every route, its security and
 * every response an app has to handle. Schemas live in ./schemas.
 */
import { OpenAPIRegistry, type ResponseConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  ApiErrorResponseSchema,
  BoardTypeSchema,
  LogbookChangesQuerySchema,
  LogbookChangesResponseSchema,
  MeResponseSchema,
  TickChangeSchema,
  TickDeletedChangeSchema,
  TickParamsSchema,
  TickSchema,
  TickStatusSchema,
  UnknownLogbookChangeSchema,
} from './schemas';

export const API_ORIGIN = 'https://api.boardsesh.com';
const OAUTH_BASE_URL = `${API_ORIGIN}/api/auth/oauth2`;

/** The name of the OAuth security scheme, as the routes refer to it. */
const OAUTH_SCHEME = 'boardseshOAuth';

/** Scopes the routes in this document use. Workout scopes join in milestone 3. */
export const PUBLIC_API_SCOPES = {
  'logbook:read': 'Every tick the climber has logged, on every board, including ones they keep private on Boardsesh.',
  'profile:read': "The climber's display name and avatar.",
  offline_access: 'Receive a refresh token to keep accessing the other granted scopes while the climber is away.',
} as const;

export type PublicApiScope = keyof typeof PUBLIC_API_SCOPES;

/** Any valid access token, whatever its scopes. */
const ANY_SCOPE = [{ [OAUTH_SCHEME]: [] }];
const requireScope = (scope: PublicApiScope) => [{ [OAUTH_SCHEME]: [scope] }];

const RateLimitHeadersSchema = z.object({
  'Boardsesh-Request-Id': z.string().openapi({ description: 'Quote this when something looks wrong.' }),
  'RateLimit-Limit': z.number().int().openapi({ description: 'Request ceiling of the tightest limit that applies.' }),
  'RateLimit-Remaining': z.number().int().openapi({ description: 'Requests left in the current window.' }),
  'RateLimit-Reset': z.number().int().openapi({ description: 'Seconds until the window resets.' }),
});

const RetryAfterHeadersSchema = RateLimitHeadersSchema.extend({
  'Retry-After': z.number().int().openapi({ description: 'Seconds to wait before retrying.' }),
});

const MaybeRetryAfterHeadersSchema = RateLimitHeadersSchema.extend({
  'Retry-After': z.number().int().optional().openapi({ description: 'Seconds to wait before retrying, when known.' }),
});

const jsonContent = (schema: z.ZodType) => ({ 'application/json': { schema } });

function successResponse(description: string, schema: z.ZodType): ResponseConfig {
  return { description, headers: RateLimitHeadersSchema, content: jsonContent(schema) };
}

function errorResponse(description: string): ResponseConfig {
  return { description, headers: RateLimitHeadersSchema, content: jsonContent(ApiErrorResponseSchema) };
}

const UNAUTHORIZED = errorResponse(
  '`invalid_token`: the access token expired or was revoked. Refresh once and retry; on `invalid_grant`, stop and reconnect.',
);
const FORBIDDEN = errorResponse('`insufficient_scope`: the token lacks `logbook:read`.');
const RATE_LIMITED: ResponseConfig = {
  description: '`rate_limited`: over the limit. Wait for `Retry-After`.',
  headers: RetryAfterHeadersSchema,
  content: jsonContent(ApiErrorResponseSchema),
};
const SERVER_ERROR: ResponseConfig = {
  description: '`server_error`: our fault. Retry with backoff.',
  headers: MaybeRetryAfterHeadersSchema,
  content: jsonContent(ApiErrorResponseSchema),
};

export function createPublicApiRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  registry.registerComponent('securitySchemes', OAUTH_SCHEME, {
    type: 'oauth2',
    description: 'OAuth 2.0 authorization code flow with PKCE (S256). Tokens are opaque.',
    flows: {
      authorizationCode: {
        authorizationUrl: `${OAUTH_BASE_URL}/authorize`,
        tokenUrl: `${OAUTH_BASE_URL}/token`,
        refreshUrl: `${OAUTH_BASE_URL}/token`,
        scopes: { ...PUBLIC_API_SCOPES },
      },
    },
  });

  // Registered so the published anyOf and the enums can refer to them by name.
  registry.register('BoardType', BoardTypeSchema);
  registry.register('TickStatus', TickStatusSchema);
  registry.register('Tick', TickSchema);
  registry.register('TickChange', TickChangeSchema);
  registry.register('TickDeletedChange', TickDeletedChangeSchema);
  registry.register('UnknownLogbookChange', UnknownLogbookChangeSchema);

  registry.registerPath({
    method: 'get',
    path: '/v1/me',
    operationId: 'getMe',
    summary: 'Who is connected',
    description:
      'Works with any valid access token. `displayName` and `avatarUrl` are present only when the token has `profile:read`.',
    security: ANY_SCOPE,
    responses: {
      200: successResponse('The connected climber, as seen by your app.', MeResponseSchema),
      401: UNAUTHORIZED,
      429: RATE_LIMITED,
      '5XX': SERVER_ERROR,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/connection',
    operationId: 'deleteConnection',
    summary: 'Disconnect this app from the climber',
    description:
      'Ends the connection this token belongs to: every token family, remembered consent and pending code. Needs no additional scope. Idempotent, but a retry may return `401`; `401` alone does not prove an earlier request succeeded.',
    security: ANY_SCOPE,
    responses: {
      204: { description: 'The connection is disconnected.', headers: RateLimitHeadersSchema },
      401: UNAUTHORIZED,
      429: RATE_LIMITED,
      '5XX': SERVER_ERROR,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/logbook/changes',
    operationId: 'getLogbookChanges',
    summary: 'Read the logbook: first complete download and every later update',
    security: requireScope('logbook:read'),
    request: { query: LogbookChangesQuerySchema },
    responses: {
      200: successResponse('One page of changes, in order.', LogbookChangesResponseSchema),
      400: errorResponse(
        '`invalid_request` for a bad parameter, `invalid_cursor` for a cursor this API did not issue.',
      ),
      401: UNAUTHORIZED,
      403: FORBIDDEN,
      410: errorResponse('`cursor_expired`: persist that a full sync is required, then start without a cursor.'),
      429: RATE_LIMITED,
      '5XX': SERVER_ERROR,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/logbook/ticks/{id}',
    operationId: 'getLogbookTick',
    summary: 'Read one tick',
    security: requireScope('logbook:read'),
    request: { params: TickParamsSchema },
    responses: {
      200: successResponse('The tick.', TickSchema),
      401: UNAUTHORIZED,
      403: FORBIDDEN,
      404: errorResponse("`not_found`: the tick was deleted or is not this climber's."),
      429: RATE_LIMITED,
      '5XX': SERVER_ERROR,
    },
  });

  return registry;
}
