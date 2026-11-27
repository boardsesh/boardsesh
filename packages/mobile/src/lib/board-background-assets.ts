import { BOARD_BACKGROUND_ASSETS as GENERATED_BOARD_BACKGROUND_ASSETS } from './board-backgrounds-manifest';
import { QUANTUM_BACKGROUND_ASSETS } from '../components/quantum/quantum-board-artwork';

/** Shared by variant selection and native file materialization. */
export const BOARD_BACKGROUND_ASSETS: Record<string, number> = {
  ...GENERATED_BOARD_BACKGROUND_ASSETS,
  ...QUANTUM_BACKGROUND_ASSETS,
};
