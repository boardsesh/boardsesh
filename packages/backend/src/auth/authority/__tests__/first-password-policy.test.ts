import { describe, expect, it } from 'vite-plus/test';
import {
  captureFirstPasswordRuntime,
  equalFirstPasswordDigest,
  firstPasswordDeadline,
  firstPasswordEmailBinding,
  isFirstPasswordInventory,
} from '../first-password-policy';

const runtime = captureFirstPasswordRuntime({
  qualification: { expectedProjectionId: 'owned-projection', expectedNormalizerVersion: 'lower-v1' },
  legacySecret: undefined,
  emailBindingKey: 'owned-first-password-private-rpc-key-6975',
});
const authority = {
  projectionId: 'owned-projection',
  normalizerVersion: 'lower-v1',
  authority: 'better-auth' as const,
  epoch: 1,
};
const apple = { userId: 'owned-user', provider: 'apple', subject: 'owned-apple-subject', generation: 0 };

describe('first-password confirmation policy', () => {
  it('captures backend runtime primitives without requiring a JWE key for canonical actors', () => {
    const original = {
      qualification: { expectedProjectionId: 'original', expectedNormalizerVersion: 'lower-v1' },
      legacySecret: undefined,
      emailBindingKey: 'original-private-rpc-secret-at-least-32-bytes',
    };
    const captured = captureFirstPasswordRuntime(original);
    original.qualification.expectedProjectionId = 'changed';
    original.emailBindingKey = 'changed-private-rpc-secret-at-least-32-bytes';
    expect(captured.qualification.expectedProjectionId).toBe('original');
    expect(captured.emailBindingKey).toBe('original-private-rpc-secret-at-least-32-bytes');
    expect(captured.legacySecret).toBeUndefined();
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.qualification)).toBe(true);
    expect(() => captureFirstPasswordRuntime({ ...original, emailBindingKey: 'short' })).toThrow(
      'FIRST_PASSWORD_AUTHORITY_UNAVAILABLE',
    );
  });

  it('binds normalized current email to the purpose, projection, normalizer and fixed UID', () => {
    const digest = firstPasswordEmailBinding(runtime, authority, 'owned-user', ' Mixed@Example.Test ');
    // Independent Python hmac/JSON known-answer vector pins the fixed purpose
    // and unambiguous complete frame as well as its variable identity fields.
    expect(digest).toBe('df1fdcf614234c792c851d43e21e4835430ecbeb9a11efdd733ea05cdbbd1579');
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(firstPasswordEmailBinding(runtime, authority, 'owned-user', 'mixed@example.test')).toBe(digest);
    expect(firstPasswordEmailBinding(runtime, authority, 'other-user', 'mixed@example.test')).not.toBe(digest);
    expect(
      firstPasswordEmailBinding(runtime, { ...authority, projectionId: 'other' }, 'owned-user', 'mixed@example.test'),
    ).not.toBe(digest);
    expect(
      firstPasswordEmailBinding(
        runtime,
        { ...authority, normalizerVersion: 'other' },
        'owned-user',
        'mixed@example.test',
      ),
    ).not.toBe(digest);
    expect(firstPasswordEmailBinding(runtime, authority, 'owned-user', 'changed@example.test')).not.toBe(digest);
    expect(
      firstPasswordEmailBinding(
        { ...runtime, emailBindingKey: 'rotated-private-rpc-secret-at-least-32-bytes' },
        authority,
        'owned-user',
        'mixed@example.test',
      ),
    ).not.toBe(digest);
  });

  it('frames adjacent identity fields without ambiguous concatenation', () => {
    expect(firstPasswordEmailBinding(runtime, { ...authority, projectionId: 'ab' }, 'c', 'x@example.test')).not.toBe(
      firstPasswordEmailBinding(runtime, { ...authority, projectionId: 'a' }, 'bc', 'x@example.test'),
    );
  });

  it('needs a Google or Apple identity, all of this user at this generation (decision of 2026-11-18)', () => {
    const google = { ...apple, provider: 'google', subject: 'google-subject' };
    const facebook = { ...apple, provider: 'facebook', subject: 'facebook-subject' };
    expect(isFirstPasswordInventory([apple], 'owned-user', 0)).toBe(true);
    expect(isFirstPasswordInventory([google], 'owned-user', 0)).toBe(true);
    expect(isFirstPasswordInventory([apple, google], 'owned-user', 0)).toBe(true);
    expect(isFirstPasswordInventory([google, facebook], 'owned-user', 0)).toBe(true);
    expect(isFirstPasswordInventory([apple, { ...apple, subject: 'second' }], 'owned-user', 0)).toBe(true);
    expect(isFirstPasswordInventory([facebook], 'owned-user', 0)).toBe(false);
    expect(isFirstPasswordInventory([{ ...apple, provider: 'unknown' }], 'owned-user', 0)).toBe(false);
    expect(isFirstPasswordInventory([], 'owned-user', 0)).toBe(false);
    expect(isFirstPasswordInventory([{ ...apple, generation: 1 }], 'owned-user', 0)).toBe(false);
    expect(isFirstPasswordInventory([google, { ...apple, userId: 'other' }], 'owned-user', 0)).toBe(false);
    expect(isFirstPasswordInventory([{ ...google, subject: '' }], 'owned-user', 0)).toBe(false);
    expect(isFirstPasswordInventory([apple], 'owned-user', Number.NaN)).toBe(false);
  });

  it('caps confirmation at five minutes and the presented session expiry', () => {
    const now = new Date('2026-11-13T12:00:00.000Z');
    const later = new Date(now.getTime() + 3_600_000);
    expect(firstPasswordDeadline(now, later).getTime()).toBe(now.getTime() + 300_000);
    expect(firstPasswordDeadline(now, new Date(now.getTime() + 10_000)).getTime()).toBe(now.getTime() + 10_000);
    expect(() => firstPasswordDeadline(now, now)).toThrow('FIRST_PASSWORD_EXPIRED');
    expect(() => firstPasswordDeadline(new Date(Number.NaN), later)).toThrow('FIRST_PASSWORD_AUTHORITY_UNAVAILABLE');
  });

  it('compares complete canonical digests without accepting truncated or malformed tokens', () => {
    expect(equalFirstPasswordDigest('a'.repeat(64), 'a'.repeat(64))).toBe(true);
    expect(equalFirstPasswordDigest('a'.repeat(64), 'b'.repeat(64))).toBe(false);
    for (const malformed of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'z'.repeat(64)])
      expect(equalFirstPasswordDigest('a'.repeat(64), malformed)).toBe(false);
  });
});
