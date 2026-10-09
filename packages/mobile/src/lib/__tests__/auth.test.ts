import { describe, expect, it } from 'vitest';
import {
  classifyNativeAuthFailureReason,
  isAppleSignInCancellation,
  isRecoverableAndroidGoogleSignInError,
  nativeSignInErrorCode,
} from '../native-auth-analytics';

describe('classifyNativeAuthFailureReason', () => {
  it('maps native credential and OAuth failures to low-cardinality analytics reasons', () => {
    expect(classifyNativeAuthFailureReason({ success: false, status: null, error: 'network' }, 'credentials')).toBe(
      'network',
    );
    expect(
      classifyNativeAuthFailureReason(
        { success: false, status: 400, error: 'email and password are required' },
        'credentials',
      ),
    ).toBe('invalid_request');
    expect(
      classifyNativeAuthFailureReason({ success: false, status: 429, error: 'Rate limit exceeded' }, 'oauth'),
    ).toBe('rate_limited');
    expect(
      classifyNativeAuthFailureReason(
        { success: false, status: 503, error: 'Service temporarily overloaded' },
        'oauth',
      ),
    ).toBe('service_unavailable');
    expect(
      classifyNativeAuthFailureReason({ success: false, status: 500, error: 'Internal server error' }, 'oauth'),
    ).toBe('server_error');
    expect(classifyNativeAuthFailureReason({ success: false, status: 418, error: 'teapot' }, 'oauth')).toBe(
      'http_error',
    );
  });

  // The web-OAuth fallback's in-app browser failing to present (iOS 26) returns
  // { error: 'browser_unavailable', status: null }. It must classify off the
  // sentinel string, not fall through to 'http_error' — a null status would
  // otherwise land in the final bucket.
  it('classifies a browser-unavailable web-fallback failure by its sentinel error, not its null status', () => {
    expect(
      classifyNativeAuthFailureReason({ success: false, status: null, error: 'browser_unavailable' }, 'oauth'),
    ).toBe('browser_unavailable');
  });

  it('keeps an exhausted Android browser race distinct from browser presentation failures', () => {
    expect(classifyNativeAuthFailureReason({ success: false, status: null, error: 'browser_timeout' }, 'oauth')).toBe(
      'browser_timeout',
    );
  });

  // Regression: the classifier used to string-match the 401 body against
  // 'Invalid credentials', but the backend says 'Invalid email or password' —
  // every real wrong-password attempt was mislabelled. Classify by endpoint.
  it('classifies a 401 by which endpoint failed, not by server copy', () => {
    expect(
      classifyNativeAuthFailureReason(
        { success: false, status: 401, error: 'Invalid email or password' },
        'credentials',
      ),
    ).toBe('invalid_credentials');
    expect(
      classifyNativeAuthFailureReason(
        { success: false, status: 401, error: 'Invalid or expired identity token' },
        'oauth',
      ),
    ).toBe('invalid_oauth_token');
    // Even an unexpected body keeps the right bucket for its endpoint.
    expect(classifyNativeAuthFailureReason({ success: false, status: 401, error: 'Unauthorized' }, 'credentials')).toBe(
      'invalid_credentials',
    );
    expect(classifyNativeAuthFailureReason({ success: false, status: 401, error: 'Unauthorized' }, 'oauth')).toBe(
      'invalid_oauth_token',
    );
  });
});

describe('nativeSignInErrorCode', () => {
  it('returns the string `.code` from a thrown native CodedError', () => {
    // The most important one: a signing-SHA-1 / OAuth-client mismatch on Android.
    expect(nativeSignInErrorCode({ code: 'DEVELOPER_ERROR', message: 'opaque' })).toBe('DEVELOPER_ERROR');
    expect(nativeSignInErrorCode({ code: 'SIGN_IN_CANCELLED' })).toBe('SIGN_IN_CANCELLED');
  });

  it('stringifies a numeric `.code` (older google-signin uses numeric status codes)', () => {
    expect(nativeSignInErrorCode({ code: 10 })).toBe('10');
    expect(nativeSignInErrorCode({ code: 0 })).toBe('0');
  });

  it('returns undefined when there is no usable code, so the caller falls back to the message', () => {
    expect(nativeSignInErrorCode(new Error('boom'))).toBeUndefined();
    expect(nativeSignInErrorCode({ code: null })).toBeUndefined();
    expect(nativeSignInErrorCode({ code: { nested: true } })).toBeUndefined();
    expect(nativeSignInErrorCode(undefined)).toBeUndefined();
    expect(nativeSignInErrorCode(null)).toBeUndefined();
    expect(nativeSignInErrorCode('DEVELOPER_ERROR')).toBeUndefined();
  });
});

