export const AURA_GPU_FLAG = 'aura-gpu-enabled';
export const AURA_GPU_FAMILIES = [
  'kilter',
  'tension',
  'decoy',
  'touchstone',
  'grasshopper',
  'soill',
  'moonboard',
  'woods',
] as const;

type AuraGpuFamily = (typeof AURA_GPU_FAMILIES)[number];
export type AuraGpuRollout = {
  version: 1;
  enabledFamilies: readonly AuraGpuFamily[];
  disabledFamilies: readonly AuraGpuFamily[];
};

export const DEFAULT_AURA_GPU_ROLLOUT: AuraGpuRollout = {
  version: 1,
  enabledFamilies: [],
  disabledFamilies: [],
};

function isFamilyList(candidate: unknown): candidate is AuraGpuFamily[] {
  if (!Array.isArray(candidate) || candidate.length > AURA_GPU_FAMILIES.length) return false;
  for (const family of candidate) {
    if (typeof family !== 'string' || !AURA_GPU_FAMILIES.some((knownFamily) => knownFamily === family)) return false;
  }
  return true;
}

/** Malformed policy cannot accidentally enable a new family. */
export function parseAuraGpuRollout(payload: unknown): AuraGpuRollout {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return DEFAULT_AURA_GPU_ROLLOUT;
  const policy = payload as Record<string, unknown>;
  const { enabledFamilies, disabledFamilies = [] } = policy;
  if (policy.version !== 1 || !isFamilyList(enabledFamilies) || !isFamilyList(disabledFamilies))
    return DEFAULT_AURA_GPU_ROLLOUT;
  return {
    version: 1,
    enabledFamilies: AURA_GPU_FAMILIES.filter((family) => enabledFamilies.includes(family)),
    disabledFamilies: AURA_GPU_FAMILIES.filter((family) => disabledFamilies.includes(family)),
  };
}

/**
 * Precedence: remote kill switch (`flag === false`), then the climber's own
 * switch (`userEnabled`, Settings > Board > GPU acceleration), then the rollout.
 * `userEnabled` can only turn the GPU off, never force it on.
 */
export function auraGpuRolloutEnabled(input: {
  flag: boolean | string | undefined;
  policy: AuraGpuRollout;
  userEnabled: boolean;
  boardName?: string;
  layoutId?: number;
}): boolean {
  if (input.flag === false || !input.userEnabled) return false;
  // The no-board form answers the emergency switch only, for existing callers.
  const boardName = input.boardName;
  if (!boardName) return true;
  const family = AURA_GPU_FAMILIES.find((knownFamily) => knownFamily === boardName.toLowerCase());
  if (!family || input.policy.disabledFamilies.includes(family)) return false;
  return (
    (family === 'kilter' && input.layoutId === 8) ||
    (input.flag === true && input.policy.enabledFamilies.includes(family))
  );
}
