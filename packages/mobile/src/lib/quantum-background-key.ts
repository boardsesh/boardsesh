import type { QuantumModelName } from '@boardsesh/board-constants/quantum';

/** The released photographs use the standard bundled-board-art key convention. */
export function getQuantumBackgroundImageKey(model: QuantumModelName): string | null {
  return model === 'belay' ? null : `quantum/quantum-${model === 's' ? 's-fitness' : model}.webp`;
}
