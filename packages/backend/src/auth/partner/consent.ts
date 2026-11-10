import { createHash } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware } from 'better-auth/api';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { PARTNER_CONSENT_ERRORS } from '@boardsesh/auth-protocol/partner-oauth';
import { oauthAppPolicy, oauthClient, oauthConnections, oauthConsentInteractions } from '@boardsesh/db/schema/auth';
import type { PartnerAuthorityConfiguration } from './configuration';
import { authorizeRedirectTarget } from './fence';
import { resolveFirstPartySession } from './first-party-session';
import { lockClimber, selectConnectionForUpdate } from './locks';
import type { PartnerDatabase } from './tables';
import { currentPartnerTransaction } from './transaction';

export const CONSENT_DETAILS_PATH = '/oauth2/consent-details';

/** The routes where a signed-in climber matters. Token and revoke authenticate the app, never a browser. */
const SESSION_PATHS: ReadonlySet<string> = new Set(['/oauth2/authorize', '/oauth2/consent', CONSENT_DETAILS_PATH]);
const CONSENT_PATHS: ReadonlySet<string> = new Set(['/oauth2/consent', CONSENT_DETAILS_PATH]);

/** Decision 21: these scopes include ticks the climber keeps to "only me", and the consent screen says so. */
const SCOPES_WITH_ONLY_ME_TICKS: ReadonlySet<string> = new Set(['logbook:read']);

export interface PartnerConsentScope {
  scope: string;
  /** True when approving lets the app read ticks the climber shares with no one. */
  includesOnlyMeTicks: boolean;
}

/** What the consent screen shows. Facts only: the www page words them in the climber's language. */
export interface PartnerConsentDetails {
  client: {
    clientId: string;
    name: string | null;
    homepageUrl: string | null;
    privacyPolicyUrl: string | null;
    termsUrl: string | null;
    /**
     * "Made by": the publisher the developer named at registration
     * (`oauth_app_policy.publisher_name`), or null for an app registered before
     * publishers were recorded. Never the developer's account name: that can be
     * their full name from Google, and anyone signed in can open this screen.
     */
    publisherName: string | null;
    /** Where the browser goes after Allow: a host, or a native app's scheme. */
    redirectHost: string | null;
  };
  scopes: PartnerConsentScope[];
  /** The climber disconnected this app before; approving connects it again. */
  reconnect: boolean;
  /** Always false until apps can be reviewed. The screen says "Boardsesh hasn't reviewed this app". */
  reviewed: false;
  expiresAt: string;
}

export function describeConsentScopes(scopes: readonly string[]): PartnerConsentScope[] {
  return scopes.map((scope) => ({ scope, includesOnlyMeTicks: SCOPES_WITH_ONLY_ME_TICKS.has(scope) }));
}

/** The key of a consent link. Its signature covers every parameter, `exp` and the issue time, so no two links share one. */
export function consentInteractionDigest(signature: string): string {
  return createHash('sha256').update(`partner-consent-interaction-v1:${signature}`).digest('hex');
}

function redirectHost(redirectUri: string | null): string | null {
  if (!redirectUri || !URL.canParse(redirectUri)) return null;
  const url = new URL(redirectUri);
  return url.host || url.protocol.replace(/:$/, '') || null;
}

function promptTokens(prompt: string): string[] {
  return prompt
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);
}

type BridgedSession = { session: { id: string; userId: string }; user: { id: string } };

function bridgedSession(candidate: unknown): BridgedSession | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const { session, user } = candidate as { session?: { id?: unknown; userId?: unknown }; user?: { id?: unknown } };
  if (typeof session?.id !== 'string' || typeof user?.id !== 'string' || session.userId !== user.id) return null;
  return candidate as BridgedSession;
}

/** The app a consent link names. The link is signed, so this is the app that asked. */
function signedClientId(oauthQuery: unknown): string | null {
  return typeof oauthQuery === 'string' ? new URLSearchParams(oauthQuery).get('client_id') : null;
}

