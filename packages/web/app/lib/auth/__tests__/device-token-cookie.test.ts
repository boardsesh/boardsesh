import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deviceTokenCookieAttributes,
  deviceTokenCookieName,
  PLAIN_DEVICE_TOKEN_COOKIE_NAME,
  SECURE_DEVICE_TOKEN_COOKIE_NAME,
} from '../device-token-cookie';

const FOUR_HUNDRED_DAYS_IN_SECONDS = 400 * 24 * 60 * 60;

describe('device token cookie (#7656)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the __Host- name over https, which the browser only accepts host-only, Secure and at Path=/', () => {
    expect(deviceTokenCookieAttributes(true)).toEqual({
      name: SECURE_DEVICE_TOKEN_COOKIE_NAME,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: FOUR_HUNDRED_DAYS_IN_SECONDS,
    });
    expect(SECURE_DEVICE_TOKEN_COOKIE_NAME.startsWith('__Host-')).toBe(true);
    expect(deviceTokenCookieAttributes(true)).not.toHaveProperty('domain');
  });

  it('drops the prefix over plain http, where a __Host- cookie cannot be set', () => {
    expect(deviceTokenCookieAttributes(false)).toMatchObject({
      name: PLAIN_DEVICE_TOKEN_COOKIE_NAME,
      httpOnly: true,
      secure: false,
    });
    expect(PLAIN_DEVICE_TOKEN_COOKIE_NAME.startsWith('__')).toBe(false);
  });

  it('follows the session cookie secure context by default', () => {
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
    expect(deviceTokenCookieName()).toBe(SECURE_DEVICE_TOKEN_COOKIE_NAME);
    expect(deviceTokenCookieAttributes().secure).toBe(true);
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    expect(deviceTokenCookieName()).toBe(PLAIN_DEVICE_TOKEN_COOKIE_NAME);
    expect(deviceTokenCookieAttributes().secure).toBe(false);
  });
});
