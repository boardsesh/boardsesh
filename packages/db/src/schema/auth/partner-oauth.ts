import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Tables behind third-party ("partner") OAuth. Two groups:
 *
 * 1. The models Better Auth OAuth Provider 1.7.17 reads and writes. Property
 *    names and export names are what the Better Auth Drizzle adapter addresses,
 *    so they must not change. Better Auth's `user` model maps onto `users`, and
 *    its `session` and `verification` models get partner-only tables here so
 *    this flow never mixes with first-party sign-in state.
 * 2. Boardsesh's own records that sit beside them (docs/integration-platform.md).
 *
 * Every user column cascades from `users`, and every foreign key column leads an
 * index: account deletion runs one cascade query per reference.
 *
 * Timestamps carry a time zone, unlike the naive columns the generator emits, so
 * expiry checks in SQL compare correctly under any session TimeZone.
 */
const timestamptz = (columnName: string) => timestamp(columnName, { withTimezone: true });

/** Better Auth `session` model. A row is created by the consent bridge, never by a Better Auth login. */
export const oauthSession = pgTable(
  'oauth_session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamptz('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at')
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('oauth_session_user_id_idx').on(table.userId),
    index('oauth_session_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * Better Auth `verification` model. For this flow it holds pending authorization
 * codes: `identifier` is the code's stored hash and `oauth_grants` keys on it.
 * It has no user column, so a pending code does not cascade from `users`, but the
 * `oauth_session` row every code names does, and redeeming requires that row.
 */
export const oauthVerification = pgTable(
  'oauth_verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index('oauth_verification_identifier_idx').on(table.identifier),
    index('oauth_verification_expires_at_idx').on(table.expiresAt),
  ],
);

export const oauthClient = pgTable(
  'oauth_client',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull().unique(),
    clientSecret: text('client_secret'),
    clientDiscoveryId: text('client_discovery_id'),
    disabled: boolean('disabled').default(false),
    skipConsent: boolean('skip_consent'),
    enableEndSession: boolean('enable_end_session'),
    subjectType: text('subject_type'),
    scopes: text('scopes').array(),
    clientCredentialsScopes: text('client_credentials_scopes').array().default([]),
    /** The developer who registered the app. Deleting them deletes the app and everything under it. */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at'),
    updatedAt: timestamptz('updated_at'),
    name: text('name'),
    uri: text('uri'),
    icon: text('icon'),
    contacts: text('contacts').array(),
    tos: text('tos'),
    policy: text('policy'),
    softwareId: text('software_id'),
    softwareVersion: text('software_version'),
    softwareStatement: text('software_statement'),
    redirectUris: text('redirect_uris').array().notNull(),
    postLogoutRedirectUris: text('post_logout_redirect_uris').array(),
    backchannelLogoutUri: text('backchannel_logout_uri'),
    backchannelLogoutSessionRequired: boolean('backchannel_logout_session_required'),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
    applicationType: text('application_type'),
    jwks: text('jwks'),
    jwksUri: text('jwks_uri'),
    grantTypes: text('grant_types').array(),
    responseTypes: text('response_types').array(),
    requirePKCE: boolean('require_pkce'),
    dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').default(false),
    referenceId: text('reference_id'),
    metadata: jsonb('metadata'),
  },
  (table) => [index('oauth_client_user_id_idx').on(table.userId)],
);

export const oauthResource = pgTable('oauth_resource', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull().unique(),
  name: text('name').notNull(),
  accessTokenTtl: integer('access_token_ttl'),
  refreshTokenTtl: integer('refresh_token_ttl'),
  signingAlgorithm: text('signing_algorithm'),
  signingKeyId: text('signing_key_id'),
  allowedScopes: text('allowed_scopes').array(),
  customClaims: jsonb('custom_claims'),
  dpopBoundAccessTokensRequired: boolean('dpop_bound_access_tokens_required').default(false),
  disabled: boolean('disabled').default(false),
  createdAt: timestamptz('created_at'),
  updatedAt: timestamptz('updated_at'),
  policyVersion: integer('policy_version').default(1),
  metadata: jsonb('metadata'),
});

export const oauthClientResource = pgTable(
  'oauth_client_resource',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    resourceId: text('resource_id')
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: 'cascade' }),
    metadata: jsonb('metadata'),
    createdAt: timestamptz('created_at'),
  },
  (table) => [
    uniqueIndex('oauth_client_resource_client_id_resource_id_uidx').on(table.clientId, table.resourceId),
    index('oauth_client_resource_resource_id_idx').on(table.resourceId),
  ],
);