/** Whether nobody may connect this app now: suspended (`disabled`), or gone. */
async function appSuspended(transaction: PartnerDatabase, clientId: string): Promise<boolean> {
  const [client] = await transaction
    .select({ disabled: oauthClient.disabled })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId));
  return !client || client.disabled === true;
}

type InteractionCheck =
  | { status: 'open'; generation: number; reconnect: boolean; expiresAt: Date; query: URLSearchParams }
  | { status: 'invalid' };

/**
 * Finds the stored consent link this request presents and checks it still
 * belongs to this climber, this login, this app and this connection generation.
 * With `spend`, the link is locked and used up in the same transaction, so a
 * second approval, a second climber, or an approval after Disconnect finds
 * nothing to approve. Lock order: `users` FOR SHARE, the link, the connection.
 */
async function checkConsentInteraction(
  transaction: PartnerDatabase,
  oauthQuery: unknown,
  climber: BridgedSession,
  { spend }: { spend: boolean },
): Promise<InteractionCheck> {
  if (typeof oauthQuery !== 'string') return { status: 'invalid' };
  const query = new URLSearchParams(oauthQuery);
  const signatures = query.getAll('sig');
  const clientId = query.get('client_id');
  if (signatures.length !== 1 || !signatures[0] || !clientId) return { status: 'invalid' };
  const userId = climber.user.id;
  if (spend && !(await lockClimber(transaction, userId))) return { status: 'invalid' };

  const digest = consentInteractionDigest(signatures[0]);
  const lookup = transaction.select().from(oauthConsentInteractions).where(eq(oauthConsentInteractions.digest, digest));
  const [interaction] = spend ? await lookup.for('update') : await lookup;
  const now = new Date();
  if (
    !interaction ||
    interaction.consumedAt !== null ||
    interaction.expiresAt <= now ||
    interaction.userId !== userId ||
    interaction.authSessionId !== climber.session.id ||
    interaction.clientId !== clientId
  ) {
    return { status: 'invalid' };
  }

  const connection = spend
    ? await selectConnectionForUpdate(transaction, userId, clientId)
    : (
        await transaction
          .select()
          .from(oauthConnections)
          .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.clientId, clientId)))
      )[0];
  // A first-time consent has no row yet: the fence creates it with the code.
  const generation = connection?.generation ?? 0;
  if (generation !== interaction.connectionGeneration) return { status: 'invalid' };

  if (spend) {
    await transaction
      .update(oauthConsentInteractions)
      .set({ consumedAt: now })
      .where(eq(oauthConsentInteractions.digest, digest));
  }
  return {
    status: 'open',
    generation,
    reconnect: connection?.revokedAt != null,
    expiresAt: interaction.expiresAt,
    query,
  };
}

/**
 * Turns the www NextAuth session cookie into the session Better Auth reads.
 * There is no other way in: no Better Auth sign-in route is served, and no new
 * cookie is ever set, so every authorize and consent request re-reads the
 * cookie, and a sign-out or account switch on www applies at once.
 */
export function partnerSessionBridge(configuration: PartnerAuthorityConfiguration): BetterAuthPlugin {
  return {
    id: 'boardsesh-partner-session-bridge',
    hooks: {
      before: [
        {
          matcher: (context) => SESSION_PATHS.has(context.path ?? ''),
          handler: createAuthMiddleware(async (context) => {
            // Consent re-enters authorize with the session this request already bridged.
            if (context.context.session) return;
            const outcome = await resolveFirstPartySession(
              context.request?.headers.get('cookie') ?? context.headers?.get('cookie') ?? null,
              configuration.nextAuthSecret,
              () => currentPartnerTransaction().transaction,
            );
            if (outcome.status !== 'signed-in') return;
            context.context.session = {
              session: outcome.session,
              user: outcome.user,
            } as unknown as NonNullable<typeof context.context.session>;
          }),
        },
      ],
    },
  };
}

interface ConsentRefusal {
  status: 401 | 403 | 400;
  body: { error: string; error_description: string };
}

const API_ERROR_STATUS = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN' } as const;

