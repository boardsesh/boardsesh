import { describe, expect, it } from 'vite-plus/test';
import {
  EMAIL_AUDIT_LIMITS,
  EMAIL_AUDIT_NORMALIZER_VERSION,
  EmailAuditAccumulator,
  EmailAuditError,
  type EmailAuditErrorCode,
  type EmailAuditIdentity,
  type EmailAuditTestLimits,
} from '../report';

const privateMarker = 'private-audit-identity-marker';

function identity(userId: string, email: string, overrides: Partial<EmailAuditIdentity> = {}): EmailAuditIdentity {
  return { userId, email, emailVerified: null, hasPassword: false, linkedProviderCount: 0, ...overrides };
}

function auditError(operation: () => void, code: EmailAuditErrorCode): EmailAuditError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(EmailAuditError);
    if (!(error instanceof EmailAuditError)) throw new Error('Expected a fixed audit error.');
    expect(error.code).toBe(code);
    expect(error.message).toBe('Account email audit could not complete.');
    expect(error.message).not.toContain(privateMarker);
    expect(JSON.stringify(error)).not.toContain(privateMarker);
    expect(error.cause).toBeUndefined();
    expect(error).not.toHaveProperty('input');
    expect(error).not.toHaveProperty('identity');
    return error;
  }
  throw new Error('Expected the audit operation to fail.');
}

describe('email audit observations', () => {
  it('returns empty observations without making a completeness or ownership claim', () => {
    const accumulator = new EmailAuditAccumulator();
    const report = accumulator.finish();
    expect(accumulator.userCount).toBe(0);
    expect(Object.values(report.counts).every((count) => count === 0)).toBe(true);
    expect(report.groups).toEqual([]);
    expect(Object.keys(report).sort()).toEqual(['counts', 'groups']);
  });

  it('distinguishes raw duplicate keys, normalized collisions, invalid addresses and login-method presence', () => {
    const accumulator = new EmailAuditAccumulator();
    const verified = new Date('2024-02-03T04:05:06.000Z');
    for (const row of [
      identity('u3', ' Alice@Example.test ', { emailVerified: verified, hasPassword: true }),
      identity('u1', 'alice@example.test', { linkedProviderCount: 2 }),
      identity('u2', 'alice@example.test', { hasPassword: true, linkedProviderCount: 1 }),
      identity('u4', 'Bob@example.test'),
      identity('u5', '   '),
      identity('u6', '', { emailVerified: verified }),
      identity('u7', 'literal%_@example.test', { linkedProviderCount: 1 }),
    ])
      accumulator.add(row);

    const report = accumulator.finish();
    expect(accumulator.userCount).toBe(7);
    expect(report.counts).toEqual({
      totalUsers: 7,
      normalizedKeyCount: 4,
      exactDuplicateKeyCount: 1,
      normalizedCollisionKeyCount: 2,
      usersInCollisionGroups: 5,
      emptyEmailUsers: 2,
      whitespaceUsers: 2,
      nonNormalizedUsers: 3,
      verifiedUsers: 2,
      passwordUsers: 2,
      providerLinkedUsers: 3,
      usersWithoutLoginMethod: 3,
      providerLinks: 4,
    });
    expect(
      report.groups.map((group) => ({ key: group.normalizedEmail, ids: group.members.map((member) => member.userId) })),
    ).toEqual([
      { key: '', ids: ['u5', 'u6'] },
      { key: 'alice@example.test', ids: ['u1', 'u2', 'u3'] },
    ]);
    expect(report.groups[1].members[2]).toEqual({
      userId: 'u3',
      email: ' Alice@Example.test ',
      emailVerified: verified.toISOString(),
      hasPassword: true,
      linkedProviderCount: 0,
    });
    expect(report.groups.every((group) => !('owner' in group) && !('ownerUserId' in group))).toBe(true);
  });

  it('counts duplicate keys once rather than counting duplicate pairs or repeated members', () => {
    const accumulator = new EmailAuditAccumulator();
    for (const userId of ['third', 'first', 'second']) accumulator.add(identity(userId, 'same@example.test'));
    expect(accumulator.finish().counts).toMatchObject({
      totalUsers: 3,
      exactDuplicateKeyCount: 1,
      normalizedCollisionKeyCount: 1,
      usersInCollisionGroups: 3,
    });
    expect(accumulator.finish().groups[0].members.map((member) => member.userId)).toEqual(['first', 'second', 'third']);
  });

  it('details a singleton empty key while retaining malformed nonempty text literally', () => {
    const accumulator = new EmailAuditAccumulator();
    accumulator.add(identity('empty', '\u00a0\ufeff\t\n'));
    accumulator.add(identity('malformed', 'not an address'));
    expect(accumulator.finish().counts).toMatchObject({
      totalUsers: 2,
      normalizedKeyCount: 2,
      normalizedCollisionKeyCount: 0,
      usersInCollisionGroups: 0,
      emptyEmailUsers: 1,
      whitespaceUsers: 1,
    });
    expect(accumulator.finish().groups).toEqual([
      {
        normalizedEmail: '',
        members: [
          {
            userId: 'empty',
            email: '\u00a0\ufeff\t\n',
            emailVerified: null,
            hasPassword: false,
            linkedProviderCount: 0,
          },
        ],
      },
    ]);
  });

  it('uses full JavaScript Unicode trimming and lowercasing without additional canonicalization', () => {
    const accumulator = new EmailAuditAccumulator();
    for (const [index, email] of [
      '\ufeff\u2003\u0130@EXAMPLE.TEST\u00a0',
      'i\u0307@example.test',
      'é@example.test',
      'e\u0301@example.test',
    ].entries())
      accumulator.add(identity(`user-${index}`, email));
    expect(accumulator.finish().counts).toMatchObject({
      normalizedKeyCount: 3,
      normalizedCollisionKeyCount: 1,
      usersInCollisionGroups: 2,
    });
    expect(accumulator.finish().groups.map((group) => group.normalizedEmail)).toEqual(['i\u0307@example.test']);
  });

  it('treats percent and underscore literally and preserves dots and plus suffixes', () => {
    const accumulator = new EmailAuditAccumulator();
    for (const [index, email] of [
      '%_@example.test',
      ' %_@EXAMPLE.TEST ',
      '%x@example.test',
      'ax@example.test',
      'a.b+tag@example.test',
      'ab+tag@example.test',
      'a.b@example.test',
    ].entries())
      accumulator.add(identity(`user-${index}`, email));
    expect(accumulator.finish().counts).toMatchObject({
      normalizedKeyCount: 6,
      normalizedCollisionKeyCount: 1,
      usersInCollisionGroups: 2,
    });
    expect(accumulator.finish().groups.map((group) => group.normalizedEmail)).toEqual(['%_@example.test']);
  });

  it('copies caller fields and Dates, and keeps earlier finish results detached from later rows', () => {
    const accumulator = new EmailAuditAccumulator();
    const verification = new Date('2020-03-04T05:06:07.000Z');
    const row = {
      userId: 'original',
      email: ' Mixed@example.test ',
      emailVerified: verification as Date | null,
      hasPassword: false,
      linkedProviderCount: 2,
    };
    accumulator.add(row);
    verification.setTime(0);
    row.userId = 'replacement';
    row.email = 'replacement@example.test';
    row.emailVerified = null;
    row.hasPassword = true;
    row.linkedProviderCount = 0;
    accumulator.add(identity('other', 'mixed@example.test'));
    const previous = accumulator.finish();
    expect(previous.groups[0].members.find((member) => member.userId === 'original')).toEqual({
      userId: 'original',
      email: ' Mixed@example.test ',
      emailVerified: '2020-03-04T05:06:07.000Z',
      hasPassword: false,
      linkedProviderCount: 2,
    });
    accumulator.add(identity('third', 'mixed@example.test'));
    expect(previous.counts.totalUsers).toBe(2);
    expect(previous.groups[0].members).toHaveLength(2);
    expect(accumulator.finish().groups[0].members).toHaveLength(3);
  });
});

