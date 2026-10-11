import { useEffectiveSurfaceMode } from './use-effective-surface-mode';
import { useOsAccessibilitySignals } from './use-os-accessibility-signals';

/**
 * Whether the controls pinned under a root tab's native bar may float over the
 * list, with a blur behind them, instead of sitting on a painted band.
 *
 * HIG Layout: "Instead of applying a solid or semi-opaque background color
 * beneath controls, use a scroll edge effect to visually elevate controls above
 * content." That holds only where the bar above them is real iOS 26 glass:
 *
 *   - surface mode `glass`: excludes Material, Android, the web, iOS before 26,
 *     and Reduce Transparency (which resolves to `solid`).
 *   - Increase Contrast known to be off. The blur is ours, so unlike the system's
 *     glass it does not firm itself up when the climber asks for more contrast.
 *
 * Both accessibility reads start on the opaque side: Reduce Transparency reads
 * `true` until the OS answers, and Increase Contrast reads `'unknown'`. So the
 * band can give way to the blur a frame after mount, never the other way round.
 */
export function useFloatingHeaderControls(): boolean {
  const surfaceMode = useEffectiveSurfaceMode();
  const { increaseContrast } = useOsAccessibilitySignals();
  return surfaceMode === 'glass' && increaseContrast === 'off';
}
