import type { QuantumModelName } from '@boardsesh/board-constants/quantum';
import type { BackgroundVariant } from '../../lib/bundled-board-art';
import xlFull from './board-art/quantum-xl.webp';
import xlThumb from './board-art/quantum-xl-thumb.webp';
import lFull from './board-art/quantum-l.webp';
import lThumb from './board-art/quantum-l-thumb.webp';
import mFull from './board-art/quantum-m.webp';
import mThumb from './board-art/quantum-m-thumb.webp';
import fitnessFull from './board-art/quantum-s-fitness.webp';
import fitnessThumb from './board-art/quantum-s-fitness-thumb.webp';

const ARTWORK = {
  xl: { full: xlFull, thumb: xlThumb },
  l: { full: lFull, thumb: lThumb },
  m: { full: mFull, thumb: mThumb },
  s: { full: fitnessFull, thumb: fitnessThumb },
} satisfies Record<Exclude<QuantumModelName, 'belay'>, Record<BackgroundVariant, number>>;

export function getQuantumArtworkSource(model: QuantumModelName, variant: BackgroundVariant): number | null {
  return model === 'belay' ? null : ARTWORK[model][variant];
}
