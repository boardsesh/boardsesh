import { describe, expect, it } from 'vite-plus/test';
import { auditIdentitySnapshot, type IdentityAuditSnapshot } from '../identity-audit';
import { auditDatabaseUrl } from '../../scripts/audit-auth-identities';

const referenceKey = new Uint8Array(32).fill(17);
const bcryptHash = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8/oQbk1Ec7T0p/7K8nXfRzC2VyM4dy';
const user = (id: string, email: string, verified = false) => ({
  id,
  email,
  emailVerified: verified ? new Date('2026-01-01T00:00:00Z') : null,
});
const credential = (userId: string) => ({ userId, passwordHash: bcryptHash });
const providerAccount = (userId: string, provider = 'apple', providerAccountId = `subject-for-${userId}`) => ({
  userId,
  provider,
  providerAccountId,
});
const emptySnapshot = (): IdentityAuditSnapshot => ({ users: [], credentials: [], providerAccounts: [] });

describe('identity audit', () => {
  it('measures exact, case, and whitespace collisions with each group ownership summary', () => {
    const snapshot: IdentityAuditSnapshot = {
      users: [
        user('exact-1', 'exact@example.com', true),
        user('exact-2', 'exact@example.com'),
        user('case-1', 'CASE@example.com'),
        user('case-2', 'case@example.com'),
        user('space-1', '\tspace@example.com\u00a0'),
        user('space-2', 'space@example.com'),
      ],
      credentials: [credential('exact-1'), credential('case-1'), credential('space-1')],
      providerAccounts: [providerAccount('exact-2'), providerAccount('case-2'), providerAccount('space-2')],
    };
    const report = auditIdentitySnapshot(snapshot, referenceKey);

    expect(report.counts).toMatchObject({
      users: 6,
      credentials: 3,
      providerAccounts: 3,
      verifiedUsers: 1,
      nonNormalizedEmails: 2,
      exactEmailDuplicateGroups: 1,
      normalizedEmailCollisionGroups: 3,
      usersInNormalizedEmailCollisions: 6,
      caseVariantCollisionGroups: 1,
      whitespaceVariantCollisionGroups: 1,
      usersWithoutSignInMethods: 0,
    });
    const exactCollision = report.findings.find((finding) => finding.emailCollision?.exactDuplicate);
    expect(exactCollision?.emailCollision).toEqual({
      exactDuplicate: true,
      caseVariants: false,
      whitespaceVariants: false,
      verifiedUsers: 1,
      credentialUsers: 1,
      providerUsers: 1,
    });
  });

  it('keeps plus aliases, dots, and different provider subjects distinct', () => {
    const snapshot: IdentityAuditSnapshot = {
      users: [
        user('climber', 'climber@example.com'),
        user('plus', 'climber+training@example.com'),
        user('dotted', 'clim.ber@example.com'),
      ],
      credentials: [],
      providerAccounts: [
        providerAccount('climber', 'apple', 'same-subject'),
        providerAccount('plus', 'google', 'same-subject'),
        providerAccount('dotted', 'apple', 'Same-Subject'),
      ],
    };

    const report = auditIdentitySnapshot(snapshot, referenceKey);
    expect(report.counts.normalizedEmailCollisionGroups).toBe(0);
    expect(report.counts.conflictingProviderSubjectGroups).toBe(0);
  });

  it('flags malformed emails, missing sign-in methods, and invalid bcrypt records without hashing them again', () => {
    const snapshot: IdentityAuditSnapshot = {
      users: [user('no-method', 'no-method@example.com'), user('invalid-email', 'not-an-address'), user('blank', '  ')],
      credentials: [
        { userId: 'invalid-email', passwordHash: 'plaintext-is-not-a-bcrypt-hash' },
        { userId: 'blank', passwordHash: bcryptHash.replace('$10$', '$03$') },
      ],
      providerAccounts: [],
    };

    const report = auditIdentitySnapshot(snapshot, referenceKey);
    expect(report.counts).toMatchObject({
      malformedEmailUsers: 2,
      malformedBcryptCredentials: 2,
      usersWithoutSignInMethods: 1,
    });
  });

  it('reports orphan credentials, malformed provider identities, and conflicting provider ownership', () => {
    const snapshot: IdentityAuditSnapshot = {
      users: [user('alice', 'alice@example.com'), user('bob', 'bob@example.com')],
      credentials: [credential('missing-credential-owner')],
      providerAccounts: [
        providerAccount('alice', 'apple', 'shared-subject'),
        providerAccount('bob', 'apple', 'shared-subject'),
        providerAccount('missing-provider-owner', 'google', 'orphan-subject'),
        providerAccount('alice', ' ', ' '),
      ],
    };

    const report = auditIdentitySnapshot(snapshot, referenceKey);
    expect(report.counts).toMatchObject({
      credentialsMissingUsers: 1,
      providerAccountsMissingUsers: 1,
      malformedProviderIdentities: 1,
      conflictingProviderSubjectGroups: 1,
    });
    expect(report.findings.find((finding) => finding.kind === 'provider-subject-conflicting-owners')).toMatchObject({
      recordCount: 2,
      userReferences: [expect.stringMatching(/^[a-f0-9]{64}$/), expect.stringMatching(/^[a-f0-9]{64}$/)],
    });
  });

  it('does not confuse delimiter-bearing provider pairs', () => {
    const snapshot: IdentityAuditSnapshot = {
      users: [user('alice', 'alice@example.com'), user('bob', 'bob@example.com')],
      credentials: [],
      providerAccounts: [providerAccount('alice', 'a:b', 'c'), providerAccount('bob', 'a', 'b:c')],
    };
    expect(auditIdentitySnapshot(snapshot, referenceKey).counts.conflictingProviderSubjectGroups).toBe(0);
  });

  it('emits no raw identifiers or credentials and isolates references between audit runs', () => {
    const snapshot: IdentityAuditSnapshot = {
      users: [
        user('private-user-id-1', 'private-address@example.com'),
        user('private-user-id-2', 'PRIVATE-address@example.com'),
      ],
      credentials: [credential('private-user-id-1')],
      providerAccounts: [providerAccount('private-user-id-2', 'private-provider-name', 'private-provider-subject')],
    };
    const before = structuredClone(snapshot);
    const firstReport = auditIdentitySnapshot(snapshot, referenceKey);
    const serializedReport = JSON.stringify(firstReport);
    const secondReport = auditIdentitySnapshot(snapshot, new Uint8Array(32).fill(18));

    for (const secret of [
      'private-user-id',
      'private-address',
      'PRIVATE-address',
      'private-provider-name',
      'private-provider-subject',
      bcryptHash,
    ]) {
      expect(serializedReport).not.toContain(secret);
    }
    expect(secondReport.counts).toEqual(firstReport.counts);
    expect(secondReport.findings[0].reference).not.toBe(firstReport.findings[0].reference);
    expect(snapshot).toEqual(before);
    expect(auditIdentitySnapshot(snapshot, referenceKey)).toEqual(firstReport);
  });

  it('measures an empty snapshot without implying migration readiness', () => {
    const report = auditIdentitySnapshot(emptySnapshot(), referenceKey);
    expect(report.findings).toEqual([]);
    expect(Object.values(report.counts).every((count) => count === 0)).toBe(true);
    expect(report.scope).toBe('identity-records-only');
    expect(report).not.toHaveProperty('readyForMigration');
  });

  it('refuses a short reference key', () => {
    expect(() => auditIdentitySnapshot(emptySnapshot(), new Uint8Array(16))).toThrow('32 random key bytes');
  });
});

