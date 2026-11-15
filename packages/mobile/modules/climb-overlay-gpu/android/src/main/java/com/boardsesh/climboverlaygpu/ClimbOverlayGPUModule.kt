package com.boardsesh.climboverlaygpu

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ClimbOverlayGPUModule : Module() {
    private var application: Context? = null
    private val callbacks =
        object : ComponentCallbacks2 {
            override fun onConfigurationChanged(config: Configuration) {}

            override fun onLowMemory() {
                OverlayRenderer.trim()
            }

            override fun onTrimMemory(level: Int) {
                if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) OverlayRenderer.trim()
            }
        }

    override fun definition() = ModuleDefinition {
        Name("ClimbOverlayGPU")
        Constants("apiVersion" to 3)
        OnCreate {
            application = appContext.reactContext?.applicationContext
            application?.registerComponentCallbacks(callbacks)
        }
        OnDestroy {
            application?.unregisterComponentCallbacks(callbacks)
            application = null
            OverlayRenderer.trim()
        }
        OnActivityEntersBackground { ClimbOverlayGPUView.foregroundChanged(false) }
        OnActivityEntersForeground { ClimbOverlayGPUView.foregroundChanged(true) }
        AsyncFunction("compare") { config: String, promise: Promise ->
            val app = application
            if (app == null)
                promise.reject("ERR_GPU_UNAVAILABLE", "GPU application unavailable", null)
            else
                OverlayRenderer.handler.post {
                    try {
                        promise.resolve(OverlayRenderer.compare(app, config))
                    } catch (failure: Exception) {
                        promise.reject("ERR_GPU_COMPARE", failure.message, failure)
                    }
                }
        }
        View(ClimbOverlayGPUView::class) {
            Events("onRenderReady", "onRenderError")
            Prop("configJson") { view: ClimbOverlayGPUView, value: String ->
                view.configJson = value
            }
            Prop("frames") { view: ClimbOverlayGPUView, value: String? -> view.frames = value }
            Prop("previousFrames") { view: ClimbOverlayGPUView, value: String? ->
                view.previousFrames = value
            }
            Prop("nextFrames") { view: ClimbOverlayGPUView, value: String? ->
                view.nextFrames = value
            }
            Prop("centerPage") { view: ClimbOverlayGPUView, value: Double ->
                view.centerPage = value
            }
            Prop("pagePosition") { view: ClimbOverlayGPUView, value: Double? ->
                view.setPagePosition(value)
            }
            Prop("requestId") { view: ClimbOverlayGPUView, value: String -> view.requestId = value }
            Prop("active") { view: ClimbOverlayGPUView, value: Boolean -> view.active = value }
            Prop("animateEdits") { view: ClimbOverlayGPUView, value: Boolean ->
                view.animateEdits = value
            }
            Prop("reduceMotion") { view: ClimbOverlayGPUView, value: Boolean ->
                view.reduceMotion = value
            }
            Prop("displayMirrored") { view: ClimbOverlayGPUView, value: Boolean ->
                view.displayMirrored = value
            }
            OnViewDidUpdateProps { view: ClimbOverlayGPUView -> view.applyProps() }
        }
    }
}
