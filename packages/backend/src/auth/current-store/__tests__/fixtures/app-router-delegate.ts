import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { NextAuthOptions } from '../../../../../../web/node_modules/next-auth';
import type { JWTEncodeParams } from '../../../../../../web/node_modules/next-auth/jwt';
import type { NextRequest } from '../../../../../../web/node_modules/next/server';
import type { Adapter } from '../../../../../../web/node_modules/next-auth/adapters';

type Provider = 'google' | 'apple' | 'facebook';
interface Outcome {
  attemptId: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    image: string | null;
    emailVerified: string | null;
    createdAt: string;
  };
  createdUser: boolean;
  sourceProof: string;
  sourceSid: string;
  generation: number;
  flow: string;
  originalAuthenticatedAt: number | null;
}
interface Intent {
  provider: Provider;
  flow: string;
  actorCookie: string | null;
  expires: number;
}
interface RequestContext {
  readonly attemptId: string;
  intent: Intent;
  actorCookie: string | null;
  outcome?: Outcome;
  failed: boolean;
  attempted: boolean;
  abortNeeded: boolean;
  encodedCookie?: string;
}
class AdmissionRejected extends Error {}
const digest = (input: string) => createHash('sha256').update(input).digest('hex');
const providerFor = (input: string): Provider | undefined =>
  ['google', 'apple', 'facebook'].includes(input) ? (input as Provider) : undefined;
