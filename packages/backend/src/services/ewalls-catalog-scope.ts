import { QUANTUM_MODEL_BY_EWALLS_TYPE, QUANTUM_RELEASED_MODELS } from '@boardsesh/board-constants/quantum';
import type { EwallsScope } from '@boardsesh/quantum-sync';

type EwallsBoardType = keyof typeof QUANTUM_MODEL_BY_EWALLS_TYPE;
type ReleasedQuantumModel = (typeof QUANTUM_RELEASED_MODELS)[number];
const releasedModels: ReadonlySet<string> = new Set(QUANTUM_RELEASED_MODELS);

export const RELEASED_EWALLS_BOARD_TYPES = Object.keys(QUANTUM_MODEL_BY_EWALLS_TYPE).filter((type) =>
  releasedModels.has(QUANTUM_MODEL_BY_EWALLS_TYPE[type as EwallsBoardType]),
);

export function releasedEwallsModel(type: unknown): ReleasedQuantumModel {
  if (typeof type !== 'string' || !RELEASED_EWALLS_BOARD_TYPES.includes(type)) {
    throw new Error('Unsupported eWalls catalogue type');
  }
  return QUANTUM_MODEL_BY_EWALLS_TYPE[type as EwallsBoardType] as ReleasedQuantumModel;
}

export function validateEwallsScopes(scopes: readonly EwallsScope[]): void {
  const keys = new Set<string>();
  const board = scopes[0]?.board;
  for (const scope of scopes) {
    if (!scope || typeof scope.board !== 'string' || scope.board.length > 256 || scope.board !== board) {
      throw new Error('Invalid eWalls catalogue board');
    }
    releasedEwallsModel(scope.forcedType);
    const key = JSON.stringify([scope.board, scope.forcedType]);
    if (keys.has(key)) throw new Error('Duplicate eWalls catalogue scopes');
    keys.add(key);
  }
}
