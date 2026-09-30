import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDENTIAL_BACKOFF_BASE_MS,
  CREDENTIAL_BACKOFF_CAP_MS,
  credentialBackoffMs,
  isCredentialInBackoff,
} from './credential-backoff';

void describe('credential backoff', () => {
  void it('is zero with no failures', () => {
    assert.equal(credentialBackoffMs(0), 0);
    assert.equal(credentialBackoffMs(-3), 0);
  });

  void it('doubles from the base per consecutive failure', () => {
    assert.equal(credentialBackoffMs(1), CREDENTIAL_BACKOFF_BASE_MS); // 2m
    assert.equal(credentialBackoffMs(2), CREDENTIAL_BACKOFF_BASE_MS * 2); // 4m
    assert.equal(credentialBackoffMs(3), CREDENTIAL_BACKOFF_BASE_MS * 4); // 8m
    assert.equal(credentialBackoffMs(6), CREDENTIAL_BACKOFF_BASE_MS * 32); // 64m
  });

  void it('caps at 6 hours and never overflows', () => {
    assert.equal(credentialBackoffMs(9), CREDENTIAL_BACKOFF_CAP_MS);
    assert.equal(credentialBackoffMs(100), CREDENTIAL_BACKOFF_CAP_MS);
    assert.ok(Number.isFinite(credentialBackoffMs(1_000_000)));
  });

  void it('treats a never-attempted or zero-failure credential as ready', () => {
    const now = new Date('2026-07-08T00:00:00Z');
    assert.equal(isCredentialInBackoff(now, null, 0), false);
    assert.equal(isCredentialInBackoff(now, null, 5), false); // no attempt clock yet
    assert.equal(isCredentialInBackoff(now, new Date('2026-07-07T00:00:00Z'), 0), false);
  });

  void it('skips a credential still inside its window and admits it after', () => {
    const attemptAt = new Date('2026-07-08T00:00:00Z');
    // 2 failures → 4 min window.
    const withinWindow = new Date(attemptAt.getTime() + 3 * 60 * 1000);
    const pastWindow = new Date(attemptAt.getTime() + 5 * 60 * 1000);
    assert.equal(isCredentialInBackoff(withinWindow, attemptAt, 2), true);
    assert.equal(isCredentialInBackoff(pastWindow, attemptAt, 2), false);
  });

  void it('holds for the later of Retry-After and the backoff, never their sum', () => {
    const attemptAt = new Date('2026-07-08T00:00:00Z');
    const hour = 60 * 60 * 1000;
    const retryAfterUntil = new Date(attemptAt.getTime() + hour);
    // 9 failures → 6 h backoff, longer than the 1 h Retry-After.
    assert.equal(isCredentialInBackoff(new Date(attemptAt.getTime() + 2 * hour), attemptAt, 9, retryAfterUntil), true);
    assert.equal(isCredentialInBackoff(new Date(attemptAt.getTime() + 6 * hour), attemptAt, 9, retryAfterUntil), false);
    // 1 failure → 2 min backoff, shorter than the Retry-After.
    assert.equal(
      isCredentialInBackoff(new Date(attemptAt.getTime() + 30 * 60 * 1000), attemptAt, 1, retryAfterUntil),
      true,
    );
    assert.equal(isCredentialInBackoff(new Date(attemptAt.getTime() + hour), attemptAt, 1, retryAfterUntil), false);
  });
});
