import { describe, expect, it } from 'vite-plus/test';
import {
  planPrototypeIdentityImport,
  PrototypeIdentityImportError,
  type PrototypeLegacyIdentity,
} from '../identity-fixtures';

const verifiedAt = new Date('2024-02-03T04:05:06.000Z');
const bcryptHash = '$2b$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

function legacyIdentity(overrides: Partial<PrototypeLegacyIdentity> = {}): PrototypeLegacyIdentity {
  return {
    id: 'existing-user-id',
    email: ' Climber+project@Example.COM ',
    name: 'Existing climber',
    image: null,
    emailVerifiedAt: verifiedAt,
    createdAt: new Date('2023-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    passwordHash: bcryptHash,
    providers: [
      { provider: 'apple', subject: 'existing-apple-subject' },
      { provider: 'google', subject: 'existing-google-subject' },
    ],
    ...overrides,
  };
}

describe('synthetic identity import planning', () => {
  it('preserves user IDs, bcrypt bytes, provider subjects, timestamps and verification', () => {
    const fixture = legacyIdentity();
    const plan = planPrototypeIdentityImport([fixture]);

    expect(plan.users).toEqual([
      {
        id: fixture.id,
        email: 'climber+project@example.com',
        name: fixture.name,
        image: fixture.image,
        emailVerified: true,
        legacyEmailVerifiedAt: verifiedAt,
        createdAt: fixture.createdAt,
        updatedAt: fixture.updatedAt,
      },
    ]);
    expect(plan.accounts).toEqual([
      expect.objectContaining({
        userId: fixture.id,
        accountId: fixture.id,
        providerId: 'credential',
        password: bcryptHash,
      }),
      expect.objectContaining({
        userId: fixture.id,
        accountId: 'existing-apple-subject',
        providerId: 'apple',
        password: null,
      }),
      expect.objectContaining({
        userId: fixture.id,
        accountId: 'existing-google-subject',
        providerId: 'google',
        password: null,
      }),
    ]);
    expect(fixture.email).toBe(' Climber+project@Example.COM ');
    expect(fixture.passwordHash).toBe(bcryptHash);
  });

  it('preserves unverified users and does not invent a name or a credential', () => {
    const plan = planPrototypeIdentityImport([
      legacyIdentity({ emailVerifiedAt: null, name: null, passwordHash: null }),
    ]);
    expect(plan.users[0]).toMatchObject({ emailVerified: false, legacyEmailVerifiedAt: null, name: '' });
    expect(plan.accounts.every((account) => account.providerId !== 'credential')).toBe(true);
  });

  it('rejects normalized collisions without selecting an owner or returning partial writes', () => {
    const fixture = legacyIdentity();
    expect(() =>
      planPrototypeIdentityImport([
        fixture,
        legacyIdentity({ id: 'another-user', email: 'climber+project@example.com' }),
      ]),
    ).toThrow(new PrototypeIdentityImportError('email-collision'));
  });

  it('rejects a duplicate provider subject even when the email differs', () => {
    expect(() =>
      planPrototypeIdentityImport([
        legacyIdentity(),
        legacyIdentity({ id: 'another-user', email: 'another@example.com' }),
      ]),
    ).toThrow(new PrototypeIdentityImportError('provider-collision'));
  });

  it('does not equate the same subject at different providers', () => {
    const plan = planPrototypeIdentityImport([
      legacyIdentity({ providers: [{ provider: 'apple', subject: 'shared-text' }] }),
      legacyIdentity({
        id: 'another-user',
        email: 'another@example.com',
        providers: [{ provider: 'google', subject: 'shared-text' }],
      }),
    ]);
    expect(plan.users).toHaveLength(2);
    expect(plan.accounts.filter((account) => account.accountId === 'shared-text')).toHaveLength(2);
  });

  it('rejects duplicate user IDs before a fixture can overwrite an identity', () => {
    expect(() =>
      planPrototypeIdentityImport([legacyIdentity(), legacyIdentity({ email: 'another@example.com', providers: [] })]),
    ).toThrow(new PrototypeIdentityImportError('duplicate-user-id'));
  });

  it.each([
    { id: '' },
    { email: '  ' },
    { email: 'not-an-email' },
    { email: 'climber@example.com\nHeader: injected' },
    { createdAt: new Date('invalid') },
    { updatedAt: new Date('invalid') },
    { emailVerifiedAt: new Date('invalid') },
    { providers: [{ provider: 'apple' as const, subject: '' }] },
  ])('rejects malformed identity metadata without logging personal data: %j', (overrides) => {
    expect(() => planPrototypeIdentityImport([legacyIdentity(overrides)])).toThrow(
      new PrototypeIdentityImportError('invalid-user'),
    );
  });

  it.each([
    'plaintext-password',
    '$argon2id$unsupported',
    '$2b$12$truncated',
    bcryptHash.replace('$12$', '$03$'),
    bcryptHash.replace('$12$', '$32$'),
  ])('rejects unsupported password storage: %s', (passwordHash) => {
    expect(() => planPrototypeIdentityImport([legacyIdentity({ passwordHash })])).toThrow(
      new PrototypeIdentityImportError('unsupported-password-hash'),
    );
  });
});
