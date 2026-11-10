import type { BetterAuthOptions, DBAdapter } from 'better-auth';
import { getPostgresErrorCode } from '../../utils/postgres-errors';
import { recordPartnerRequestError } from './transaction';

/**
 * Better Auth must never write identity rows here: `users` belongs to NextAuth
 * and today's writers, `oauth_session` rows come from the consent bridge only,
 * and there is no `account` table. Listing both the model and its table name
 * covers every spelling the adapter accepts.
 */
const IDENTITY_MODELS = new Set(['user', 'users', 'session', 'oauthSession', 'account']);

const ADAPTER_WRITE_METHODS = [
  'create',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'consumeOne',
  'incrementOne',
] as const;

const ADAPTER_READ_METHODS = ['findOne', 'findMany', 'count'] as const;

/** Better Auth's names for the session model. Its rows come from the consent bridge only. */
const SESSION_MODELS = new Set(['session', 'oauthSession']);

/**
 * Better Auth finds a session by token only when a request presents its own
 * session cookie. This server never sets one: the climber is whoever the www
 * NextAuth cookie names, and the bridge hands Better Auth that session itself.
 * So a session is never found by token, and nothing but the bridge can sign
 * anyone in, even with a correctly signed Better Auth cookie. Rows are still
 * read by id, which is how a code or token names its session.
 */
function readsSessionByToken(args: AdapterArguments): boolean {
  if (!SESSION_MODELS.has(args.model) || !Array.isArray(args.where)) return false;
  return args.where.some(
    (clause: unknown) =>
      typeof clause === 'object' && clause !== null && (clause as { field?: unknown }).field === 'token',
  );
}

const NOTHING_FOUND: Record<(typeof ADAPTER_READ_METHODS)[number], unknown> = { findOne: null, findMany: [], count: 0 };

type AdapterMethod = (typeof ADAPTER_WRITE_METHODS)[number] | (typeof ADAPTER_READ_METHODS)[number];
type AdapterArguments = { model: string } & Record<string, unknown>;
type CallableAdapter = Record<AdapterMethod, (args: AdapterArguments) => Promise<unknown>>;

export class PartnerIdentityWriteError extends Error {
  constructor(model: string, method: string) {
    super(`Partner OAuth refused a ${method} on the ${model} model: identity rows are read-only here.`);
    this.name = 'PartnerIdentityWriteError';
  }
}

/** Keeps the database code and nothing else: a Drizzle error's message and cause carry the query parameters. */
export class PartnerDatabaseError extends Error {
  readonly code: string | undefined;

  constructor(code: string | undefined) {
    super(`Partner OAuth query failed (${code ?? 'unknown code'}).`);
    this.name = 'PartnerDatabaseError';
    this.code = code;
  }
}

function isFailedQuery(error: unknown): boolean {
  return error instanceof Error && 'query' in error && 'params' in error;
}

/**
 * Wraps every adapter method in place, so the adapter object keeps its identity
 * (Better Auth registers the schema check against it) and a transaction adapter
 * built from it inherits the guard. Query failures are sanitized here because
 * stock endpoints print `error.message` from their own catch blocks.
 */
export function guardPartnerAdapter<Options extends BetterAuthOptions>(
  createAdapter: (options: Options) => DBAdapter<Options>,
): (options: Options) => DBAdapter<Options> {
  return (options) => {
    const adapter = createAdapter(options);
    const callable = adapter as unknown as CallableAdapter;
    const writes: readonly AdapterMethod[] = ADAPTER_WRITE_METHODS;
    for (const method of [...ADAPTER_WRITE_METHODS, ...ADAPTER_READ_METHODS]) {
      const call = callable[method].bind(adapter);
      callable[method] = async (args) => {
        if (writes.includes(method) && IDENTITY_MODELS.has(args.model)) {
          throw new PartnerIdentityWriteError(args.model, method);
        }
        if (!writes.includes(method) && readsSessionByToken(args)) {
          return NOTHING_FOUND[method as (typeof ADAPTER_READ_METHODS)[number]];
        }
        try {
          return await call(args);
        } catch (error) {
          if (!isFailedQuery(error)) throw error;
          recordPartnerRequestError(error);
          throw new PartnerDatabaseError(getPostgresErrorCode(error));
        }
      };
    }
    return adapter;
  };
}
