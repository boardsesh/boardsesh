import { rolesGrantAdmin } from '@boardsesh/community-roles';
import { communityRoles } from '@boardsesh/db/schema';
import { lockDeveloper, requireRecentSignIn } from './developer-change';
import { hasVerifiedPartnerDeveloperEmail } from './developer-email';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware, isAPIError } from 'better-auth/api';
import { and, asc, count, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  oauthAppPolicy,
  oauthClient,
  oauthClientResource,
  oauthConnections,
  oauthConsent,
  oauthGrants,
  oauthVerification,
  users,
} from '@boardsesh/db/schema/auth';
import type { WebSignInProof } from '@boardsesh/shared-schema';
// Type only: the email owns the notice's shape, and never reaches into this folder.
import type { PartnerAppChangeNotice } from '../../email/partner-app-emails';
import { logger } from '../../utils/logger';
import type { PartnerAuthority } from './authority';
import { lockAppForDeletion } from './locks';
import type { PartnerAuthorityConfiguration } from './configuration';
import { PARTNER_SCOPES } from './configuration';
import type { PartnerRegisteredOrigins } from './registered-origins';
import {
  normalizePartnerAppInput,
  normalizePartnerAppPatch,
  PARTNER_APP_AUTH_METHODS,
  PARTNER_APPS_PER_DEVELOPER,
  PARTNER_LAUNCH_MAX_ACTIVE_CONNECTIONS,
  PARTNER_LAUNCH_MAX_NEW_CONNECTIONS_PER_DAY,
  PartnerRegistrationError,
  type PartnerAppApplicationType,
  type PartnerAppAuthMethod,
  type PartnerAppCredentials,
  type PartnerAppInput,
  type PartnerAppRecord,
} from './registration-rules';
import type { PartnerDatabase } from './tables';
import { isPartnerDatabaseBusy, runInPartnerTransaction } from './transaction';

/** Same global-admin predicate as requireAdmin; the request cannot supply this authority. */
async function developerMayUseBoardseshBranding(database: PartnerDatabase, developerId: string): Promise<boolean> {
  const roles = await database
    .select({ role: communityRoles.role, boardType: communityRoles.boardType })
    .from(communityRoles)
    .where(eq(communityRoles.userId, developerId))
    .for('share');
  return rolesGrantAdmin(roles);
}

type OAuthClientRow = typeof oauthClient.$inferSelect;
type OAuthAppPolicyRow = typeof oauthAppPolicy.$inferSelect;

/**
 * Better Auth's client endpoints read the developer from a session. A
 * registration call carries one only when this module made the call, inside
 * `actAsDeveloper`; an HTTP request never runs inside this store and always
 * carries a Request. Create is SERVER_ONLY, rotate is in `disabledPaths`, and
 * neither is in `PARTNER_ROUTES`.
 */
const registrationActor = new AsyncLocalStorage<{ developerId: string }>();
const ACTOR_PATHS: ReadonlySet<string> = new Set(['/admin/oauth2/create-client', '/oauth2/client/rotate-secret']);

export function partnerRegistrationActorPlugin(): BetterAuthPlugin {
  return {
    id: 'boardsesh-partner-registration-actor',
    hooks: {
      before: [
        {
          matcher: (context) => context.path !== undefined && ACTOR_PATHS.has(context.path),
          handler: createAuthMiddleware(async (context) => {
            const actor = registrationActor.getStore();
            if (!actor || context.request) return;
            const now = new Date();
            context.context.session = {
              session: {
                id: 'partner-registration',
                token: '',
                userId: actor.developerId,
                createdAt: now,
                updatedAt: now,
                expiresAt: new Date(now.getTime() + 60_000),
              },
              user: { id: actor.developerId },
            } as unknown as NonNullable<typeof context.context.session>;
          }),
        },
      ],
    },
  };
}

function actAsDeveloper<Result>(developerId: string, work: () => Promise<Result>): Promise<Result> {
  return registrationActor.run({ developerId }, work);
}

/**
 * What registration hands the provider. Everything but the developer's own
 * fields is fixed here: consent is always shown, PKCE is always required, the
 * token endpoint takes a shared secret or nothing (never `private_key_jwt`, so
 * no `jwks_uri` is ever fetched), and the app gets exactly the published scopes
 * and the one API resource.
 */
