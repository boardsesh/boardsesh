package com.boardsesh.diagnostics

import android.content.Context
import android.content.pm.ApplicationInfo
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import io.sentry.Sentry
import io.sentry.android.core.SentryAndroidOptions
import org.json.JSONObject

class MobileDiagnosticsModule : Module() {
    private external fun nativeAbort()
    override fun definition() = ModuleDefinition {
        Name("MobileDiagnostics")
        Constants {
            val context = appContext.reactContext
            val preferences = context?.getSharedPreferences("boardsesh-diagnostics", Context.MODE_PRIVATE)
            val markerDurable = preferences?.getBoolean("startupMarkerDurable", false) == true
            mapOf("nativeInitVersion" to 1, "nativeAbortVersion" to 2, "nativeStartupId" to
                context?.getSharedPreferences("boardsesh-diagnostics", Context.MODE_PRIVATE)?.getString("startupId", null),
                "previousNativeStartupId" to if (markerDurable) preferences?.getString("previousStartupId", null) else null)
        }
        Function("crashNativeAbort") { testRunId: String, snapshotJson: String ->
            val context = appContext.reactContext ?: return@Function false
            if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) return@Function false
            if (!Sentry.isEnabled() || testRunId.isEmpty() || testRunId.length > 200 || snapshotJson.toByteArray(Charsets.UTF_8).size > 32768) return@Function false
            val snapshot = try { JSONObject(snapshotJson) } catch (_: Exception) { return@Function false }
            val options = Sentry.getCurrentScopes().options as? SentryAndroidOptions ?: return@Function false
            if (!options.isEnableNdk || !options.isEnableScopeSync) return@Function false
            val nativeScope = try { Class.forName("io.sentry.ndk.NativeScope") } catch (_: Exception) { return@Function false }
            val setNativeTag = try { nativeScope.getMethod("nativeSetTag", String::class.java, String::class.java) } catch (_: Exception) { return@Function false }
            val removeNativeTag = try { nativeScope.getMethod("nativeRemoveTag", String::class.java) } catch (_: Exception) { return@Function false }
            val removeNativeExtra = try { nativeScope.getMethod("nativeRemoveExtra", String::class.java) } catch (_: Exception) { return@Function false }
            val setNativeExtra = try { nativeScope.getMethod("nativeSetExtra", String::class.java, String::class.java) } catch (_: Exception) { return@Function false }
            try {
                System.loadLibrary("boardsesh_diagnostics")
                // Verify the SDK JNI entry point before changing any test attribution.
                removeNativeExtra.invoke(null, "boardsesh_native_abort_probe")
                removeNativeTag.invoke(null, "boardsesh_native_abort_probe")
            } catch (_: LinkageError) { return@Function false } catch (_: Exception) { return@Function false }
            val launchId = snapshot.optJSONObject("launch")?.optString("launchId")
            if (launchId != null && launchId.length > 200) return@Function false
            AtomicDiagnosticAbort.run(
                { runnable -> options.executorService.submit(runnable) },
                onFailure = {
                    // Attempt every removal even if a JNI entry point fails. No Java
                    // scope setters are used, so no observer can replay our test tags.
                    for (tag in listOf("source", "sentry_test_kind", "test_run_id")) {
                        try { removeNativeTag.invoke(null, tag) } catch (_: Throwable) { }
                    }
                    try { removeNativeExtra.invoke(null, "mobile_diagnostics_native_abort") } catch (_: Throwable) { }
                },
            ) {
                // This executor first drains old NdkScopeObserver writes. Stamp the
                // NDK scope directly so no new asynchronous observer writes outlive
                // this action if abort fails and the attribution is rolled back.
                setNativeTag.invoke(null, "source", "sentry-test")
                setNativeTag.invoke(null, "sentry_test_kind", "native-abort")
                setNativeTag.invoke(null, "test_run_id", testRunId)
                if (!launchId.isNullOrEmpty()) setNativeTag.invoke(null, "launch_id", launchId)
                setNativeExtra.invoke(null, "mobile_diagnostics_native_abort", snapshotJson)
                nativeAbort()
            }
        }
    }
}
