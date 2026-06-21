import { useEffectiveSurfaceMode } from './use-effective-surface-mode';

/**
 * Whether the real iOS 26 Liquid Glass path is active — i.e. `GlassSurface`
 * renders a native `GlassView` rather than the blur/material/solid fallback.
 * Native glass draws its own refractive edge, so on this path components drop
 * their hand-drawn hairline borders and separation shadows (those belong to the
 * other paths, where the surface has no intrinsic edge). Because this is false
 * for the Material variant, chrome automatically re-adds its border + elevation
 * in Material mode, which is exactly what a flat M3 surface wants.
 *
 * Thin wrapper over `useEffectiveSurfaceMode()` so the chrome and `GlassSurface`
 * always agree on the active path.
 */
export function useNativeGlass(): boolean {
  return useEffectiveSurfaceMode() === 'glass';
}