describe('identity audit database selection', () => {
  it('requires an explicit audit URL without falling back to application credentials', () => {
    expect(() => auditDatabaseUrl({ DATABASE_URL: 'postgresql://secret@production.invalid/application' })).toThrow(
      'AUTH_IDENTITY_AUDIT_DATABASE_URL is required',
    );
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])('accepts the explicit local host %s', (hostname) => {
    const databaseUrl = `postgresql://audit-user:audit-password@${hostname}:5433/restored_fixture`;
    expect(auditDatabaseUrl({ AUTH_IDENTITY_AUDIT_DATABASE_URL: databaseUrl })).toBe(databaseUrl);
  });

  it.each([
    'postgresql://audit-user:secret@production.invalid/restored_fixture',
    'https://localhost/restored_fixture',
    'postgresql://localhost',
    'postgresql://localhost/restored_fixture?host=production.invalid',
    'postgresql://localhost/restored_fixture?hostaddr=192.0.2.1',
    'postgresql://localhost/restored_fixture?default_transaction_read_only=off',
    'not-a-url',
  ])('refuses remote, malformed, or option-bearing URLs without echoing secrets', (databaseUrl) => {
    expect(() => auditDatabaseUrl({ AUTH_IDENTITY_AUDIT_DATABASE_URL: databaseUrl })).toThrow();
    try {
      auditDatabaseUrl({ AUTH_IDENTITY_AUDIT_DATABASE_URL: databaseUrl });
    } catch (error) {
      expect(String(error)).not.toContain(databaseUrl);
      expect(String(error)).not.toContain('secret');
    }
  });
});
