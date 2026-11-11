import crypto from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { ABSENT_PASSWORD_HASH, PASSWORD_HASH_COST } from '@boardsesh/auth-protocol/password-hash';
import type { DbInstance } from '@boardsesh/db/client';
import { authSubjectCutoffs, users, userCredentials, userProfiles } from '@boardsesh/db/schema/auth';
import { normalizeAccountEmail } from '../normalize-email';

type PasswordIdentityReader = Pick<DbInstance, 'select'>;
type PasswordIdentityTransaction = Parameters<Parameters<DbInstance['transaction']>[0]>[0];

export const MAX_CURRENT_STORE_PASSWORD_CANDIDATES = 8;
const REGISTER_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const NAME_MAX_LENGTH = 100;

interface PasswordRegistration {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
}

export interface PreparedPasswordRegistration {
  readonly email: string;
  readonly passwordHash: string;
  readonly name?: string;
}

export interface CurrentStorePasswordCandidate {
  readonly userId: string;
  readonly passwordHash: string;
  readonly createdAt: Date;
}

/**
 * One bounded comparison engine; callers own their explicit legacy lookup policy.
 * An address with no password still runs one comparison at the stored cost, so
 * it takes as long to reject as an address with a wrong password.
 */
export async function matchCurrentStorePasswordCandidate(
  candidates: readonly CurrentStorePasswordCandidate[],
  password: string,
): Promise<{ userId: string; createdAt: Date } | null> {
  const snapshot = candidates.map((candidate) => ({
    userId: candidate.userId,
    passwordHash: candidate.passwordHash,
    createdAt: candidate.createdAt instanceof Date ? new Date(candidate.createdAt.getTime()) : candidate.createdAt,
  }));
  if (snapshot.length === 0) {
    await compare(password, ABSENT_PASSWORD_HASH);
    return null;
  }
  if (snapshot.length > MAX_CURRENT_STORE_PASSWORD_CANDIDATES) {
    await Promise.all(
      snapshot
        .slice(0, MAX_CURRENT_STORE_PASSWORD_CANDIDATES)
        .map((candidate) => compare(password, candidate.passwordHash)),
    );
    return null;
  }
  const matches = await Promise.all(snapshot.map((candidate) => compare(password, candidate.passwordHash)));
  const matchingIndexes = matches.reduce<number[]>((indexes, matchesPassword, index) => {
    if (matchesPassword) indexes.push(index);
    return indexes;
  }, []);
  if (matchingIndexes.length !== 1) return null;
  const authenticated = snapshot[matchingIndexes[0]];
  return { userId: authenticated.userId, createdAt: authenticated.createdAt };
}

/**
 * What a password check proved, read before bcrypt. The issuer compares it with
 * the same row under its user lock and refuses on any difference, so a check
 * that passed before a reset cannot issue after it (BA-04 section 4).
 */
export interface VerifiedPasswordSnapshot {
  readonly userId: string;
  readonly createdAt: Date;
  readonly passwordHash: string;
  /** `auth_subject_cutoffs.generation`, 0 with no row. */
  readonly generation: number;
}

/** Current-store password verification only; no credential issuance or mutation. */
export async function authenticateCurrentStorePassword(
  database: PasswordIdentityReader,
  email: string,
  password: string,
): Promise<VerifiedPasswordSnapshot | null> {
  const normalizedEmail = normalizeAccountEmail(email);
  // Preserve exact case-insensitive matching, including literal '_' and '%'.
  // Historic duplicate-by-case rows remain independently owned accounts.
  // The cutoff join adds no statement: the generation rides the candidate read.
  const candidates = await database
    .select({
      userId: users.id,
      passwordHash: userCredentials.passwordHash,
      createdAt: users.createdAt,
      generation: authSubjectCutoffs.generation,
    })
    .from(users)
    .innerJoin(userCredentials, eq(userCredentials.userId, users.id))
    .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, users.id))
    .where(sql`LOWER(${users.email}) = ${normalizedEmail}`)
    .limit(MAX_CURRENT_STORE_PASSWORD_CANDIDATES + 1);
  const matched = await matchCurrentStorePasswordCandidate(candidates, password);
  const proved = matched ? candidates.find((candidate) => candidate.userId === matched.userId) : undefined;
  if (!matched || !proved) return null;
  return {
    userId: matched.userId,
    createdAt: matched.createdAt,
    passwordHash: proved.passwordHash,
    generation: proved.generation ?? 0,
  };
}

/** Shared native creation email policy; subjects and login passwords are separate. */
export function parseCurrentStoreRegistrationEmail(
  email: unknown,
): { ok: true; email: string } | { ok: false; error: string } {
  if (typeof email !== 'string' || email.trim().length === 0)
    return { ok: false, error: 'email and password are required' };
  const normalizedEmail = normalizeAccountEmail(email);
  if (!REGISTER_EMAIL_REGEX.test(normalizedEmail)) return { ok: false, error: 'Invalid email address' };
  return { ok: true, email: normalizedEmail };
}

/** Preserve the native registration bounds and error text; login has no new bounds. */
export function parseCurrentStorePasswordRegistration(
  body: Record<string, unknown>,
): { ok: true; registration: PasswordRegistration } | { ok: false; error: string } {
  const { email, password, name } = body;
  const parsedEmail = parseCurrentStoreRegistrationEmail(email);
  if (!parsedEmail.ok) return parsedEmail;
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
  return { ok: true, registration: { email: parsedEmail.email, password, name: trimmedName } };
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
  const passwordHash = await hash(password, PASSWORD_HASH_COST);
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
  reservedUserId?: string,
): Promise<{ userId: string; createdAt: Date }> {
  const { email, name, passwordHash } = registration;
  // Only a trusted backend stage may supply the ID it just reserved. Legacy
  // callers omit it and retain the existing server-generated ID behavior.
  const userId = reservedUserId ?? crypto.randomUUID();
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
