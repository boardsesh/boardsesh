/** Load Quantum SVG code only for a Quantum surface. The literal path lets Metro
 * include the module while leaving other board renderers' startup graph alone. */
export function loadQuantumBoardImage(): typeof import('./QuantumBoardImage').QuantumBoardImage {
  return (require('./QuantumBoardImage') as typeof import('./QuantumBoardImage')).QuantumBoardImage;
}