const unavailable = () =>
  new Response('Owned fixture unavailable', { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
function cookie(request: NextRequest): string | null {
  const names = ['__Secure-next-auth.session-token', 'next-auth.session-token'];
  const entries: { name: string; content: string }[] = [];
  for (const rawPart of (request.headers.get('cookie') ?? '').split(';')) {
    const part = rawPart.trim();
    const separator = part.indexOf('=');
    const name = separator < 0 ? part : part.slice(0, separator).trim();
    if (!names.some((reservedName) => name.startsWith(reservedName))) continue;
    if (separator < 0) return 'invalid-bare-fixture-actor';
    entries.push({ name, content: part.slice(separator + 1).trim() });
  }
  if (!entries.length) return null;
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) return 'invalid-duplicate-fixture-actor';
  const presentNames = names.filter((name) => entries.some((entry) => entry.name.startsWith(name)));
  if (presentNames.length !== 1) return 'invalid-ambiguous-fixture-actor';
  const base = presentNames[0];
  if (
    entries.some((entry) => !entry.content || (entry.name !== base && !/^\.\d+$/.test(entry.name.slice(base.length))))
  )
    return 'invalid-fixture-actor';
  if (entries.some((entry) => entry.name === base))
    return entries.length === 1 ? decodeURIComponent(entries[0].content) : 'invalid-mixed-fixture-actor';
  entries.sort(
    (first, second) => Number(first.name.slice(base.length + 1)) - Number(second.name.slice(base.length + 1)),
  );
  if (entries.some((entry, index) => entry.name !== `${base}.${index}`)) return 'invalid-chunked-fixture-actor';
  return decodeURIComponent(entries.map((entry) => entry.content).join(''));
}

/** Explicit fixture-only replacement; no production route imports this helper. */
export function installAppRouterFixtureDelegate(options: {
  authOptions: NextAuthOptions;
  backend: { origin: string; secret: string };
  fetch: typeof fetch;
  encode(parameters: JWTEncodeParams): Promise<string>;
  faults?: { failEvent?: boolean; failEncode?: boolean };
  beforeEncode?: () => Promise<void>;
}) {
  const backend = new URL(options.backend.origin);
  if (
    backend.protocol !== 'http:' ||
    backend.hostname !== '127.0.0.1' ||
    !backend.port ||
    backend.pathname !== '/' ||
    backend.search ||
    backend.hash ||
    backend.username ||
    backend.password
  )
    throw new Error('Unowned compound backend');
  const credential = options.backend.secret;
  const contexts = new AsyncLocalStorage<RequestContext>();
  const intents = new Map<string, Intent>();
  const continuations = new Map<string, { url: string; expires: number }>();
  const facts = {
    deniedMutations: [] as string[],
    stockIsNewUser: [] as boolean[],
    abortAcknowledged: [] as boolean[],
    compounds: 0,
  };
  async function rpc(path: '/intent' | '/compound' | '/abort' | '/validate', command: object): Promise<unknown> {
    const response = await options.fetch(`${backend.origin}${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) throw new AdmissionRejected('Owned admission rejected');
      throw new Error('Owned compound unavailable');
    }
    const body = await response.text();
    if (body.length > 32768) throw new Error('Owned compound reply limit');
    return JSON.parse(body) as unknown;
  }
  async function validateIssued(context: RequestContext, encoded: string) {
    const result = (await rpc('/validate', { actorCookie: encoded })) as {
      valid?: unknown;
      userId?: unknown;
      sourceSid?: unknown;
    };
    if (
      !context.outcome ||
      result.valid !== true ||
      result.userId !== context.outcome.user.id ||
      result.sourceSid !== context.outcome.sourceSid
    )
      throw new Error('Owned issuance no longer valid');
  }
  async function abort(context: RequestContext) {
    try {
      await rpc(
        '/abort',
        context.outcome
          ? { sourceProof: context.outcome.sourceProof }
          : {
              provider: context.intent.provider,
              flow: context.intent.flow,
              actorCookie: context.intent.actorCookie,
              attemptId: context.attemptId,
            },
      );
      facts.abortAcknowledged.push(true);
    } catch {
      facts.abortAcknowledged.push(false);
    }
  }
  const originalJwt = options.authOptions.callbacks?.jwt;
  const originalAdapter = options.authOptions.adapter;
  if (!originalAdapter) throw new Error('Missing actual configured adapter');
  const deny = (name: string): never => {
    facts.deniedMutations.push(name);
    throw new Error('Fixture adapter mutations denied');
  };
  const adapter: Adapter = {
    ...originalAdapter,
    async createUser() {
      return deny('createUser');
    },
    async updateUser() {
      return deny('updateUser');
    },
    async deleteUser() {
      return deny('deleteUser');
    },
    async linkAccount() {
      return deny('linkAccount');
    },
    async unlinkAccount() {
      return deny('unlinkAccount');
    },
    async createSession() {
      return deny('createSession');
    },
    async updateSession() {
      return deny('updateSession');
    },
    async deleteSession() {
      return deny('deleteSession');
    },
    async createVerificationToken() {
      return deny('createVerificationToken');
    },
    async useVerificationToken() {
      return deny('useVerificationToken');
    },
  };
  options.authOptions.adapter = adapter;
  options.authOptions.callbacks = {
    ...options.authOptions.callbacks,
    async signIn(parameters) {
      const current = contexts.getStore();
      const account = parameters.account;
      if (
        !current ||
        !account ||
        account.provider !== current.intent.provider ||
        typeof account.providerAccountId !== 'string'
      )
        return false;
      const profile = parameters.profile as Record<string, unknown> | undefined;
      current.attempted = true;
      try {
        facts.compounds += 1;
        const received = (await rpc('/compound', {
          provider: account.provider,
          subject: account.providerAccountId,
          flow: current.intent.flow,
          actorCookie: current.actorCookie,
          attemptId: current.attemptId,
          ...(typeof profile?.email === 'string' ? { email: profile.email } : {}),
          ...(typeof profile?.name === 'string' ? { name: profile.name } : {}),
          ...(typeof parameters.user.image === 'string' ? { image: parameters.user.image } : {}),
        })) as Outcome;
        if (
          !received ||
          typeof received.user?.id !== 'string' ||
          typeof received.sourceProof !== 'string' ||
          typeof received.sourceSid !== 'string' ||
          received.flow !== current.intent.flow ||
          received.attemptId !== current.attemptId ||
          typeof received.createdUser !== 'boolean'
        )
          throw new Error('Malformed fixture compound');
        current.outcome = received;
        return true;
      } catch (error) {
        current.failed = true;
        current.abortNeeded = !(error instanceof AdmissionRejected);
        return false;
      }
    },
    async jwt(parameters) {
      const token = originalJwt ? await originalJwt(parameters) : parameters.token;
      const current = contexts.getStore();
      if (!current?.outcome || !parameters.user) return token;
      const outcome = current.outcome;
      if (parameters.user.id !== outcome.user.id) {
        current.failed = true;
        throw new Error('Fixture owner mismatch');
      }
      facts.stockIsNewUser.push(parameters.isNewUser ?? false);
      token.authSessionId = outcome.sourceSid;
      token.sourceProof = outcome.sourceProof;
      token.originalAuthenticatedAt = outcome.originalAuthenticatedAt;
      token.accountCreated = outcome.createdUser;
      if (parameters.account?.provider === 'google' || parameters.account?.provider === 'apple')
        token.nativeOAuthCreationProof = {
          authSessionId: outcome.sourceSid,
          provider: parameters.account.provider,
          signedInAt: Date.now(),
          accountCreation: {
            userId: outcome.user.id,
            accountCreated: outcome.createdUser,
            provider: parameters.account.provider,
            createdAt: outcome.user.createdAt,
          },
        };
      return token;
    },
  };
  options.authOptions.events = {
    async createUser() {
      return deny('events.createUser');
    },
    async linkAccount() {
      return deny('events.linkAccount');
    },
    async signIn() {
      if (options.faults?.failEvent) {
        const current = contexts.getStore();
        if (current) current.failed = true;
        throw new Error('Owned late event failure');
      }
    },
  };
  options.authOptions.jwt = {
    ...options.authOptions.jwt,
    async encode(parameters) {
      const current = contexts.getStore();
      try {
        if (current?.outcome) await options.beforeEncode?.();
        if (current?.outcome && options.faults?.failEncode) {
          const cyclic: Record<string, unknown> = {};
          cyclic.self = cyclic;
          return await options.encode({ ...parameters, token: { ...parameters.token, syntheticCyclicFault: cyclic } });
        }
        const encoded = await options.encode(parameters);
        if (current?.outcome) {
          await validateIssued(current, encoded);
          current.encodedCookie = encoded;
        }
        return encoded;
      } catch {
        if (current) current.failed = true;
        throw new Error('Owned encoder failure');
      }
    },
  };
  return {
    facts,
    async normalize(request: NextRequest, construct: typeof NextRequest): Promise<NextRequest | Response> {
      if (request.nextUrl.pathname.startsWith('/__proof/continue/')) {
        const key = request.nextUrl.pathname.slice('/__proof/continue/'.length);
        const held = continuations.get(key);
        if (request.method !== 'GET' || !held || held.expires <= Date.now()) return unavailable();
        continuations.delete(key);
        return new construct(held.url, { method: 'GET', headers: request.headers });
      }
      if (request.method === 'POST' && request.nextUrl.pathname === '/api/auth/callback/apple') {
        const form = new URLSearchParams(await request.clone().text());
        const states = form.getAll('state');
        if (states.length !== 1 || !intents.has(digest(`apple\0${states[0]}`))) return unavailable();
        const heldUrl = new URL('/api/auth/callback/apple', request.url);
        heldUrl.search = form.toString();
        const key = randomUUID();
        continuations.set(key, { url: heldUrl.href, expires: Date.now() + 60000 });
        return new Response(null, {
          status: 303,
          headers: {
            Location: new URL(`/__proof/continue/${key}`, request.url).href,
            'Cache-Control': 'private, no-store',
          },
        });
      }
      return request;
    },
    async run(request: NextRequest, operation: () => Promise<Response>): Promise<Response> {
      const [, , , action, rawProvider] = request.nextUrl.pathname.split('/');
      const provider = providerFor(rawProvider ?? '');
      if (action === 'signin' && provider && request.method === 'POST') {
        const response = await operation();
        const location = response.headers.get('Location');
        const state = location ? new URL(location).searchParams.get('state') : null;
        if (!state) return response;
        const intent: Intent = {
          provider,
          flow: digest(`${provider}\0${state}`),
          actorCookie: cookie(request),
          expires: Date.now() + 15 * 60 * 1000,
        };
        try {
          await rpc('/intent', { provider, flow: intent.flow, actorCookie: intent.actorCookie });
          intents.set(intent.flow, intent);
          return response;
        } catch {
          return unavailable();
        }
      }
      if (action !== 'callback' || !provider) return operation();
      const states = request.nextUrl.searchParams.getAll('state');
      if (states.length !== 1) return unavailable();
      const intent = intents.get(digest(`${provider}\0${states[0]}`));
      if (!intent || intent.expires <= Date.now()) return unavailable();
      const context: RequestContext = {
        attemptId: randomUUID(),
        intent,
        actorCookie: cookie(request),
        failed: false,
        attempted: false,
        abortNeeded: false,
      };
      return contexts.run(context, async () => {
        let response: Response;
        try {
          response = await operation();
        } catch {
          context.failed = true;
          response = unavailable();
        }
        const location = response.headers.get('Location');
        if (
          context.outcome &&
          (!response.headers.getSetCookie().some((header) => header.startsWith('__Secure-next-auth.session-token')) ||
            response.status >= 400 ||
            (location && new URL(location, request.url).searchParams.has('error')))
        )
          context.failed = true;
        if (context.failed) {
          if (context.outcome || (context.attempted && context.abortNeeded)) await abort(context);
          return unavailable();
        }
        if (context.outcome && context.encodedCookie) {
          try {
            await validateIssued(context, context.encodedCookie);
          } catch {
            await abort(context);
            return unavailable();
          }
        }
        return response;
      });
    },
  };
}
