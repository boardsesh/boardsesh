package com.boardsesh.frostedbokeh

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Canvas
import android.graphics.Rect
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.view.Choreographer
import android.view.ViewTreeObserver
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.common.LifecycleState
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/** Native-only motion; RN owns all overlays, text, clipping and control behaviour. */
class FrostedBokehGPUView(context: Context, appContext: AppContext) : ExpoView(context, appContext), LifecycleEventListener {
    private val onRenderError by EventDispatcher()
    var pendingBlobs: List<GPUBlobRecord> = emptyList()
    var pendingBase = "#0E0D12"
    var pendingBlend = "screen"
    var pendingKey = ""
    var pendingReduceMotion = false
    var pendingDrift = 0.0
    var pendingSwell = 0.0
    var pendingGlideMs = 0.0

    private val motion = BokehMotion()
    private var painter: BokehPainter? = null
    private var base = floatArrayOf(0f, 0f, 0f, 1f)
    private var blend = 0f
    private var reduceMotion = false
    private var drift = 0f
    private var swell = 0f
    private var failed = false
    private var disposed = false
    private var observing = false
    private var foreground = false
    private var lowPower = false
    private var framePending = false
    private var lastVisible = false
    private val visibleBounds = Rect()
    private val startedAt = now()
    private val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    private val choreographer = Choreographer.getInstance()
    private val frameCallback = Choreographer.FrameCallback {
        framePending = false
        if (visible()) {
            invalidate()
            scheduleFrame()
        }
    }
    // Scrolling can move an attached view out of the viewport without a
    // visibility callback. Observe traversal so it also restarts on re-entry.
    private val preDrawListener = ViewTreeObserver.OnPreDrawListener {
        val showing = visible()
        if (showing != lastVisible) {
            lastVisible = showing
            refresh()
        }
        true
    }
    private val powerReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            lowPower = powerManager.isPowerSaveMode
            refresh()
        }
    }

    init {
        setWillNotDraw(false)
        isClickable = false
        isFocusable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun applyProps() {
        if (failed || disposed) return
        try {
            if (Build.VERSION.SDK_INT < 33) {
                reportError("unsupported")
                return
            }
            if (painter == null) painter = AgslBokehPainter()
            base = rgba(pendingBase)
            blend = when (pendingBlend) { "screen" -> 0f; "multiply" -> 1f; else -> 2f }
            reduceMotion = pendingReduceMotion
            drift = pendingDrift.toFloat().coerceAtLeast(0f)
            swell = pendingSwell.toFloat().coerceAtLeast(0f)
            val next = pendingBlobs.take(MAX_BLOBS).map { blob ->
                val color = rgba(blob.color)
                BokehBlob(blob.x.toFloat(), blob.y.toFloat(), blob.r.toFloat(), blob.peak.toFloat(), color[0], color[1], color[2])
            }
            motion.update(pendingKey, next, now(), pendingGlideMs / 1000, reduceMotion)
            refresh()
        } catch (_: Exception) {
            reportError("pipeline")
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (!visible() || painter == null) return
        if (!canvas.isHardwareAccelerated) {
            reportError("hardware-acceleration")
            return
        }
        try {
            val timestamp = now()
            val checkpoint = canvas.save()
            try {
                clipToPaddingBox(canvas)
                painter?.draw(canvas, width, height, motion.blobs(timestamp), base, blend,
                    resources.displayMetrics.density.takeIf { it > 0f } ?: 1f,
                    ((timestamp - startedAt) % 10_000).toFloat(), drift, swell,
                    !reduceMotion && !lowPower && drift + swell > 0)
            } finally {
                canvas.restoreToCount(checkpoint)
            }
        } catch (_: Exception) {
            reportError("draw")
        }
    }

    private fun visible(): Boolean = !failed && !disposed && foreground && isAttachedToWindow &&
        windowVisibility == VISIBLE && isShown && width > 0 && height > 0 && getGlobalVisibleRect(visibleBounds)

    private fun scheduleFrame() {
        val fps = bokehFrameRate(visible(), reduceMotion, lowPower, motion.gliding(now()), drift + swell > 0)
        if (fps == 0) {
            stopFrames()
        } else if (!framePending) {
            framePending = true
            // Wake just before the next target vsync, not one vsync after it.
            choreographer.postFrameCallbackDelayed(frameCallback, (1000L / fps - 1).coerceAtLeast(0))
        }
    }

    private fun stopFrames() {
        choreographer.removeFrameCallback(frameCallback)
        framePending = false
    }

    private fun refresh() {
        stopFrames()
        if (visible()) invalidate()
        scheduleFrame()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (disposed) return
        foreground = appContext.reactContext?.lifecycleState == LifecycleState.RESUMED
        lowPower = powerManager.isPowerSaveMode
        appContext.reactContext?.addLifecycleEventListener(this)
        val filter = IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(powerReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            context.registerReceiver(powerReceiver, filter)
        }
        viewTreeObserver.addOnPreDrawListener(preDrawListener)
        observing = true
        refresh()
    }

    override fun onDetachedFromWindow() {
        stopObserving()
        super.onDetachedFromWindow()
    }

    private fun stopObserving() {
        stopFrames()
        if (!observing) return
        observing = false
        appContext.reactContext?.removeLifecycleEventListener(this)
        context.unregisterReceiver(powerReceiver)
        if (viewTreeObserver.isAlive) viewTreeObserver.removeOnPreDrawListener(preDrawListener)
    }

    fun dispose() {
        disposed = true
        stopObserving()
        painter = null
    }

    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        refresh()
    }

    override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
        super.onSizeChanged(width, height, oldWidth, oldHeight)
        refresh()
    }

    override fun onHostResume() {
        foreground = true
        lowPower = powerManager.isPowerSaveMode
        refresh()
    }

    override fun onHostPause() {
        foreground = false
        stopFrames()
    }

    override fun onHostDestroy() = dispose()

    private fun reportError(reason: String) {
        if (failed) return
        failed = true
        stopFrames()
        // Deliver outside drawing/layout, after Expo has installed event props.
        post { if (!disposed) onRenderError(mapOf("reason" to reason)) }
    }

    companion object {
        private fun now() = SystemClock.elapsedRealtimeNanos() / 1_000_000_000.0
        private fun rgba(hex: String): FloatArray {
            var clean = hex.trim().removePrefix("#")
            if (clean.length == 3) clean = clean.map { "$it$it" }.joinToString("")
            val color = clean.take(6).toLongOrNull(16) ?: 0L
            return floatArrayOf(((color shr 16) and 255).toFloat() / 255,
                ((color shr 8) and 255).toFloat() / 255, (color and 255).toFloat() / 255, 1f)
        }
    }
}
