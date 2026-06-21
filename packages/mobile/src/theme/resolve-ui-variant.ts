import type { UiVariantPreference } from '@boardsesh/key-value-storage';

/**
 * The resolved visual variant the whole app renders in. Unlike the stored
 * `UiVariantPreference` ('auto' | 'liquidGlass' | 'material'), this is the
 * concrete choice after `'auto'` has been resolved against device capability —
 * it is never `'auto'`.
 *
 *   liquidGlass — the iOS 26 Liquid Glass UI (preferred, primary)
 *   material    — the Material 3 UI (default off iOS 26)
 */
export type UiVariant = 'liquidGlass' | 'material';

/**
 * Resolve the effective variant from the user's preference and whether this
 * platform prefers the glass aesthetic by default. An explicit choice always
 * wins; `'auto'` follows the platform — Liquid Glass on every iPhone (including
 * iOS < 26, where it renders via the blur fallback) and Material on Android.
 *
 * Note this is the *aesthetic* decision, separate from whether the device can
 * render real iOS 26 glass chrome (`useGlassCapability`): an older iPhone resolves
 * to `liquidGlass` here and degrades its surfaces/tab bar downstream.
 *
 * Pure and synchronous so the first paint can pick the right variant without
 * waiting on async storage — `autoPrefersGlass` is a synchronous platform check.
 */
export function resolveUiVariant(preference: UiVariantPreference, autoPrefersGlass: boolean): UiVariant {
  if (preference === 'liquidGlass') return 'liquidGlass';
  if (preference === 'material') return 'material';
  return autoPrefersGlass ? 'liquidGlass' : 'material';
}