describe('email audit limits and fixed failures', () => {
  it('publishes frozen canonical limits and normalizer version', () => {
    expect(EMAIL_AUDIT_NORMALIZER_VERSION).toBe('js-trim-lower-v1');
    expect(EMAIL_AUDIT_LIMITS).toEqual({
      maxUsers: 100000,
      maxTextBytes: 67108864,
      maxFieldBytes: 4096,
      maxDetailBytes: 16777216,
      pageSize: 1000,
      maximumMs: 30000,
    });
    expect(Object.isFrozen(EMAIL_AUDIT_LIMITS)).toBe(true);
  });

  it.each([
    { maxUsers: 0 },
    { maxUsers: -1 },
    { maxUsers: 1.5 },
    { maxUsers: Number.NaN },
    { maxUsers: EMAIL_AUDIT_LIMITS.maxUsers + 1 },
    { maxTextBytes: 0 },
    { maxTextBytes: Number.POSITIVE_INFINITY },
    { maxTextBytes: EMAIL_AUDIT_LIMITS.maxTextBytes + 1 },
    null,
    [],
    { unexpected: 1 },
  ])('rejects invalid or raised test limits with a fixed configuration error', (options) => {
    auditError(() => new EmailAuditAccumulator(options as EmailAuditTestLimits), 'CONFIGURATION');
  });

  it('copies lower test limits and fails before retaining an excess user', () => {
    const limits = { maxUsers: 1 };
    const accumulator = new EmailAuditAccumulator(limits);
    limits.maxUsers = 100;
    accumulator.add(identity('first', 'first@example.test'));
    auditError(() => accumulator.add(identity(privateMarker, `${privateMarker}@example.test`)), 'INPUT_LIMIT');
    expect(accumulator.userCount).toBe(1);
    expect(accumulator.finish().counts.normalizedKeyCount).toBe(1);
  });

  it('limits retained UTF-8 bytes rather than character counts', () => {
    const accumulator = new EmailAuditAccumulator({ maxTextBytes: 5 });
    accumulator.add(identity('u', 'é')); // UID one byte; raw/key two bytes each.
    auditError(() => accumulator.add(identity('v', '')), 'INPUT_LIMIT');
    expect(accumulator.finish().counts).toMatchObject({ totalUsers: 1, normalizedKeyCount: 1, emptyEmailUsers: 0 });
  });

  it('caps raw and normalized fields, including Unicode lowercase expansion', () => {
    const accumulator = new EmailAuditAccumulator();
    accumulator.add(identity('boundary', 'é'.repeat(2048)));
    auditError(() => accumulator.add(identity('long-email', 'é'.repeat(2049))), 'INPUT_LIMIT');
    auditError(() => accumulator.add(identity('u'.repeat(4097), 'small')), 'INPUT_LIMIT');
    auditError(() => accumulator.add(identity('expanded', '\u0130'.repeat(2048))), 'INPUT_LIMIT');
    expect(accumulator.userCount).toBe(1);
  });

  it('rejects repeated UIDs without treating two observations as two accounts', () => {
    const accumulator = new EmailAuditAccumulator();
    accumulator.add(identity(privateMarker, `${privateMarker}@example.test`));
    auditError(() => accumulator.add(identity(privateMarker, 'different@example.test')), 'INVALID_ROW');
    expect(accumulator.finish().counts).toMatchObject({
      totalUsers: 1,
      normalizedKeyCount: 1,
      exactDuplicateKeyCount: 0,
    });
  });

  it.each([null, undefined, [], privateMarker])('rejects non-row input with a fixed error', (row) => {
    const accumulator = new EmailAuditAccumulator();
    auditError(() => accumulator.add(row as unknown as EmailAuditIdentity), 'INVALID_ROW');
    expect(accumulator.userCount).toBe(0);
  });

  it.each([
    { userId: '' },
    { userId: ' \t' },
    { userId: null },
    { email: null },
    { email: undefined },
    { hasPassword: 1 },
    { linkedProviderCount: -1 },
    { linkedProviderCount: 0.5 },
    { linkedProviderCount: Number.NaN },
    { linkedProviderCount: Number.POSITIVE_INFINITY },
    { linkedProviderCount: Number.MAX_SAFE_INTEGER + 1 },
    { emailVerified: undefined },
    { emailVerified: '2020-01-01T00:00:00Z' },
    { emailVerified: new Date(Number.NaN) },
  ])('rejects unreadable fields without retaining a partial identity or disclosing it', (overrides) => {
    const accumulator = new EmailAuditAccumulator();
    const row = { ...identity(privateMarker, `${privateMarker}@example.test`), ...overrides };
    auditError(() => accumulator.add(row as EmailAuditIdentity), 'INVALID_ROW');
    expect(accumulator.userCount).toBe(0);
    accumulator.add(identity(privateMarker, 'valid@example.test'));
    expect(accumulator.finish().counts.totalUsers).toBe(1);
  });

  it('converts unexpected row access errors into a fixed non-PII failure', () => {
    const row = identity(privateMarker, `${privateMarker}@example.test`);
    Object.defineProperty(row, 'email', {
      get() {
        throw new Error(privateMarker);
      },
    });
    const accumulator = new EmailAuditAccumulator();
    auditError(() => accumulator.add(row), 'INVALID_ROW');
    expect(accumulator.userCount).toBe(0);
  });

  it('rejects aggregate provider counts beyond safe integers before changing observed state', () => {
    const accumulator = new EmailAuditAccumulator();
    accumulator.add(identity('many', 'many@example.test', { linkedProviderCount: Number.MAX_SAFE_INTEGER }));
    auditError(() => accumulator.add(identity('next', 'next@example.test', { linkedProviderCount: 1 })), 'INPUT_LIMIT');
    expect(accumulator.userCount).toBe(1);
    accumulator.add(identity('next', 'next@example.test'));
    expect(accumulator.finish().counts).toMatchObject({
      totalUsers: 2,
      providerLinks: Number.MAX_SAFE_INTEGER,
      providerLinkedUsers: 1,
    });
  });
});
