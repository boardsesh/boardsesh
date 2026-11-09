import { normalizeAccountEmail } from '../normalize-email';

export const EMAIL_AUDIT_NORMALIZER_VERSION = 'js-trim-lower-v1';

export const EMAIL_AUDIT_LIMITS = Object.freeze({
  maxUsers: 100000,
  maxTextBytes: 67108864,
  maxFieldBytes: 4096,
  maxDetailBytes: 16777216,
  pageSize: 1000,
  maximumMs: 30000,
});

export type EmailAuditErrorCode =
  | 'CONFIGURATION'
  | 'INPUT_LIMIT'
  | 'INVALID_ROW'
  | 'TIME_LIMIT'
  | 'COUNT_MISMATCH'
  | 'SNAPSHOT_UNAVAILABLE'
  | 'OUTPUT_UNAVAILABLE';

export class EmailAuditError extends Error {
  constructor(readonly code: EmailAuditErrorCode) {
    super('Account email audit could not complete.');
    this.name = 'EmailAuditError';
  }
}

export interface EmailAuditIdentity {
  readonly userId: string;
  readonly email: string;
  readonly emailVerified: Date | null;
  readonly hasPassword: boolean;
  readonly linkedProviderCount: number;
}

export interface EmailAuditMember {
  readonly userId: string;
  readonly email: string;
  readonly emailVerified: string | null;
  readonly hasPassword: boolean;
  readonly linkedProviderCount: number;
}

export interface EmailAuditCounts {
  readonly totalUsers: number;
  readonly normalizedKeyCount: number;
  readonly exactDuplicateKeyCount: number;
  readonly normalizedCollisionKeyCount: number;
  readonly usersInCollisionGroups: number;
  readonly emptyEmailUsers: number;
  readonly whitespaceUsers: number;
  readonly nonNormalizedUsers: number;
  readonly verifiedUsers: number;
  readonly passwordUsers: number;
  readonly providerLinkedUsers: number;
  readonly usersWithoutLoginMethod: number;
  readonly providerLinks: number;
}

export interface EmailAuditGroup {
  readonly normalizedEmail: string;
  readonly members: readonly EmailAuditMember[];
}

export interface EmailAuditReport {
  readonly counts: EmailAuditCounts;
  readonly groups: readonly EmailAuditGroup[];
}

export interface EmailAuditTestLimits {
  readonly maxUsers?: number;
  readonly maxTextBytes?: number;
}

function lowerLimits(options: EmailAuditTestLimits): { maxUsers: number; maxTextBytes: number } {
  try {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new Error();
    if (Object.keys(options).some((name) => name !== 'maxUsers' && name !== 'maxTextBytes')) throw new Error();
    const maxUsers = options.maxUsers === undefined ? EMAIL_AUDIT_LIMITS.maxUsers : options.maxUsers;
    const maxTextBytes = options.maxTextBytes === undefined ? EMAIL_AUDIT_LIMITS.maxTextBytes : options.maxTextBytes;
    if (
      !Number.isSafeInteger(maxUsers) ||
      maxUsers < 1 ||
      maxUsers > EMAIL_AUDIT_LIMITS.maxUsers ||
      !Number.isSafeInteger(maxTextBytes) ||
      maxTextBytes < 1 ||
      maxTextBytes > EMAIL_AUDIT_LIMITS.maxTextBytes
    )
      throw new Error();
    return { maxUsers, maxTextBytes };
  } catch {
    throw new EmailAuditError('CONFIGURATION');
  }
}

