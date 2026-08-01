import { createOnceRunner, migrateSecureKeysToV2 } from './keychain-namespace-migration';
import { deleteSecureValue, readSecureValue, writeSecureValue } from './secure-store-io';

export const JWT_KEY = 'boardsesh_jwt';
export const REFRESH_TOKEN_KEY = 'boardsesh_refresh_token';
export const EXPIRES_AT_KEY = 'boardsesh_token_expires_at';
const CLEARED_CREDENTIAL = '__boardsesh_auth_credential_cleared__';
const AUTH_SECURE_KEYS = [JWT_KEY, REFRESH_TOKEN_KEY, EXPIRES_AT_KEY] as const;
let credentialGeneration = 0;
let credentialMutationQueue: Promise<void> = Promise.resolve();

class AuthCredentialCleanupError extends Error {
  readonly failures: readonly unknown[];

  constructor(message: string, failures: readonly unknown[]) {
    super(message);
    this.name = 'AuthCredentialCleanupError';
    this.failures = failures;
  }
}

// Copies the three credential keys into the v2 keychain namespace (#4103), which
// is the only way to reset their accessibility class so a locked-device
// background read stops failing. Serialized through the credential mutation queue
// so it can never interleave with a sign-in or sign-out write, and driven from
// getStoredCredential rather than a mounted component so it runs off the app's
// first token read — before AuthProvider has decided whether to render children.
//
// The migration treats the CLEARED_CREDENTIAL tombstone as an opaque value and
// carries it across unchanged: it must stay visible to getStoredCredential in v2,
// or a signed-out user whose deletion never physically landed would read the live
// legacy credential through the fallback and be signed back in.
const ensureAuthCredentialsMigrated = createOnceRunner(async () => {
  await serializeCredentialMutation(async () => {
    await migrateSecureKeysToV2(AUTH_SECURE_KEYS, 'auth');
  });
});

async function getStoredCredential(key: string): Promise<string | null> {
  // Best-effort. A keychain that refuses the migration refuses the read below
  // too, which is exactly today's behaviour — the migration must never change
  // the outcome of the read it precedes.
  await ensureAuthCredentialsMigrated().catch(() => undefined);
  const storedCredential = await readSecureValue(key);
  return storedCredential === CLEARED_CREDENTIAL ? null : storedCredential;
}

async function clearStoredCredential(key: string): Promise<void> {
  const failures: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // Clears BOTH namespaces. Deleting only v2 would let the legacy copy
      // resurface through readSecureValue's fallback on the next launch.
      await deleteSecureValue(key);
      // Deletion cannot be trusted from its result: expo-secure-store's iOS
      // deleteValueWithKeyAsync discards every SecItemDelete status and never
      // throws (SecureStoreModule.swift:43-51). That was survivable while one
      // item existed; across two namespaces a half-completed delete would leave
      // the legacy copy for the read fallback to find. Confirm by reading.
      if ((await readSecureValue(key)) === null) return;
    } catch (error) {
      failures.push(error);
    }
  }

  try {
    // Some keychain failures reject deletion while still permitting an overwrite.
    // Persist a value that every getter treats as absent so credentials cannot be
    // restored on relaunch merely because physical deletion was unavailable.
    // Written to v2 (and mirrored to legacy) so it shadows any legacy credential
    // the failed deletion left behind.
    await writeSecureValue(key, CLEARED_CREDENTIAL);
  } catch (error) {
    failures.push(error);
    throw new AuthCredentialCleanupError(`Failed to clear stored auth credential: ${key}`, failures);
  }
}

function serializeCredentialMutation<Result>(mutation: () => Promise<Result>): Promise<Result> {
  const result = credentialMutationQueue.then(mutation, mutation);
  credentialMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function writeCredentialForGeneration(generation: number, key: string, credential: string): Promise<boolean> {
  if (generation !== credentialGeneration) return false;
  await writeSecureValue(key, credential);
  return generation === credentialGeneration;
}

export async function getAuthToken(): Promise<string | null> {
  return getStoredCredential(JWT_KEY);
}

export async function getRefreshToken(): Promise<string | null> {
  return getStoredCredential(REFRESH_TOKEN_KEY);
}

export async function getTokenExpiresAt(): Promise<Date | null> {
  const value = await getStoredCredential(EXPIRES_AT_KEY);
  return value ? new Date(value) : null;
}

export function captureAuthCredentialGeneration(): number {
  return credentialGeneration;
}

export function isAuthCredentialGenerationCurrent(generation: number): boolean {
  return generation === credentialGeneration;
}

export function storeTokensForGeneration(
  generation: number,
  jwt: string,
  refreshToken: string,
  expiresAt: string,
): Promise<boolean> {
  return serializeCredentialMutation(async () => {
    // Write the JWT LAST so its presence is the commit marker: getAuthToken keys
    // "authenticated" off the JWT, so a partial write (or a generation change
    // mid-sequence) can only leave the JWT absent — a clean unauthenticated
    // state that re-syncs — never a JWT stranded without its refresh token.
    if (!(await writeCredentialForGeneration(generation, REFRESH_TOKEN_KEY, refreshToken))) return false;
    if (!(await writeCredentialForGeneration(generation, EXPIRES_AT_KEY, expiresAt))) return false;
    return writeCredentialForGeneration(generation, JWT_KEY, jwt);
  });
}

export async function storeTokens(jwt: string, refreshToken: string, expiresAt: string): Promise<void> {
  // A completed sign-in is a new credential owner, even when it follows a
  // signed-out generation whose SecureStore cleanup is still settling.
  credentialGeneration += 1;
  const generation = captureAuthCredentialGeneration();
  await storeTokensForGeneration(generation, jwt, refreshToken, expiresAt);
}

export function clearTokensForGeneration(generation: number): Promise<boolean> {
  if (!isAuthCredentialGenerationCurrent(generation)) return Promise.resolve(false);
  // Invalidate in-flight token writes synchronously, before deletion waits for
  // the serialized SecureStore mutation boundary.
  const clearedGeneration = generation + 1;
  credentialGeneration = clearedGeneration;
  return serializeCredentialMutation(async (): Promise<boolean> => {
    const results = await Promise.allSettled([
      clearStoredCredential(JWT_KEY),
      clearStoredCredential(REFRESH_TOKEN_KEY),
      clearStoredCredential(EXPIRES_AT_KEY),
    ]);
    const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (failures.length > 0) {
      // A newer sign-in queues its writes behind this cleanup but takes
      // generation ownership immediately. Its credentials will replace any
      // failed deletion/tombstone once this mutation settles, so the old
      // sign-out must neither report ownership nor surface its stale failure.
      if (!isAuthCredentialGenerationCurrent(clearedGeneration)) return false;
      throw new AuthCredentialCleanupError('Failed to clear one or more stored auth credentials', failures);
    }
    return isAuthCredentialGenerationCurrent(clearedGeneration);
  });
}

export async function clearTokens(): Promise<void> {
  await clearTokensForGeneration(captureAuthCredentialGeneration());
}

export async function isTokenExpiringSoon(): Promise<boolean> {
  const expiresAt = await getTokenExpiresAt();
  if (!expiresAt) return true;
  const oneDayMs = 24 * 60 * 60 * 1000;
  return expiresAt.getTime() - Date.now() < oneDayMs;
}
