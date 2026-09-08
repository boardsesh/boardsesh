// The namespace stamp: the per-key record that lets the migration tell a STALE v2
// copy from a fresh one (#5345).
//
// Phase 1 of #4103 runs two keychain namespaces at once and reads v2 first. That
// is correct while v2 is always the newer copy, and it stops being true the moment
// a bundle is rolled back: JS that predates #4127 reads and writes the LEGACY
// namespace only, so a token refresh on the rolled-back build lands a new JWT and a
// rotated refresh token in legacy while v2 keeps the pre-rollback pair. Roll
// forward and readSecureValue hands back the stale v2 pair, whose refresh token the
// backend already revoked — a 401 and a forced sign-out. migrateKey could not
// repair it either, because the presence of a v2 item was the only "already
// migrated" signal it had.
//
// A plain counter cannot fix that, and this is the crux of the design: the
// rolled-back build knows nothing about generations, so it never bumps one. Its
// write is invisible to any marker it does not itself maintain. What IS visible is
// that the value it left behind is not the value WE left behind.
//
// So the stamp records, per namespace, a fingerprint of the content an aware build
// last put there:
//
//   string    — we left this fingerprint there
//   null      — we left it empty
//   undefined — we do not know (our write or delete could not be confirmed)
//
// and the rule that falls out of it is:
//
//   a namespace whose current content disagrees with the stamp was last written by
//   a build that does not maintain stamps, i.e. one running AFTER our stamp — so
//   its content is the newer one.
//
// Everything else is conservative in the same direction: no stamp, an unreadable
// stamp, or an `undefined` side all resolve to "v2 wins", which is exactly today's
// behaviour and keeps #4127's resurrection guard intact — a v2 tombstone written
// while the legacy write was rejected records `legacy: undefined`, so a live legacy
// credential can never out-rank it.
//
// The stamp lives in the v2 namespace ONLY, as its own key, and never inside the
// value:
//
//   * Its own key, because keychainAccessible is applied at insert time and
//     expo-secure-store's update() sends kSecValueData alone
//     (SecureStoreModule.swift:127-144) — but more importantly because wrapping a
//     value in an envelope would hand a rolled-back build JSON where it expects a
//     JWT. Bare values in both namespaces is what keeps every older bundle, #4127's
//     included, able to read what we write.
//   * v2 only, because legacy items are WHEN_UNLOCKED and reject on exactly the
//     locked devices this whole migration exists for. A stamp that cannot be read
//     when it is needed is worse than no stamp; v2 is AFTER_FIRST_UNLOCK. It also
//     leaves phase 2 (#4128) nothing extra to clean up in legacy.
//
// Phase 2 deletes the legacy copies and collapses the read to a single v2 call. At
// that point there is no second namespace to disagree with and this module can go
// with it. See docs/keychain-namespaces.md.

import * as SecureStore from 'expo-secure-store';
import { SECURE_STORE_V2_OPTIONS, USES_V2_NAMESPACE } from './secure-store-options';

/**
 * Suffix for the stamp's own SecureStore key.
 *
 * Never collides with a real key: every migrated key is a `boardsesh_*` or
 * `*_override` literal owned by a store, and `secure-store-stamp.test.ts` pins that
 * none of them ends in this suffix. Stamp keys are themselves never migrated — they
 * only ever exist in v2, where every write is already a fresh insert.
 */
export const NAMESPACE_STAMP_SUFFIX = '.nsgen';

/**
 * What an aware build last left in one namespace: a fingerprint, `null` for
 * "deliberately empty", or `undefined` for "could not be confirmed".
 */
export type NamespaceContent = string | null | undefined;

export type SecureNamespaceStamp = {
  /**
   * Monotonic per-key count of aware writes. Nothing in the freshness decision
   * reads it — disagreement with the fingerprints is what carries the ordering —
   * but it is what a human comparing two devices at 2am has to go on, and it rides
   * along in the migration's analytics event.
   */
  generation: number;
  v2: NamespaceContent;
  legacy: NamespaceContent;
};

/** Whether v2 or legacy holds the newer value for a key present in both. */
export type NamespaceVerdict = 'v2-current' | 'legacy-newer';

export function namespaceStampKey(key: string): string {
  return `${key}${NAMESPACE_STAMP_SUFFIX}`;
}

/**
 * A short, stable fingerprint of a stored value — FNV-1a over the code units,
 * prefixed with the length.
 *
 * Not a cryptographic digest and does not need to be: it is compared only against
 * another fingerprint of a value already sitting in the same keychain, and the one
 * thing riding on it is "did somebody else write this". A collision would make us
 * miss a repair and fall back to today's v2-wins behaviour, never invent one, so
 * the failure direction is the safe one. It is also synchronous, which expo-crypto
 * is not — this runs on the app's first token read.
 */
export function fingerprintSecureValue(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return `${value.length}.${(hash >>> 0).toString(36)}`;
}

type StampPayload = { g: number; v2?: string | null; l?: string | null };

