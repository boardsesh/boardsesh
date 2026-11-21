package expo.modules.memorytrim

import android.app.Application
import android.content.ComponentCallbacks2
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.bumptech.glide.Glide
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android-only, side-effect-only module. It has no JS-callable API: on native
 * module-registry init (app launch) its OnCreate registers a
 * [ComponentCallbacks2] on the application, so the Android framework calls back
 * on memory pressure. This is the "next lever" from docs/react-native-performance.md
 * rule 7 — JS Image.clearMemoryCache() can't move Glide's native bitmap cache /
 * pool.
 *
 * Scope is deliberately narrow: [MemoryTrimPolicy] documents what stock Glide
 * already handles itself and limits this module to the one gap — a full clear
 * in the TRIM_MEMORY_UI_HIDDEN(20)..39 window, so board-art bitmaps are
 * released the moment the UI hides rather than when the system escalates to
 * BACKGROUND(40).
 */
class MemoryTrimModule : Module() {
    private companion object {
        const val TAG = "MemoryTrim"
    }

    // Held so OnDestroy can unregister the exact same instance we registered.
    private var registeredApplication: Application? = null
    private var memoryCallbacks: ComponentCallbacks2? = null

    override fun definition() = ModuleDefinition {
        Name("MemoryTrim")

        OnCreate {
            val application = appContext.reactContext?.applicationContext as? Application
            if (application == null) {
                Log.w(TAG, "OnCreate: no application context; trim callbacks not registered")
                return@OnCreate
            }
            Log.d(TAG, "OnCreate: registering trim callbacks")

            val callbacks = object : ComponentCallbacks2 {
                override fun onConfigurationChanged(newConfig: Configuration) {
                    // Not a memory signal — nothing to trim.
                }

                @Suppress("OVERRIDE_DEPRECATION")
                override fun onLowMemory() {
                    // Required override. Stock Glide's own callback already full-clears
                    // on this legacy signal — nothing to add.
                }

                override fun onTrimMemory(level: Int) {
                    if (MemoryTrimPolicy.shouldFullClear(level)) {
                        // UI hidden (backgrounded): the bitmap cache is dead weight —
                        // drop all of it now instead of Glide's stock half-trim.
                        // Outside this window stock Glide's self-registered callback
                        // already trims/clears; acting here would double-trim.
                        Log.d(TAG, "onTrimMemory(level=$level): full Glide clear")
                        clearGlideMemoryOnMain(application)
                    }
                }
            }

            application.registerComponentCallbacks(callbacks)
            registeredApplication = application
            memoryCallbacks = callbacks
        }

        OnDestroy {
            memoryCallbacks?.let { registeredApplication?.unregisterComponentCallbacks(it) }
            memoryCallbacks = null
            registeredApplication = null
        }
    }

    /**
     * Glide.clearMemory() asserts it runs on the main thread. onTrimMemory /
     * onLowMemory are already delivered on the main thread, but hop to the main
     * looper defensively so any future call site can't trip the assertion.
     */
    private fun clearGlideMemoryOnMain(application: Application) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            Glide.get(application).clearMemory()
        } else {
            Handler(Looper.getMainLooper()).post {
                Glide.get(application).clearMemory()
            }
        }
    }
}
