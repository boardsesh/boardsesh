import { requireOptionalNativeModule } from 'expo-modules-core';

// Android-only diagnostic bridge for the edge-to-edge login-screen touch-freeze.
// See WindowRelayoutModule.kt for the why. Both calls resolve `false` when no
// activity is attached (nothing to relayout).
type WindowRelayoutNativeModule = {
  /**
   * Force a window-insets re-dispatch + layout pass on the Android decor view —
   * the lightweight candidate fix for the cold-start hit-region freeze.
   */
  requestApplyInsets(): Promise<boolean>;
  /**
   * Recreate the current Android Activity (heavier relayout; closest thing to
   * the split-screen Configuration change without multi-window).
   */
  recreate(): Promise<boolean>;
};

// requireOptionalNativeModule returns null on iOS (module is Android-only) and on
// any binary built before this module was added — always check before calling.
export const windowRelayoutNative = requireOptionalNativeModule<WindowRelayoutNativeModule>('WindowRelayout');
