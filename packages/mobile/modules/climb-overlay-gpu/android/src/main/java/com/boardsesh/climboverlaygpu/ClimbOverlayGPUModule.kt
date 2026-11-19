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
        Constants(
            "apiVersion" to OverlayPacketLayout.NATIVE_API_VERSION,
            "assetApiVersion" to 0,
            "swapCommandApi" to OverlaySwapCommand.API,
            // Protocol support only; no EGL or shader compiler runs while reading constants.
            "swapLookVersion" to OverlaySwapLook.VERSION,
        )
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
        AsyncFunction("getResourceStats") { promise: Promise ->
            OverlayRenderer.handler.post {
                try { promise.resolve(OverlayRenderer.resourceStats()) }
                catch(failure: Exception) { promise.reject("ERR_GPU_STATS","GPU resource statistics unavailable",failure) }
            }
        }
        AsyncFunction("compare") { config: String, promise: Promise ->
            val app = application
            if (app == null)
                promise.reject("ERR_GPU_UNAVAILABLE", "GPU application unavailable", null)
            else {
                OverlayPacketMetrics.begin()
                OverlayRenderer.handler.post {
                    try {
                        promise.resolve(OverlayRenderer.compare(app, config))
                    } catch (failure: Exception) {
                        promise.reject("ERR_GPU_COMPARE", failure.message, failure)
                    } finally { OverlayPacketMetrics.end() }
                }
            }
        }
        View(ClimbOverlayGPUView::class) {
            Events("onRenderReady", "onRenderError", "onSwapLookState")
            Prop("configJson") { view: ClimbOverlayGPUView, value: String ->
                view.configJson = value
            }
            Prop("geometryAssetPath") { view: ClimbOverlayGPUView, value: String? ->
                view.geometryAssetPath = value
            }
            Prop("geometryAssetSha256") { view: ClimbOverlayGPUView, value: String? ->
                view.geometryAssetSha256 = value
            }
            Prop("generatedGeometryDirectory") { view: ClimbOverlayGPUView, value: String? ->
                view.generatedGeometryDirectory = value
            }
            Prop("prefetchFrames") { view: ClimbOverlayGPUView, frames: List<String> -> view.prefetchFrames=frames.take(2) }
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
            Prop("revealMode") { view: ClimbOverlayGPUView, value: String? -> view.setRevealMode(value) }
            Prop("swapFrame") { view: ClimbOverlayGPUView, value: List<Double>? ->
                view.setSwapFrame(value)
            }
            Prop("swapLook") { view: ClimbOverlayGPUView, value: List<Double>? -> view.setSwapLook(value) }
            // The lab's readout listens; the player does not, so its view sends no onSwapLookState.
            Prop("swapLookStateEvents") { view: ClimbOverlayGPUView, value: Boolean? ->
                view.setSwapLookStateEvents(value == true)
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
