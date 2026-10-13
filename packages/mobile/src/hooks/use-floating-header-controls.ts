import { useEffectiveSurfaceMode } from './use-effective-surface-mode';
import { useOsAccessibilitySignals } from './use-os-accessibility-signals';

/**
 * Whether the controls pinned under a root tab's native bar may float over the
 * list as individual native glass surfaces, instead of sitting on a painted band.
 *
 * The native bar owns its scroll-edge material. Supplementary controls float
 * without a continuous custom blur only where that bar is real iOS 26 glass:
 *
 *   - surface mode `glass`: excludes Material, Android, the web, iOS before 26,
 *     and Reduce Transparency (which resolves to `solid`).
 *   - Increase Contrast known to be off. Higher contrast retains an opaque band
 *     to keep the controls clearly separated from list content.
 *
 * Both accessibility reads start on the opaque side: Reduce Transparency reads
 * `true` until the OS answers, and Increase Contrast reads `'unknown'`. So the
 * band can give way to floating controls after mount, never the other way round.
 */
export function useFloatingHeaderControls(): boolean {
  const surfaceMode = useEffectiveSurfaceMode();
  const { increaseContrast } = useOsAccessibilitySignals();
  return surfaceMode === 'glass' && increaseContrast === 'off';
}
