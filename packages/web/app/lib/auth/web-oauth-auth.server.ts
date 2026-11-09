import 'server-only';
import type { NextAuthOptions } from 'next-auth';
import type { Adapter, AdapterUser } from 'next-auth/adapters';
import { decode, encode } from 'next-auth/jwt';
import type { WebOAuthProvider, WebOAuthResolveDenialCode, WebOAuthResolveReply } from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { createWebOAuthCommandClient, type WebOAuthCommandClient } from './web-oauth-command-client.server';

type ResolvedIdentity = Extract<WebOAuthResolveReply, { outcome: 'resolved' }>;
/** Denials the climber can act on. Every other code stays NextAuth's generic AccessDenied. */
const ACTIONABLE_DENIAL_REDIRECTS: Partial<Record<WebOAuthResolveDenialCode, string>> = {
  email_conflict: '/auth/error?error=OAuthAccountNotLinked',
  email_required: '/auth/error?error=OAuthEmailRequired',
};
export interface WebOAuthRequestBinding {
  provider: WebOAuthProvider;
  flow: string;
  actorCookie: string | null;
}

export function createWebOAuthLogger(onError: () => void = () => {}): NonNullable<NextAuthOptions['logger']> {
  return {
    error() {
      onError();
      console.warn(JSON.stringify({ event: 'web_oauth_identity_error', phase: 'framework' }));
    },
    warn() {
      console.warn(JSON.stringify({ event: 'web_oauth_identity_warning', phase: 'framework' }));
    },
    debug() {},
  };
}

function adapterUser(identity: ResolvedIdentity): AdapterUser {
  const { id, email, name, image, emailVerified } = identity.user;
  return { id, email, name, image, emailVerified: emailVerified === null ? null : new Date(emailVerified) };
}

function issuedSession(response: Response, name: string): string | null {
  const entries: { name: string; content: string }[] = [];
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const separator = pair.indexOf('=');
    const cookieName = pair.slice(0, separator);
    if (separator < 0 || (cookieName !== name && !cookieName.startsWith(`${name}.`))) continue;
    const content = pair.slice(separator + 1);
    if (!content || /;\s*Max-Age=0(?:;|$)/i.test(header)) continue;
    entries.push({ name: cookieName, content });
  }
  if (entries.length === 0 || new Set(entries.map((entry) => entry.name)).size !== entries.length) return null;
  if (entries.some((entry) => entry.name === name))
    return entries.length === 1 ? decodeURIComponent(entries[0].content) : null;
  entries.sort(
    (first, second) => Number(first.name.slice(name.length + 1)) - Number(second.name.slice(name.length + 1)),
  );
  if (entries.some((entry, index) => entry.name !== `${name}.${index}`)) return null;
  return decodeURIComponent(entries.map((entry) => entry.content).join(''));
}

