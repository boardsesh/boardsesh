import { describe, expect, it } from 'vitest';
import { resolveAccountEmail } from '@boardsesh/auth-protocol/account-email';
import {
  LEGACY_LINK_CREATION_TOLERANCE_MS,
  LEGACY_PASSWORD_RESET_LIFETIME_MS,
  legacyLinkAccount,
} from '../legacy-link-account';

const issuedAt = new Date('2026-11-17T10:00:00.000Z');
const link = {
  expires: new Date(issuedAt.getTime() + LEGACY_PASSWORD_RESET_LIFETIME_MS),
  lifetimeMs: LEGACY_PASSWORD_RESET_LIFETIME_MS,
};
const account = (id: string, email: string, createdAt = new Date('2026-01-01T00:00:00.000Z')) => ({
  id,
  email,
  createdAt,
});

describe('legacyLinkAccount', () => {
  it('binds to the one account storing the exact address', () => {
    const accountA = account('account-a', 'Shared@Example.test');
    const accountB = account('account-b', 'shared@example.test');
    expect(legacyLinkAccount(resolveAccountEmail(accountA.email, [accountA, accountB]), link)).toBe(accountA);
    expect(legacyLinkAccount(resolveAccountEmail(accountB.email, [accountA, accountB]), link)).toBe(accountB);
  });

  it('never binds to an account that has the address only in other capitals', () => {
    const accountB = account('account-b', 'shared@example.test');
    expect(legacyLinkAccount(resolveAccountEmail('Shared@Example.test', [accountB]), link)).toBeNull();
  });

  it('refuses two accounts storing the same text', () => {
    const rows = [account('twin-a', 'twin@example.test'), account('twin-b', 'twin@example.test')];
    expect(legacyLinkAccount(resolveAccountEmail('twin@example.test', rows), link)).toBeNull();
  });

  it('accepts creation up to the tolerance after issue, and refuses it later', () => {
    const atLimit = account(
      'at-limit',
      'climber@example.test',
      new Date(issuedAt.getTime() + LEGACY_LINK_CREATION_TOLERANCE_MS),
    );
    const pastLimit = account(
      'past-limit',
      'climber@example.test',
      new Date(issuedAt.getTime() + LEGACY_LINK_CREATION_TOLERANCE_MS + 1),
    );
    expect(legacyLinkAccount(resolveAccountEmail(atLimit.email, [atLimit]), link)).toBe(atLimit);
    expect(legacyLinkAccount(resolveAccountEmail(pastLimit.email, [pastLimit]), link)).toBeNull();
  });
});