/** An endpoint's `json` ignores its status outside a Response, so an endpoint refuses by throwing. */
function refusalError({ status, body }: ConsentRefusal): APIError {
  return new APIError(API_ERROR_STATUS[status], body, { 'cache-control': 'no-store' });
}

// The `error` codes are PARTNER_CONSENT_ERRORS, which the www consent pages switch on.
const LOGIN_REQUIRED: ConsentRefusal = {
  status: 401,
  body: { error: PARTNER_CONSENT_ERRORS.loginRequired, error_description: 'Sign in to Boardsesh again to continue.' },
};
const CROSS_SITE: ConsentRefusal = {
  status: 403,
  body: {
    error: PARTNER_CONSENT_ERRORS.crossSite,
    error_description: 'Consent is answered only from the Boardsesh website.',
  },
};
const LINK_SPENT: ConsentRefusal = {
  status: 400,
  body: { error: PARTNER_CONSENT_ERRORS.linkSpent, error_description: 'This consent link is no longer valid.' },
};
const APP_SUSPENDED: ConsentRefusal = {
  status: 403,
  body: { error: PARTNER_CONSENT_ERRORS.appSuspended, error_description: 'This app cannot be connected.' },
};
const NO_STORE = { 'cache-control': 'no-store' };

/**
 * The consent backend. Every consent link the provider signs is stored as an
 * `oauth_consent_interactions` row, bound to the climber, their login, the app
 * and the connection generation. The consent post must present a row that is
 * still open, and spends it. Both consent routes accept only the exact www
 * origin, whatever cookies say, because SameSite=Lax lets every *.boardsesh.com
 * subdomain send the session cookie.
 */
