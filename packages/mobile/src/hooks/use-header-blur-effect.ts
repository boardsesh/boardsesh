import { useGlassCapability } from './use-glass-capability';

/** The pre-iOS 26 bar blur a transparent native header falls back to. */
export const LEGACY_HEADER_BLUR_EFFECT = 'systemMaterial';

/**
 * The `headerBlurEffect` for a transparent native header on Liquid Glass. The one
 * gate every glass stack (`useStackScreenOptions`, `RootNavigationStack`) and
 * `NativeRootHeader` share.
 *
 * iOS 26 draws its own scroll edge effect under a transparent bar, so the legacy
 * `systemMaterial` blur on top of it reads as a grey band over a black page.
 * HIG Layout: "Instead of applying a solid or semi-opaque background color beneath
 * controls, use a scroll edge effect to visually elevate controls above content."
 * Only iOS without Liquid Glass keeps the blur, because a transparent bar there has
 * no material of its own and content would show straight through it.
 */
export function useHeaderBlurEffect(): typeof LEGACY_HEADER_BLUR_EFFECT | undefined {
  return useGlassCapability() ? undefined : LEGACY_HEADER_BLUR_EFFECT;
}