export function managedRegistrationBody(input: PartnerAppInput, configuration: PartnerAuthorityConfiguration) {
  return {
    client_name: input.name,
    ...(input.homepageUrl ? { client_uri: input.homepageUrl } : {}),
    policy_uri: input.privacyPolicyUrl,
    redirect_uris: input.redirectUris,
    application_type: input.applicationType,
    token_endpoint_auth_method: input.tokenEndpointAuthMethod,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code' as const],
    scope: PARTNER_SCOPES.join(' '),
    resources: [configuration.resource],
    skip_consent: false,
    require_pkce: true,
    enable_end_session: false,
    dpop_bound_access_tokens: false,
    client_secret_expires_at: 0,
  };
}

const MANAGED_GRANT_TYPES = ['authorization_code', 'refresh_token'];

/**
 * A row registration may leave behind. The body above already fixes these
 * values; this refuses, rolling the registration back, if the provider stored
 * anything else, so a library change cannot quietly turn one of them on.
 */
export function managedClientProblem(row: OAuthClientRow, developerId: string): string | null {
  const authMethod = row.tokenEndpointAuthMethod;
  if (row.userId !== developerId) return 'owner';
  if (row.skipConsent !== false) return 'skip_consent';
  if (row.requirePKCE !== true) return 'require_pkce';
  if (!PARTNER_APP_AUTH_METHODS.some((method) => method === authMethod)) return 'token_endpoint_auth_method';
  if (row.jwks !== null || row.jwksUri !== null) return 'jwks';
  if (row.disabled === true) return 'disabled';
  if (row.enableEndSession === true) return 'enable_end_session';
  if (row.backchannelLogoutUri !== null) return 'backchannel_logout_uri';
  if ((row.clientCredentialsScopes ?? []).length > 0) return 'client_credentials_scopes';
  const grantTypes = [...(row.grantTypes ?? [])].sort();
  if (grantTypes.join(' ') !== [...MANAGED_GRANT_TYPES].sort().join(' ')) return 'grant_types';
  if ((row.responseTypes ?? []).join(' ') !== 'code') return 'response_types';
  if (authMethod === 'none' ? row.clientSecret !== null : !row.clientSecret) return 'client_secret';
  return null;
}

function toRecord(
  row: OAuthClientRow,
  policy: OAuthAppPolicyRow | null | undefined,
  activeConnections: number,
): PartnerAppRecord {
  return {
    clientId: row.clientId,
    name: row.name ?? '',
    publisherName: policy?.publisherName ?? null,
    homepageUrl: row.uri,
    privacyPolicyUrl: row.policy ?? '',
    applicationType: (row.applicationType === 'native' ? 'native' : 'web') satisfies PartnerAppApplicationType,
    tokenEndpointAuthMethod: (PARTNER_APP_AUTH_METHODS.find((method) => method === row.tokenEndpointAuthMethod) ??
      'client_secret_basic') satisfies PartnerAppAuthMethod,
    redirectUris: row.redirectUris,
    createdAt: row.createdAt ?? new Date(0),
    suspendedAt: policy?.suspendedAt ?? null,
    suspensionReason: policy?.suspensionReason ?? null,
    maxActiveConnections: policy?.maxActiveConnections ?? PARTNER_LAUNCH_MAX_ACTIVE_CONNECTIONS,
    maxNewConnectionsPerDay: policy?.maxNewConnectionsPerDay ?? PARTNER_LAUNCH_MAX_NEW_CONNECTIONS_PER_DAY,
    activeConnections,
  };
}

/**
 * Live connections per app, counted as the caps count them: redeemed
 * (`connected_at` set) and not ended. An approval nobody redeemed is not one.
 */
async function countActiveConnections(
  database: PartnerDatabase,
  clientIds: readonly string[],
): Promise<Map<string, number>> {
  if (clientIds.length === 0) return new Map();
  const rows = await database
    .select({ clientId: oauthConnections.clientId, connections: count() })
    .from(oauthConnections)
    .where(
      and(
        inArray(oauthConnections.clientId, [...clientIds]),
        isNotNull(oauthConnections.connectedAt),
        isNull(oauthConnections.revokedAt),
      ),
    )
    .groupBy(oauthConnections.clientId);
  return new Map(rows.map((row) => [row.clientId, row.connections]));
}

async function activeConnectionsOf(database: PartnerDatabase, clientId: string): Promise<number> {
  return (await countActiveConnections(database, [clientId])).get(clientId) ?? 0;
}

