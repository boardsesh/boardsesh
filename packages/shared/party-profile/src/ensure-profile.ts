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
  // All targeted runtimes provide `crypto.randomUUID`: browsers since 2020,
  // Node ≥14.17, Hermes ≥RN 0.74. A silent fallback to `Date.now() + Math.random()`
  // would mask real provisioning bugs (missing polyfill, wrong globalThis,
  // unexpected sandbox) by handing out non-UUID strings — fail loud instead.
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!cryptoObj || typeof cryptoObj.randomUUID !== 'function') {
    throw new Error('crypto.randomUUID unavailable — party profile cannot generate an id');
  }
  return cryptoObj.randomUUID();
}
