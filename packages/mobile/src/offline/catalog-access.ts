import type { SqlExecutor } from '@boardsesh/offline-sync';
let authGenerationIsCurrent: ((generation: number) => boolean) | null = null;
let observedCredentialGeneration: number | null = null;

export const CATALOG_VIEWER_KEY = 'privacy:catalog-viewer:v1';
/**
 * Written instead of the viewer marker when a revalidation for this credential
 * had to keep another account's rows (possible unsynced work, or rows a queued
 * write names). Reads stay closed; a later check counts only those rows and
 * stamps the marker once none are left, without withdrawing anything again.
 */
export const CATALOG_HELD_KEY = 'privacy:catalog-held:v1';
type CatalogCredential = { generation: number; digest: string };
let catalogEpoch = 0;
let catalogBlocked = false;
const credentialMismatchListeners = new Set<() => void>();

/** A refreshed token needs fresh server authorization before using old downloads. */
export function subscribeCatalogCredentialMismatch(listener: () => void): () => void {
  credentialMismatchListeners.add(listener);
  return () => {
    credentialMismatchListeners.delete(listener);
  };
}
export function beginCatalogInvalidation(): void {
  catalogEpoch += 1;
  catalogBlocked = true;
}
export function finishCatalogInvalidation(): void {
  catalogBlocked = false;
}
export function captureCatalogReadEpoch(): number {
  return catalogEpoch;
}
export function isCatalogReadCurrent(epoch: number): boolean {
  return !catalogBlocked && epoch === catalogEpoch;
}

/** Match a credential previously accepted by the server, never a decoded JWT claim. */
export async function captureCatalogCredential(): Promise<CatalogCredential | null> {
  const { captureAuthCredentialGeneration, getAuthToken, isAuthCredentialGenerationCurrent } =
    await import('../lib/auth-store');
  authGenerationIsCurrent = isAuthCredentialGenerationCurrent;
  const generation = captureAuthCredentialGeneration();
  if (observedCredentialGeneration !== null && observedCredentialGeneration !== generation) catalogEpoch += 1;
  observedCredentialGeneration = generation;
  const token = await getAuthToken();
  if (!token || !isAuthCredentialGenerationCurrent(generation)) return null;
  const { digestStringAsync, CryptoDigestAlgorithm } = await import('expo-crypto');
  const digest = await digestStringAsync(CryptoDigestAlgorithm.SHA256, token);
  return isAuthCredentialGenerationCurrent(generation) ? { generation, digest } : null;
}

export function isCatalogCredentialCurrent(credential: CatalogCredential | null): boolean {
  return credential !== null && authGenerationIsCurrent?.(credential.generation) === true;
}

async function writeCatalogViewerRecord(
  db: SqlExecutor,
  key: typeof CATALOG_VIEWER_KEY | typeof CATALOG_HELD_KEY,
  viewerId: string,
  credential: CatalogCredential | null,
): Promise<void> {
  if (!isCatalogCredentialCurrent(credential) || (await captureCatalogCredential())?.digest !== credential?.digest) {
    throw new Error('Account changed during catalogue revalidation');
  }
  const otherKey = key === CATALOG_VIEWER_KEY ? CATALOG_HELD_KEY : CATALOG_VIEWER_KEY;
  await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [otherKey]);
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    key,
    JSON.stringify({ viewerId, credentialDigest: credential!.digest }),
  ]);
  if (!isCatalogCredentialCurrent(credential) || (await captureCatalogCredential())?.digest !== credential?.digest) {
    throw new Error('Account changed during catalogue revalidation');
  }
}

/** Open local catalogue reads for this credential. */
export function stampCatalogViewer(
  db: SqlExecutor,
  viewerId: string,
  credential: CatalogCredential | null,
): Promise<void> {
  return writeCatalogViewerRecord(db, CATALOG_VIEWER_KEY, viewerId, credential);
}

/** Keep local catalogue reads closed for this credential only while kept rows remain. */
export function holdCatalogViewer(
  db: SqlExecutor,
  viewerId: string,
  credential: CatalogCredential | null,
): Promise<void> {
  return writeCatalogViewerRecord(db, CATALOG_HELD_KEY, viewerId, credential);
}

/** The held record, when it names this viewer and the exact credential being checked. */
export async function isCatalogHeldFor(
  db: SqlExecutor,
  viewerId: string,
  credential: CatalogCredential,
): Promise<boolean> {
  const record = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    CATALOG_HELD_KEY,
  ]);
  if (!record) return false;
  const parsed = JSON.parse(record.value) as { viewerId?: unknown; credentialDigest?: unknown };
  return parsed.viewerId === viewerId && parsed.credentialDigest === credential.digest;
}

/** Resolve only an identity already checked by the server for this exact credential. */
export async function getAuthorizedCatalogViewerId(db: SqlExecutor): Promise<string | null> {
  try {
    const epoch = captureCatalogReadEpoch();
    if (!isCatalogReadCurrent(epoch)) return null;
    const credential = await captureCatalogCredential();
    if (!credential) return null;
    const marker = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
      CATALOG_VIEWER_KEY,
    ]);
    if (!marker) return null;
    const parsed = JSON.parse(marker.value) as { viewerId?: unknown; credentialDigest?: unknown };
    if (
      parsed.credentialDigest !== credential.digest &&
      isCatalogCredentialCurrent(credential) &&
      isCatalogReadCurrent(epoch)
    ) {
      // A marker read can straddle token refresh without an account-generation
      // change. Only the current read may request repair of this credential.
      const currentCredential = await captureCatalogCredential();
      if (currentCredential?.digest === credential.digest && isCatalogReadCurrent(epoch)) {
        for (const listener of credentialMismatchListeners) listener();
      }
    }
    return typeof parsed.viewerId === 'string' &&
      parsed.viewerId.length > 0 &&
      parsed.credentialDigest === credential.digest &&
      isCatalogCredentialCurrent(credential) &&
      isCatalogReadCurrent(epoch)
      ? parsed.viewerId
      : null;
  } catch {
    return null;
  }
}

/** A failed cleanup or account handover cannot turn a downloaded copy into public data. */
export async function canReadPrivateCatalog(db: SqlExecutor): Promise<boolean> {
  return (await getAuthorizedCatalogViewerId(db)) !== null;
}

/**
 * Where the signed-in credential stands with the downloaded catalogue:
 *
 * - `stamped`: a viewer marker exists. It may name an older credential; a read
 *   reports that through `subscribeCatalogCredentialMismatch`.
 * - `held`: a revalidation for this viewer and credential left reads closed only
 *   for the rows it had to keep.
 * - `unstamped`: nothing covers this credential: a new install, a catalogue
 *   wiped at sign-out, a bundle that never stamped one, a withdrawal that never
 *   finished, or a held record for another account or token.
 *
 * Null when no credential can be read.
 */
export async function readCatalogStamp(
  db: SqlExecutor,
  viewerId: string,
): Promise<'stamped' | 'held' | 'unstamped' | null> {
  try {
    const credential = await captureCatalogCredential();
    if (!credential) return null;
    const marker = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
      CATALOG_VIEWER_KEY,
    ]);
    if (marker) return 'stamped';
    const held = await isCatalogHeldFor(db, viewerId, credential);
    if (!isCatalogCredentialCurrent(credential)) return null;
    return held ? 'held' : 'unstamped';
  } catch {
    return null;
  }
}