function isSuspended(row: OAuthClientRow, policy: OAuthAppPolicyRow | null | undefined): boolean {
  return row.disabled === true || Boolean(policy?.suspendedAt);
}

/** The developer's own app. Another developer's app reads as missing, so ids reveal nothing. */
async function findOwnedApp(
  transaction: PartnerDatabase,
  developerId: string,
  clientId: string,
): Promise<{ row: OAuthClientRow; policy: OAuthAppPolicyRow | null } | null> {
  const [found] = await transaction
    .select({ row: oauthClient, policy: oauthAppPolicy })
    .from(oauthClient)
    .leftJoin(oauthAppPolicy, eq(oauthAppPolicy.clientId, oauthClient.clientId))
    .where(and(eq(oauthClient.clientId, clientId), eq(oauthClient.userId, developerId)));
  return found ?? null;
}

async function requireOwnedApp(transaction: PartnerDatabase, developerId: string, clientId: string) {
  const found = await findOwnedApp(transaction, developerId, clientId);
  if (!found) throw new PartnerRegistrationError('not_found', 'No app with that client ID.');
  if (isSuspended(found.row, found.policy)) {
    throw new PartnerRegistrationError('suspended', 'This app is suspended, so it cannot be changed.');
  }
  return found;
}

async function assertManagedClient(
  transaction: PartnerDatabase,
  developerId: string,
  clientId: string,
  resource: string,
) {
  const found = await findOwnedApp(transaction, developerId, clientId);
  if (!found) throw new Error('Registered partner app is missing.');
  const problem = managedClientProblem(found.row, developerId);
  if (problem) throw new Error(`Registered partner app breaks the managed policy (${problem}).`);
  const links = await transaction
    .select({ resourceId: oauthClientResource.resourceId })
    .from(oauthClientResource)
    .where(eq(oauthClientResource.clientId, clientId));
  if (links.length !== 1 || links[0].resourceId !== resource) {
    throw new Error('Registered partner app is not linked to exactly the API resource.');
  }
  return found;
}

/** The provider refused metadata the rules let through. Show its reason, never its internals. */
function providerRefusal(error: unknown): PartnerRegistrationError | null {
  if (!isAPIError(error)) return null;
  const body = (error as { body?: { error?: unknown; error_description?: unknown } }).body;
  const code = typeof body?.error === 'string' ? body.error : undefined;
  if (code !== 'invalid_redirect_uri' && code !== 'invalid_client_metadata' && code !== 'invalid_scope') return null;
  const description = typeof body?.error_description === 'string' ? body.error_description : undefined;
  return new PartnerRegistrationError('invalid_input', description ?? 'These app details were refused.');
}

export type { PartnerAppChangeNotice };

/**
 * Sends the notice, to a verified address only. Called after commit and never
 * awaited; a throw or a rejection is logged and goes no further, so it can
 * neither hold nor fail a change (nor lose a rotated secret).
 */
export type PartnerAppChangeNotifier = (notice: PartnerAppChangeNotice) => Promise<void>;

/** A notice a transaction prepared, sent or skipped once it commits. */
type PendingNotice = { readonly notice: PartnerAppChangeNotice; readonly emailVerified: boolean };

/** The redirect URIs an edit adds and removes, or null when it leaves the set as it was. */
function redirectUriChange(
  before: readonly string[],
  after: readonly string[] | undefined,
): { added: number; removed: number } | null {
  if (after === undefined) return null;
  const added = after.filter((uri) => !before.includes(uri)).length;
  const removed = before.filter((uri) => !after.includes(uri)).length;
  return added === 0 && removed === 0 ? null : { added, removed };
}

/** A lock or statement timeout is a retry, never a broken app. */
async function inRegistrationTransaction<Result>(
  database: PartnerDatabase,
  work: (transaction: PartnerDatabase) => Promise<Result>,
): Promise<Result> {
  try {
    return await runInPartnerTransaction(database, (transaction) => work(transaction));
  } catch (error) {
    if (isPartnerDatabaseBusy(error)) {
      throw new PartnerRegistrationError('busy', 'The server is busy. Try again shortly.', { cause: error });
    }
    throw providerRefusal(error) ?? error;
  }
}

