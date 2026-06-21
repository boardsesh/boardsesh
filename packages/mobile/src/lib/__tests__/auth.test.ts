import { describe, expect, it } from 'vitest';
import { classifyNativeAuthFailureReason, nativeSignInErrorCode } from '../native-auth-analytics';

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
