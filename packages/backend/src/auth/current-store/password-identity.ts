import crypto from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import type { DbInstance } from '@boardsesh/db/client';
import { users, userCredentials, userProfiles } from '@boardsesh/db/schema/auth';
import { normalizeAccountEmail } from '../normalize-email';

type PasswordIdentityReader = Pick<DbInstance, 'select'>;
type PasswordIdentityTransaction = Parameters<Parameters<DbInstance['transaction']>[0]>[0];

const DUMMY_PASSWORD_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8/oQbk1Ec7T0p/7K8nXfRzC2VyM4dy';
const MAX_CREDENTIAL_CANDIDATES = 8;
const REGISTER_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const NAME_MAX_LENGTH = 100;
const BCRYPT_COST = 12;

interface PasswordRegistration {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
}

interface PreparedPasswordRegistration {
  readonly email: string;
  readonly passwordHash: string;
  readonly name?: string;
}

/** Current-store password verification only; no credential issuance or mutation. */
export async function authenticateCurrentStorePassword(
  database: PasswordIdentityReader,
  email: string,
  password: string,
): Promise<{ userId: string; createdAt: Date } | null> {
  const normalizedEmail = normalizeAccountEmail(email);
  // Preserve exact case-insensitive matching, including literal '_' and '%'.
  // Historic duplicate-by-case rows remain independently owned accounts.
  const candidates = await database
    .select({ userId: users.id, passwordHash: userCredentials.passwordHash, createdAt: users.createdAt })
    .from(users)
    .innerJoin(userCredentials, eq(userCredentials.userId, users.id))
    .where(sql`LOWER(${users.email}) = ${normalizedEmail}`)
    .limit(MAX_CREDENTIAL_CANDIDATES + 1);

  if (candidates.length === 0) {
    // Unknown addresses and OAuth-only users retain one dummy comparison.
    await compare(password, DUMMY_PASSWORD_HASH);
    return null;
  }
  if (candidates.length > MAX_CREDENTIAL_CANDIDATES) {
    await Promise.all(
      candidates.slice(0, MAX_CREDENTIAL_CANDIDATES).map((candidate) => compare(password, candidate.passwordHash)),
    );
    return null;
  }
  // Every candidate is checked. No first-row or first-password-match takeover.
  const matches = await Promise.all(candidates.map((candidate) => compare(password, candidate.passwordHash)));
  const matchingIndexes = matches.reduce<number[]>((indexes, matchesPassword, index) => {
    if (matchesPassword) indexes.push(index);
    return indexes;
  }, []);
  if (matchingIndexes.length !== 1) return null;
  const authenticated = candidates[matchingIndexes[0]];
  return { userId: authenticated.userId, createdAt: authenticated.createdAt };
}

/** Preserve the native registration bounds and error text; login has no new bounds. */
export function parseCurrentStorePasswordRegistration(
  body: Record<string, unknown>,
): { ok: true; registration: PasswordRegistration } | { ok: false; error: string } {
  const { email, password, name } = body;
  if (typeof email !== 'string' || email.trim().length === 0)
    return { ok: false, error: 'email and password are required' };
  const normalizedEmail = normalizeAccountEmail(email);
  if (!REGISTER_EMAIL_REGEX.test(normalizedEmail)) return { ok: false, error: 'Invalid email address' };
  if (typeof password !== 'string' || password.length === 0)
    return { ok: false, error: 'email and password are required' };
  if (password.length < PASSWORD_MIN_LENGTH) return { ok: false, error: 'Password must be at least 8 characters' };
  if (password.length > PASSWORD_MAX_LENGTH) return { ok: false, error: 'Password must be less than 128 characters' };

  let trimmedName: string | undefined;
  if (name !== undefined && name !== null) {
    if (typeof name !== 'string') return { ok: false, error: 'name must be a string' };
    const candidate = name.trim();
    if (candidate.length > NAME_MAX_LENGTH) return { ok: false, error: 'Name must be less than 100 characters' };
    if (candidate.length > 0) trimmedName = candidate;
  }
  return { ok: true, registration: { email: normalizedEmail, password, name: trimmedName } };
}

/**
 * Keep the existing exact-email precheck and bcrypt work before the transaction.
 * This is not a normalized reservation or a concurrent-registration guarantee.
 */
export async function prepareCurrentStorePasswordRegistration(
  database: PasswordIdentityReader,
  registration: PasswordRegistration,
): Promise<PreparedPasswordRegistration | null> {
  const { email, password, name } = registration;
  const existing = await database.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) return null;
  const passwordHash = await hash(password, BCRYPT_COST);
  return { email, name, passwordHash };
}

/**
 * Caller must use the same transaction for native refresh persistence. Keeping
 * the existing issuer in that transaction also rolls these writes back if mint
 * or signing fails. No provider account, verification token or session is added.
 */
export async function insertCurrentStorePasswordIdentity(
  transaction: PasswordIdentityTransaction,
  registration: PreparedPasswordRegistration,
  emailVerificationEnabled: boolean,
): Promise<{ userId: string; createdAt: Date }> {
  const { email, name, passwordHash } = registration;
  const userId = crypto.randomUUID();
  const createdAt = new Date();
  await transaction.insert(users).values({
    id: userId,
    createdAt,
    email,
    name: name ?? email.split('@')[0],
    emailVerified: emailVerificationEnabled ? null : new Date(),
  });
  await transaction.insert(userCredentials).values({ userId, passwordHash });
  await transaction.insert(userProfiles).values({ userId }).onConflictDoNothing();
  return { userId, createdAt };
}