export interface PartnerRegistration {
  listApps(database: PartnerDatabase, developerId: string): Promise<PartnerAppRecord[]>;
  createApp(
    database: PartnerDatabase,
    developerId: string,
    input: Record<string, unknown>,
    options?: { requireEmailProof?: boolean },
  ): Promise<PartnerAppCredentials>;
  /**
   * `signIn` is the request's verified sign-in (`ConnectionContext.webSignIn`).
   * An edit that adds or removes a redirect URI needs it recent; any other edit does not.
   */
  updateApp(
    database: PartnerDatabase,
    developerId: string,
    clientId: string,
    patch: Record<string, unknown>,
    signIn: WebSignInProof | null | undefined,
  ): Promise<PartnerAppRecord>;
  /** Needs a recent `signIn`. */
  rotateSecret(
    database: PartnerDatabase,
    developerId: string,
    clientId: string,
    signIn: WebSignInProof | null | undefined,
  ): Promise<PartnerAppCredentials>;
  /** False when the developer has no app with that id. Needs a recent `signIn`. */
  deleteApp(
    database: PartnerDatabase,
    developerId: string,
    clientId: string,
    signIn: WebSignInProof | null | undefined,
  ): Promise<boolean>;
}

/**
 * The developer console's backend. Each call runs in one transaction on the
 * database the caller passes (the GraphQL pool), and the provider's own calls
 * join it through the partner handle. The developer id is the authenticated
 * Boardsesh account; eligibility (mode, allowlist) is the caller's to check.
 * A redirect URI change, a new secret and a deletion each need a recent
 * sign-in (`requireRecentSignIn`). Those and a new app, once committed, tell
 * `notifyDeveloper` when the developer's address is verified.
 */
