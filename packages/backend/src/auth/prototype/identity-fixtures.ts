import { z } from 'zod';
import { normalizeAccountEmail } from '../normalize-email';

/** Synthetic import fixtures only. This module is never mounted by the backend. */
export interface PrototypeLegacyProvider {
  readonly provider: 'google' | 'apple' | 'facebook';
  readonly subject: string;
}

export interface PrototypeLegacyIdentity {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly image: string | null;
  readonly emailVerifiedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly passwordHash: string | null;
  readonly providers: readonly PrototypeLegacyProvider[];
}

export type PrototypeIdentityImportFailure =
  | 'invalid-user'
  | 'duplicate-user-id'
  | 'email-collision'
  | 'provider-collision'
  | 'unsupported-password-hash';

export class PrototypeIdentityImportError extends Error {
  constructor(readonly code: PrototypeIdentityImportFailure) {
    // Do not put fixture emails, provider subjects, or password hashes in errors.
    super(`Prototype identity import rejected: ${code}`);
    this.name = 'PrototypeIdentityImportError';
  }
}

/**
 * Validate an entire fixture batch before writing anything. Production collision
 * resolution, writer fencing and idempotent backfill are separate epic gates.
 */
export function planPrototypeIdentityImport(identities: readonly PrototypeLegacyIdentity[]) {
  const userIds = new Set<string>();
  const normalizedEmails = new Set<string>();
  const providerSubjects = new Set<string>();
  const users = [];
  const accounts = [];

  for (const identity of identities) {
    const email = normalizeAccountEmail(identity.email);
    if (
      !identity.id ||
      !z.email().safeParse(email).success ||
      !Number.isFinite(identity.createdAt.getTime()) ||
      !Number.isFinite(identity.updatedAt.getTime())
    ) {
      throw new PrototypeIdentityImportError('invalid-user');
    }
    if (identity.emailVerifiedAt !== null && !Number.isFinite(identity.emailVerifiedAt.getTime())) {
      throw new PrototypeIdentityImportError('invalid-user');
    }
    if (userIds.has(identity.id)) throw new PrototypeIdentityImportError('duplicate-user-id');
    if (normalizedEmails.has(email)) throw new PrototypeIdentityImportError('email-collision');
    userIds.add(identity.id);
    normalizedEmails.add(email);

    users.push({
      id: identity.id,
      email,
      name: identity.name ?? '',
      image: identity.image,
      emailVerified: identity.emailVerifiedAt !== null,
      legacyEmailVerifiedAt: identity.emailVerifiedAt,
      createdAt: identity.createdAt,
      updatedAt: identity.updatedAt,
    });

    if (identity.passwordHash !== null) {
      if (!/^\$2[aby]\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/.test(identity.passwordHash)) {
        throw new PrototypeIdentityImportError('unsupported-password-hash');
      }
      accounts.push({
        id: `credential:${identity.id}`,
        userId: identity.id,
        accountId: identity.id,
        providerId: 'credential',
        password: identity.passwordHash,
        createdAt: identity.createdAt,
        updatedAt: identity.updatedAt,
      });
    }

    for (const provider of identity.providers) {
      if (!provider.subject) throw new PrototypeIdentityImportError('invalid-user');
      const providerKey = JSON.stringify([provider.provider, provider.subject]);
      if (providerSubjects.has(providerKey)) throw new PrototypeIdentityImportError('provider-collision');
      providerSubjects.add(providerKey);
      accounts.push({
        id: `provider:${providerKey}`,
        userId: identity.id,
        accountId: provider.subject,
        providerId: provider.provider,
        password: null,
        createdAt: identity.createdAt,
        updatedAt: identity.updatedAt,
      });
    }
  }

  return { users, accounts };
}
