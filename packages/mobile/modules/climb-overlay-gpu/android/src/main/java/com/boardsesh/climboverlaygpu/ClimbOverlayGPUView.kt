package com.boardsesh.climboverlaygpu

import android.animation.ValueAnimator
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.ContentObserver
import android.graphics.SurfaceTexture
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.Choreographer
import android.view.TextureView
import android.view.View
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.atomic.AtomicBoolean

class ClimbOverlayGPUView(context: Context, appContext: AppContext) :
    ExpoView(context, appContext), TextureView.SurfaceTextureListener {
    private val onRenderReady by EventDispatcher<Map<String, Any?>>()
    private val onRenderError by EventDispatcher()
    var configJson = ""
    var geometryAssetPath: String? = null
    var geometryAssetSha256: String? = null
    var generatedGeometryDirectory: String? = null
    var frames: String? = null
    var previousFrames: String? = null
    var nextFrames: String? = null
    var centerPage = 0.0
    var requestId = ""
    var active = false
    var animateEdits = false
    var reduceMotion = false
    var displayMirrored = false
    private var pagePosition: Double? = null
    private val main = Handler(Looper.getMainLooper())
    private val texture =
        TextureView(context).apply {
            isOpaque = false
            surfaceTextureListener = this@ClimbOverlayGPUView
        }
    @Volatile private var attached = false
    @Volatile private var generation = 0L
    @Volatile private var latest: OverlayRequest? = null
    @Volatile private var allowed = false
    @Volatile
    internal var controls = OverlayControls(null, false, false, false)
        private set

    @Volatile private var session: OverlaySession? = null
    private var revision = 0L
    private var observedEmptyConfig: String? = null
    private val preparing = AtomicBoolean(false)
    private val drawing = AtomicBoolean(false)
    private val needsFrame = AtomicBoolean(false)
    private var consumptionObservation: Runnable? = null
    private var animationScheduled = false
    private var lastAnimationFrameNanos = 0L
    private var registered = false
    private var systemLowPower = false
    private var systemReduced = false
    private var lastErrorRevision: Long? = null
    private val frameCallback = Choreographer.FrameCallback { frameTime ->
        animationScheduled = false
        if (allowed && animateEdits && !controls.reduced && !controls.lowPower) {
            if (OverlayPolicy.animationFrameDue(lastAnimationFrameNanos, frameTime)) {
                lastAnimationFrameNanos = frameTime
                requestDraw()
            } else requestAnimationFrame()
        }
    }
    private val powerReceiver =
        object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                refreshMotionPolicy()
                applyProps()
            }
        }
    private val animationObserver =
        object : ContentObserver(main) {
            override fun onChange(selfChange: Boolean) {
                refreshMotionPolicy()
                applyProps()
            }
        }

    init {
        addView(texture, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        views.add(this)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        texture.layout(0, 0, right - left, bottom - top)
        applyProps()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        attached = true
        refreshMotionPolicy()
        if (!registered) {
            context.registerReceiver(
                powerReceiver,
                IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED),
            )
            context.contentResolver.registerContentObserver(
                Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),
                false,
                animationObserver,
            )
            registered = true
        }
        post { applyProps() }
    }

    override fun onDetachedFromWindow() {
        attached = false
        allowed = false
        latest = null
        revision++
        cancelAnimation()
        cancelConsumptionObservation()
        if (registered) {
            context.unregisterReceiver(powerReceiver)
            context.contentResolver.unregisterContentObserver(animationObserver)
            registered = false
        }
        session?.let { OverlayRenderer.deactivate(it) }
        super.onDetachedFromWindow()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        post { applyProps() }
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        post { applyProps() }
    }

    fun setPagePosition(position: Double?) {
        if (position == null || !position.isFinite() || position == pagePosition) return
        pagePosition = position
        controls = controls.copy(position = position)
        requestDraw()
    }

    private fun refreshMotionPolicy() {
        systemLowPower =
            (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isPowerSaveMode
        systemReduced =
            if (Build.VERSION.SDK_INT >= 26) !ValueAnimator.areAnimatorsEnabled()
            else
                Settings.Global.getFloat(
                    context.contentResolver,
                    Settings.Global.ANIMATOR_DURATION_SCALE,
                    1f,
                ) <= 0
    }

    fun applyProps() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post { applyProps() }
            return
        }
        val lowPower = systemLowPower
        val reduced = reduceMotion || systemReduced
        controls = OverlayControls(pagePosition, reduced, lowPower, displayMirrored)
        val wasAllowed = allowed
        allowed =
            active &&
                isAttachedToWindow &&
                isShown &&
                windowVisibility == VISIBLE &&
                OverlayRenderer.foreground
        if (!allowed) {
            cancelAnimation()
            cancelConsumptionObservation()
            needsFrame.set(false)
            if (wasAllowed || latest != null) {
                latest = null
                revision++
                observedEmptyConfig = null
                session?.let { OverlayRenderer.deactivate(it) }
            }
            return
        }
        if (reduced || lowPower || !animateEdits) cancelAnimation()
        if (configJson.isEmpty() || !centerPage.isFinite()) return
        if (observedEmptyConfig != configJson) observedEmptyConfig = null
        if (animateEdits && frames == "") observedEmptyConfig = configJson
        val old = latest
        val same =
            old != null &&
                old.config == configJson &&
                old.geometryAssetPath == geometryAssetPath &&
                old.geometryAssetSha256 == geometryAssetSha256 &&
                old.generatedGeometryDirectory == generatedGeometryDirectory &&
                old.frames == frames &&
                old.previous == previousFrames &&
                old.next == nextFrames &&
                old.center == centerPage &&
                old.requestId == requestId &&
                old.animateEdits == animateEdits &&
                old.generation == generation
        if (!same) {
            cancelAnimation()
            cancelConsumptionObservation()
            revision++
            lastErrorRevision = null
            latest =
                OverlayRequest(
                    configJson,
                    frames,
                    previousFrames,
                    nextFrames,
                    centerPage,
                    requestId,
                    revision,
                    generation,
                    animateEdits,
                    observedEmptyConfig == configJson,
                    geometryAssetPath,
                    geometryAssetSha256,
                    generatedGeometryDirectory,
                )
            schedulePrepare()
        } else requestDraw()
    }

    internal fun matchesGeneration(expected: Long) = generation == expected && attached

    internal fun matches(request: OverlayRequest) =
        allowed && generation == request.generation && latest?.revision == request.revision

    internal fun schedulePrepare() {
        val target = session ?: return
        if (!preparing.compareAndSet(false, true)) return
        OverlayRenderer.handler.post {
            val request = latest
            try {
                if (request != null && target.generation == request.generation)
                    OverlayRenderer.prepare(target, request)
            } finally {
                preparing.set(false)
                if (latest != null && latest != request) schedulePrepare()
            }
        }
    }

    internal fun requestDraw() {
        needsFrame.set(true)
        resumeDraw()
    }

    internal fun resumeDraw() {
        val target = session ?: return
        if (!allowed || !needsFrame.get() || !drawing.compareAndSet(false, true)) return
        OverlayRenderer.handler.post {
            var submitted = false
            try {
                if (needsFrame.getAndSet(false)) {
                    submitted = OverlayRenderer.draw(target)
                    if (!submitted) needsFrame.set(true)
                }
            } finally {
                drawing.set(false)
                if (submitted && needsFrame.get()) resumeDraw()
            }
        }
    }

    internal fun requestAnimationFrame() {
        main.post {
            if (
                allowed &&
                    animateEdits &&
                    !controls.reduced &&
                    !controls.lowPower &&
                    !animationScheduled
            ) {
                animationScheduled = true
                Choreographer.getInstance().postFrameCallback(frameCallback)
            }
        }
    }

    private fun cancelAnimation() {
        if (animationScheduled) Choreographer.getInstance().removeFrameCallback(frameCallback)
        animationScheduled = false
    }

    internal fun observeConsumption(target: OverlaySession, request: OverlayRequest) {
        main.post {
            if (!matches(request) || session !== target || consumptionObservation != null)
                return@post
            // HWUI consumes the layer on RenderThread after TextureView's
            // synchronous update listener. Do not redraw; reread its timestamp.
            val observation = Runnable {
                consumptionObservation = null
                if (matches(request) && session === target) {
                    OverlayRenderer.consumed(target, target.texture.timestamp, request)
                }
            }
            consumptionObservation = observation
            main.postDelayed(observation, 16)
        }
    }

    private fun cancelConsumptionObservation() {
        consumptionObservation?.let { main.removeCallbacks(it) }
        consumptionObservation = null
    }

    internal fun ready(request: OverlayRequest, metrics: RenderMetrics) {
        main.post {
            if (!matches(request)) return@post
            onRenderReady(
                mapOf(
                    "requestId" to request.requestId,
                    "prepareMs" to metrics.prepareMs,
                    "uploadMs" to metrics.uploadMs,
                    "gpuMs" to null,
                    "atlasBytes" to metrics.atlasBytes,
                    "atlasCacheHit" to metrics.cacheHit,
                    "editChangedHoldCount" to metrics.changed,
                    "editDurationMs" to metrics.editDurationMs,
                    "lowPowerMode" to controls.lowPower,
                ),
            )
        }
    }

    internal fun failed(request: OverlayRequest?, reason: String) {
        main.post {
            val accepted = request ?: latest ?: return@post
            if (!matches(accepted) || lastErrorRevision == accepted.revision) return@post
            lastErrorRevision = accepted.revision
            cancelAnimation()
            cancelConsumptionObservation()
            onRenderError(mapOf("requestId" to accepted.requestId, "reason" to reason))
        }
    }

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        generation++
        val created = OverlaySession(this, surface, generation)
        session = created
        latest = null
        OverlayRenderer.attach(created)
        applyProps()
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
        session?.let { OverlayRenderer.resized(it) }
    }

    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        generation++
        latest = null
        cancelAnimation()
        cancelConsumptionObservation()
        needsFrame.set(false)
        session?.let { OverlayRenderer.detach(it) }
        session = null
        return false // Render thread releases this texture after destroying EGLSurface.
    }

    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {
        session
            ?.takeIf { it.texture === surface }
            ?.let { OverlayRenderer.consumed(it, surface.timestamp) }
    }

    companion object {
        private val views = Collections.newSetFromMap(WeakHashMap<ClimbOverlayGPUView, Boolean>())

        fun foregroundChanged(foreground: Boolean) {
            OverlayRenderer.foreground = foreground
            if (!foreground) OverlayRenderer.background()
            views.toList().forEach {
                it.refreshMotionPolicy()
                it.applyProps()
            }
        }
    }
}