export function partnerConsentGuard(
  configuration: PartnerAuthorityConfiguration,
  { consentPage }: { consentPage: string },
): BetterAuthPlugin {
  const consentLinkPrefix = `${consentPage}?`;

  return {
    id: 'boardsesh-partner-consent',
    endpoints: {
      partnerConsentDetails: createAuthEndpoint(
        CONSENT_DETAILS_PATH,
        { method: 'POST', body: z.object({ oauth_query: z.string() }) },
        async (context) => {
          const climber = bridgedSession(context.context.session);
          if (!climber) throw refusalError(LOGIN_REQUIRED);
          const { transaction } = currentPartnerTransaction();
          const linkClientId = signedClientId(context.body.oauth_query);
          if (linkClientId && (await appSuspended(transaction, linkClientId))) throw refusalError(APP_SUSPENDED);
          const interaction = await checkConsentInteraction(transaction, context.body.oauth_query, climber, {
            spend: false,
          });
          if (interaction.status !== 'open') throw refusalError(LINK_SPENT);
          const clientId = interaction.query.get('client_id') ?? '';
          // The app's own published fields only: nothing about the account that registered it.
          const [client] = await transaction
            .select({
              clientId: oauthClient.clientId,
              name: oauthClient.name,
              uri: oauthClient.uri,
              policy: oauthClient.policy,
              tos: oauthClient.tos,
              disabled: oauthClient.disabled,
              publisherName: oauthAppPolicy.publisherName,
            })
            .from(oauthClient)
            .leftJoin(oauthAppPolicy, eq(oauthAppPolicy.clientId, oauthClient.clientId))
            .where(eq(oauthClient.clientId, clientId));
          if (!client || client.disabled) throw refusalError(APP_SUSPENDED);
          const details: PartnerConsentDetails = {
            client: {
              clientId: client.clientId,
              name: client.name,
              homepageUrl: client.uri,
              privacyPolicyUrl: client.policy,
              termsUrl: client.tos,
              publisherName: client.publisherName,
              redirectHost: redirectHost(interaction.query.get('redirect_uri')),
            },
            scopes: describeConsentScopes(promptTokens(interaction.query.get('scope') ?? '')),
            reconnect: interaction.reconnect,
            reviewed: false,
            expiresAt: interaction.expiresAt.toISOString(),
          };
          context.setHeader('cache-control', 'no-store');
          return context.json(details);
        },
      ),
    },
    hooks: {
      before: [
        // Stock prompt=login wants a Better Auth sign-in, which this server never
        // performs, so it would send the climber to sign in forever. Decision 19
        // is the sign-in rule here instead: the bridge yields a session only for
        // a sign-in under 30 days old, so an older one is sent to sign in anyway.
        {
          matcher: (context) => context.path === '/oauth2/authorize',
          handler: createAuthMiddleware(async (context) => {
            const source = context.method === 'POST' ? 'body' : 'query';
            const parameters: Record<string, unknown> | undefined = context[source];
            if (!parameters || typeof parameters.prompt !== 'string') return;
            const prompts = promptTokens(parameters.prompt);
            // prompt=none with anything else is refused by the provider; keep it refused.
            if (!prompts.includes('login') || prompts.includes('none')) return;
            const remaining = prompts.filter((token) => token !== 'login');
            // In place: a hook's returned context is merged, so it cannot remove a key.
            if (remaining.length > 0) parameters.prompt = remaining.join(' ');
            else delete parameters.prompt;
          }),
        },
        {
          matcher: (context) => CONSENT_PATHS.has(context.path ?? ''),
          handler: createAuthMiddleware(async (context) => {
            const origin = context.request?.headers.get('origin') ?? context.headers?.get('origin');
            const refusal =
              origin !== configuration.webOrigin
                ? CROSS_SITE
                : bridgedSession(context.context.session)
                  ? null
                  : LOGIN_REQUIRED;
            if (refusal) return context.json(refusal.body, { status: refusal.status, headers: NO_STORE });
            // The details endpoint checks its link itself and spends nothing.
            if (context.path !== '/oauth2/consent') return;
            const climber = bridgedSession(context.context.session);
            if (!climber)
              return context.json(LOGIN_REQUIRED.body, { status: LOGIN_REQUIRED.status, headers: NO_STORE });
            const { transaction, state } = currentPartnerTransaction();
            // A suspended app answers as such, and spends nothing: the link may
            // work again if the app is reinstated before it expires.
            const linkClientId = signedClientId(context.body?.oauth_query);
            if (linkClientId && (await appSuspended(transaction, linkClientId))) {
              return context.json(APP_SUSPENDED.body, { status: APP_SUSPENDED.status, headers: NO_STORE });
            }
            const interaction = await checkConsentInteraction(transaction, context.body?.oauth_query, climber, {
              spend: true,
            });
            if (interaction.status !== 'open') {
              return context.json(LINK_SPENT.body, { status: LINK_SPENT.status, headers: NO_STORE });
            }
            state.consent = { approved: context.body?.accept === true, generation: interaction.generation };
          }),
        },
      ],
      after: [
        // The provider sent a signed-in climber to the consent screen: store that link.
        {
          matcher: (context) => context.path === '/oauth2/authorize',
          handler: createAuthMiddleware(async (context) => {
            const climber = bridgedSession(context.context.session);
            if (!climber) return;
            const target = authorizeRedirectTarget(context);
            if (!target?.startsWith(consentLinkPrefix)) return;
            const signed = new URL(target).searchParams;
            const signature = signed.get('sig');
            const clientId = signed.get('client_id');
            const expiresAtSeconds = Number(signed.get('exp'));
            if (!signature || !clientId || !Number.isSafeInteger(expiresAtSeconds)) {
              throw new Error('Consent link is missing its signed fields.');
            }
            const { transaction } = currentPartnerTransaction();
            // FOR SHARE before the insert: a foreign-key check alone does not wait
            // for a password reset, which would then miss this row.
            if (!(await lockClimber(transaction, climber.user.id))) {
              throw new Error('Consent link issued for a missing account.');
            }
            const connection = await selectConnectionForUpdate(transaction, climber.user.id, clientId);
            await transaction.insert(oauthConsentInteractions).values({
              digest: consentInteractionDigest(signature),
              userId: climber.user.id,
              authSessionId: climber.session.id,
              clientId,
              connectionGeneration: connection?.generation ?? 0,
              expiresAt: new Date(expiresAtSeconds * 1000),
            });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
