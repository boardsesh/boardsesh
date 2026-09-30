package com.boardsesh.diagnostics

import android.content.Context
import android.content.pm.ApplicationInfo
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MobileDiagnosticsModule : Module() {
    private external fun nativeAbort()
    override fun definition() = ModuleDefinition {
        Name("MobileDiagnostics")
        Constants {
            val context = appContext.reactContext
            val preferences = context?.getSharedPreferences("boardsesh-diagnostics", Context.MODE_PRIVATE)
            val markerDurable = preferences?.getBoolean("startupMarkerDurable", false) == true
            mapOf("nativeInitVersion" to 1, "nativeStartupId" to
                context?.getSharedPreferences("boardsesh-diagnostics", Context.MODE_PRIVATE)?.getString("startupId", null),
                "previousNativeStartupId" to if (markerDurable) preferences?.getString("previousStartupId", null) else null)
        }
        Function("crashNativeAbort") {
            val context = appContext.reactContext ?: return@Function
            // JS also checks Sentry enablement and tester access. Native Debug is always safe.
            if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) return@Function
            System.loadLibrary("boardsesh_diagnostics")
            nativeAbort()
        }
    }
}
