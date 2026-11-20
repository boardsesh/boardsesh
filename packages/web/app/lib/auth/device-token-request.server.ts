import 'server-only';
import type { createPasswordCommandAuthRequest } from './password-command-auth.server';
type WebAuthOptions = Parameters<typeof createPasswordCommandAuthRequest>[0];
import { viewerMarkerCookieName } from '@boardsesh/auth-protocol/viewer-marker';
import { mintDeviceToken, readDeviceTokenSecret } from '@boardsesh/auth-protocol/device-token';
import { deviceTokenCookieAttributes } from './device-token-cookie';
import { responseSetsSessionCookie } from './secure-cookies';

export function appendDeviceTokenCookie(response: Response, token: string): Response {
  const attributes = deviceTokenCookieAttributes();
  const cookie = `${attributes.name}=${token}; Path=/; Max-Age=${attributes.maxAge}; HttpOnly; SameSite=Lax${attributes.secure ? '; Secure' : ''}`;
  const originalCookies = response.headers.getSetCookie();
  const markerPrefix = `${viewerMarkerCookieName(attributes.secure)}=`;
  response.headers.delete('Set-Cookie');
  let inserted = false;
  for (const originalCookie of originalCookies) {
    // The account-switch marker remains the last publication signal. This
    // reads response names only, never the marker presented by a browser.
    if (!inserted && originalCookie.startsWith(markerPrefix)) {
      response.headers.append('Set-Cookie', cookie);
      inserted = true;
    }
    response.headers.append('Set-Cookie', originalCookie);
  }
  if (!inserted) response.headers.append('Set-Cookie', cookie);
  return response;
}

/** One response-local token, never a JWT/session claim or mutable shared option. */
export function createDeviceTokenAuthRequest(
  base: WebAuthOptions,
  published: (response: Response) => boolean = () => true,
) {
  const secret = readDeviceTokenSecret(process.env);
  let deviceToken: string | undefined;
  if (!('secret' in secret)) return { options: base, decorate: (response: Response) => response };
  const options: WebAuthOptions = {
    ...base,
    callbacks: {
      ...base.callbacks,
      async jwt(parameters) {
        const token = (await base.callbacks?.jwt?.(parameters)) ?? parameters.token;
        // A session read/update has no user; only a completed sign-in seeds a device.
        if (
          parameters.user?.id &&
          ['credentials', 'google', 'apple', 'native-oauth'].includes(parameters.account?.provider ?? '')
        ) {
          try {
            deviceToken = (await mintDeviceToken({ userId: parameters.user.id, secret: secret.secret })).token;
          } catch {
            // Recognition is auxiliary; a failed mint must not fail a proved login.
          }
        }
        return token;
      },
    },
  };
  return {
    options,
    decorate(response: Response) {
      // Admission may have refused the JWT after the callback. Seed only when
      // its final response actually publishes a login cookie.
      return deviceToken && responseSetsSessionCookie(response) && published(response)
        ? appendDeviceTokenCookie(response, deviceToken)
        : response;
    },
  };
}
