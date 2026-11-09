import type { BetterAuthOptions, DBAdapter } from 'better-auth';

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

type AdapterWriteMethod = (typeof ADAPTER_WRITE_METHODS)[number];
type AdapterWriteArguments = { model: string } & Record<string, unknown>;
type WritableAdapter = Record<AdapterWriteMethod, (args: AdapterWriteArguments) => Promise<unknown>>;

export class PartnerIdentityWriteError extends Error {
  constructor(model: string, method: string) {
    super(`Partner OAuth refused a ${method} on the ${model} model: identity rows are read-only here.`);
    this.name = 'PartnerIdentityWriteError';
  }
}

/**
 * Wraps every write method in place, so the adapter object keeps its identity
 * (Better Auth registers the schema check against it) and a transaction adapter
 * built from it inherits the guard.
 */
export function guardPartnerAdapter<Options extends BetterAuthOptions>(
  createAdapter: (options: Options) => DBAdapter<Options>,
): (options: Options) => DBAdapter<Options> {
  return (options) => {
    const adapter = createAdapter(options);
    const writable = adapter as unknown as WritableAdapter;
    for (const method of ADAPTER_WRITE_METHODS) {
      const write = writable[method].bind(adapter);
      writable[method] = async (args) => {
        if (IDENTITY_MODELS.has(args.model)) throw new PartnerIdentityWriteError(args.model, method);
        return write(args);
      };
    }
    return adapter;
  };
}
