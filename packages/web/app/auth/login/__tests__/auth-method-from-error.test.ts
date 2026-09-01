import { describe, expect, it } from 'vite-plus/test';
import { authMethodFromError, safeAuthError } from '../auth-error-classification';

describe('authMethodFromError', () => {
  it('classifies CredentialsSignin as credentials, not oauth', () => {
    expect(authMethodFromError('CredentialsSignin')).toBe('credentials');
  });

  it('classifies OAuth-shaped error codes as oauth', () => {
    expect(authMethodFromError('OAuthSignin')).toBe('oauth');
    expect(authMethodFromError('OAuthCallback')).toBe('oauth');
    expect(authMethodFromError('OAuthCreateAccount')).toBe('oauth');
    expect(authMethodFromError('OAuthEmailRequired')).toBe('oauth');
    expect(authMethodFromError('OAuthAccountNotLinked')).toBe('oauth');
  });

  it('defaults unknown / null / empty inputs to oauth (the broader bucket)', () => {
    expect(authMethodFromError(null)).toBe('oauth');
    expect(authMethodFromError(undefined)).toBe('oauth');
    expect(authMethodFromError('')).toBe('oauth');
    expect(authMethodFromError('AccessDenied')).toBe('oauth');
  });
});

describe('safeAuthError', () => {
  it('passes through known NextAuth error codes verbatim', () => {
    expect(safeAuthError('CredentialsSignin')).toBe('CredentialsSignin');
    expect(safeAuthError('OAuthCallback')).toBe('OAuthCallback');
    expect(safeAuthError('OAuthEmailRequired')).toBe('OAuthEmailRequired');
    expect(safeAuthError('AccessDenied')).toBe('AccessDenied');
  });

  it('buckets attacker-supplied or unknown strings to "unknown"', () => {
    expect(safeAuthError('some+arbitrary+string')).toBe('unknown');
    expect(safeAuthError('<script>alert(1)</script>')).toBe('unknown');
    expect(safeAuthError('OAuthSignin; DROP TABLE users')).toBe('unknown');
  });

  it('treats null / undefined / empty as "unknown"', () => {
    expect(safeAuthError(null)).toBe('unknown');
    expect(safeAuthError(undefined)).toBe('unknown');
    expect(safeAuthError('')).toBe('unknown');
  });
});
