import { AURA_COMPRESSED_BUDGET_BYTES, AURA_GENERATED_BUDGET_BYTES, AURA_GENERATED_MAX_ENTRIES } from './manifest';

export type AuraCacheKind = 'compressed' | 'generated';
export type AuraCacheFile = Readonly<{
  key: string;
  bytes: number;
  lastUsed: number;
  offline: boolean;
  /** Stable prefetch order prevents background work evicting its first board. */
  priority?: number;
}>;

/** Both ceilings apply; pinning offline boards is a preference, never an exemption. */
export function selectAuraCacheSurvivors(files: readonly AuraCacheFile[], kind: AuraCacheKind): Set<string> {
  const budget = kind === 'compressed' ? AURA_COMPRESSED_BUDGET_BYTES : AURA_GENERATED_BUDGET_BYTES;
  const countLimit = kind === 'generated' ? AURA_GENERATED_MAX_ENTRIES : Number.MAX_SAFE_INTEGER;
  const prioritized = [...files].sort(
    (left, right) =>
      Number(right.offline) - Number(left.offline) ||
      (right.priority ?? 0) - (left.priority ?? 0) ||
      right.lastUsed - left.lastUsed ||
      left.key.localeCompare(right.key),
  );
  let retainedBytes = 0;
  const survivors = new Set<string>();
  for (const file of prioritized) {
    if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !Number.isFinite(file.lastUsed)) continue;
    if (survivors.has(file.key) || survivors.size === countLimit || file.bytes > budget - retainedBytes) continue;
    survivors.add(file.key);
    retainedBytes += file.bytes;
  }
  return survivors;
}
