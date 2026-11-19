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
import com.facebook.react.bridge.ReactContext
import com.facebook.react.common.LifecycleState
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.views.ExpoViewCommandReceiver

/** Native-only motion; RN owns all overlays, text, clipping and control behaviour. */
class FrostedBokehGPUView(context: Context, appContext: AppContext) :
    ExpoView(context, appContext), LifecycleEventListener, ExpoViewCommandReceiver {
    private val onRenderError by EventDispatcher()
    var pendingBlobs: List<GPUBlobRecord> = emptyList()
    var pendingBase = "#0E0D12"
    var pendingBlend = "screen"
    var pendingKey = ""
    var pendingReduceMotion = false
    var pendingDrift = 0.0
    var pendingSwell = 0.0
    var pendingSwapClimbs: GPUSwapClimbsRecord? = null
    var pendingSwapLook: List<Double>? = null
    var pendingReleaseMs = 220.0
    var pendingReleaseOutMs = 150.0

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
    private var lifecycleContext: ReactContext? = null
    private var foreground = false
    private var lowPower = false
    private var framePending = false
    private var lastVisible = false
    private var lastFrameAt = -1.0
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
            motion.look = BokehSwapLook.parse(pendingSwapLook)
            motion.releaseSeconds = (pendingReleaseMs / 1000).coerceAtLeast(0.001)
            motion.fadeSeconds = (pendingReleaseOutMs / 1000).coerceAtLeast(0.001)
            val current = BokehClimb(pendingKey, lights(pendingBlobs))
            val pages = mutableMapOf<Int, BokehClimb>()
            pendingSwapClimbs?.let { climbs ->
                val center = nearestPage(climbs.centerPage)
                pages[center] = current
                climbs.previous?.let { pages[center - 1] = BokehClimb(it.key, lights(it.blobs)) }
                climbs.next?.let { pages[center + 1] = BokehClimb(it.key, lights(it.blobs)) }
            }
            motion.setClimbs(current, pages, now())
            refresh()
        } catch (_: Exception) {
            reportError("pipeline")
        }
    }

    /** The board's swap frame, from the `swapFrame` command or prop. */
    fun setSwapFrame(values: List<Double>) {
        if (failed || disposed) return
        val timestamp = now()
        if (!motion.applyFrame(values, timestamp)) return
        lastFrameAt = timestamp
        refresh()
    }

    /**
     * Fabric view commands, forwarded by the patched expo-modules-core view manager on the
     * main thread, so a pending React commit cannot hold a swap frame back (as the board).
     */
    override fun receiveViewCommand(commandId: String, args: List<Any?>): Boolean {
        if (commandId != "swapFrame") return false
        val values = args.map { arg -> (arg as? Number)?.toDouble() ?: return true }
        setSwapFrame(values)
        return true
    }

    private fun lights(records: List<GPUBlobRecord>): List<BokehBlob> = records.take(MAX_BLOBS).map { record ->
        val color = rgba(record.color)
        val x = record.x.toFloat()
        val y = record.y.toFloat()
        BokehBlob(x, y, record.r.toFloat(), record.peak.toFloat(), color[0], color[1], color[2],
            // Hold ids are small; anything past 2^53 is not one.
            id = if (record.id >= 0 && record.id < 9_007_199_254_740_992.0) record.id.toLong() else -1,
            seed = if (record.seed >= 0 && record.seed.isFinite()) record.seed.toFloat() else positionSeed(x, y))
    }

    /** Swap frames arrive only while the board moves; this long after the last one the loop slows down. */
    private fun moving(timestamp: Double): Boolean =
        motion.transitioning(timestamp) || (lastFrameAt >= 0 && timestamp - lastFrameAt < FRAME_QUIET_SECONDS)

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
        val fps = bokehFrameRate(visible(), reduceMotion, lowPower, moving(now()), drift + swell > 0)
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
        // Expo exposes this as Context; the lifecycle API belongs to ReactContext.
        val reactContext = appContext.reactContext as? ReactContext
        if (reactContext == null) {
            reportError("react-context")
            return
        }
        lifecycleContext = reactContext
        foreground = reactContext.lifecycleState == LifecycleState.RESUMED
        lowPower = powerManager.isPowerSaveMode
        reactContext.addLifecycleEventListener(this)
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
        lifecycleContext?.removeLifecycleEventListener(this)
        lifecycleContext = null
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

    override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
        super.onSizeChanged(width, height, oldWidth, oldHeight)
        motion.width = width / (resources.displayMetrics.density.takeIf { it > 0f } ?: 1f)
        refresh()
    }

    companion object {
        private const val FRAME_QUIET_SECONDS = 0.1
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
