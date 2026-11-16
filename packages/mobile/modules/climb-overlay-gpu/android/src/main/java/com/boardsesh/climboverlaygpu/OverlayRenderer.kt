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
)

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
)

internal class UploadedAtlas(
    val source: String,
    val key: String,
    val assetKey: List<String?>,
    val manifest: AtlasManifest,
    val pixels: Int,
    val lut: Int,
    val bytes: Int,
    val uploadMs: Double,
) {
    var users = 0
}

internal class OverlaySession(
    val view: ClimbOverlayGPUView,
    val texture: SurfaceTexture,
    val generation: Long,
) {
    var surface: Surface? = null
    var bufferWidth = 0
    var bufferHeight = 0
    var eglSurface: EGLSurface = EGL14.EGL_NO_SURFACE
    var atlas: UploadedAtlas? = null
    var preparedConfig: String? = null
    var preparedAssetKey: List<String?>? = null
    var current: ActiveScene? = null
    var previous: ActiveScene? = null
    var next: ActiveScene? = null
    var request: OverlayRequest? = null
    var baseline: Map<Long, Long>? = null
    var baselineConfig: String? = null
    var metrics: RenderMetrics? = null
    var editPending = false
    var editStart: Long? = null
    var reported = false
    val ledger = PresentationLedger()
    val fences = LinkedHashMap<Long, Pair<Long, Long>>() // timestamp -> GLsync, submission nanos
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
    private var initializationFailure: String? = null
    private var program = 0
    private var uniformBuffer = 0
    private var cache: UploadedAtlas? = null
    private val budget = AtlasBudget()
    private val bufferBytes = HashMap<Int, Int>()
    private val retiredBuffers = ArrayList<Pair<Long, Int>>()
    private val sessions = LinkedHashSet<OverlaySession>()
    private var maxBlockSize = 0
    private var maxTextureSize = 0
    private var maxViewport = intArrayOf(0, 0)
    @Volatile var foreground = true

    private fun checked(label: String) {
        val error = GLES31.glGetError()
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
            GLES31.glDeleteShader(shader)
            error("GPU shader compilation failed: $reason")
        }
        return shader
    }

    private fun initialize() {
        initializationFailure?.let { error(it) }
        if (initialized) {
            park()
            return
        }
        try {
            initializeContext()
            initialized = true
        } catch (failure: Exception) {
            resetContext()
            initializationFailure = failure.message ?: "GPU initialization unavailable"
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
        uniformBuffer = buffer(directBytes(144), GLES31.GL_UNIFORM_BUFFER)
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
        reserveBytes(amount)
        val ids = IntArray(1)
        GLES31.glGenBuffers(1, ids, 0)
        try {
            GLES31.glBindBuffer(target, ids[0])
            GLES31.glBufferData(target, bytes.remaining(), bytes, GLES31.GL_STATIC_DRAW)
            checked("GPU buffer allocation")
            bufferBytes[ids[0]] = amount
            return ids[0]
        } catch (failure: Exception) {
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
            } else retiredBuffers.add(fence to amount)
        }
    }

    private fun releaseScene(scene: ActiveScene?) {
        scene?.let { deleteBuffer(it.buffer) }
    }

    private fun releaseScenes(session: OverlaySession) {
        releaseScene(session.current)
        releaseScene(session.previous)
        releaseScene(session.next)
        session.current = null
        session.previous = null
        session.next = null
        session.editPending = false
        session.editStart = null
        session.metrics = null
    }

    private fun dropCache() {
        cache?.let {
            check(it.users == 0) { "Cannot evict an active atlas" }
            GLES31.glFinish() // Old commands must release residency before replacement.
            deleteBuffer(it.pixels)
            deleteBuffer(it.lut)
            collectRetiredBuffers()
        }
        cache = null
    }

    private fun releaseAtlas(session: OverlaySession) {
        session.atlas?.let {
            check(it.users > 0)
            it.users--
        }
        session.atlas = null
        session.preparedConfig = null
        session.preparedAssetKey = null
    }

    private fun acquireAtlas(
        app: Context,
        source: String,
        geometryAssetPath: String? = null,
        geometryAssetSha256: String? = null,
        generatedGeometryDirectory: String? = null,
        canUpload: () -> Boolean = { foreground },
    ): Pair<UploadedAtlas, Boolean> {
        val assetKey = listOf(geometryAssetPath, geometryAssetSha256, generatedGeometryDirectory)
        cache
            ?.takeIf { it.source == source && it.assetKey == assetKey }
            ?.let {
                it.users++
                return it to true
            }
        require(source.length <= 8 * 1024 * 1024) { "GPU config too large" }
        val canonical = JSONObject(source).apply { put("frames", "") }.toString()
        cache
            ?.takeIf { it.key == canonical && it.assetKey == assetKey }
            ?.let {
                it.users++
                return it to true
            }
        check(cache?.users == null || cache?.users == 0) {
            "Another layout occupies the GPU atlas budget"
        }
        dropCache()
        val activity = app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memory = ActivityManager.MemoryInfo()
        activity.getMemoryInfo(memory)
        check(
            !activity.isLowRamDevice &&
                !memory.lowMemory &&
                memory.availMem - memory.threshold >= OverlayPolicy.PREPARE_HEADROOM,
        ) {
            "Insufficient memory headroom for GPU atlas preparation"
        }
        // Serial executor permits only one Rust prepare/upload allocation at a time.
        val atlas =
            BoardRendererBridge.prepareOwnedAtlas(canonical, geometryAssetPath, geometryAssetSha256, generatedGeometryDirectory).use { owner ->
                owner.useBuffers { manifestBytes, rawPixels ->
                    require(manifestBytes.remaining() in 1..4 * 1024 * 1024)
                    val header = ByteArray(manifestBytes.remaining())
                    manifestBytes.get(header)
                    val payload = rawPixels.slice().order(ByteOrder.LITTLE_ENDIAN)
                    val manifest =
                        AtlasManifest.parse(String(header, Charsets.UTF_8), payload.remaining())
                    require(
                        payload.remaining() <= maxBlockSize &&
                            manifest.width <= maxViewport[0] &&
                            manifest.height <= maxViewport[1] &&
                            manifest.width <= maxTextureSize &&
                            manifest.height <= maxTextureSize,
                    ) {
                        "GPU storage or viewport limit exceeded"
                    }
                    check(canUpload()) { "GPU atlas upload cancelled" }
                    var pixels = 0
                    var lut = 0
                    try {
                        val started = System.nanoTime()
                        pixels = buffer(payload)
                        val lutBytes = directBytes(257 * 4)
                        manifest.lut.forEach { lutBytes.putFloat(it) }
                        lutBytes.flip()
                        lut = buffer(lutBytes)
                        UploadedAtlas(
                            source,
                            canonical,
                            assetKey,
                            manifest,
                            pixels,
                            lut,
                            payload.remaining(),
                            (System.nanoTime() - started) / 1e6,
                        )
                    } catch (failure: Exception) {
                        deleteBuffer(pixels)
                        deleteBuffer(lut)
                        throw failure
                    }
                }
            }
        if (!canUpload()) {
            deleteBuffer(atlas.pixels)
            deleteBuffer(atlas.lut)
            error("GPU atlas preparation cancelled")
        }
        atlas.users = 1
        cache = atlas
        return atlas to false
    }

    fun attach(session: OverlaySession) {
        handler.post {
            try {
                if (!session.view.matchesGeneration(session.generation)) return@post
                initialize()
                session.surface = Surface(session.texture)
                session.eglSurface =
                    EGL14.eglCreateWindowSurface(
                        display,
                        config,
                        session.surface,
                        intArrayOf(EGL14.EGL_NONE),
                        0,
                    )
                check(session.eglSurface != EGL14.EGL_NO_SURFACE) {
                    "GPU window surface unavailable"
                }
                sessions.add(session)
                session.view.schedulePrepare()
            } catch (failure: Exception) {
                fail(session, failure)
            }
        }
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
                    releaseAtlas(session)
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
                releaseAtlas(session)
                session.request = null
                session.baseline = null
                session.baselineConfig = null
            } catch (failure: Exception) {
                fail(session, failure)
            }
        }
    }

    private fun clearFences(session: OverlaySession) {
        session.fences.values.forEach { GLES31.glDeleteSync(it.first) }
        session.fences.clear()
        session.ledger.clear()
    }

    fun prepare(session: OverlaySession, request: OverlayRequest) {
        try {
            if (!eligible(session, request)) return
            initialize()
            clearFences(session)
            releaseScenes(session)
            val started = System.nanoTime()
            val atlas: UploadedAtlas
            val hit: Boolean
            if (session.atlas != null && session.preparedConfig == request.config && session.preparedAssetKey == listOf(request.geometryAssetPath, request.geometryAssetSha256, request.generatedGeometryDirectory)) {
                atlas = session.atlas!!
                hit = true
            } else {
                releaseAtlas(session)
                val acquired =
                    acquireAtlas(session.view.context, request.config, request.geometryAssetPath, request.geometryAssetSha256, request.generatedGeometryDirectory) {
                        eligible(session, request)
                    }
                atlas = acquired.first
                hit = acquired.second
                session.atlas = atlas
                session.preparedConfig = request.config
                session.preparedAssetKey = listOf(request.geometryAssetPath, request.geometryAssetSha256, request.generatedGeometryDirectory)
            }
            if (!eligible(session, request)) {
                releaseAtlas(session)
                trim()
                return
            }
            val frames = request.frames ?: JSONObject(request.config).getString("frames")
            val current = selectHolds(atlas.manifest, frames)
            val previous = request.previous?.let { selectHolds(atlas.manifest, it) }
            val next = request.next?.let { selectHolds(atlas.manifest, it) }
            fun roles(holds: List<ActiveHold>?) =
                holds.orEmpty().associate { it.hold.id to it.role.identity }
            val currentRoles = roles(current)
            val previousRoles = roles(previous)
            val nextRoles = roles(next)
            val baseline =
                if (!request.animateEdits) null
                else if (session.baselineConfig == request.config) session.baseline
                else if (request.observedEmpty) emptyMap() else null
            fun annotate(
                holds: List<ActiveHold>,
                lower: Map<Long, Long>,
                upper: Map<Long, Long>,
                baseline: Map<Long, Long>?,
            ): ActiveScene {
                for (active in holds) {
                    active.previous =
                        lower[active.hold.id]?.let { if (it == active.role.identity) 1 else 2 } ?: 0
                    active.next =
                        upper[active.hold.id]?.let { if (it == active.role.identity) 1 else 2 } ?: 0
                    active.changed =
                        baseline != null && baseline[active.hold.id] != active.role.identity
                }
                return ActiveScene(holds, buffer(encodeHolds(holds)))
            }
            session.current = annotate(current, previousRoles, nextRoles, baseline)
            session.previous = previous?.let { annotate(it, emptyMap(), currentRoles, null) }
            session.next = next?.let { annotate(it, currentRoles, emptyMap(), null) }
            if (!eligible(session, request)) {
                releaseScenes(session)
                releaseAtlas(session)
                trim()
                return
            }
            session.request = request
            session.reported = false
            if (request.animateEdits) {
                session.baseline = currentRoles
                session.baselineConfig = request.config
            }
            val controls = session.view.controls
            val changed = current.count { it.changed }
            session.editPending =
                request.animateEdits && changed > 0 && !controls.reduced && !controls.lowPower
            session.metrics =
                RenderMetrics(
                    (System.nanoTime() - started) / 1e6,
                    if (hit) 0.0 else atlas.uploadMs,
                    atlas.bytes,
                    hit,
                    changed,
                    if (session.editPending) OverlayPolicy.EDIT_DURATION_NS / 1e6 else 0.0,
                )
            ensureSurfaceSize(session, atlas)
            if (eligible(session, request)) session.view.requestDraw()
        } catch (failure: Exception) {
            fail(session, failure, request)
        }
    }

    fun resized(session: OverlaySession) {
        handler.post {
            if (session.destroyed) return@post
            session.bufferWidth = 0
            session.view.requestDraw()
        }
    }

    private fun ensureSurfaceSize(session: OverlaySession, atlas: UploadedAtlas) {
        if (
            session.bufferWidth != atlas.manifest.width ||
                session.bufferHeight != atlas.manifest.height
        ) {
            clearFences(session)
            park()
            EGL14.eglDestroySurface(display, session.eglSurface)
            session.eglSurface = EGL14.EGL_NO_SURFACE
            session.texture.setDefaultBufferSize(atlas.manifest.width, atlas.manifest.height)
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
                    actualWidth[0] == atlas.manifest.width &&
                    actualHeight[0] == atlas.manifest.height,
            ) {
                "GPU surface dimensions do not match atlas"
            }
            session.bufferWidth = atlas.manifest.width
            session.bufferHeight = atlas.manifest.height
        }
    }

    private fun eligible(session: OverlaySession, request: OverlayRequest): Boolean =
        foreground &&
            !session.destroyed &&
            session.eglSurface != EGL14.EGL_NO_SURFACE &&
            session.view.matches(request)

    private fun uniforms(
        atlas: UploadedAtlas,
        lower: ActiveScene,
        upper: ActiveScene,
        progress: Float,
        reach: Float,
        productionEmpty: Boolean,
        mirrored: Boolean,
    ): ByteBuffer {
        val manifest = atlas.manifest
        val bytes = directBytes(144)
        fun vector(vararg values: Float) {
            values.forEach { bytes.putFloat(it) }
        }
        vector(
            manifest.width.toFloat(),
            manifest.height.toFloat(),
            lower.descriptors.size.toFloat(),
            if (manifest.glow) 1f else 0f,
        )
        manifest.veil.forEach { bytes.putFloat(it / 255) }
        manifest.tuning.forEach { bytes.putFloat(it) }
        vector(manifest.tuning2[0], manifest.tuning2[1], lower.maxReach, 0f)
        bytes.putInt(manifest.covers?.offset ?: -1)
        bytes.putInt(OverlayPolicy.selectStampLayers(lower.stampLayers, upper.stampLayers, progress))
        repeat(2) { bytes.putInt(0) }
        vector(manifest.width.toFloat(), manifest.height.toFloat(), 0f, 0f)
        vector(progress, OverlayPolicy.REVEAL_BAND, 0f, reach)
        vector(
            upper.descriptors.size.toFloat(),
            upper.maxReach,
            if (productionEmpty) 1f else 0f,
            if (mirrored) 1f else 0f,
        )
        (manifest.covers?.crop ?: intArrayOf(0, 0, 0, 0)).forEach { bytes.putInt(it) }
        bytes.flip()
        return bytes
    }

    private fun encode(
        atlas: UploadedAtlas,
        lower: ActiveScene,
        upper: ActiveScene,
        params: ByteBuffer,
    ) {
        GLES31.glViewport(0, 0, atlas.manifest.width, atlas.manifest.height)
        GLES31.glDisable(GLES31.GL_BLEND)
        GLES31.glDisable(GLES31.GL_DEPTH_TEST)
        GLES31.glDisable(GLES31.GL_DITHER)
        GLES31.glUseProgram(program)
        GLES31.glBindBufferBase(GLES31.GL_SHADER_STORAGE_BUFFER, 0, atlas.pixels)
        GLES31.glBindBufferBase(GLES31.GL_SHADER_STORAGE_BUFFER, 1, lower.buffer)
        GLES31.glBindBufferBase(GLES31.GL_SHADER_STORAGE_BUFFER, 2, upper.buffer)
        GLES31.glBindBufferBase(GLES31.GL_SHADER_STORAGE_BUFFER, 3, atlas.lut)
        GLES31.glBindBuffer(GLES31.GL_UNIFORM_BUFFER, uniformBuffer)
        GLES31.glBufferSubData(GLES31.GL_UNIFORM_BUFFER, 0, 144, params)
        GLES31.glBindBufferBase(GLES31.GL_UNIFORM_BUFFER, 0, uniformBuffer)
        GLES31.glDrawArrays(GLES31.GL_TRIANGLES, 0, 3)
        checked("GPU draw")
    }

    fun draw(session: OverlaySession): Boolean {
        val request = session.request ?: return false
        if (!eligible(session, request)) return false
        try {
            val atlas = session.atlas ?: return false
            val current = session.current ?: return false
            ensureSurfaceSize(session, atlas)
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
                    session.previous != null,
                    session.next != null,
                    controls.reduced,
                )
            val lower = if (selection.lower == -1) session.previous!! else current
            val upper = if (selection.upper == 1) session.next!! else current
            val now = System.nanoTime()
            val reach = session.editStart?.let { OverlayPolicy.reach(now - it) } ?: 1f
            if (!eligible(session, request)) return false
            GLES31.glBindFramebuffer(GLES31.GL_FRAMEBUFFER, 0)
            encode(
                atlas,
                lower,
                upper,
                uniforms(
                    atlas,
                    lower,
                    upper,
                    selection.progress,
                    reach,
                    request.previous != null || request.next != null || request.animateEdits,
                    controls.mirrored,
                ),
            )
            val frame =
                session.ledger.submit(now, request.revision, request.generation) ?: return false
            check(EGLExt.eglPresentationTimeANDROID(display, session.eglSurface, frame.timestamp)) {
                "GPU frame timestamp failed"
            }
            val sync = GLES31.glFenceSync(GLES31.GL_SYNC_GPU_COMMANDS_COMPLETE, 0)
            check(sync != 0L) { "GPU completion fence unavailable" }
            session.fences[frame.timestamp] = sync to now
            check(EGL14.eglSwapBuffers(display, session.eglSurface)) { "GPU swap failed" }
            poll(session, frame.timestamp)
            val running =
                session.editStart?.let { now - it < OverlayPolicy.EDIT_DURATION_NS } == true
            if (!running && session.editStart != null) session.editStart = null
            if (running) session.view.requestAnimationFrame()
            return true
        } catch (failure: Exception) {
            fail(session, failure, request)
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
            GLES31.glDeleteSync(fence.first)
            session.fences.remove(timestamp)
            session.ledger.finish(timestamp)?.let { accept(session, it) }
            requestConsumptionObservation(session)
            session.view.resumeDraw()
        } catch (failure: Exception) {
            fail(session, failure)
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
        }
        // Progress could have changed while both queued frames were in flight.
        session.view.resumeDraw()
    }

    private fun fail(
        session: OverlaySession,
        failure: Exception,
        request: OverlayRequest? = session.request,
    ) {
        session.editPending = false
        session.editStart = null
        session.view.failed(request, failure.message ?: "GPU renderer unavailable")
        // Release rejected/cancelled work instead of pinning a failed layout.
        if (EGL14.eglGetError() == EGL14.EGL_CONTEXT_LOST) resetContext()
        else if (context != EGL14.EGL_NO_CONTEXT) {
            try {
                park()
                clearFences(session)
                releaseScenes(session)
                releaseAtlas(session)
                if (cache?.users == 0) dropCache()
            } catch (_: Exception) {
                // An invalid context can report BAD_CONTEXT rather than LOST.
                // Cleanup failure must still restore PNG, not kill the worker.
                resetContext()
            }
        }
    }

    private fun resetContext() {
        sessions.forEach { session ->
            session.fences.clear()
            session.ledger.clear()
            session.atlas = null
            session.preparedConfig = null
            session.preparedAssetKey = null
            session.current = null
            session.previous = null
            session.next = null
            session.editPending = false
            session.editStart = null
            session.view.failed(session.request, "GPU context lost")
            if (session.eglSurface != EGL14.EGL_NO_SURFACE)
                EGL14.eglDestroySurface(display, session.eglSurface)
            session.eglSurface = EGL14.EGL_NO_SURFACE
        }
        cache = null
        bufferBytes.clear()
        retiredBuffers.clear()
        if (budget.bytes > 0) budget.release(budget.bytes.toInt())
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
    }

    fun compare(app: Context, source: String): Map<String, Any?> {
        check(foreground) { "GPU comparison requires foreground app" }
        initialize()
        val started = System.nanoTime()
        val (atlas, hit) = acquireAtlas(app, source)
        var scene: ActiveScene? = null
        var texture = 0
        var framebuffer = 0
        var comparisonBytes = 0
        try {
            val descriptors = selectHolds(atlas.manifest, JSONObject(source).getString("frames"))
            scene = ActiveScene(descriptors, buffer(encodeHolds(descriptors)))
            val prepareMs = (System.nanoTime() - started) / 1e6
            val width = atlas.manifest.width
            val height = atlas.manifest.height
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
            encode(atlas, scene, scene, uniforms(atlas, scene, scene, 0f, 1f, false, false))
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
                "uploadMs" to if (hit) 0.0 else atlas.uploadMs,
                "atlasBytes" to atlas.bytes,
                "atlasCacheHit" to hit,
                "gpuUri" to png(gpu, "gpu"),
                "referenceUri" to png(reference.data, "reference"),
            )
        } finally {
            GLES31.glBindFramebuffer(GLES31.GL_FRAMEBUFFER, 0)
            releaseScene(scene)
            if (framebuffer != 0) GLES31.glDeleteFramebuffers(1, intArrayOf(framebuffer), 0)
            if (texture != 0) GLES31.glDeleteTextures(1, intArrayOf(texture), 0)
            if (comparisonBytes > 0) {
                GLES31.glFinish()
                budget.release(comparisonBytes)
            }
            atlas.users--
        }
    }

    fun trim() {
        handler.post {
            if (cache?.users == 0 && context != EGL14.EGL_NO_CONTEXT) {
                park()
                dropCache()
            }
        }
    }

    fun background() {
        foreground = false
        handler.post {
            sessions.forEach {
                it.editPending = false
                it.editStart = null
            }
            trim()
        }
    }
}
