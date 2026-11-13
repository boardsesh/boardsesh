import type { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import {
  browserBackendSessionKey,
  readBrowserBackendSessionScope,
} from '@boardsesh/auth-protocol/browser-backend-session';
import { sameBrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';
import type { UserProfile } from '@/app/profile/[user_id]/utils/profile-constants';
import {
  BROWSER_PROFILE_RESPONSE_MAX_BYTES,
  BrowserProfileAuthorityError,
  ProfileNotFoundError,
  browserProfileResponseSchema,
} from './browser-profile-response';

type AuthorityClient = Pick<
  ReturnType<typeof createBrowserBackendClient>,
  'getSnapshot' | 'isSessionCurrent' | 'retire'
>;

async function readBoundedBody(response: Response, signal: AbortSignal, assertCurrent: () => void): Promise<unknown> {
  if (!response.body) {
    let removeAbortListener = () => {};
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new BrowserProfileAuthorityError('unavailable'));
        signal.addEventListener('abort', abort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
      });
      const contents: unknown = await Promise.race([response.json(), cancelled]);
      assertCurrent();
      if (
        signal.aborted ||
        new TextEncoder().encode(JSON.stringify(contents)).byteLength > BROWSER_PROFILE_RESPONSE_MAX_BYTES
      )
        throw new BrowserProfileAuthorityError('unavailable');
      return contents;
    } finally {
      removeAbortListener();
    }
  }
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let contents = '';
    while (true) {
      assertCurrent();
      if (signal.aborted) throw new BrowserProfileAuthorityError('unavailable');
      const chunk = await reader.read();
      assertCurrent();
      if (signal.aborted) throw new BrowserProfileAuthorityError('unavailable');
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > BROWSER_PROFILE_RESPONSE_MAX_BYTES) throw new BrowserProfileAuthorityError('unavailable');
      contents += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(contents + decoder.decode());
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Capture the actual accepted Session object and revision before dispatch.
 * A response's public owner cannot mint this process-local receipt. */
export async function readSelectedBrowserProfile(input: {
  readonly userId: string;
  readonly session: unknown;
  readonly client: AuthorityClient;
  readonly fetch: typeof fetch;
  readonly signal?: AbortSignal;
  readonly onDenied?: () => void;
}): Promise<UserProfile> {
  try {
    const userId = input.userId;
    const session = input.session;
    const client = input.client;
    const fetchProfile = input.fetch;
    const suppliedSignal = input.signal;
    const onDenied = input.onDenied;
    const revision = client.getSnapshot().revision;
    const observed = readBrowserBackendSessionScope(session);
    if (observed.status !== 'selected' && observed.status !== 'anonymous')
      throw new BrowserProfileAuthorityError('superseded');
    const owner = observed.status === 'selected' ? observed.owner : null;
    const ownerKey = owner === null ? null : browserBackendSessionKey(owner);
    const assertCurrent = () => {
      if (!client.isSessionCurrent(session) || client.getSnapshot().revision !== revision)
        throw new BrowserProfileAuthorityError('superseded');
      const current = readBrowserBackendSessionScope(session);
      if (
        ownerKey === null
          ? current.status !== 'anonymous'
          : current.status !== 'selected' || browserBackendSessionKey(current.owner) !== ownerKey
      )
        throw new BrowserProfileAuthorityError('superseded');
    };
    const retireCaptured = (): never => {
      assertCurrent();
      client.retire();
      try {
        onDenied?.();
      } catch {
        // A refresh hint cannot revive or publish the retired request.
      }
      throw new BrowserProfileAuthorityError('superseded');
    };
    assertCurrent();
    const deadline = AbortSignal.timeout(15_000);
    const signal = suppliedSignal ? AbortSignal.any([suppliedSignal, deadline]) : deadline;
    if (signal.aborted) throw new BrowserProfileAuthorityError('unavailable');
    const response = await fetchProfile(`/api/internal/profile/${encodeURIComponent(userId)}`, {
      credentials: 'include',
      cache: 'no-store',
      signal,
    });
    assertCurrent();
    if (signal.aborted) throw new BrowserProfileAuthorityError('unavailable');
    if (response.status === 401 || response.status === 409) {
      // Retire only the exact still-current request. This never acknowledges
      // anonymity or alters the browser's credential cookies.
      return retireCaptured();
    }
    if (response.status === 404) throw new ProfileNotFoundError();
    if (!response.ok) throw new BrowserProfileAuthorityError('unavailable');
    const parsed = browserProfileResponseSchema.safeParse(await readBoundedBody(response, signal, assertCurrent));
    assertCurrent();
    if (!parsed.success) throw new BrowserProfileAuthorityError('unavailable');
    const profile = parsed.data;
    if (
      profile.profile.id !== userId ||
      (owner === null
        ? profile.owner !== null
        : profile.owner === null || !sameBrowserBackendLeaseOwner(owner, profile.owner))
    )
      return retireCaptured();
    if (
      (profile.profile.email !== undefined && owner?.userId !== userId) ||
      (owner === null && (profile.profile.credentials?.length ?? 0) > 0)
    )
      throw new BrowserProfileAuthorityError('unavailable');
    return profile.profile;
  } catch (error) {
    if (error instanceof BrowserProfileAuthorityError || error instanceof ProfileNotFoundError) throw error;
    throw new BrowserProfileAuthorityError('unavailable');
  }
}
