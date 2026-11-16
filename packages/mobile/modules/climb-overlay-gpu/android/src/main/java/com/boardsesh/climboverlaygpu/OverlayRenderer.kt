package com.boardsesh.climboverlaygpu

import android.app.ActivityManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES31
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import com.boardsesh.boardrenderer.BoardRendererBridge
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import kotlin.math.sqrt
import org.json.JSONObject

internal data class OverlayRequest(
    val config: String,
    val frames: String?,
    val previous: String?,
    val next: String?,
    val center: Double,
    val requestId: String,
    val revision: Long,
    val generation: Long,
    val animateEdits: Boolean,
    val observedEmpty: Boolean,
    val geometryAssetPath: String? = null,
    val geometryAssetSha256: String? = null,
    val generatedGeometryDirectory: String? = null,
) {
    fun sameGeometry(other: OverlayRequest): Boolean =
        config == other.config && generation == other.generation &&
            geometryAssetPath == other.geometryAssetPath &&
            geometryAssetSha256 == other.geometryAssetSha256 &&
            generatedGeometryDirectory == other.generatedGeometryDirectory
}

internal data class OverlayControls(
    val position: Double?,
    val reduced: Boolean,
    val lowPower: Boolean,
    val mirrored: Boolean,
)

internal data class RenderMetrics(
    val prepareMs: Double,
    val uploadMs: Double,
    val atlasBytes: Int,
    val cacheHit: Boolean,
    val changed: Int,
    val editDurationMs: Double,
    val uploadBytes: Int = 0,
    val litHoldCount: Int = 0,
)

internal class OverlaySession(
    val view: ClimbOverlayGPUView,
    val texture: SurfaceTexture,
    val generation: Long,
) {
    var surface: Surface? = null
    var bufferWidth = 0
    var bufferHeight = 0
    var eglSurface: EGLSurface = EGL14.EGL_NO_SURFACE
    var packet: UploadedPacket? = null
    var request: OverlayRequest? = null
    var baseline: Map<Long, Long>? = null
    var baselineConfig: String? = null
    var metrics: RenderMetrics? = null
    var editPending = false
    var editStart: Long? = null
    var reported = false
    val ledger = PresentationLedger()
    val fences = LinkedHashMap<Long, Pair<Long, Long>>() // timestamp -> GLsync, submission nanos
    val recovery = ContextRecoveryGate()
    var destroyed = false
}

/** All EGL, cache, native allocations and GL handles belong to this one thread. */
internal object OverlayRenderer {
    private val thread = HandlerThread("BoardseshClimbGPU").apply { start() }
    val handler = Handler(thread.looper)
    private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var context: EGLContext = EGL14.EGL_NO_CONTEXT
    private var config: EGLConfig? = null
    private var parking: EGLSurface = EGL14.EGL_NO_SURFACE
    private var initialized = false
    private var program = 0
    private var uniformBuffer = 0
    private val budget = AtlasBudget()
    private val bufferBytes = HashMap<Int, Int>()
    private val retiredBuffers = ArrayList<Pair<Long, Int>>()
    private val detachedCommandFences = ArrayList<Long>()
    private var resourcePollScheduled=false
    private var resourcePollStarted=0L
    private var contextGeneration=0L
    private val sessions = LinkedHashSet<OverlaySession>()
    private var maxBlockSize = 0
    private var maxTextureSize = 0
    private var maxViewport = intArrayOf(0, 0)
    @Volatile var foreground = true

    private fun checked(label: String) {
        val error = GLES31.glGetError()
        if (error == GLES31.GL_OUT_OF_MEMORY) throw OverlayResourceFailure()
        check(error == GLES31.GL_NO_ERROR) { "$label failed (GL $error)" }
    }

    private fun shader(type: Int, source: String): Int {
        val shader = GLES31.glCreateShader(type)
        GLES31.glShaderSource(shader, source)
        GLES31.glCompileShader(shader)
        val status = IntArray(1)
        GLES31.glGetShaderiv(shader, GLES31.GL_COMPILE_STATUS, status, 0)
        if (status[0] == 0) {
            val reason = GLES31.glGetShaderInfoLog(shader)
            val glError = GLES31.glGetError()
            GLES31.glDeleteShader(shader)
            if(glError==GLES31.GL_OUT_OF_MEMORY)throw OverlayResourceFailure()
            error("GPU shader compilation failed: $reason")
        }
        return shader
    }

    private fun initialize() {
        if (initialized) {
            park()
            return
        }
        try {
            initializeContext()
            initialized = true
        } catch (failure: Exception) {
            resetContext(recover = false)
            throw failure
        }
    }

