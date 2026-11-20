import { DEVICE_TOKEN_LIFETIME_SECONDS } from '@boardsesh/auth-protocol/device-token';
import { isSecureCookieContext } from './secure-cookies';

/**
 * The browser half of device recognition (#7656): the cookie that will carry a
 * device token minted on sign-in and reset completion. NextAuth publishes it
 * beside the admitted login; the password counter verifies it before a compare.
 *
 * Host-only and HttpOnly: page scripts never see it and no other host shares
 * it. Over https it takes the `__Host-` prefix, which the browser only accepts
 * with Secure, Path=/ and no Domain, so a sibling subdomain cannot plant one.
 */
export const SECURE_DEVICE_TOKEN_COOKIE_NAME = '__Host-boardsesh.device';
export const PLAIN_DEVICE_TOKEN_COOKIE_NAME = 'boardsesh.device';

export interface DeviceTokenCookieAttributes {
  readonly name: string;
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: 'lax';
  readonly path: '/';
  /** Seconds, the token's own 400-day life. */
  readonly maxAge: number;
}

export function deviceTokenCookieName(secure: boolean = isSecureCookieContext()): string {
  return secure ? SECURE_DEVICE_TOKEN_COOKIE_NAME : PLAIN_DEVICE_TOKEN_COOKIE_NAME;
}

/**
 * Everything a `Set-Cookie` for the device token needs except its value. Lax,
 * so the cookie rides the top-level sign-in POST and OAuth callbacks but no
 * cross-site subresource.
 */
export function deviceTokenCookieAttributes(secure: boolean = isSecureCookieContext()): DeviceTokenCookieAttributes {
  return Object.freeze({
    name: deviceTokenCookieName(secure),
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: DEVICE_TOKEN_LIFETIME_SECONDS,
  });
}
