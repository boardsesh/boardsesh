import { describe, expect, it } from 'vitest';
import { buildNativeOAuthSignInUrl } from '../social-login-buttons';

describe('buildNativeOAuthSignInUrl', () => {
  it('builds a provider sign-in URL with native callback route', () => {
    const url = buildNativeOAuthSignInUrl({
      origin: 'https://boardsesh.com',
      provider: 'google',
      callbackPath: '/settings',
    });

    expect(url).toBe(
      'https://boardsesh.com/api/auth/signin/google?callbackUrl=https%3A%2F%2Fboardsesh.com%2Fapi%2Fauth%2Fnative%2Fcallback%3Fnext%3D%252Fsettings',
    );
  });

  it('normalizes non-relative callback path values', () => {
    const url = buildNativeOAuthSignInUrl({
      origin: 'https://boardsesh.com',
      provider: 'apple',
      callbackPath: 'https://example.com/evil',
    });

    expect(url).toContain('next%3D%252F');
  });
});

