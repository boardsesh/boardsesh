import { describe, expect, it } from 'vite-plus/test';
import {
  BROWSER_PASSWORD_RECEIPT_PREFIX,
  browserPasswordCredentialHash,
  browserPasswordReceiptHash,
  browserPasswordStateHash,
  sameBrowserPasswordAuthority,
  sameBrowserPasswordSession,
} from '../browser-password-policy';
import type { WebPasswordCandidate } from '../../current-store/web-password';
import type { BrowserPasswordPreparation } from '@boardsesh/auth-protocol/browser-password-v1';

const candidate: WebPasswordCandidate = {
  userId: 'matched-user',
  email: 'unchanged@example.test',
  name: 'Profile',
  image: null,
  createdAt: new Date('2020-01-01T00:00:00Z'),
  emailVerified: new Date('2020-01-02T00:00:00Z'),
  passwordHash: 'exact-bcrypt-hash',
  generation: 3,
  deleted: false,
};
const proof = {
  version: 1 as const,
  userId: 'matched-user',
  authSessionId: 'fresh-SID',
  generation: 3,
  authenticatedAt: '2026-11-15T16:00:00.000Z',
  linkGuarded: true,
};
const expiresAt = '2026-12-15T16:00:00.000Z';
const session = {
  ...proof,
  authenticatedAt: new Date(proof.authenticatedAt),
  requiresAccountCutoff: false,
  expiresAt: new Date(expiresAt),
};
const authority = {
  projectionId: 'projection',
  normalizerVersion: 'normalizer',
  authority: 'current-store' as const,
  epoch: 1,
};
// This policy test needs only the hash-bound fields: the protocol tests own its complete valid shape.
const preparation = { authority, credentialProof: proof, expiresAt } as unknown as BrowserPasswordPreparation;

describe('browser password durable evidence policy', () => {
  it('keeps the receipt outside existing link, command and handoff namespaces', () => {
    expect(BROWSER_PASSWORD_RECEIPT_PREFIX).toBe('ba03-browser-password-v1:');
    for (const prefix of ['password-reset:', 'email-verification:', 'ba03-web-auth:', 'ba03-native-handoff-v1:'])
      expect(BROWSER_PASSWORD_RECEIPT_PREFIX.startsWith(prefix)).toBe(false);
  });
  it.each(['userId', 'email', 'passwordHash', 'generation', 'deleted', 'emailVerified'] as const)(
    'invalidates a prepared password when %s changes',
    (field) => {
      const changed = { ...candidate };
      if (field === 'userId') changed.userId = 'different-user';
      if (field === 'email') changed.email = 'changed@example.test';
      if (field === 'passwordHash') changed.passwordHash = 'new-password-hash';
      if (field === 'generation') changed.generation++;
      if (field === 'deleted') changed.deleted = true;
      if (field === 'emailVerified') changed.emailVerified = null;
      expect(browserPasswordStateHash(changed)).not.toBe(browserPasswordStateHash(candidate));
    },
  );
  it('does not invalidate the password proof for unrelated profile edits', () => {
    expect(browserPasswordStateHash({ ...candidate, name: 'New name', image: 'new-avatar' })).toBe(
      browserPasswordStateHash(candidate),
    );
  });
  it('requires the exact candidate bytes and kind, while ignoring reader key transport', () => {
    const original = { kind: 'legacy-jwe' as const, credential: 'retained-jwe', secret: 'reader-key' };
    expect(browserPasswordCredentialHash(original)).toBe(
      browserPasswordCredentialHash({ ...original, secret: 'rotated-key' }),
    );
    expect(browserPasswordCredentialHash(original)).not.toBe(
      browserPasswordCredentialHash({ ...original, credential: 'different-jwe' }),
    );
    expect(browserPasswordCredentialHash(original)).not.toBe(
      browserPasswordCredentialHash({ kind: 'canonical-token', token: original.credential }),
    );
  });
  it('cannot treat prepared or aborted evidence as exact durable completion', () => {
    const receipt = (state: 'prepared' | 'completed' | 'aborted', candidateHash?: string) =>
      browserPasswordReceiptHash('operation-token', 'browser-intent-token', preparation, state, candidateHash);
    expect(
      new Set([
        receipt('prepared'),
        receipt('aborted'),
        receipt('completed', 'candidate-A'),
        receipt('completed', 'candidate-B'),
      ]).size,
    ).toBe(4);
    expect(receipt('completed', 'candidate-A')).not.toBe(
      browserPasswordReceiptHash('other-operation', 'browser-intent-token', preparation, 'completed', 'candidate-A'),
    );
    expect(receipt('completed', 'candidate-A')).not.toBe(
      browserPasswordReceiptHash('operation-token', 'other-intent', preparation, 'completed', 'candidate-A'),
    );
    expect(receipt('completed', 'candidate-A')).not.toBe(
      browserPasswordReceiptHash(
        'operation-token',
        'browser-intent-token',
        { ...preparation, expiresAt: 'later' },
        'completed',
        'candidate-A',
      ),
    );
  });
  it.each([
    'userId',
    'authSessionId',
    'generation',
    'authenticatedAt',
    'linkGuarded',
    'requiresAccountCutoff',
    'expiresAt',
  ] as const)('refuses current candidate %s drift', (field) => {
    const changed = { ...session };
    if (field === 'userId') changed.userId = 'other';
    if (field === 'authSessionId') changed.authSessionId = 'other-SID';
    if (field === 'generation') changed.generation++;
    if (field === 'authenticatedAt') changed.authenticatedAt = new Date('2026-11-15T16:00:01Z');
    if (field === 'linkGuarded') changed.linkGuarded = false;
    if (field === 'requiresAccountCutoff') changed.requiresAccountCutoff = true;
    if (field === 'expiresAt') changed.expiresAt = new Date(Date.parse(expiresAt) + 1_000);
    expect(sameBrowserPasswordSession(changed, proof, expiresAt)).toBe(false);
    expect(sameBrowserPasswordSession(session, proof, expiresAt)).toBe(true);
  });
  it.each(['projectionId', 'normalizerVersion', 'authority', 'epoch'] as const)(
    'refuses changed authority %s',
    (field) => {
      const changed = { ...authority, [field]: field === 'epoch' ? 2 : 'changed' };
      expect(sameBrowserPasswordAuthority(preparation, changed as typeof authority)).toBe(false);
      expect(sameBrowserPasswordAuthority(preparation, authority)).toBe(true);
    },
  );
});
