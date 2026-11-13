import 'server-only';
import { sameBrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';
import { browserConsumerFacade, publicBrowserLeaseOwner } from './browser-consumers.server';
import { getProfileData } from '@/app/profile/[user_id]/server-profile-data';
import { BROWSER_PROFILE_RESPONSE_MAX_BYTES, browserProfileResponseSchema } from './browser-profile-response';

const headers = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json; charset=utf-8' };
function refusal(status: string): Response {
  return Response.json(
    { error: status === 'unavailable' ? 'unavailable' : 'identity_changed' },
    { status: status === 'unavailable' ? 503 : status === 'conflict' ? 409 : 401, headers },
  );
}

/** Only a genuine legacy observation delegates to the unchanged flat endpoint.
 * Every selected reply is buffered and re-admitted before any profile bytes. */
export function createSelectedProfileResponse(
  dependencies: {
    readonly authority?: Pick<typeof browserConsumerFacade, 'observe' | 'lease'>;
    readonly readProfile?: typeof getProfileData;
  } = {},
) {
  const authority = dependencies.authority ?? browserConsumerFacade;
  const readProfile = dependencies.readProfile ?? getProfileData;
  return async (cookieHeader: string | null, userId: string): Promise<Response | null> => {
    try {
      const before = await authority.observe(cookieHeader);
      if (before.status === 'legacy') return null;
      if (before.status !== 'admitted' && before.status !== 'anonymous') return refusal(before.status);
      const owner = before.status === 'admitted' ? publicBrowserLeaseOwner(before) : null;
      let profile: Awaited<ReturnType<typeof getProfileData>>;
      if (before.status === 'admitted') {
        const lease = await authority.lease(before);
        if (lease.status !== 'admitted') return refusal(lease.status);
        if (owner === null || !sameBrowserBackendLeaseOwner(lease.owner, owner)) return refusal('conflict');
        profile = await readProfile(userId, before.session.userId, { authToken: lease.token });
      } else {
        profile = await readProfile(userId, undefined, { authToken: undefined, publicOnly: true });
      }
      if (
        profile !== null &&
        (profile.id !== userId ||
          (profile.email !== undefined && owner?.userId !== userId) ||
          (owner === null && (profile.credentials?.length ?? 0) > 0))
      )
        return refusal('unavailable');
      const contents =
        profile === null
          ? JSON.stringify({ error: 'profile_not_found' })
          : JSON.stringify(browserProfileResponseSchema.parse({ browserProfileVersion: 1, owner, profile }));
      if (Buffer.byteLength(contents, 'utf8') > BROWSER_PROFILE_RESPONSE_MAX_BYTES) return refusal('unavailable');
      const after = await authority.observe(cookieHeader);
      if (after.status === 'unavailable') return refusal('unavailable');
      if (before.status === 'admitted') {
        if (after.status !== 'admitted') return refusal(after.status);
        if (
          owner === null ||
          !sameBrowserBackendLeaseOwner(owner, publicBrowserLeaseOwner(after)) ||
          before.actor.credential.kind !== after.actor.credential.kind
        )
          return refusal('conflict');
      } else if (
        after.status !== 'anonymous' ||
        before.cursor.bindingId !== after.cursor.bindingId ||
        before.cursor.version !== after.cursor.version
      ) {
        return refusal('conflict');
      }
      return new Response(contents, { status: profile === null ? 404 : 200, headers });
    } catch {
      return refusal('unavailable');
    }
  };
}

export const selectedProfileResponse = createSelectedProfileResponse();