    private fun initializeContext() {
        display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        check(display != EGL14.EGL_NO_DISPLAY)
        val versions = IntArray(2)
        check(EGL14.eglInitialize(display, versions, 0, versions, 1)) { "EGL unavailable" }
        val choices = arrayOfNulls<EGLConfig>(1)
        val count = IntArray(1)
        val attributes =
            intArrayOf(
                EGL14.EGL_RENDERABLE_TYPE,
                0x40,
                EGL14.EGL_SURFACE_TYPE,
                EGL14.EGL_WINDOW_BIT or EGL14.EGL_PBUFFER_BIT,
                EGL14.EGL_RED_SIZE,
                8,
                EGL14.EGL_GREEN_SIZE,
                8,
                EGL14.EGL_BLUE_SIZE,
                8,
                EGL14.EGL_ALPHA_SIZE,
                8,
                EGL14.EGL_NONE,
            )
        check(
            EGL14.eglChooseConfig(display, attributes, 0, choices, 0, 1, count, 0) && count[0] > 0,
        ) {
            "RGBA GLES3 surface unavailable"
        }
        config = choices[0]
        context =
            EGL14.eglCreateContext(
                display,
                config,
                EGL14.EGL_NO_CONTEXT,
                intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE),
                0,
            )
        check(context != EGL14.EGL_NO_CONTEXT) { "GLES3 unavailable" }
        parking =
            EGL14.eglCreatePbufferSurface(
                display,
                config,
                intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE),
                0,
            )
        park()
        val major = IntArray(1)
        val minor = IntArray(1)
        GLES31.glGetIntegerv(GLES31.GL_MAJOR_VERSION, major, 0)
        GLES31.glGetIntegerv(GLES31.GL_MINOR_VERSION, minor, 0)
        check(major[0] > 3 || major[0] == 3 && minor[0] >= 1) { "GLES3.1 required" }
        val blocks = IntArray(1)
        GLES31.glGetIntegerv(GLES31.GL_MAX_FRAGMENT_SHADER_STORAGE_BLOCKS, blocks, 0)
        check(blocks[0] >= 4) { "Fragment storage buffers unavailable" }
        GLES31.glGetIntegerv(GLES31.GL_MAX_SHADER_STORAGE_BLOCK_SIZE, blocks, 0)
        maxBlockSize = blocks[0]
        GLES31.glGetIntegerv(GLES31.GL_MAX_VIEWPORT_DIMS, maxViewport, 0)
        GLES31.glGetIntegerv(GLES31.GL_MAX_TEXTURE_SIZE, blocks, 0)
        maxTextureSize = blocks[0]
        check(
            EGL14.eglQueryString(display, EGL14.EGL_EXTENSIONS)
                ?.split(' ')
                ?.contains("EGL_ANDROID_presentation_time") == true,
        ) {
            "Frame timestamp extension unavailable"
        }
        val vertex = shader(GLES31.GL_VERTEX_SHADER, OverlayShader.vertex)
        val fragment =
            try {
                shader(GLES31.GL_FRAGMENT_SHADER, OverlayShader.fragment)
            } catch (failure: Exception) {
                GLES31.glDeleteShader(vertex)
                throw failure
            }
        program = GLES31.glCreateProgram()
        GLES31.glAttachShader(program, vertex)
        GLES31.glAttachShader(program, fragment)
        GLES31.glLinkProgram(program)
        GLES31.glDeleteShader(vertex)
        GLES31.glDeleteShader(fragment)
        val linked = IntArray(1)
        GLES31.glGetProgramiv(program, GLES31.GL_LINK_STATUS, linked, 0)
        check(linked[0] != 0) { "GPU shader link failed: ${GLES31.glGetProgramInfoLog(program)}" }
        uniformBuffer = buffer(directBytes(OverlayPacketLayout.UNIFORM_BYTES), GLES31.GL_UNIFORM_BUFFER)
        checked("GPU initialization")
    }

    private fun park() {
        check(
            parking != EGL14.EGL_NO_SURFACE &&
                EGL14.eglMakeCurrent(display, parking, parking, context),
        ) {
            "EGL context unavailable"
        }
    }

    private fun collectRetiredBuffers() {
        val iterator = retiredBuffers.iterator()
        while (iterator.hasNext()) {
            val (fence, amount) = iterator.next()
            val status = GLES31.glClientWaitSync(fence, 0, 0)
            if (status == GLES31.GL_ALREADY_SIGNALED || status == GLES31.GL_CONDITION_SATISFIED) {
                GLES31.glDeleteSync(fence)
                budget.release(amount)
                OverlayPacketMetrics.gpuEnd()
                iterator.remove()
            } else check(status == GLES31.GL_TIMEOUT_EXPIRED) { "GPU resource retirement failed" }
        }
    }

    private fun reserveBytes(amount: Int) {
        collectRetiredBuffers()
        if (budget.bytes + amount > OverlayPolicy.ATLAS_LIMIT && retiredBuffers.isNotEmpty()) {
            GLES31.glFinish()
            collectRetiredBuffers()
        }
        budget.reserve(amount)
    }

    private fun buffer(bytes: ByteBuffer, target: Int = GLES31.GL_SHADER_STORAGE_BUFFER): Int {
        val amount = bytes.remaining()
        val ids = IntArray(1)
        reserveBytes(amount)
        GLES31.glGenBuffers(1, ids, 0)
        try {
            GLES31.glBindBuffer(target, ids[0])
            GLES31.glBufferData(target, bytes.remaining(), bytes, GLES31.GL_STATIC_DRAW)
            checked("GPU buffer allocation")
            bufferBytes[ids[0]] = amount
            return ids[0]
        } catch (failure: Throwable) {
            GLES31.glDeleteBuffers(1, ids, 0)
            budget.release(amount)
            throw failure
        }
    }

    private fun deleteBuffer(id: Int) {
        if (id == 0) return
        val amount = bufferBytes.remove(id)
        GLES31.glDeleteBuffers(1, intArrayOf(id), 0)
        if (amount != null) {
            // glDeleteBuffers can leave storage retained by an in-flight draw.
            val fence = GLES31.glFenceSync(GLES31.GL_SYNC_GPU_COMMANDS_COMPLETE, 0)
            if (fence == 0L) {
                GLES31.glFinish()
                budget.release(amount)
            } else {
                try { retiredBuffers.add(fence to amount) }
                catch(_: OutOfMemoryError) { GLES31.glFinish();GLES31.glDeleteSync(fence);budget.release(amount);return }
                OverlayPacketMetrics.gpuBegin();scheduleResourceRetirement()
            }
        }
    }

    internal fun trackPacketUploads() {
        if(context==EGL14.EGL_NO_CONTEXT)return
        val fence=GLES31.glFenceSync(GLES31.GL_SYNC_GPU_COMMANDS_COMPLETE,0)
        if(fence==0L) { GLES31.glFinish();return }
        try { detachedCommandFences.add(fence) }
        catch(_: OutOfMemoryError) { GLES31.glFinish();GLES31.glDeleteSync(fence);return }
        OverlayPacketMetrics.gpuBegin();scheduleResourceRetirement()
    }
    internal fun scheduleResourceRetirement() {
        GLES31.glFlush()
        if(resourcePollScheduled)return
        resourcePollScheduled=true;resourcePollStarted=System.nanoTime()
        val generation=contextGeneration
        handler.postDelayed(object: Runnable {
            override fun run() {
                if(generation!=contextGeneration)return
                if(context==EGL14.EGL_NO_CONTEXT) { resourcePollScheduled=false;return }
                try {
                    val completedBefore=OverlayPacketMetrics.gpuCompletionEpoch()
                    park();collectRetiredBuffers();OverlayPacketArena.collect()
                    val iterator=detachedCommandFences.iterator()
                    while(iterator.hasNext()) {
                        val fence=iterator.next();val status=GLES31.glClientWaitSync(fence,0,0)
                        if(status==GLES31.GL_ALREADY_SIGNALED || status==GLES31.GL_CONDITION_SATISFIED) {
                            GLES31.glDeleteSync(fence);OverlayPacketMetrics.gpuEnd();iterator.remove()
                        } else check(status==GLES31.GL_TIMEOUT_EXPIRED)
                    }
                    if(OverlayPacketMetrics.gpuCompletionEpoch()!=completedBefore)resourcePollStarted=System.nanoTime()
                    if(retiredBuffers.isEmpty() && !OverlayPacketArena.hasRetired() && detachedCommandFences.isEmpty())resourcePollScheduled=false
                    else if(System.nanoTime()-resourcePollStarted>5_000_000_000L) { resourcePollScheduled=false;resetContext() }
                    else handler.postDelayed(this,8)
                } catch(_: Exception) { resourcePollScheduled=false;resetContext() }
            }
        },8)
    }

    internal fun checkPacketGL() = checked("GPU packet allocation/upload")
    internal fun uploadPacketBuffer(bytes: ByteBuffer): Int = buffer(bytes)
    internal fun deletePacketBuffer(id: Int) = deleteBuffer(id)
    internal fun allocatePacketBuffer(amount: Int): Int {
        require(amount in 4..minOf(OverlayPacketLayout.MAX_GPU_BYTES,maxBlockSize))
        val ids=IntArray(1);reserveBytes(amount)
        GLES31.glGenBuffers(1,ids,0)
        try {
            GLES31.glBindBuffer(GLES31.GL_SHADER_STORAGE_BUFFER,ids[0])
            GLES31.glBufferData(GLES31.GL_SHADER_STORAGE_BUFFER,amount,null,GLES31.GL_DYNAMIC_DRAW)
            checked("GPU arena allocation");bufferBytes[ids[0]]=amount;return ids[0]
        } catch(failure: Throwable) { GLES31.glDeleteBuffers(1,ids,0);budget.release(amount);throw failure }
    }

    private fun releaseScenes(session: OverlaySession) {
        OverlayPacketArena.retire(session.packet);session.packet=null
        session.editPending=false;session.editStart=null;session.metrics=null
    }

    fun attach(session: OverlaySession) {
        handler.post {
            try {
                if (!session.view.matchesGeneration(session.generation)) return@post
                initialize()
                ensureWindowSurface(session)
                session.view.schedulePrepare()
            } catch (failure: Exception) {
                fail(session, failure)
            }
        }
    }

    private fun ensureWindowSurface(session: OverlaySession) {
        if (session.eglSurface != EGL14.EGL_NO_SURFACE) return
        if (session.surface == null) session.surface = Surface(session.texture)
        session.eglSurface = EGL14.eglCreateWindowSurface(
            display, config, session.surface, intArrayOf(EGL14.EGL_NONE), 0,
        )
        check(session.eglSurface != EGL14.EGL_NO_SURFACE) { "GPU window surface unavailable" }
        session.bufferWidth = 0
        session.bufferHeight = 0
        sessions.add(session)
    }

    fun detach(session: OverlaySession) {
        handler.post {
            if (session.destroyed) return@post
            session.destroyed = true
            if (context != EGL14.EGL_NO_CONTEXT) {
                try {
                    park()
                    clearFences(session)
                    releaseScenes(session)
                    } catch (_: Exception) {
                    resetContext()
                }
                if (session.eglSurface != EGL14.EGL_NO_SURFACE)
                    EGL14.eglDestroySurface(display, session.eglSurface)
            }
            session.eglSurface = EGL14.EGL_NO_SURFACE
            session.surface?.release()
            session.surface = null
            // TextureView returned false: release only after EGL no longer uses it.
            session.texture.release()
            sessions.remove(session)
        }
    }

    fun deactivate(session: OverlaySession) {
        handler.post {
            if (session.destroyed || context == EGL14.EGL_NO_CONTEXT) return@post
            try {
                park()
                clearFences(session)
                releaseScenes(session)
                session.request = null
                session.baseline = null
                session.baselineConfig = null
            } catch (failure: Exception) {
                fail(session, failure)
            }
        }
    }

    private fun clearFences(session: OverlaySession) {
        session.fences.values.forEach { detachedCommandFences.add(it.first) }
        if(session.fences.isNotEmpty())scheduleResourceRetirement()
        session.fences.clear()
        session.ledger.clear()
    }

    fun prepare(session: OverlaySession, request: OverlayRequest,cancel: PacketCancellation) {
        try {
            if (!OverlayLifecycle.beginPreparation({ canPrepare(session,request) },{ initialize() },{ ensureWindowSurface(session) })) return
            clearFences(session);releaseScenes(session)
            val baseline=if(!request.animateEdits)null else if(session.baselineConfig==request.config)session.baseline else if(request.observedEmpty)emptyMap() else null
            OverlayPacketArena.session(session.view.context,request.config,cancel).use { cpu ->
                val packet=OverlayPacketArena.prepare(cpu,packetSource(request.frames,request.previous,request.next,baseline),cancel,
                    { canPrepare(session,request) }) ?: throw OverlayWorkCancelled()
                if(!eligible(session,request)) { OverlayPacketArena.retire(packet);return }
                session.packet=packet;session.request=request;session.reported=false
                if(request.animateEdits) { session.baseline=packet.header.roles;session.baselineConfig=request.config }
                val controls=session.view.controls
                session.editPending=request.animateEdits && packet.header.changed>0 && !controls.reduced && !controls.lowPower
                session.metrics=RenderMetrics(packet.prepareMs,packet.uploadMs,packet.selectedBytes,packet.hit,packet.header.changed,
                    if(session.editPending)OverlayPolicy.EDIT_DURATION_NS/1e6 else 0.0,packet.uploadBytes,packet.header.scenes[0].count)
                ensureSurfaceSize(session,packet.header.width,packet.header.height)
                if(eligible(session,request))session.view.requestDraw()
            }
        } catch(failure: OutOfMemoryError) { fail(session,OverlayResourceFailure(),request) }
        catch(failure: Exception) { fail(session,failure,request) }
    }

    fun resized(session: OverlaySession) {
        handler.post {
            if (session.destroyed) return@post
            session.bufferWidth = 0
            session.view.requestDraw()
        }
    }

    private fun ensureSurfaceSize(session: OverlaySession, width: Int,height: Int) {
        if (
            session.eglSurface == EGL14.EGL_NO_SURFACE ||
                session.bufferWidth != width ||
                session.bufferHeight != height
        ) {
            clearFences(session)
            park()
            if (session.eglSurface != EGL14.EGL_NO_SURFACE)
                EGL14.eglDestroySurface(display, session.eglSurface)
            session.eglSurface = EGL14.EGL_NO_SURFACE
            session.texture.setDefaultBufferSize(width, height)
            session.eglSurface =
                EGL14.eglCreateWindowSurface(
                    display,
                    config,
                    session.surface,
                    intArrayOf(EGL14.EGL_NONE),
                    0,
                )
            check(session.eglSurface != EGL14.EGL_NO_SURFACE) {
                "GPU atlas-sized surface unavailable"
            }
            val actualWidth = IntArray(1)
            val actualHeight = IntArray(1)
            check(
                EGL14.eglQuerySurface(
                    display,
                    session.eglSurface,
                    EGL14.EGL_WIDTH,
                    actualWidth,
                    0,
                ) &&
                    EGL14.eglQuerySurface(
                        display,
                        session.eglSurface,
                        EGL14.EGL_HEIGHT,
                        actualHeight,
                        0,
                    ) &&
                    actualWidth[0] == width &&
                    actualHeight[0] == height,
            ) {
                "GPU surface dimensions do not match atlas"
            }
            session.bufferWidth = width
            session.bufferHeight = height
        }
    }

    private fun eligible(session: OverlaySession, request: OverlayRequest): Boolean =
        canPrepare(session, request) && session.eglSurface != EGL14.EGL_NO_SURFACE

    private fun canPrepare(session: OverlaySession, request: OverlayRequest): Boolean =
        foreground &&
            !session.destroyed &&
            session.view.matches(request)

    private fun encode(packet: UploadedPacket,lower: Int,upper: Int,params: ByteBuffer) {
        GLES31.glViewport(0,0,packet.header.width,packet.header.height)
        GLES31.glDisable(GLES31.GL_BLEND);GLES31.glDisable(GLES31.GL_DEPTH_TEST);GLES31.glDisable(GLES31.GL_DITHER)
        GLES31.glUseProgram(program)
        GLES31.glBindBufferBase(GLES31.GL_SHADER_STORAGE_BUFFER,OverlayPacketLayout.GLES_STORAGE_BINDINGS_PIXELS,packet.arena.buffer)
        GLES31.glBindBufferBase(GLES31.GL_SHADER_STORAGE_BUFFER,OverlayPacketLayout.GLES_STORAGE_BINDINGS_LOWER,packet.descriptors[lower])
        GLES31.glBindBufferBase(GLES31.GL_SHADER_STORAGE_BUFFER,OverlayPacketLayout.GLES_STORAGE_BINDINGS_UPPER,packet.descriptors[upper])
        GLES31.glBindBufferBase(GLES31.GL_SHADER_STORAGE_BUFFER,OverlayPacketLayout.GLES_STORAGE_BINDINGS_RESOURCES,packet.resources)
        GLES31.glBindBuffer(GLES31.GL_UNIFORM_BUFFER,uniformBuffer)
        GLES31.glBufferSubData(GLES31.GL_UNIFORM_BUFFER,0,OverlayPacketLayout.UNIFORM_BYTES,params)
        GLES31.glBindBufferBase(GLES31.GL_UNIFORM_BUFFER,OverlayPacketLayout.GLES_UNIFORM_BINDINGS_UNIFORMS,uniformBuffer)
        GLES31.glDrawArrays(GLES31.GL_TRIANGLES,0,3);checked("GPU draw")
    }

    fun draw(session: OverlaySession): Boolean {
        val request = session.request ?: return false
        if (!eligible(session, request)) return false
        try {
            val packet = session.packet ?: return false
            ensureSurfaceSize(session,packet.header.width,packet.header.height)
            if (!OverlayPolicy.canSubmit(session.ledger.size, session.fences.size)) return false
            check(EGL14.eglMakeCurrent(display, session.eglSurface, session.eglSurface, context)) {
                "GPU surface lost"
            }
            val controls = session.view.controls
            if (controls.reduced || controls.lowPower || !request.animateEdits) {
                session.editPending = false
                session.editStart = null
            }
            val selection =
                OverlayPolicy.select(
                    controls.position ?: request.center,
                    request.center,
                    packet.header.present[1],
                    packet.header.present[2],
                    controls.reduced,
                )
            val lower = if (selection.lower == -1) 1 else 0
            val upper = if (selection.upper == 1) 2 else 0
            val now = System.nanoTime()
            val reach = session.editStart?.let { OverlayPolicy.reach(now - it) } ?: 1f
            if (!eligible(session, request)) return false
            GLES31.glBindFramebuffer(GLES31.GL_FRAMEBUFFER, 0)
            encode(packet,lower,upper,packet.uniforms(lower,upper,selection.progress,reach,
                request.previous!=null || request.next!=null || request.animateEdits,controls.mirrored))
            val frame =
                session.ledger.submit(now, request.revision, request.generation) ?: return false
            check(EGLExt.eglPresentationTimeANDROID(display, session.eglSurface, frame.timestamp)) {
                "GPU frame timestamp failed"
            }
            val sync = GLES31.glFenceSync(GLES31.GL_SYNC_GPU_COMMANDS_COMPLETE, 0)
            check(sync != 0L) { "GPU completion fence unavailable" }
            session.fences[frame.timestamp] = sync to now
            OverlayPacketMetrics.gpuBegin()
            check(EGL14.eglSwapBuffers(display, session.eglSurface)) { "GPU swap failed" }
            poll(session, frame.timestamp)
            val running =
                session.editStart?.let { now - it < OverlayPolicy.EDIT_DURATION_NS } == true
            if (!running && session.editStart != null) session.editStart = null
            if (running) session.view.requestAnimationFrame()
            return true
        } catch (failure: Exception) {
            fail(session, failure, request, scope = "context")
            return false
        }
    }

    private fun poll(session: OverlaySession, timestamp: Long) {
        val fence = session.fences[timestamp] ?: return
        if (session.destroyed) return
        try {
            park()
            val status = GLES31.glClientWaitSync(fence.first, 0, 0)
            if (status == GLES31.GL_TIMEOUT_EXPIRED) {
                check(System.nanoTime() - fence.second < 2_000_000_000L) {
                    "GPU completion timed out"
                }
                handler.postDelayed({ poll(session, timestamp) }, 2)
                return
            }
            check(status == GLES31.GL_ALREADY_SIGNALED || status == GLES31.GL_CONDITION_SATISFIED) {
                "GPU completion failed"
            }
            GLES31.glDeleteSync(fence.first);OverlayPacketMetrics.gpuEnd()
            session.fences.remove(timestamp)
            session.ledger.finish(timestamp)?.let { accept(session, it) }
            requestConsumptionObservation(session)
            session.view.resumeDraw()
        } catch (failure: Exception) {
            fail(session, failure, scope = "context")
        }
    }

    fun consumed(
        session: OverlaySession,
        timestamp: Long,
        observedRequest: OverlayRequest? = null,
    ) {
        handler.post {
            if (observedRequest != null && session.request != observedRequest) return@post
            val consumed = session.ledger.consume(timestamp)
            consumed?.let { accept(session, it) }
            requestConsumptionObservation(session)
        }
    }

    private fun requestConsumptionObservation(session: OverlaySession) {
        val request = session.request ?: return
        if (!eligible(session, request)) return
        when (
            session.ledger.consumptionWait(System.nanoTime(), request.revision, request.generation)
        ) {
            PresentationLedger.ConsumptionWait.NONE -> Unit
            PresentationLedger.ConsumptionWait.RETRY ->
                session.view.observeConsumption(session, request)
            PresentationLedger.ConsumptionWait.TIMED_OUT -> {
                clearFences(session)
                fail(
                    session,
                    IllegalStateException("GPU texture consumption timestamp unavailable"),
                    request,
                )
            }
        }
    }

    private fun accept(session: OverlaySession, frame: PresentationLedger.Frame) {
        val request = session.request ?: return
        if (!session.ledger.accept(frame, request.revision, request.generation)) return
        if (!eligible(session, request)) return
        if (!session.reported) {
            session.reported = true
            val controls = session.view.controls
            if (session.editPending && !controls.reduced && !controls.lowPower) {
                session.editPending = false
                session.editStart = System.nanoTime()
                session.view.requestAnimationFrame()
            }
            session.view.ready(request, session.metrics ?: return)
            session.packet?.session?.persistAfterReady()
            session.view.schedulePrefetch()
        }
        // Progress could have changed while both queued frames were in flight.
        session.view.resumeDraw()
    }

    private fun fail(
        session: OverlaySession,
        failure: Exception,
        request: OverlayRequest? = session.request,
        scope: String = "static",
    ) {
        session.editPending = false
        session.editStart = null
        val eglFailure = EGL14.eglGetError()
        if (eglFailure == EGL14.EGL_CONTEXT_LOST || eglFailure == EGL14.EGL_BAD_CONTEXT) {
            session.request = request ?: session.view.currentRequest()
            sessions.add(session)
            resetContext()
            return
        }
        val cancelled = failure is OverlayWorkCancelled || request?.let { !canPrepare(session, it) } == true
        val frameFailure = failure as? AtlasFrameFailure
        val packetFailure = failure as? PacketFailure
        if (context != EGL14.EGL_NO_CONTEXT) {
            try {
                park()
                clearFences(session)
                releaseScenes(session)
                session.request = null
                session.metrics = null
                // Frame/cancellation errors leave CPU sessions and arena residency intact.
            } catch (_: Exception) {
                session.request = request ?: session.view.currentRequest()
                sessions.add(session)
                resetContext()
                return
            }
        }
        if (cancelled) return
        session.view.failed(request,
            packetFailure?.reason ?: frameFailure?.reasonCode ?: if (failure is OverlayResourceFailure || eglFailure==EGL14.EGL_BAD_ALLOC) "gpu-resource-limit" else "gpu-preparation-failed",
            packetFailure?.scope ?: if (frameFailure != null) "frame" else if (failure is OverlayResourceFailure || eglFailure==EGL14.EGL_BAD_ALLOC) "context" else scope)
    }

    private fun resetContext(recover: Boolean = true) {
        contextGeneration++
        val retry = ArrayList<OverlaySession>()
        sessions.forEach { session ->
            session.fences.clear()
            session.ledger.clear()
            session.editPending = false
            session.editStart = null
            session.bufferWidth = 0
            session.bufferHeight = 0
            session.reported = false
            // A newer request can already be queued while this shared context
            // is lost. Recover the current view request, not stale scene state.
            val request = session.view.currentRequest()
            if (recover && request != null && canPrepare(session, request)) {
                if (session.recovery.retry(request.revision, request.generation)) retry.add(session)
                else session.view.failed(request, "gpu-context-lost", "context")
            }
            if (session.eglSurface != EGL14.EGL_NO_SURFACE)
                EGL14.eglDestroySurface(display, session.eglSurface)
            session.eglSurface = EGL14.EGL_NO_SURFACE
        }
        OverlayPacketArena.abandonContext()
        sessions.forEach { it.packet?.let { packet->packet.handle.close();packet.session.close() };it.packet=null }
        bufferBytes.clear()
        retiredBuffers.clear()
        detachedCommandFences.clear();resourcePollScheduled=false
        EGL14.eglMakeCurrent(
            display,
            EGL14.EGL_NO_SURFACE,
            EGL14.EGL_NO_SURFACE,
            EGL14.EGL_NO_CONTEXT,
        )
        if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context)
        if (parking != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, parking)
        EGL14.eglTerminate(display)
        context = EGL14.EGL_NO_CONTEXT
        parking = EGL14.EGL_NO_SURFACE
        display = EGL14.EGL_NO_DISPLAY
        program = 0
        uniformBuffer = 0
        initialized = false
        OverlayPacketMetrics.gpuReset()
        // Destroy the old context before releasing its allocation accounting.
        if (budget.bytes > 0) budget.release(budget.bytes.toInt())
        retry.forEach { it.view.retryAfterContextLoss() }
    }

    fun compare(app: Context, source: String): Map<String, Any?> {
        check(foreground) { "GPU comparison requires foreground app" }
        initialize()
        val started = System.nanoTime()
        val cancel=PacketCancellation()
        val cpu=OverlayPacketArena.session(app,source,cancel)
        val packet=try { OverlayPacketArena.prepare(cpu,packetSource(null,null,null,null),cancel,{foreground})!! }
            catch(failure: Throwable) { cpu.close();cancel.close();throw failure }
        var texture = 0
        var framebuffer = 0
        var comparisonBytes = 0
        try {
            val prepareMs = (System.nanoTime() - started) / 1e6
            val width = packet.header.width
            val height = packet.header.height
            val activity = app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val memory = ActivityManager.MemoryInfo()
            activity.getMemoryInfo(memory)
            check(
                !memory.lowMemory &&
                    memory.availMem - memory.threshold >=
                        OverlayPolicy.comparisonHeadroom(width, height),
            ) {
                "Insufficient memory headroom for GPU comparison"
            }
            reserveBytes(width * height * 4)
            comparisonBytes = width * height * 4
            val ids = IntArray(1)
            GLES31.glGenTextures(1, ids, 0)
            texture = ids[0]
            GLES31.glBindTexture(GLES31.GL_TEXTURE_2D, texture)
            GLES31.glTexStorage2D(GLES31.GL_TEXTURE_2D, 1, GLES31.GL_RGBA8, width, height)
            GLES31.glGenFramebuffers(1, ids, 0)
            framebuffer = ids[0]
            GLES31.glBindFramebuffer(GLES31.GL_FRAMEBUFFER, framebuffer)
            GLES31.glFramebufferTexture2D(
                GLES31.GL_FRAMEBUFFER,
                GLES31.GL_COLOR_ATTACHMENT0,
                GLES31.GL_TEXTURE_2D,
                texture,
                0,
            )
            check(
                GLES31.glCheckFramebufferStatus(GLES31.GL_FRAMEBUFFER) ==
                    GLES31.GL_FRAMEBUFFER_COMPLETE,
            )
            check(foreground) { "GPU comparison cancelled while backgrounded" }
            encode(packet,0,0,packet.uniforms(0,0,0f,1f,false,false))
            val readback = directBytes(width * height * 4)
            GLES31.glReadPixels(
                0,
                0,
                width,
                height,
                GLES31.GL_RGBA,
                GLES31.GL_UNSIGNED_BYTE,
                readback,
            )
            checked("GPU comparison readback")
            val gpu = ByteArray(width * height * 4)
            // glReadPixels produces bottom-up rows.
            for (row in 0 until height) {
                readback.position((height - 1 - row) * width * 4)
                readback.get(gpu, row * width * 4, width * 4)
            }
            val cpuStarted = System.nanoTime()
            val reference =
                BoardRendererBridge.render(source) ?: error("Rust reference render failed")
            val cpuMs = (System.nanoTime() - cpuStarted) / 1e6
            require(
                reference.width == width &&
                    reference.height == height &&
                    reference.data.size == gpu.size,
            )
            var maxError = 0
            var sum = 0.0
            var pixelsOverOne = 0
            for (pixel in 0 until width * height) {
                var exceeds = false
                for (channel in 0..3) {
                    val index = pixel * 4 + channel
                    val delta =
                        kotlin.math.abs(
                            (gpu[index].toInt() and 255) - (reference.data[index].toInt() and 255),
                        )
                    maxError = maxOf(maxError, delta)
                    sum += delta.toDouble() * delta
                    if (delta > 1) exceeds = true
                }
                if (exceeds) pixelsOverOne++
            }
            val directory = File(app.cacheDir, "climb-overlay-gpu").apply { mkdirs() }
            val token = UUID.randomUUID().toString()
            fun png(bytes: ByteArray, name: String): String {
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                bitmap.setPremultiplied(true)
                try {
                    bitmap.copyPixelsFromBuffer(ByteBuffer.wrap(bytes))
                    val file = File(directory, "$token-$name.png")
                    file.outputStream().use {
                        check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
                    }
                    return android.net.Uri.fromFile(file).toString()
                } finally {
                    bitmap.recycle()
                }
            }
            return mapOf(
                "width" to width,
                "height" to height,
                "maxChannelError" to maxError,
                "rmse" to sqrt(sum / gpu.size),
                "pixelsOverOne" to pixelsOverOne,
                "cpuRenderMs" to cpuMs,
                "gpuMs" to null,
                "prepareMs" to prepareMs,
                "uploadMs" to packet.uploadMs,
                "atlasBytes" to packet.selectedBytes,
                "atlasCacheHit" to packet.hit,
                "gpuUri" to png(gpu, "gpu"),
                "referenceUri" to png(reference.data, "reference"),
            )
        } finally {
            GLES31.glBindFramebuffer(GLES31.GL_FRAMEBUFFER, 0)
            OverlayPacketArena.retire(packet)
            if (framebuffer != 0) GLES31.glDeleteFramebuffers(1, intArrayOf(framebuffer), 0)
            if (texture != 0) GLES31.glDeleteTextures(1, intArrayOf(texture), 0)
            if (comparisonBytes > 0) {
                GLES31.glFinish()
                budget.release(comparisonBytes)
            }
            cpu.close();cancel.close()
        }
    }

    fun resourceStats(): Map<String,Any?> = packetResourceStats()+mapOf("gpuReservedBytes" to budget.bytes)

    fun trim() {
        handler.post { if(context!=EGL14.EGL_NO_CONTEXT) { park();OverlayPacketArena.releaseGPU() } }
    }
    fun prefetch(app: Context,request: OverlayRequest,frames: List<String>,cancel: PacketCancellation,valid: ()->Boolean) {
        if(!foreground || !valid() || !initialized)return
        try {
            park()
            OverlayPacketArena.session(app,request.config,cancel).use { session ->
                for(frame in frames.take(2)) {
                    if(!foreground || !valid())return
                    OverlayPacketArena.prepare(session,packetSource(frame,null,null,null),cancel,{foreground && valid()},true)
                }
            }
        } catch(_: Exception) { /* Optional acceleration never emits Ready or failure. */ }
    }

    fun background() {
        foreground = false
        handler.post {
            try {
                if (context != EGL14.EGL_NO_CONTEXT) {
                    park()
                    sessions.forEach {
                        it.editPending = false
                        it.editStart = null
                        clearFences(it)
                        releaseScenes(it)
                        it.request = null
                    }
                OverlayPacketArena.releaseGPU()
                }
            } catch (_: Exception) {
                resetContext(recover = false)
            }
        }
    }
}