export function createPartnerRegistration({
  authority,
  configuration,
  registeredOrigins,
  notifyDeveloper,
}: {
  authority: PartnerAuthority;
  configuration: PartnerAuthorityConfiguration;
  registeredOrigins: PartnerRegisteredOrigins;
  notifyDeveloper: PartnerAppChangeNotifier;
}): PartnerRegistration {
  function notifyFailed(notice: PartnerAppChangeNotice, error: unknown): void {
    logger.warn('[PartnerApps] The app change email could not be sent', {
      change: notice.change,
      clientId: notice.clientId,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
  }

  /**
   * After commit, and never awaited: the change stands whatever the mailer
   * does. Neither a notifier that throws at once nor one that rejects later
   * reaches the request, so a rotation always returns its new secret. Logs
   * carry the change and the client ID, never an address.
   */
  function notifyAfterCommit(pending: PendingNotice | null): void {
    if (!pending) return;
    const { notice, emailVerified } = pending;
    if (!emailVerified) {
      logger.warn('[PartnerApps] No app change email: the developer email is not verified', {
        change: notice.change,
        clientId: notice.clientId,
      });
      return;
    }
    let sending: Promise<void>;
    try {
      sending = notifyDeveloper(notice);
    } catch (error) {
      notifyFailed(notice, error);
      return;
    }
    void Promise.resolve(sending).catch((error: unknown) => notifyFailed(notice, error));
  }

  return {
    async listApps(database, developerId) {
      const rows = await database
        .select({ row: oauthClient, policy: oauthAppPolicy })
        .from(oauthClient)
        .leftJoin(oauthAppPolicy, eq(oauthAppPolicy.clientId, oauthClient.clientId))
        .where(eq(oauthClient.userId, developerId))
        .orderBy(asc(oauthClient.createdAt), asc(oauthClient.clientId));
      const active = await countActiveConnections(
        database,
        rows.map(({ row }) => row.clientId),
      );
      return rows.map(({ row, policy }) => toRecord(row, policy, active.get(row.clientId) ?? 0));
    },

    async createApp(database, developerId, rawInput, options) {
      const created = await inRegistrationTransaction(database, async (transaction) => {
        // Serializes this developer's registrations, so the app count below holds under a race.
        await lockDeveloper(transaction, developerId);
        const input = normalizePartnerAppInput(rawInput, configuration.developerTermsVersion, {
          allowBoardseshBranding: await developerMayUseBoardseshBranding(transaction, developerId),
        });
        const [developer] = await transaction
          .select({ email: users.email, emailVerified: users.emailVerified })
          .from(users)
          .where(eq(users.id, developerId))
          .for('share');
        const emailProof = developer && (await hasVerifiedPartnerDeveloperEmail(transaction, developerId));
        if (!developer || (options?.requireEmailProof ? !emailProof : !developer.emailVerified && !emailProof)) {
          throw new PartnerRegistrationError(
            'email_not_verified',
            'Verify your email address before you register an app.',
          );
        }
        const owned = await transaction.$count(oauthClient, eq(oauthClient.userId, developerId));
        if (owned >= PARTNER_APPS_PER_DEVELOPER) {
          throw new PartnerRegistrationError(
            'app_limit_reached',
            `An account can register at most ${PARTNER_APPS_PER_DEVELOPER} apps.`,
          );
        }

        const registered = await actAsDeveloper(developerId, () =>
          authority.api.adminCreateOAuthClient({
            headers: new Headers(),
            body: managedRegistrationBody(input, configuration),
          }),
        );
        const { row } = await assertManagedClient(
          transaction,
          developerId,
          registered.client_id,
          configuration.resource,
        );
        const [policy] = await transaction
          .insert(oauthAppPolicy)
          .values({
            clientId: row.clientId,
            ownerUserId: developerId,
            publisherName: input.publisherName,
            maxActiveConnections: PARTNER_LAUNCH_MAX_ACTIVE_CONNECTIONS,
            maxNewConnectionsPerDay: PARTNER_LAUNCH_MAX_NEW_CONNECTIONS_PER_DAY,
            // What the developer agreed to, and when: the terms are the basis for suspending an app.
            termsVersion: input.acceptedTermsVersion,
            termsAcceptedAt: new Date(),
          })
          .returning();
        const credentials: PartnerAppCredentials = {
          app: toRecord(row, policy, 0),
          clientSecret: registered.client_secret ?? null,
        };
        // Not gated: told instead, so a developer hears of an app someone else registered in their name.
        const registeredNotice: PendingNotice = {
          notice: {
            developerEmail: developer.email,
            appName: row.name ?? '',
            clientId: row.clientId,
            changedAt: new Date(),
            change: 'app_registered',
          },
          emailVerified: true,
        };
        return { credentials, notice: registeredNotice };
      });
      registeredOrigins.invalidate();
      notifyAfterCommit(created.notice);
      return created.credentials;
    },

    async updateApp(database, developerId, clientId, rawPatch, signIn) {
      const { updated, notice } = await inRegistrationTransaction(database, async (transaction) => {
        await lockDeveloper(transaction, developerId);
        const { row } = await requireOwnedApp(transaction, developerId, clientId);
        const patch = normalizePartnerAppPatch(rawPatch, row.applicationType === 'native' ? 'native' : 'web', {
          allowBoardseshBranding: await developerMayUseBoardseshBranding(transaction, developerId),
        });
        // Checked after the input, so a developer fixes the form before signing in again.
        const redirectChange = redirectUriChange(row.redirectUris, patch.redirectUris);
        const developer = redirectChange ? await requireRecentSignIn(transaction, developerId, signIn) : null;
        const now = new Date();
        // Written directly: the provider's update could also reach consent,
        // PKCE and the auth method, and none of those may ever change here.
        await transaction
          .update(oauthClient)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.homepageUrl !== undefined ? { uri: patch.homepageUrl } : {}),
            ...(patch.privacyPolicyUrl !== undefined ? { policy: patch.privacyPolicyUrl } : {}),
            ...(patch.redirectUris !== undefined ? { redirectUris: patch.redirectUris } : {}),
            updatedAt: now,
          })
          .where(and(eq(oauthClient.clientId, clientId), eq(oauthClient.userId, developerId)));
        // A redirect URI the app did not have is a new place codes can go. A
        // climber approved the app as it was, so every remembered consent goes
        // and each climber sees the consent screen again before the next code.
        // Tokens already issued keep working (neither the token endpoint nor
        // the API reads consent), and Connected apps lists their scopes instead.
        // Only a removal keeps consent: it opens nowhere new.
        if (patch.redirectUris?.some((uri) => !row.redirectUris.includes(uri))) {
          await transaction.delete(oauthConsent).where(eq(oauthConsent.clientId, clientId));
        }
        if (patch.publisherName !== undefined) {
          // An update, never an insert: an app without a policy row can gain no
          // connections, and an edit must not change that.
          await transaction
            .update(oauthAppPolicy)
            .set({ publisherName: patch.publisherName, updatedAt: now })
            .where(eq(oauthAppPolicy.clientId, clientId));
        }
        const current = await assertManagedClient(transaction, developerId, clientId, configuration.resource);
        const changed: PendingNotice | null =
          redirectChange && developer
            ? {
                notice: {
                  developerEmail: developer.email,
                  appName: current.row.name ?? '',
                  clientId,
                  changedAt: now,
                  change: 'redirect_uris_changed',
                  ...redirectChange,
                },
                emailVerified: developer.emailVerified,
              }
            : null;
        return {
          updated: toRecord(current.row, current.policy, await activeConnectionsOf(transaction, clientId)),
          notice: changed,
        };
      });
      registeredOrigins.invalidate();
      notifyAfterCommit(notice);
      return updated;
    },

    async rotateSecret(database, developerId, clientId, signIn) {
      const { rotated, notice } = await inRegistrationTransaction(database, async (transaction) => {
        await lockDeveloper(transaction, developerId);
        const { row, policy } = await requireOwnedApp(transaction, developerId, clientId);
        if (row.tokenEndpointAuthMethod === 'none') {
          throw new PartnerRegistrationError('no_secret', 'A public app has no client secret to rotate.');
        }
        const developer = await requireRecentSignIn(transaction, developerId, signIn);
        // The provider stores the new secret encrypted; the old one stops working at commit.
        const provided = await actAsDeveloper(developerId, () =>
          authority.api.rotateClientSecret({ headers: new Headers(), body: { client_id: clientId } }),
        );
        if (typeof provided.client_secret !== 'string' || provided.client_secret.length === 0) {
          throw new Error('Secret rotation returned no secret.');
        }
        const credentials: PartnerAppCredentials = {
          app: toRecord(row, policy, await activeConnectionsOf(transaction, clientId)),
          clientSecret: provided.client_secret,
        };
        const changed: PendingNotice = {
          notice: {
            developerEmail: developer.email,
            appName: row.name ?? '',
            clientId,
            changedAt: new Date(),
            change: 'secret_rotated',
          },
          emailVerified: developer.emailVerified,
        };
        return { rotated: credentials, notice: changed };
      });
      notifyAfterCommit(notice);
      return rotated;
    },

    async deleteApp(database, developerId, clientId, signIn) {
      const notice = await inRegistrationTransaction(database, async (transaction) => {
        await lockDeveloper(transaction, developerId);
        const found = await findOwnedApp(transaction, developerId, clientId);
        if (!found) return null;
        if (isSuspended(found.row, found.policy)) {
          throw new PartnerRegistrationError('suspended', 'This app is suspended, so it cannot be deleted.');
        }
        // Before the cascade's locks. This holds the developer's own `users` row
        // FOR SHARE, which never waits on the FOR SHARE the cascade takes below.
        const developer = await requireRecentSignIn(transaction, developerId, signIn);
        // Every climber row, consent screen and connection the cascade reaches,
        // in the partner lock order. Waits for any issuer holding one, and no
        // grant can then be added to a locked connection. The app row goes last,
        // so no lock on it is ever held while waiting for a connection an issuer holds.
        await lockAppForDeletion(transaction, clientId);
        // Pending codes have no foreign key: find them through their grants.
        const grants = await transaction
          .select({ authorizationCodeId: oauthGrants.authorizationCodeId })
          .from(oauthGrants)
          .innerJoin(oauthConnections, eq(oauthConnections.id, oauthGrants.connectionId))
          .where(eq(oauthConnections.clientId, clientId));
        if (grants.length > 0) {
          await transaction.delete(oauthVerification).where(
            inArray(
              oauthVerification.identifier,
              grants.map((grant) => grant.authorizationCodeId),
            ),
          );
        }
        // Cascades to tokens, consent, connections, grants, subjects, policy and resource links.
        await transaction
          .delete(oauthClient)
          .where(and(eq(oauthClient.clientId, clientId), eq(oauthClient.userId, developerId)));
        const changed: PendingNotice = {
          notice: {
            developerEmail: developer.email,
            appName: found.row.name ?? '',
            clientId,
            changedAt: new Date(),
            change: 'app_deleted',
          },
          emailVerified: developer.emailVerified,
        };
        return changed;
      });
      if (!notice) return false;
      registeredOrigins.invalidate();
      notifyAfterCommit(notice);
      return true;
    },
  };
}
