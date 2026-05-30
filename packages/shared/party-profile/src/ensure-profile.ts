import type { PartyProfile, PartyProfileStorage } from './types';

/** Read the existing profile or create one and persist it. */
export async function ensureProfile(
  storage: PartyProfileStorage,
  generateId: () => string = defaultGenerateId,
): Promise<PartyProfile> {
  const existing = await storage.get();
  if (existing !== null) return existing;
  const created: PartyProfile = { id: generateId() };
  await storage.set(created);
  return created;
}

function defaultGenerateId(): string {
  const cryptoObj: { randomUUID?: () => string } | undefined =
    typeof globalThis !== 'undefined' && (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      ? (globalThis as { crypto: { randomUUID?: () => string } }).crypto
      : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}
