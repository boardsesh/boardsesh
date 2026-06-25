import { describe, it, expect } from 'vite-plus/test';
import { createHash } from 'node:crypto';
import {
  PASSWORD_RESET_IDENTIFIER_PREFIX,
  getPasswordResetIdentifier,
  hashResetToken,
  consistentDelay,
} from '../password-reset';

describe('password-reset utilities', () => {
  describe('getPasswordResetIdentifier', () => {
    it('prefixes the email with the reset namespace', () => {
      expect(getPasswordResetIdentifier('user@example.com')).toBe('password-reset:user@example.com');
    });

    it('uses the exported prefix constant', () => {
      const email = 'climber@boardsesh.com';
      expect(getPasswordResetIdentifier(email)).toBe(`${PASSWORD_RESET_IDENTIFIER_PREFIX}${email}`);
    });

    it('keeps password-reset identifiers distinct from raw emails (no token collision)', () => {
      expect(getPasswordResetIdentifier('a@b.com')).not.toBe('a@b.com');
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
      expect(Date.now() - start).toBeGreaterThanOrEqual(55);
    });

    it('returns immediately when the minimum has already elapsed', async () => {
      const start = Date.now() - 1000;
      const before = Date.now();
      await consistentDelay(start, 50);
      expect(Date.now() - before).toBeLessThan(40);
    });
  });
});
