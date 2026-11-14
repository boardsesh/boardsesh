import { describe, expect, it } from 'vite-plus/test';
import {
  captureFirstPasswordRuntime,
  equalFirstPasswordDigest,
  firstPasswordDeadline,
  firstPasswordEmailBinding,
  isAppleOnlyFirstPasswordInventory,
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

  it('requires at least one Apple identity and refuses every other linked provider', () => {
    expect(isAppleOnlyFirstPasswordInventory([apple], 'owned-user', 0)).toBe(true);
    expect(isAppleOnlyFirstPasswordInventory([apple, { ...apple, subject: 'second' }], 'owned-user', 0)).toBe(true);
    for (const provider of ['google', 'facebook', 'unknown'])
      expect(isAppleOnlyFirstPasswordInventory([apple, { ...apple, provider }], 'owned-user', 0)).toBe(false);
    expect(isAppleOnlyFirstPasswordInventory([], 'owned-user', 0)).toBe(false);
    expect(isAppleOnlyFirstPasswordInventory([{ ...apple, generation: 1 }], 'owned-user', 0)).toBe(false);
    expect(isAppleOnlyFirstPasswordInventory([{ ...apple, userId: 'other' }], 'owned-user', 0)).toBe(false);
    expect(isAppleOnlyFirstPasswordInventory([{ ...apple, subject: '' }], 'owned-user', 0)).toBe(false);
    expect(isAppleOnlyFirstPasswordInventory([apple], 'owned-user', Number.NaN)).toBe(false);
  });

  it('caps confirmation at five minutes and every original source/binding/intent deadline', () => {
    const now = new Date('2026-11-13T12:00:00.000Z');
    const later = new Date(now.getTime() + 3_600_000);
    expect(firstPasswordDeadline(now, later, later, later).getTime()).toBe(now.getTime() + 300_000);
    for (const shorter of [0, 1, 2]) {
      const limits = [later, later, later];
      limits[shorter] = new Date(now.getTime() + 10_000);
      expect(firstPasswordDeadline(now, limits[0], limits[1], limits[2]).getTime()).toBe(now.getTime() + 10_000);
    }
    expect(() => firstPasswordDeadline(now, now, later, later)).toThrow('FIRST_PASSWORD_EXPIRED');
    expect(() => firstPasswordDeadline(new Date(Number.NaN), later, later, later)).toThrow(
      'FIRST_PASSWORD_AUTHORITY_UNAVAILABLE',
    );
  });

  it('compares complete canonical digests without accepting truncated or malformed tokens', () => {
    expect(equalFirstPasswordDigest('a'.repeat(64), 'a'.repeat(64))).toBe(true);
    expect(equalFirstPasswordDigest('a'.repeat(64), 'b'.repeat(64))).toBe(false);
    for (const malformed of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'z'.repeat(64)])
      expect(equalFirstPasswordDigest('a'.repeat(64), malformed)).toBe(false);
  });
});
