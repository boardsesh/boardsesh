import xlFull from './board-art/quantum-xl.webp';
import xlThumb from './board-art/quantum-xl-thumb.webp';
import lFull from './board-art/quantum-l.webp';
import lThumb from './board-art/quantum-l-thumb.webp';
import mFull from './board-art/quantum-m.webp';
import mThumb from './board-art/quantum-m-thumb.webp';
import fitnessFull from './board-art/quantum-s-fitness.webp';
import fitnessThumb from './board-art/quantum-s-fitness-thumb.webp';

/** Keep literal asset imports so Metro bundles both standard background variants. */
export const QUANTUM_BACKGROUND_ASSETS: Record<string, number> = {
  'quantum/quantum-xl.webp': xlFull,
  'quantum/thumbs/quantum-xl.webp': xlThumb,
  'quantum/quantum-l.webp': lFull,
  'quantum/thumbs/quantum-l.webp': lThumb,
  'quantum/quantum-m.webp': mFull,
  'quantum/thumbs/quantum-m.webp': mThumb,
  'quantum/quantum-s-fitness.webp': fitnessFull,
  'quantum/thumbs/quantum-s-fitness.webp': fitnessThumb,
};
