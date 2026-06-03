import { describe, expect, it } from 'vitest';
import { KilterApiError, isTransientKilterError } from './errors';

describe('isTransientKilterError', () => {
  it('treats invalid_grant as permanent (user must re-auth)', () => {
    expect(isTransientKilterError(new KilterApiError('invalid_grant', 'refresh expired'))).toBe(false);
  });

  it('treats invalid_client as transient (operator OAuth-client misconfig, not per-user)', () => {
    // invalid_client is the same for every credential the daemon walks —
    // it means KILTER_OAUTH_CLIENT_ID/SECRET are wrong. Treating it
    // permanent would mass-flip every user to syncStatus = 'error', so we
    // retry instead. invalid_grant stays the per-user "must re-auth" signal.
    expect(isTransientKilterError(new KilterApiError('invalid_client', 'bad client id'))).toBe(true);
  });

  it('treats unauthorized as transient (transient 401 → next cycle re-fetches token)', () => {
    // Reversed from the original "permanent" semantics: a single 401
    // during a Keycloak realm reload should not permanently disable
    // the credential. invalid_grant remains the terminal "must
    // re-auth" signal.
    expect(isTransientKilterError(new KilterApiError('unauthorized', 'JWT bad'))).toBe(true);
  });

  it('treats unknown as permanent', () => {
    expect(isTransientKilterError(new KilterApiError('unknown', 'who knows'))).toBe(false);
  });

  it('treats rate_limited as transient', () => {
    expect(isTransientKilterError(new KilterApiError('rate_limited', '429'))).toBe(true);
  });

  it('treats network as transient', () => {
    expect(isTransientKilterError(new KilterApiError('network', 'connection refused'))).toBe(true);
  });

  it('treats timeout as transient', () => {
    expect(isTransientKilterError(new KilterApiError('timeout', 'request timeout'))).toBe(true);
  });

  it('treats powersync as transient', () => {
    expect(isTransientKilterError(new KilterApiError('powersync', 'stream busted'))).toBe(true);
  });

  it('treats http 500 as transient', () => {
    expect(isTransientKilterError(new KilterApiError('http', '500 server error', 500))).toBe(true);
  });

  it('treats http 503 as transient', () => {
    expect(isTransientKilterError(new KilterApiError('http', '503 unavailable', 503))).toBe(true);
  });

  it('treats http 400 as permanent', () => {
    expect(isTransientKilterError(new KilterApiError('http', '400 bad request', 400))).toBe(false);
  });

  it('treats http 401 as permanent', () => {
    expect(isTransientKilterError(new KilterApiError('http', '401 unauthorized', 401))).toBe(false);
  });

  it('treats http 403 as permanent', () => {
    expect(isTransientKilterError(new KilterApiError('http', '403 forbidden', 403))).toBe(false);
  });

  it('treats http 404 as permanent', () => {
    expect(isTransientKilterError(new KilterApiError('http', '404 not found', 404))).toBe(false);
  });

  it('treats http with no httpStatus as permanent (httpStatus undefined → false)', () => {
    expect(isTransientKilterError(new KilterApiError('http', '???'))).toBe(false);
  });

  it('fails open to transient for a raw Error (non-KilterApiError)', () => {
    expect(isTransientKilterError(new Error('something else broke'))).toBe(true);
  });

  it('fails open to transient for a thrown string', () => {
    expect(isTransientKilterError('boom')).toBe(true);
  });

  it('fails open to transient for a thrown number', () => {
    expect(isTransientKilterError(42)).toBe(true);
  });

  it('fails open to transient for null/undefined', () => {
    expect(isTransientKilterError(null)).toBe(true);
    expect(isTransientKilterError(undefined)).toBe(true);
  });
});