function textBytes(contents: string): number {
  return Buffer.byteLength(contents, 'utf8');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Groups observed rows only. The caller must establish snapshot/EOF/count
 * completeness and enforce the optional serialized detail-output limit.
 */
export class EmailAuditAccumulator {
  private readonly limits: { maxUsers: number; maxTextBytes: number };
  private readonly userIds = new Set<string>();
  private readonly rawEmailCounts = new Map<string, number>();
  private readonly normalizedMembers = new Map<string, EmailAuditMember[]>();
  private retainedTextBytes = 0;
  private readonly counts = {
    totalUsers: 0,
    normalizedKeyCount: 0,
    exactDuplicateKeyCount: 0,
    normalizedCollisionKeyCount: 0,
    usersInCollisionGroups: 0,
    emptyEmailUsers: 0,
    whitespaceUsers: 0,
    nonNormalizedUsers: 0,
    verifiedUsers: 0,
    passwordUsers: 0,
    providerLinkedUsers: 0,
    usersWithoutLoginMethod: 0,
    providerLinks: 0,
  };

  constructor(options: EmailAuditTestLimits = {}) {
    this.limits = lowerLimits(options);
  }

  get userCount(): number {
    return this.counts.totalUsers;
  }

  add(identity: EmailAuditIdentity): void {
    try {
      this.addIdentity(identity);
    } catch (error) {
      if (error instanceof EmailAuditError) throw error;
      throw new EmailAuditError('INVALID_ROW');
    }
  }

  private addIdentity(identity: EmailAuditIdentity): void {
    if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) {
      throw new EmailAuditError('INVALID_ROW');
    }
    const { userId, email, emailVerified, hasPassword, linkedProviderCount } = identity;
    if (
      typeof userId !== 'string' ||
      userId.length === 0 ||
      typeof email !== 'string' ||
      typeof hasPassword !== 'boolean' ||
      !Number.isSafeInteger(linkedProviderCount) ||
      linkedProviderCount < 0
    )
      throw new EmailAuditError('INVALID_ROW');
    if ([userId, email].some((contents) => textBytes(contents) > EMAIL_AUDIT_LIMITS.maxFieldBytes)) {
      throw new EmailAuditError('INPUT_LIMIT');
    }
    if (!userId.trim() || this.userIds.has(userId)) throw new EmailAuditError('INVALID_ROW');

    let verification: string | null = null;
    if (emailVerified !== null) {
      if (!(emailVerified instanceof Date)) throw new EmailAuditError('INVALID_ROW');
      const timestamp = Date.prototype.getTime.call(emailVerified);
      if (!Number.isFinite(timestamp)) throw new EmailAuditError('INVALID_ROW');
      verification = new Date(timestamp).toISOString();
    }

    const normalizedEmail = normalizeAccountEmail(email);
    const hasWhitespace = email !== email.trim();
    if (textBytes(normalizedEmail) > EMAIL_AUDIT_LIMITS.maxFieldBytes) {
      throw new EmailAuditError('INPUT_LIMIT');
    }
    const members = this.normalizedMembers.get(normalizedEmail);
    // Charge copied identity/address/verification text, plus each retained key.
    // Paging the source does not remove this accumulator's memory bound.
    const addedTextBytes =
      textBytes(userId) +
      textBytes(email) +
      (verification === null ? 0 : textBytes(verification)) +
      (members === undefined ? textBytes(normalizedEmail) : 0);
    const providerLinks = this.counts.providerLinks + linkedProviderCount;
    if (
      this.userCount >= this.limits.maxUsers ||
      this.retainedTextBytes + addedTextBytes > this.limits.maxTextBytes ||
      !Number.isSafeInteger(providerLinks)
    )
      throw new EmailAuditError('INPUT_LIMIT');

    // All fallible validation precedes state changes, including Date copying.
    const member = { userId, email, emailVerified: verification, hasPassword, linkedProviderCount };
    const exactCount = this.rawEmailCounts.get(email) ?? 0;
    this.userIds.add(userId);
    this.rawEmailCounts.set(email, exactCount + 1);
    this.retainedTextBytes += addedTextBytes;
    if (members === undefined) {
      this.normalizedMembers.set(normalizedEmail, [member]);
      this.counts.normalizedKeyCount += 1;
    } else {
      // A second member makes BOTH observed users part of a collision group.
      this.counts.usersInCollisionGroups += members.length === 1 ? 2 : 1;
      if (members.length === 1) this.counts.normalizedCollisionKeyCount += 1;
      members.push(member);
    }
    this.counts.totalUsers += 1;
    if (exactCount === 1) this.counts.exactDuplicateKeyCount += 1;
    if (!normalizedEmail) this.counts.emptyEmailUsers += 1;
    if (hasWhitespace) this.counts.whitespaceUsers += 1;
    if (email !== normalizedEmail) this.counts.nonNormalizedUsers += 1;
    if (verification !== null) this.counts.verifiedUsers += 1;
    if (hasPassword) this.counts.passwordUsers += 1;
    if (linkedProviderCount > 0) this.counts.providerLinkedUsers += 1;
    if (!hasPassword && linkedProviderCount === 0) this.counts.usersWithoutLoginMethod += 1;
    this.counts.providerLinks = providerLinks;
  }

  finish(): EmailAuditReport {
    // Empty normalized keys are always detailed. A singleton empty key is
    // invalid-address evidence, not an additional collision or chosen owner.
    const groups = [...this.normalizedMembers]
      .filter(([normalizedEmail, members]) => normalizedEmail === '' || members.length > 1)
      .sort(([leftEmail], [rightEmail]) => compareText(leftEmail, rightEmail))
      .map(([normalizedEmail, members]) =>
        Object.freeze({
          normalizedEmail,
          members: Object.freeze(
            members
              .map((member) => Object.freeze({ ...member }))
              .sort((leftMember, rightMember) => compareText(leftMember.userId, rightMember.userId)),
          ),
        }),
      );
    return Object.freeze({ counts: Object.freeze({ ...this.counts }), groups: Object.freeze(groups) });
  }
}