/** Request-local identity verdict; this creates no backend session or fresh-age proof. */
export function createWebOAuthIdentityAuthRequest(
  base: NextAuthOptions,
  binding: WebOAuthRequestBinding,
  clientFactory: () => WebOAuthCommandClient = createWebOAuthCommandClient,
) {
  const { provider, flow, actorCookie } = binding;
  let outcome: ResolvedIdentity | undefined;
  let unavailable = false;
  let encoded: string | undefined;
  const rejectUnavailable = (): never => {
    unavailable = true;
    throw new AuthBackendUnavailableError();
  };
  if (!base.adapter || base.session?.strategy !== 'jwt') return rejectUnavailable();
  const denyMutation = (): never => rejectUnavailable();
  const adapter: Adapter = {
    ...base.adapter,
    async getUserByAccount(account) {
      if (account.provider !== provider) return rejectUnavailable();
      // Prevent stock email/account heuristics before the compound command.
      if (!outcome) return null;
      if (account.providerAccountId !== outcome.account.providerAccountId) return rejectUnavailable();
      return adapterUser(outcome);
    },
    async getUser(userId) {
      if (!outcome || userId !== outcome.user.id) return rejectUnavailable();
      return adapterUser(outcome);
    },
    async getUserByEmail() {
      return rejectUnavailable();
    },
    async getSessionAndUser() {
      return rejectUnavailable();
    },
    async createUser() {
      return denyMutation();
    },
    async updateUser() {
      return denyMutation();
    },
    async deleteUser() {
      return denyMutation();
    },
    async linkAccount() {
      return denyMutation();
    },
    async unlinkAccount() {
      return denyMutation();
    },
    async createSession() {
      return denyMutation();
    },
    async updateSession() {
      return denyMutation();
    },
    async deleteSession() {
      return denyMutation();
    },
    async createVerificationToken() {
      return denyMutation();
    },
    async useVerificationToken() {
      return denyMutation();
    },
  };
  const options: NextAuthOptions = {
    ...base,
    adapter,
    providers: base.providers.map((configured) => {
      if (configured.type !== 'oauth' || (configured.options?.id ?? configured.id) !== provider) return configured;
      return {
        ...configured,
        allowDangerousEmailAccountLinking: false,
        options: configured.options ? { ...configured.options, allowDangerousEmailAccountLinking: false } : undefined,
      };
    }),
    debug: false,
    logger: createWebOAuthLogger(() => {
      if (outcome) unavailable = true;
    }),
    callbacks: {
      ...base.callbacks,
      async signIn(parameters) {
        const account = parameters.account;
        if (!account || account.type !== 'oauth' || account.provider !== provider || !account.providerAccountId)
          return rejectUnavailable();
        try {
          const reply = await clientFactory().resolve({
            provider,
            flow,
            actorCookie,
            subject: account.providerAccountId,
            email: parameters.user.email ?? null,
            name: parameters.user.name ?? null,
            image: parameters.user.image ?? null,
          });
          if (reply.outcome === 'denied') return ACTIONABLE_DENIAL_REDIRECTS[reply.code] ?? false;
          outcome = reply;
          return true;
        } catch {
          return rejectUnavailable();
        }
      },
      async jwt(parameters) {
        try {
          if (!outcome || parameters.user?.id !== outcome.user.id) return rejectUnavailable();
          const token = base.callbacks?.jwt ? await base.callbacks.jwt(parameters) : parameters.token;
          if (token.sub !== outcome.user.id || typeof token.authSessionId !== 'string' || !token.authSessionId)
            return rejectUnavailable();
          // Stock sees the compound-created account as an existing row. Keep
          // the installed client's creation receipt accurate without changing SID.
          if (provider === 'apple' || provider === 'google') {
            token.nativeOAuthCreationProof = {
              authSessionId: token.authSessionId,
              provider,
              signedInAt: Date.now(),
              accountCreation: {
                userId: outcome.user.id,
                accountCreated: outcome.createdUser,
                provider,
                createdAt: outcome.user.createdAt,
              },
            };
          }
          return token;
        } catch {
          return rejectUnavailable();
        }
      },
    },
    events: {
      ...base.events,
      async createUser() {
        return denyMutation();
      },
      async updateUser() {
        return denyMutation();
      },
      async linkAccount() {
        return denyMutation();
      },
      async session() {
        return denyMutation();
      },
      async signIn(parameters) {
        try {
          if (!outcome || parameters.user.id !== outcome.user.id) return rejectUnavailable();
          await base.events?.signIn?.({ ...parameters, isNewUser: outcome.createdUser });
        } catch {
          return rejectUnavailable();
        }
      },
    },
    jwt: {
      ...base.jwt,
      async encode(parameters) {
        try {
          if (!outcome) return rejectUnavailable();
          const result = await (base.jwt?.encode ?? encode)(parameters);
          const claims = await (base.jwt?.decode ?? decode)({
            token: result,
            secret: parameters.secret,
            salt: parameters.salt,
          });
          if (claims?.sub !== outcome.user.id || typeof claims.authSessionId !== 'string' || !claims.authSessionId)
            return rejectUnavailable();
          encoded = result;
          return result;
        } catch {
          return rejectUnavailable();
        }
      },
    },
  };
  return {
    options,
    unavailable: () => unavailable,
    resolved: () => outcome !== undefined,
    publicationMatches(response: Response): boolean {
      try {
        if (!outcome || unavailable || !encoded || response.status >= 400) return false;
        const location = response.headers.get('Location');
        if (location && new URL(location, 'https://auth.invalid').searchParams.has('error')) return false;
        const cookieName = options.cookies?.sessionToken?.name;
        return !!cookieName && issuedSession(response, cookieName) === encoded;
      } catch {
        return false;
      }
    },
  };
}