describe('isRecoverableAndroidGoogleSignInError', () => {
  // GMS surfaces DEVELOPER_ERROR / INTERNAL_ERROR inconsistently across builds:
  // a numeric `.code`, a string `.code`, or no code with the name only in the
  // message. All three must recover (the browser fallback bypasses the native SDK).
  it('recovers the config-class codes in every representation GMS throws', () => {
    expect(isRecoverableAndroidGoogleSignInError(Object.assign(new Error('x'), { code: 'DEVELOPER_ERROR' }))).toBe(
      true,
    );
    expect(isRecoverableAndroidGoogleSignInError(Object.assign(new Error('x'), { code: 'INTERNAL_ERROR' }))).toBe(true);
    expect(isRecoverableAndroidGoogleSignInError(Object.assign(new Error('x'), { code: 10 }))).toBe(true);
    expect(isRecoverableAndroidGoogleSignInError(Object.assign(new Error('x'), { code: 8 }))).toBe(true);
    // No usable code — the name is only in the message (observed on builds 350+).
    expect(
      isRecoverableAndroidGoogleSignInError(new Error('DEVELOPER_ERROR: Follow troubleshooting instructions at ...')),
    ).toBe(true);
    expect(isRecoverableAndroidGoogleSignInError(new Error('INTERNAL_ERROR'))).toBe(true);
  });

  // Strict scope: everything else surfaces its native error rather than bouncing
  // into a browser — transient network, Play Services gaps, cancels, unknown.
  it('does not recover non-config failures', () => {
    expect(isRecoverableAndroidGoogleSignInError(Object.assign(new Error('network'), { code: 7 }))).toBe(false);
    expect(isRecoverableAndroidGoogleSignInError(Object.assign(new Error('no play services'), { code: 2 }))).toBe(
      false,
    );
    expect(
      isRecoverableAndroidGoogleSignInError(Object.assign(new Error('cancelled'), { code: 'SIGN_IN_CANCELLED' })),
    ).toBe(false);
    expect(isRecoverableAndroidGoogleSignInError(new Error('some other failure'))).toBe(false);
    expect(isRecoverableAndroidGoogleSignInError(undefined)).toBe(false);
    expect(isRecoverableAndroidGoogleSignInError(null)).toBe(false);
    expect(isRecoverableAndroidGoogleSignInError('DEVELOPER_ERROR')).toBe(false);
  });
});

describe('isAppleSignInCancellation', () => {
  it('treats the coded cancel and the message-only cancel as the same intent', () => {
    expect(isAppleSignInCancellation({ code: 'ERR_REQUEST_CANCELED' })).toBe(true);
    // Some builds reject with no usable `.code` — 49 events / 44 users in 30
    // days reached the sign-in hook's outer catch this way and bounced the
    // climber into the browser OAuth fallback (#3088).
    expect(isAppleSignInCancellation(new Error('The user canceled the authorization attempt'))).toBe(true);
    expect(isAppleSignInCancellation(new Error('The user cancelled the authorization attempt'))).toBe(true);
  });

  it('keeps real Apple failures classified as failures', () => {
    expect(isAppleSignInCancellation(new Error('The authorization attempt failed for an unknown reason'))).toBe(false);
    expect(isAppleSignInCancellation({ code: 'ERR_REQUEST_UNKNOWN' })).toBe(false);
    expect(isAppleSignInCancellation(new Error('The user canceled a different thing entirely'))).toBe(false);
  });

  it('handles non-object throws without blowing up', () => {
    expect(isAppleSignInCancellation(null)).toBe(false);
    expect(isAppleSignInCancellation(undefined)).toBe(false);
    expect(isAppleSignInCancellation('The user canceled the authorization attempt')).toBe(false);
  });
});
