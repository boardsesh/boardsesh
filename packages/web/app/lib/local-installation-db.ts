import { createIndexedDBStore } from './idb-helper';

const STORE_NAME = 'installation';
const INSTALLATION_ID_KEY = 'installation-id';

const getDB = createIndexedDBStore('boardsesh-local-installation', STORE_NAME);

function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID (very old Safari).
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

let cachedInstallationId: string | null = null;

export async function getInstallationId(): Promise<string | null> {
  if (cachedInstallationId) return cachedInstallationId;

  const db = await getDB();
  if (!db) return null;

  const existing = (await db.get(STORE_NAME, INSTALLATION_ID_KEY)) as string | undefined;
  if (existing) {
    cachedInstallationId = existing;
    return existing;
  }

  const fresh = randomUuid();
  await db.put(STORE_NAME, fresh, INSTALLATION_ID_KEY);
  cachedInstallationId = fresh;
  return fresh;
}