export function serializeNamespaceStamp(stamp: SecureNamespaceStamp): string {
  const payload: StampPayload = { g: stamp.generation };
  // An omitted field is the wire form of `undefined` — "we do not know" — and it
  // must stay distinguishable from an explicit null, which means "we left it
  // empty". Collapsing the two would let a rejected legacy write read back as a
  // confirmed empty namespace, and a live credential would then out-rank a
  // tombstone.
  if (stamp.v2 !== undefined) payload.v2 = stamp.v2;
  if (stamp.legacy !== undefined) payload.l = stamp.legacy;
  return JSON.stringify(payload);
}

function contentFrom(record: Record<string, unknown>, field: string): NamespaceContent {
  if (!(field in record)) return undefined;
  const stored = record[field];
  if (stored === null) return null;
  return typeof stored === 'string' ? stored : undefined;
}

export function parseNamespaceStamp(raw: string | null): SecureNamespaceStamp | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A stamp we cannot read is a stamp we do not have. Falls through to
    // "v2 wins", today's behaviour.
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  return {
    generation: typeof record.g === 'number' ? record.g : 0,
    v2: contentFrom(record, 'v2'),
    legacy: contentFrom(record, 'l'),
  };
}

/**
 * Which namespace holds the newer value, for a key that exists in both with
 * DIFFERENT content.
 *
 * Every unknown resolves to `v2-current`, so the only way to reach `legacy-newer`
 * is a stamp that positively contradicts what legacy holds while still matching
 * what v2 holds — the rolled-back-build signature.
 */
export function resolveNamespaceVerdict(
  stamp: SecureNamespaceStamp | null,
  v2Value: string,
  legacyValue: string,
): NamespaceVerdict {
  // No stamp at all: a device that has not written anything since this shipped.
  // Indistinguishable from the pre-#5345 world, and treated as it.
  if (stamp === null) return 'v2-current';
  // v2 moved since our stamp. Only a v2-aware build writes v2, and every one of
  // those writes v2 FIRST and then mirrors — so if the two namespaces disagree it
  // is because that build's legacy mirror was rejected, and v2 is the newer half.
  if (stamp.v2 !== fingerprintSecureValue(v2Value)) return 'v2-current';
  // We could not confirm what our own last write left in legacy. This is the
  // tombstone case #4127's final commit exists for: sign-out landed the tombstone
  // in v2 while the legacy write was rejected on a locked device, so legacy still
  // holds the live credential it was meant to retire. It must not out-rank v2.
  if (stamp.legacy === undefined) return 'v2-current';
  // Legacy is exactly as an aware build left it (a fingerprint match), or has
  // changed under a build that maintains no stamps — which can only be JS that
  // predates the v2 namespace, running after our stamp.
  return stamp.legacy === fingerprintSecureValue(legacyValue) ? 'v2-current' : 'legacy-newer';
}

// Generation of the last stamp this process wrote, per key. Saves one keychain
// read per write after the first; a cold start still reads the stored stamp so the
// counter carries across launches. Only the counter is cached — never a value or a
// fingerprint, which would go stale the moment another process wrote.
const lastWrittenGeneration = new Map<string, number>();

async function readStoredStamp(key: string): Promise<SecureNamespaceStamp | null> {
  return parseNamespaceStamp(await SecureStore.getItemAsync(namespaceStampKey(key), SECURE_STORE_V2_OPTIONS));
}

/** Read a key's stamp. Resolves null when there is none, or it cannot be read. */
export async function readNamespaceStamp(key: string): Promise<SecureNamespaceStamp | null> {
  if (!USES_V2_NAMESPACE) return null;
  try {
    return await readStoredStamp(key);
  } catch {
    return null;
  }
}

async function nextGeneration(key: string): Promise<number> {
  const cached = lastWrittenGeneration.get(key);
  if (cached !== undefined) return cached + 1;
  const stored = await readNamespaceStamp(key);
  return (stored?.generation ?? 0) + 1;
}

/**
 * Record what this write left in each namespace. Best-effort and never throws: a
 * missing or stale stamp only ever costs a repair we could have made, and the whole
 * point of the caller reaching here is that its real write already landed.
 *
 * No-op off iOS, where there is only one namespace and nothing to compare.
 */
export async function writeNamespaceStamp(key: string, v2: NamespaceContent, legacy: NamespaceContent): Promise<void> {
  if (!USES_V2_NAMESPACE) return;
  try {
    const generation = await nextGeneration(key);
    await SecureStore.setItemAsync(
      namespaceStampKey(key),
      serializeNamespaceStamp({ generation, v2, legacy }),
      SECURE_STORE_V2_OPTIONS,
    );
    lastWrittenGeneration.set(key, generation);
  } catch {
    // A locked v2 namespace means the value write next to it failed too.
  }
}

/** Drop a key's stamp, for a delete that verified both namespaces are empty. */
export async function clearNamespaceStamp(key: string): Promise<void> {
  if (!USES_V2_NAMESPACE) return;
  lastWrittenGeneration.delete(key);
  await SecureStore.deleteItemAsync(namespaceStampKey(key), SECURE_STORE_V2_OPTIONS);
}
