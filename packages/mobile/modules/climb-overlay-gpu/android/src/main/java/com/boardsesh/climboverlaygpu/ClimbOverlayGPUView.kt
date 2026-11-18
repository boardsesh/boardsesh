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
import android.util.Log
import android.view.Choreographer
import android.view.TextureView
import android.view.View
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.views.ExpoViewCommandReceiver
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.atomic.AtomicBoolean

class ClimbOverlayGPUView(context: Context, appContext: AppContext) :
    ExpoView(context, appContext), TextureView.SurfaceTextureListener, ExpoViewCommandReceiver {
    private val onRenderReady by EventDispatcher<Map<String, Any?>>()
    private val onRenderError by EventDispatcher()
    /**
     * Whether the swap look is drawing, sent when that changes, and only while
     * JS listens ([setSwapLookStateEvents]: the lab's readout; the player leaves it off).
     */
    private val onSwapLookState by EventDispatcher<Map<String, Any>>()
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
    /** A seven-number frame's shared floor, for the look; null for the shipped frames. */
    private var sharedFloor: Float? = null
    /** Which climbs arrive this frame, for the look (a seven-number frame's last two numbers). */
    private var arrivals = OverlaySwapLook.Arrivals()
    /** The swap look; null draws API 7's swap. */
    private var swapLook: OverlaySwapLook.Look? = null
    private var swapLookRejected = false
    /** The `swapLookStateEvents` prop: the lab's readout listens for [onSwapLookState]; the player does not. */
    @Volatile private var swapLookStateEvents = false
    /** The renderer could not build the look program (main thread, from [swapLookShader]). */
    private var swapLookShaderMissing = false
    /** Render thread only: the last availability [swapLookShader] reported; the program is assumed until told. */
    private var swapLookShaderSeen = true
    /** Holds in the last look drawn since the look last changed; null until one is drawn. Main thread. */
    private var swapLookAppliedHolds: Int? = null
    private var swapLookLastReport: Map<String, Any>? = null
    /** Bumped whenever [swapLookAppliedHolds] resets, so a late report from the render thread is dropped. */
    @Volatile private var swapLookEpoch = 0L
    /** Render thread only: the last (epoch, hold count) it reported, so it posts once per change. */
    private var swapLookDrawnEpoch = -1L
    private var swapLookDrawnHolds = -1
    private var swapLookLogged = false
    /** The newest swap frame this view has applied, by the app's sequence. */
    private val swapSequence = SwapFrameSequenceGate()
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
    private var consumptionObserved: OverlayRequest? = null
    private var consumptionObservedCarried = false
    private var animationScheduled = false
    private var lastAnimationFrameNanos = 0L
    private var registered = false
    private var systemLowPower = false
    private var systemReduced = false
    /** Thermal status severe or worse (API 29+): the swap look's reach stays at 1. */
    private var systemHot = false
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
            watchThermal(this)
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
            unwatchThermal(this)
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
        reportSwapLook()
        requestDraw()
    }

    /**
     * The swap's frame: its pair and weights, published to the render thread
     * as one controls snapshot. It arrives as the `swapFrame` command and again
     * as the animated prop; a frame older than one already applied is dropped.
     * The timing lives in the app.
     */
    fun setSwapFrame(frame: List<Double>?) {
        val sequenced = OverlaySwapCommand.split(frame) ?: return
        val next = controls.withSwapFrame(sequenced.frame, sequenced.arrivals) ?: return
        if (!swapSequence.admit(sequenced.sequence)) return
        if (next == controls) return
        if (next.position != pagePosition) cancelPrefetch()
        pagePosition = next.position
        outgoingWeight = next.outgoing
        incomingWeight = next.incoming
        sharedWeight = next.shared
        sharedFloor = next.sharedFloor
        arrivals = next.arrivals
        controls = next
        requestDraw()
    }

    /**
     * The swap look's numbers ([OverlaySwapLook.Look]), set when the look
     * changes. Null or malformed turns the look off.
     */
    fun setSwapLook(values: List<Double>?) {
        val look = OverlaySwapLook.Look.parse(values)
        swapLookRejected = values != null && look == null
        if (look != swapLook) {
            swapLook = look
            resetSwapLookApplied()
            controls = controls.copy(look = look)
            requestDraw()
        }
        reportSwapLook()
    }

    /**
     * The `swapLookStateEvents` prop: true while JS listens for [onSwapLookState]
     * (the lab's readout). Off, the view sends no state event and the render
     * thread posts nothing about the look. Turning it on sends the current state.
     */
    fun setSwapLookStateEvents(enabled: Boolean) {
        if (enabled == swapLookStateEvents) return
        swapLookStateEvents = enabled
        if (!enabled) return
        resetSwapLookApplied()
        swapLookLastReport = null
        reportSwapLook()
    }

    private fun resetSwapLookApplied() {
        swapLookAppliedHolds = null
        swapLookEpoch++
    }

    /**
     * Tells the app whether the look is off (with why), ready, or drawn (with its
     * hold count), only when that changes, and only while JS listens. Main thread.
     */
    private fun reportSwapLook() {
        if (!swapLookStateEvents) return
        val offReason =
            OverlaySwapLook.offReason(
                swapLook,
                swapLookRejected,
                revealMode,
                reduceMotion || systemReduced,
                swapLookShaderMissing,
            )
        if (offReason != null) resetSwapLookApplied()
        val report =
            OverlaySwapLook.report(
                offReason,
                swapLookAppliedHolds,
                OverlaySwapLook.reachOffReason(systemLowPower, systemHot),
            )
        if (report == swapLookLastReport) return
        swapLookLastReport = report
        onSwapLookState(report)
    }

    /**
     * Render thread, on every swap draw while the app sends a look: whether the
     * renderer has the look program. A change is posted to the main thread, where
     * a missing program reads as off ([OverlaySwapLook.SHADER_UNAVAILABLE]).
     */
    internal fun swapLookShader(available: Boolean) {
        if (available == swapLookShaderSeen) return
        swapLookShaderSeen = available
        main.post {
            swapLookShaderMissing = !available
            resetSwapLookApplied()
            reportSwapLook()
        }
    }

    /**
     * Render thread, after each draw, with the look words it bound (0: none). A
     * frame that used the look reports it the first time, and again when its hold
     * count changes, while JS listens; the first one is logged.
     */
    internal fun swapLookDrawn(lookWords: Int) {
        if (lookWords <= 0) return
        val holds = lookWords / 4 - 1
        val epoch = swapLookEpoch
        if (epoch == swapLookDrawnEpoch && holds == swapLookDrawnHolds) return
        swapLookDrawnEpoch = epoch
        swapLookDrawnHolds = holds
        if (!swapLookLogged) {
            swapLookLogged = true
            val reach = OverlaySwapLook.reachOffReason(controls.lowPower, controls.hot) ?: "on"
            Log.i(LOG_TAG, "swap look applied: $holds holds, reach $reach")
        }
        if (!swapLookStateEvents) return
        main.post {
            if (swapLookEpoch != epoch || swapLookAppliedHolds == holds) return@post
            swapLookAppliedHolds = holds
            reportSwapLook()
        }
    }

    /**
     * Fabric view commands, forwarded by the patched expo-modules-core view
     * manager on the main thread. They run first in the next mount pass, so a
     * pending React commit cannot hold the frame back (#7737).
     */
    override fun receiveViewCommand(commandId: String, args: List<Any?>): Boolean {
        if (commandId != OverlaySwapCommand.NAME) return false
        OverlaySwapCommand.values(args)?.let(::setSwapFrame)
        return true
    }

    private fun refreshMotionPolicy() {
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        systemLowPower = power.isPowerSaveMode
        // iOS pins the look's reach at ProcessInfo.ThermalState.serious; Android's
        // nearest is SEVERE ("UX is largely impacted").
        systemHot = Build.VERSION.SDK_INT >= 29 && power.currentThermalStatus >= PowerManager.THERMAL_STATUS_SEVERE
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
        // The Reduce Motion prop, Battery Saver or the thermal status may have changed.
        reportSwapLook()
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
                sharedFloor,
                arrivals,
                swapLook,
                systemHot,
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
            // Runs once on the render thread, after any off-thread encode has returned.
            val finished: ()->Unit={
                if(activePreparation===cancel)activePreparation=null
                cancel.close();OverlayPacketMetrics.end()
                val retry=preparationQueue.finish(latest!=null && latest!=request)
                if(latest!=null && retry)schedulePrepare()
            }
            if(target.generation==request.generation)OverlayRenderer.prepare(target,request,cancel,finished) else finished()
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

    /**
     * [carried]: [request] is the old request still drawing the swap while the
     * next trio prepares. Its re-read runs while this view still allows that
     * carry, and gives way to the current request's.
     */
    internal fun observeConsumption(target: OverlaySession, request: OverlayRequest, carried: Boolean = false) {
        main.post {
            if (session !== target || !observationCurrent(request, carried)) return@post
            if (!OverlayConsumption.takesSlot(consumptionObserved, consumptionObservedCarried, request, carried))
                return@post
            cancelConsumptionObservation()
            // HWUI consumes the layer on RenderThread after TextureView's
            // synchronous update listener. Do not redraw; reread its timestamp.
            val observation = Runnable {
                consumptionObservation = null
                consumptionObserved = null
                consumptionObservedCarried = false
                if (session === target && observationCurrent(request, carried)) {
                    OverlayRenderer.consumed(target, target.texture.timestamp, request)
                }
            }
            consumptionObservation = observation
            consumptionObserved = request
            consumptionObservedCarried = carried
            main.postDelayed(observation, 16)
        }
    }

    private fun observationCurrent(request: OverlayRequest, carried: Boolean) =
        OverlayConsumption.observationCurrent(matches(request), carried, matchesGeometry(request))

    private fun cancelConsumptionObservation() {
        consumptionObservation?.let { main.removeCallbacks(it) }
        consumptionObservation = null
        consumptionObserved = null
        consumptionObservedCarried = false
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
        private const val LOG_TAG = "ClimbOverlayGPU"
        private val views = Collections.newSetFromMap(WeakHashMap<ClimbOverlayGPUView, Boolean>())

        fun foregroundChanged(foreground: Boolean) {
            OverlayRenderer.foreground = foreground
            if (!foreground) OverlayRenderer.background()
            views.toList().forEach {
                it.refreshMotionPolicy()
                it.applyProps()
            }
        }

        /** Attached views on API 29+, all told by one process-wide thermal listener. Main thread. */
        private val thermalViews = LinkedHashSet<ClimbOverlayGPUView>()
        /** The application's `PowerManager` and its `OnThermalStatusChangedListener`, while any view is attached. */
        private var thermalPower: PowerManager? = null
        private var thermalListener: Any? = null

        private fun watchThermal(view: ClimbOverlayGPUView) {
            if (Build.VERSION.SDK_INT < 29) return
            thermalViews.add(view)
            if (thermalListener != null) return
            val power = view.context.applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
            val listener =
                PowerManager.OnThermalStatusChangedListener {
                    thermalViews.toList().forEach { attached ->
                        attached.refreshMotionPolicy()
                        attached.applyProps()
                    }
                }
            power.addThermalStatusListener(listener)
            thermalPower = power
            thermalListener = listener
        }

        private fun unwatchThermal(view: ClimbOverlayGPUView) {
            if (Build.VERSION.SDK_INT < 29) return
            if (!thermalViews.remove(view) || thermalViews.isNotEmpty()) return
            (thermalListener as? PowerManager.OnThermalStatusChangedListener)?.let { thermalPower?.removeThermalStatusListener(it) }
            thermalPower = null
            thermalListener = null
        }
    }
}
