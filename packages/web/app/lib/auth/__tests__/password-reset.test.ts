import { describe, it, expect } from 'vite-plus/test';
import { createHash } from 'node:crypto';
import {
  PASSWORD_RESET_IDENTIFIER_PREFIX,
  PASSWORD_RESET_USER_IDENTIFIER_PREFIX,
  getPasswordResetIdentifier,
  getPasswordResetUserId,
  getLegacyPasswordResetEmail,
  hashResetToken,
  consistentDelay,
} from '../password-reset';

describe('password-reset utilities', () => {
  describe('getPasswordResetIdentifier', () => {
    it('binds the reset identifier to the selected user id', () => {
      expect(getPasswordResetIdentifier('user-123')).toBe('password-reset:v2:user:user-123');
    });

    it('uses the exported user-id prefix constant', () => {
      expect(getPasswordResetIdentifier('user-123')).toBe(`${PASSWORD_RESET_USER_IDENTIFIER_PREFIX}user-123`);
    });

    it('keeps password-reset identifiers distinct from raw emails (no token collision)', () => {
      expect(getPasswordResetIdentifier('user-123')).not.toBe('user-123');
    });
  });

  describe('identifier parsing', () => {
    it('parses current user-bound identifiers', () => {
      expect(getPasswordResetUserId('password-reset:v2:user:user-123')).toBe('user-123');
      expect(getLegacyPasswordResetEmail('password-reset:v2:user:user-123')).toBeNull();
    });

    it('keeps legacy email identifiers distinguishable for fail-closed resolution', () => {
      expect(getPasswordResetUserId('password-reset:Foo@example.com')).toBeNull();
      expect(getLegacyPasswordResetEmail('password-reset:Foo@example.com')).toBe('Foo@example.com');
      expect(getLegacyPasswordResetEmail('unrelated:value')).toBeNull();
      expect(getLegacyPasswordResetEmail(PASSWORD_RESET_IDENTIFIER_PREFIX)).toBeNull();
    });
  });

  describe('hashResetToken', () => {
    it('returns the sha256 hex digest of the token', () => {
      const token = '11111111-2222-3333-4444-555555555555';
      const expected = createHash('sha256').update(token).digest('hex');
      expect(hashResetToken(token)).toBe(expected);
    });

    it('is deterministic for the same token', () => {
      const token = 'abc-token';
      expect(hashResetToken(token)).toBe(hashResetToken(token));
    });

    it('produces different hashes for different tokens', () => {
      expect(hashResetToken('token-a')).not.toBe(hashResetToken('token-b'));
    });

    it('does not return the raw token (so a DB leak does not expose the link)', () => {
      const token = 'raw-secret-token';
      expect(hashResetToken(token)).not.toContain(token);
    });

    it('emits a 64-char hex string', () => {
      expect(hashResetToken('anything')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('consistentDelay', () => {
    it('waits the remaining time up to the minimum', async () => {
      const start = Date.now();
      await consistentDelay(start, 60);
      // setTimeout never fires early, so the delay is always >= the requested 60ms;
      // assert a generous lower bound so a coarse-resolution clock can't flake it.
      expect(Date.now() - start).toBeGreaterThanOrEqual(45);
    });

    it('returns immediately when the minimum has already elapsed', async () => {
      const start = Date.now() - 1000;
      const before = Date.now();
      await consistentDelay(start, 50);
      expect(Date.now() - before).toBeLessThan(40);
    });
  });
});
