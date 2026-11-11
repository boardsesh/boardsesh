import { AuthAdmissionUnavailableError } from '../human-admission';
import type { DbInstance } from '@boardsesh/db/client';
import { users } from '@boardsesh/db/schema';
import { sql } from 'drizzle-orm';
import { normalizeAccountEmail } from '../normalize-email';
import { CURRENT_EMAIL_NORMALIZER_VERSION, lockIdentityManifest } from '../current-store/foundation-context';
import { transactionSettings } from '../current-store/command-context';
import {
  MAX_CURRENT_STORE_PASSWORD_CANDIDATES,
  matchCurrentStorePasswordCandidate,
  readCurrentStorePasswordCandidates,
  type VerifiedPasswordSnapshot,
} from '../current-store/password-identity';
import { bindIdentityAuthority } from './identity-authority';
import { captureIdentityAuthority, type IdentityAuthorityReceipt } from './router';
import { verifyAuthorityPassword } from './authority';

export interface VerifiedIdentityPasswordSnapshot extends VerifiedPasswordSnapshot {
  readonly authorityReceipt?: IdentityAuthorityReceipt;
}

/** Select the writer and snapshot atomically; no bcrypt runs in a transaction. */
async function authenticate(
  database: DbInstance,
  email: string,
  password: string,
): Promise<VerifiedIdentityPasswordSnapshot | null> {
  const normalizedEmail = normalizeAccountEmail(email);
  const snapshot = await database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    const manifest = await lockIdentityManifest(transaction);
    if (!manifest || manifest.phase !== 'enforced') {
      if (manifest?.writerAuthority === 'better-auth') throw new Error('IDENTITY_AUTHORITY_NOT_ENFORCED');
      return { candidates: await readCurrentStorePasswordCandidates(transaction, email), authorityReceipt: undefined };
    }
    const authorityReceipt = await captureIdentityAuthority(transaction, {
      expectedProjectionId: manifest.projectionId,
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
    });
    if (authorityReceipt.authority === 'current-store')
      return { candidates: await readCurrentStorePasswordCandidates(transaction, email), authorityReceipt };
    const identity = bindIdentityAuthority(transaction, authorityReceipt);
    const owners = await transaction
      .select({ userId: users.id, email: users.email, createdAt: users.createdAt })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`)
      .limit(MAX_CURRENT_STORE_PASSWORD_CANDIDATES + 1);
    const candidates: Array<{ userId: string; passwordHash: string; createdAt: Date; generation: number }> = [];
    for (const owner of owners) {
      if (owner.email !== normalizeAccountEmail(owner.email)) throw new Error('IDENTITY_NORMALIZED_EMAIL_REQUIRED');
      const credential = await identity.readPassword(owner.userId);
      if (credential) candidates.push({ ...credential, createdAt: owner.createdAt });
    }
    return { candidates, authorityReceipt };
  });
  const verifier =
    snapshot.authorityReceipt?.authority === 'better-auth'
      ? (passwordHash: string, submittedPassword: string) =>
          verifyAuthorityPassword({ hash: passwordHash, password: submittedPassword })
      : undefined;
  const matched = await matchCurrentStorePasswordCandidate(snapshot.candidates, password, verifier);
  const proved = matched ? snapshot.candidates.find((candidate) => candidate.userId === matched.userId) : undefined;
  if (!matched || !proved) return null;
  return {
    userId: matched.userId,
    createdAt: matched.createdAt,
    passwordHash: proved.passwordHash,
    generation: proved.generation ?? 0,
    ...(snapshot.authorityReceipt ? { authorityReceipt: snapshot.authorityReceipt } : {}),
  };
}

/** Never expose decoder, SQL parameters or credential evidence to the HTTP logger. */
export async function authenticateIdentityPassword(
  database: DbInstance,
  email: string,
  password: string,
): Promise<VerifiedIdentityPasswordSnapshot | null> {
  try {
    if (process.env.DEBUG_SQL === 'true') throw new Error('Unsafe identity SQL logging');
    return await authenticate(database, email, password);
  } catch {
    throw new AuthAdmissionUnavailableError();
  }
}
