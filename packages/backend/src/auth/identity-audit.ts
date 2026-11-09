import { createHmac } from 'node:crypto';
import { normalizeAccountEmail } from './normalize-email';

export type IdentityAuditSnapshot = {
  users: readonly { id: string; email: string; emailVerified: Date | null }[];
  credentials: readonly { userId: string; passwordHash: string }[];
  providerAccounts: readonly { userId: string; provider: string; providerAccountId: string }[];
};

type AuditFindingKind =
  | 'normalized-email-collision'
  | 'malformed-email'
  | 'malformed-bcrypt-credential'
  | 'credential-missing-user'
  | 'provider-account-missing-user'
  | 'malformed-provider-identity'
  | 'provider-subject-conflicting-owners'
  | 'user-without-sign-in-method';

export type IdentityAuditFinding = {
  kind: AuditFindingKind;
  reference: string;
  userReferences: string[];
  recordCount: number;
  emailCollision?: {
    exactDuplicate: boolean;
    caseVariants: boolean;
    whitespaceVariants: boolean;
    verifiedUsers: number;
    credentialUsers: number;
    providerUsers: number;
  };
};

/** These checks flag import prerequisites; a clean report never authorizes cutover. */
export function auditIdentitySnapshot(snapshot: IdentityAuditSnapshot, referenceKey: Uint8Array) {
  if (referenceKey.byteLength < 32) throw new Error('Audit references require at least 32 random key bytes');

  const reference = (purpose: string, ...parts: string[]) =>
    createHmac('sha256', referenceKey)
      .update(JSON.stringify([purpose, ...parts]))
      .digest('hex');
  const userReference = (userId: string) => reference('user', userId);
  const findings: IdentityAuditFinding[] = [];
  const usersById = new Map(snapshot.users.map((user) => [user.id, user]));
  const credentialOwners = new Set(snapshot.credentials.map((credential) => credential.userId));
  const providerOwners = new Set(snapshot.providerAccounts.map((account) => account.userId));
  const emailGroups = new Map<string, IdentityAuditSnapshot['users'][number][]>();
  const exactEmailCounts = new Map<string, number>();
  const providerGroups = new Map<string, IdentityAuditSnapshot['providerAccounts'][number][]>();
  let nonNormalizedEmails = 0;

  for (const user of snapshot.users) {
    // This is the proposed identity rule, not a write or a production lookup.
    const normalizedEmail = normalizeAccountEmail(user.email);
    if (normalizedEmail !== user.email) nonNormalizedEmails += 1;
    const group = emailGroups.get(normalizedEmail) ?? [];
    group.push(user);
    emailGroups.set(normalizedEmail, group);
    exactEmailCounts.set(user.email, (exactEmailCounts.get(user.email) ?? 0) + 1);

    // Matches the existing native registration shape. Flag for review rather
    // than claiming to validate every RFC mailbox form or mailbox ownership.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      findings.push({
        kind: 'malformed-email',
        reference: userReference(user.id),
        userReferences: [userReference(user.id)],
        recordCount: 1,
      });
    }
    if (!credentialOwners.has(user.id) && !providerOwners.has(user.id)) {
      findings.push({
        kind: 'user-without-sign-in-method',
        reference: userReference(user.id),
        userReferences: [userReference(user.id)],
        recordCount: 1,
      });
    }
  }

  for (const [normalizedEmail, group] of emailGroups) {
    if (group.length < 2) continue;
    findings.push({
      kind: 'normalized-email-collision',
      reference: reference('email-group', normalizedEmail),
      userReferences: group.map((user) => userReference(user.id)).sort(),
      recordCount: group.length,
      emailCollision: {
        exactDuplicate: new Set(group.map((user) => user.email)).size < group.length,
        caseVariants: new Set(group.map((user) => user.email.trim())).size > 1,
        whitespaceVariants: group.some((user) => user.email !== user.email.trim()),
        verifiedUsers: group.filter((user) => user.emailVerified !== null).length,
        credentialUsers: group.filter((user) => credentialOwners.has(user.id)).length,
        providerUsers: group.filter((user) => providerOwners.has(user.id)).length,
      },
    });
  }

  for (const credential of snapshot.credentials) {
    const ownerReference = userReference(credential.userId);
    if (!usersById.has(credential.userId)) {
      findings.push({
        kind: 'credential-missing-user',
        reference: ownerReference,
        userReferences: [ownerReference],
        recordCount: 1,
      });
    }
    const bcryptCost = Number(credential.passwordHash.slice(4, 6));
    if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(credential.passwordHash) || bcryptCost < 4 || bcryptCost > 31) {
      findings.push({
        kind: 'malformed-bcrypt-credential',
        reference: ownerReference,
        userReferences: [ownerReference],
        recordCount: 1,
      });
    }
  }

  for (const account of snapshot.providerAccounts) {
    const accountReference = reference('provider-subject', account.provider, account.providerAccountId);
    const groupKey = JSON.stringify([account.provider, account.providerAccountId]);
    const group = providerGroups.get(groupKey) ?? [];
    group.push(account);
    providerGroups.set(groupKey, group);
    if (!usersById.has(account.userId)) {
      findings.push({
        kind: 'provider-account-missing-user',
        reference: accountReference,
        userReferences: [userReference(account.userId)],
        recordCount: 1,
      });
    }
    if (!account.provider.trim() || !account.providerAccountId.trim()) {
      findings.push({
        kind: 'malformed-provider-identity',
        reference: accountReference,
        userReferences: [userReference(account.userId)],
        recordCount: 1,
      });
    }
  }

  for (const group of providerGroups.values()) {
    const ownerIds = [...new Set(group.map((account) => account.userId))];
    if (ownerIds.length < 2) continue;
    findings.push({
      kind: 'provider-subject-conflicting-owners',
      reference: reference('provider-subject', group[0].provider, group[0].providerAccountId),
      userReferences: ownerIds.map(userReference).sort(),
      recordCount: group.length,
    });
  }

  const countFindings = (kind: AuditFindingKind) => findings.filter((finding) => finding.kind === kind).length;
  const emailCollisions = findings.filter((finding) => finding.kind === 'normalized-email-collision');

  return {
    schemaVersion: 1 as const,
    scope: 'identity-records-only' as const,
    normalization: 'trim().toLowerCase()' as const,
    referenceScheme: 'per-run-hmac-sha256' as const,
    counts: {
      users: snapshot.users.length,
      credentials: snapshot.credentials.length,
      providerAccounts: snapshot.providerAccounts.length,
      verifiedUsers: snapshot.users.filter((user) => user.emailVerified !== null).length,
      nonNormalizedEmails,
      exactEmailDuplicateGroups: [...exactEmailCounts.values()].filter((count) => count > 1).length,
      normalizedEmailCollisionGroups: emailCollisions.length,
      usersInNormalizedEmailCollisions: emailCollisions.reduce((total, group) => total + group.recordCount, 0),
      caseVariantCollisionGroups: emailCollisions.filter((group) => group.emailCollision?.caseVariants).length,
      whitespaceVariantCollisionGroups: emailCollisions.filter((group) => group.emailCollision?.whitespaceVariants)
        .length,
      malformedEmailUsers: countFindings('malformed-email'),
      malformedBcryptCredentials: countFindings('malformed-bcrypt-credential'),
      credentialsMissingUsers: countFindings('credential-missing-user'),
      providerAccountsMissingUsers: countFindings('provider-account-missing-user'),
      malformedProviderIdentities: countFindings('malformed-provider-identity'),
      conflictingProviderSubjectGroups: countFindings('provider-subject-conflicting-owners'),
      usersWithoutSignInMethods: countFindings('user-without-sign-in-method'),
    },
    findings: findings.sort((left, right) =>
      `${left.kind}:${left.reference}`.localeCompare(`${right.kind}:${right.reference}`),
    ),
  };
}
