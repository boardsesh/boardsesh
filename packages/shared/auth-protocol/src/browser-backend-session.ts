import { browserBackendLeaseOwnerSchema, type BrowserBackendLeaseOwner } from './browser-backend-lease';

export type BrowserBackendSessionScope =
  | { readonly status: 'selected'; readonly owner: Readonly<BrowserBackendLeaseOwner> }
  | { readonly status: 'anonymous' | 'legacy' | 'invalid' };

/** Only a successful central session response can establish this public scope.
 * It is correlation metadata, never proof of source-credential possession. */
export function readBrowserBackendSessionScope(input: unknown): BrowserBackendSessionScope {
  if (input === null) return { status: 'anonymous' };
  if (typeof input !== 'object' || Array.isArray(input)) return { status: 'invalid' };
  const session = input as Record<string, unknown>;
  if (!('browserSelection' in session)) return { status: Object.keys(session).length === 0 ? 'anonymous' : 'legacy' };
  const parsed = browserBackendLeaseOwnerSchema.safeParse(session.browserSelection);
  const user = session.user;
  if (
    !parsed.success ||
    typeof user !== 'object' ||
    user === null ||
    Array.isArray(user) ||
    !('id' in user) ||
    user.id !== parsed.data.userId ||
    session.authSessionId !== parsed.data.authSessionId ||
    session.authGeneration !== parsed.data.generation ||
    typeof session.expires !== 'string' ||
    !Number.isFinite(Date.parse(session.expires))
  )
    return { status: 'invalid' };
  return {
    status: 'selected',
    owner: Object.freeze({ ...parsed.data, cursor: Object.freeze(parsed.data.cursor) }),
  };
}

/** A metadata-only cache/remount scope. Never include a bearer or private
 * binding lease/deadline in a cache key, React key or broadcast message. */
export function browserBackendSessionKey(owner: BrowserBackendLeaseOwner): string {
  const captured = browserBackendLeaseOwnerSchema.parse(owner);
  return JSON.stringify([
    captured.userId,
    captured.authSessionId,
    captured.generation,
    captured.cursor.bindingId,
    captured.cursor.version,
  ]);
}
