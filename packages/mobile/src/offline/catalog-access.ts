import type { SqlExecutor } from '@boardsesh/offline-sync';
let authGenerationIsCurrent: ((generation: number) => boolean) | null = null;
let observedCredentialGeneration: number | null = null;

export const CATALOG_VIEWER_KEY = 'privacy:catalog-viewer:v1';
type CatalogCredential = { generation: number; digest: string };
let catalogEpoch = 0;
let catalogBlocked = false;
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

export async function stampCatalogViewer(
  db: SqlExecutor,
  viewerId: string,
  credential: CatalogCredential | null,
): Promise<void> {
  if (!isCatalogCredentialCurrent(credential)) throw new Error('Account changed during catalogue revalidation');
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    CATALOG_VIEWER_KEY,
    JSON.stringify({ viewerId, credentialDigest: credential!.digest }),
  ]);
  if (!isCatalogCredentialCurrent(credential)) throw new Error('Account changed during catalogue revalidation');
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
