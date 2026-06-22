package com.boardsesh.windowrelayout

import androidx.core.view.ViewCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Tester-only diagnostic bridge for the Android-16 edge-to-edge "touch-dead"
 * login freeze (Pixel 9/10, Galaxy S24/S25). On those devices the cold-start
 * login screen's native hit-region is laid out against stale window metrics and
 * never re-laid-out until a real Configuration change (split-screen) re-runs
 * window metrics — so touch is dead until then.
 *
 * This module lets the FreezeDebugOverlay force that relayout from JS:
 *   - requestApplyInsets(): re-dispatch window insets + a layout pass on the
 *     decor view (the lightweight candidate fix).
 *   - recreate(): tear down + rebuild the Activity (the heavier fallback, the
 *     closest thing to split-screen's Configuration change).
 * A contributor can reproduce the frozen baseline, tap a button, and observe
 * whether touch returns — confirming the fix in a single build.
 *
 * Android-only (see expo-module.config.json); `requireOptionalNativeModule`
 * returns null on iOS and on binaries built before this module was added.
 */
class WindowRelayoutModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("WindowRelayout")

    // Force Android to re-dispatch window insets + a layout pass on the decor
    // view — what a real Configuration change (e.g. entering split-screen) does.
    // Resolves false when no activity is attached (nothing to relayout).
    AsyncFunction("requestApplyInsets") {
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      activity.runOnUiThread {
        val decorView = activity.window?.decorView ?: return@runOnUiThread
        ViewCompat.requestApplyInsets(decorView)
        decorView.requestLayout()
      }
      true
    }

    // Heavier hammer: recreate the Activity, the closest thing to split-screen's
    // Configuration change without entering multi-window. Confirms whether a full
    // relayout (not just an inset re-dispatch) is what unfreezes touch.
    AsyncFunction("recreate") {
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      activity.runOnUiThread { activity.recreate() }
      true
    }
  }
}
