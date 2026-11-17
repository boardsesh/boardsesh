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
    var prefetchFrames: List<String> = emptyList()
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
    private var revealMode = OverlayPolicy.REVEAL_MODE_WIPE
    private var outgoingWeight = 1f
    private var incomingWeight = 0f
    private var sharedWeight = 1f
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
    private val preparationQueue = OverlayPreparationQueue()
    private val drawing = AtomicBoolean(false)
    private val needsFrame = AtomicBoolean(false)
    private var consumptionObservation: Runnable? = null
    private var animationScheduled = false
    private var lastAnimationFrameNanos = 0L
    private var registered = false
    private var systemLowPower = false
    private var systemReduced = false
    private var lastErrorRevision: Long? = null
    @Volatile private var activePreparation: PacketCancellation? = null
    @Volatile private var idlePreparation: PacketCancellation? = null
    private var idleTask: Runnable? = null
    private var idleJob: OverlayPacketJob? = null
    private var idleFrames: List<String> = emptyList()

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
        activePreparation?.cancel();cancelPrefetch()
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
        cancelPrefetch()
        controls = controls.copy(position = position)
        requestDraw()
    }

    /** "swap" or "wipe" from the app; anything else is the wipe. */
    fun setRevealMode(name: String?) {
        val next = OverlayPolicy.revealMode(name)
        if (next == revealMode) return
        revealMode = next
        controls = controls.copy(revealMode = next)
        requestDraw()
    }

    /**
     * The swap's animated prop: its pair and weights, published to the
     * render thread as one controls snapshot. The timing lives in the app.
     */
    fun setSwapFrame(frame: List<Double>?) {
        val next = controls.withSwapFrame(frame) ?: return
        if (next == controls) return
        if (next.position != pagePosition) cancelPrefetch()
        pagePosition = next.position
        outgoingWeight = next.outgoing
        incomingWeight = next.incoming
        sharedWeight = next.shared
        controls = next
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
        controls =
            OverlayControls(
                pagePosition,
                reduced,
                lowPower,
                displayMirrored,
                revealMode,
                outgoingWeight,
                incomingWeight,
                sharedWeight,
            )
        val wasAllowed = allowed
        allowed =
            active &&
                isAttachedToWindow &&
                isShown &&
                windowVisibility == VISIBLE &&
                OverlayRenderer.foreground
        if (!allowed) {
            activePreparation?.cancel();cancelPrefetch()
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
            activePreparation?.cancel();cancelPrefetch()
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
        } else { schedulePrefetch();requestDraw() }
    }

    internal fun matchesGeneration(expected: Long) = generation == expected && attached

    internal fun matches(request: OverlayRequest) =
        allowed && generation == request.generation && latest?.revision == request.revision

    internal fun matchesGeometry(request: OverlayRequest): Boolean =
        allowed && generation == request.generation && latest?.sameGeometry(request) == true

    internal fun currentRequest(): OverlayRequest? = latest

    internal fun retryAfterContextLoss() {
        preparationQueue.requestRecovery()
        main.post {
            if (!preparationQueue.needsRecovery) return@post
            cancelAnimation()
            cancelConsumptionObservation()
            if (allowed && latest != null) schedulePrepare()
        }
    }

    internal fun schedulePrepare() {
        val target=session ?: return
        val request=latest ?: return
        if(!preparationQueue.begin())return
        val cancel=try { PacketCancellation() } catch(failure: Exception) {
            preparationQueue.started();preparationQueue.finish(false)
            failed(request,"gpu-resource-limit","context");return
        }
        activePreparation=cancel
        OverlayPacketMetrics.begin()
        OverlayRenderer.handler.post {
            preparationQueue.started()
            try {
                if(target.generation==request.generation)OverlayRenderer.prepare(target,request,cancel)
            } finally {
                if(activePreparation===cancel)activePreparation=null
                cancel.close();OverlayPacketMetrics.end()
                val retry=preparationQueue.finish(latest!=null && latest!=request)
                if(latest!=null && retry)schedulePrepare()
            }
        }
    }

    private fun cancelPrefetch() {
        idleTask?.let { main.removeCallbacks(it) };idleTask=null
        idleJob?.cancel();idleJob=null
        idlePreparation?.cancel();idlePreparation=null;idleFrames=emptyList()
    }

    internal fun schedulePrefetch() {
        main.post {
            val request=latest ?: return@post
            if(!allowed || kotlin.math.abs((controls.position?:request.center)-request.center)>0.0001)return@post
            val frames=prefetchFrames.filter { it.toByteArray(Charsets.UTF_8).size<=32768 }.take(2)
            if(frames==idleFrames)return@post
            cancelPrefetch();idleFrames=frames
            if(frames.isEmpty())return@post
            OverlayPacketMetrics.begin()
            val job=OverlayPacketJob(OverlayPacketMetrics::end);idleJob=job
            val task=Runnable {
                if(!job.start())return@Runnable
                if(!matches(request)) { job.finish();return@Runnable }
                val cancel=try { PacketCancellation() } catch(_: Exception) { job.finish();return@Runnable }
                idlePreparation=cancel
                OverlayRenderer.handler.post {
                    try { OverlayRenderer.prefetch(context,request,frames,cancel) { matches(request) && idlePreparation===cancel } }
                    finally { cancel.close();job.finish() }
                }
            }
            idleTask=task;main.postDelayed(task,150)
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
                    "uploadBytes" to metrics.uploadBytes,
                    "litHoldCount" to metrics.litHoldCount,
                    "editChangedHoldCount" to metrics.changed,
                    "editDurationMs" to metrics.editDurationMs,
                    "lowPowerMode" to controls.lowPower,
                ),
            )
        }
    }

    internal fun failed(request: OverlayRequest?, reason: String, scope: String) {
        main.post {
            val accepted = request ?: latest ?: return@post
            if (!matches(accepted) || lastErrorRevision == accepted.revision) return@post
            lastErrorRevision = accepted.revision
            cancelAnimation()
            cancelConsumptionObservation()
            onRenderError(mapOf("requestId" to accepted.requestId, "reason" to reason, "failureScope" to scope))
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
