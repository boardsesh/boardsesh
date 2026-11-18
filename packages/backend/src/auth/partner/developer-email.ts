import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { users, partnerDeveloperEmails } from '@boardsesh/db/schema/auth';
import { deliverableEmailSchema } from '../../email/email-service';
import { PartnerRegistrationError } from './registration-rules';
import type { PartnerDatabase } from './tables';

export const PARTNER_EMAIL_PROOF_LIFETIME_MS = 30 * 60 * 1000;
export const PARTNER_EMAIL_RESEND_INTERVAL_MS = 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type PartnerDeveloperEmailStatus = { email: string; verified: boolean };
export type PartnerDeveloperEmailNotifier = (email: string, token: string) => Promise<void>;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Compare exact current email and account ID; never select an identity by email. */
export async function hasVerifiedPartnerDeveloperEmail(database: PartnerDatabase, userId: string): Promise<boolean> {
  const [proof] = await database
    .select({ userId: partnerDeveloperEmails.userId })
    .from(partnerDeveloperEmails)
    .innerJoin(users, and(eq(users.id, partnerDeveloperEmails.userId), eq(users.email, partnerDeveloperEmails.email)))
    .where(and(eq(users.id, userId), isNotNull(partnerDeveloperEmails.verifiedAt)));
  return Boolean(proof);
}

export async function readPartnerDeveloperEmailStatus(
  database: PartnerDatabase,
  userId: string,
): Promise<PartnerDeveloperEmailStatus> {
  const [account] = await database.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!account) throw new PartnerRegistrationError('not_found', 'Account is unavailable.');
  return { email: account.email, verified: await hasVerifiedPartnerDeveloperEmail(database, userId) };
}

/** The raw token exists only until the email is sent. A resend invalidates the previous challenge. */
export async function requestPartnerDeveloperEmail(
  database: PartnerDatabase,
  userId: string,
  notify: PartnerDeveloperEmailNotifier,
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const recipient = await database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .for('share');
    if (!account) throw new PartnerRegistrationError('not_found', 'Account is unavailable.');
    if (!deliverableEmailSchema.safeParse(account.email).success)
      throw new PartnerRegistrationError('invalid_input', 'This account needs a deliverable email address.');
    // This lock serializes requests for one account even before a proof row exists.
    await transaction.execute(sql`select pg_advisory_xact_lock(719284, hashtext(${userId}))`);
    const [previous] = await transaction
      .select({
        email: partnerDeveloperEmails.email,
        requestedAt: partnerDeveloperEmails.requestedAt,
        verifiedAt: partnerDeveloperEmails.verifiedAt,
      })
      .from(partnerDeveloperEmails)
      .where(eq(partnerDeveloperEmails.userId, userId))
      .for('update');
    // A stale tab cannot undo an ownership proof for the unchanged address.
    if (previous?.email === account.email && previous.verifiedAt) return null;
    const now = new Date();
    if (previous && now.getTime() - previous.requestedAt.getTime() < PARTNER_EMAIL_RESEND_INTERVAL_MS)
      throw new PartnerRegistrationError('busy', 'Wait one minute before requesting another email.');
    const proof = {
      email: account.email,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + PARTNER_EMAIL_PROOF_LIFETIME_MS),
      requestedAt: now,
      verifiedAt: null,
    };
    await transaction
      .insert(partnerDeveloperEmails)
      .values({ userId, ...proof })
      .onConflictDoUpdate({ target: partnerDeveloperEmails.userId, set: proof });
    return account.email;
  });
  if (recipient !== null) await notify(recipient, token);
}

/** Explicit POST/GraphQL action, not opening the email link. Conditional UPDATE consumes once under a race. */
export async function confirmPartnerDeveloperEmail(
  database: PartnerDatabase,
  userId: string,
  token: unknown,
): Promise<boolean> {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .for('share');
    if (!account) return false;
    const now = new Date();
    const consumed = await transaction
      .update(partnerDeveloperEmails)
      .set({ tokenHash: null, expiresAt: null, verifiedAt: now })
      .where(
        and(
          eq(partnerDeveloperEmails.userId, userId),
          eq(partnerDeveloperEmails.email, account.email),
          eq(partnerDeveloperEmails.tokenHash, hashToken(token)),
          gt(partnerDeveloperEmails.expiresAt, now),
        ),
      )
      .returning({ userId: partnerDeveloperEmails.userId });
    return consumed.length === 1;
  });
}