export const oauthRefreshToken = pgTable(
  'oauth_refresh_token',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => oauthSession.id, { onDelete: 'set null' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    revoked: timestamptz('revoked'),
    rotatedAt: timestamptz('rotated_at'),
    rotationReplayResponse: text('rotation_replay_response'),
    rotationReplayExpiresAt: timestamptz('rotation_replay_expires_at'),
    authTime: timestamptz('auth_time'),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (table) => [
    index('oauth_refresh_token_client_id_idx').on(table.clientId),
    index('oauth_refresh_token_session_id_idx').on(table.sessionId),
    index('oauth_refresh_token_user_id_idx').on(table.userId),
    index('oauth_refresh_token_authorization_code_id_idx').on(table.authorizationCodeId),
  ],
);

export const oauthAccessToken = pgTable(
  'oauth_access_token',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => oauthSession.id, { onDelete: 'set null' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    refreshId: text('refresh_id').references(() => oauthRefreshToken.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    revoked: timestamptz('revoked'),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (table) => [
    index('oauth_access_token_client_id_idx').on(table.clientId),
    index('oauth_access_token_session_id_idx').on(table.sessionId),
    index('oauth_access_token_user_id_idx').on(table.userId),
    index('oauth_access_token_authorization_code_id_idx').on(table.authorizationCodeId),
    index('oauth_access_token_refresh_id_idx').on(table.refreshId),
  ],
);

export const oauthConsent = pgTable(
  'oauth_consent',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    scopes: text('scopes').array().notNull(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    index('oauth_consent_client_id_idx').on(table.clientId),
    index('oauth_consent_user_id_idx').on(table.userId),
  ],
);

export const oauthClientAssertion = pgTable('oauth_client_assertion', {
  id: text('id').primaryKey(),
  expiresAt: timestamptz('expires_at').notNull(),
});

/**
 * Boardsesh's policy for an app, keyed by the provider's client id. The provider
 * stays authoritative for client authentication, redirects and token issuance.
 */
export const oauthAppPolicy = pgTable(
  'oauth_app_policy',
  {
    clientId: text('client_id')
      .primaryKey()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    termsVersion: text('terms_version'),
    termsAcceptedAt: timestamptz('terms_accepted_at'),
    /**
     * Who makes the app, as the developer typed it at registration: the consent
     * screen's "Made by". Public, so it follows the app-name rules. Null only for
     * an app registered before the column existed; the screen then shows no
     * "Made by" and never falls back to the developer's own account name.
     */
    publisherName: text('publisher_name'),
    rateTier: text('rate_tier').default('default').notNull(),
    /** Launch caps. Raising an app's limit is an update to its own row. */
    maxActiveConnections: integer('max_active_connections').default(25).notNull(),
    maxNewConnectionsPerDay: integer('max_new_connections_per_day').default(20).notNull(),
    suspendedAt: timestamptz('suspended_at'),
    suspensionReason: text('suspension_reason'),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [index('oauth_app_policy_owner_user_id_idx').on(table.ownerUserId)],
);

/**
 * One current connection per climber and app. Generation goes up on every
 * revocation; a token whose grant carries an older generation can never work
 * again, even after the climber reconnects.
 */
export const oauthConnections = pgTable(
  'oauth_connections',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    generation: integer('generation').default(0).notNull(),
    scopes: text('scopes').array().default([]).notNull(),
    /** Set when the app first redeems a code; cleared by an approved reconnect until it redeems again. The caps count on it. */
    connectedAt: timestamptz('connected_at'),
    lastUsedAt: timestamptz('last_used_at'),
    revokedAt: timestamptz('revoked_at'),
    revocationReason: text('revocation_reason'),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    updatedAt: timestamptz('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('oauth_connections_user_id_client_id_uidx').on(table.userId, table.clientId),
    index('oauth_connections_client_id_connected_at_idx').on(table.clientId, table.connectedAt),
  ],
);

/** The stable public id an app sees for a climber. Survives reconnects; never `users.id`. */
export const oauthSubjects = pgTable(
  'oauth_subjects',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    subject: text('subject').notNull().unique(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.clientId] }),
    index('oauth_subjects_client_id_idx').on(table.clientId),
  ],
);

/**
 * One row per authorization code, written in the transaction that issues it.
 * Tokens carry the same `authorizationCodeId`, so this row binds them to a
 * connection generation and lets Disconnect find pending codes by index. Its id
 * doubles as the `oauth_verification.identifier` of the pending code.
 */
export const oauthGrants = pgTable(
  'oauth_grants',
  {
    authorizationCodeId: text('authorization_code_id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => oauthConnections.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
  },
  (table) => [index('oauth_grants_connection_id_idx').on(table.connectionId)],
);

/**
 * Hashes of refresh tokens a grant family has used. The provider may prune an
 * expired consumed row while the family still has live descendants; this keeps
 * reuse detection working until the whole family is gone. Expiry alone is never
 * permission to forget a row here.
 */
export const oauthRefreshAncestors = pgTable(
  'oauth_refresh_ancestors',
  {
    tokenHash: text('token_hash').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    authorizationCodeId: text('authorization_code_id').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    consumedAt: timestamptz('consumed_at'),
  },
  (table) => [
    index('oauth_refresh_ancestors_family_idx').on(table.userId, table.clientId, table.authorizationCodeId),
    index('oauth_refresh_ancestors_client_id_idx').on(table.clientId),
    index('oauth_refresh_ancestors_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * A single-use consent screen, bound to the climber, their NextAuth session and
 * the connection generation it was opened against. Switching account or
 * reconnecting makes the pending screen unusable.
 */
export const oauthConsentInteractions = pgTable(
  'oauth_consent_interactions',
  {
    digest: text('digest').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    authSessionId: text('auth_session_id').notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    connectionGeneration: integer('connection_generation').notNull(),
    createdAt: timestamptz('created_at').defaultNow().notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    consumedAt: timestamptz('consumed_at'),
  },
  (table) => [
    index('oauth_consent_interactions_user_id_idx').on(table.userId),
    index('oauth_consent_interactions_client_id_idx').on(table.clientId),
    index('oauth_consent_interactions_expires_at_idx').on(table.expiresAt),
  ],
);
