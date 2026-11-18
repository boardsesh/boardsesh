package com.boardsesh.climboverlaygpu

import android.content.Context
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.GLES31
import android.os.Build
import android.util.Log
import kotlin.concurrent.thread

/** A linked look program, or 0 and why not. */
internal class LookProgramBuild(val program: Int, val failure: String?)

/**
 * The swap look's GLES program ([OverlayShader.lookFragment]): whether this
 * phone can build it, and building it. It is a second program beside the base
 * one, so a phone that cannot compile or link it keeps drawing every frame with
 * the base program, main's source byte for byte, and loses only the look.
 *
 * - **The module constant.** At module creation [probe] starts a thread that
 *   opens a throwaway 1×1 EGL context and reads `GL_RENDERER` and `GL_VERSION`.
 *   If an earlier launch stored an answer for that GPU driver, this app
 *   versionCode and this look source, that is the answer and nothing is built;
 *   else it builds the program and stores whether it built ([SwapLookProbe]).
 *   `swapLookVersion` ([version]) waits for the answer, at most [WAIT_MS], and
 *   is [OverlaySwapLook.VERSION] only if it says built; otherwise 0, so the app
 *   sends no look and no seven-number frames, exactly what it sent before the
 *   look existed. The answer holds for the process. A probe still running at
 *   [WAIT_MS] (a cold driver cache on the first launch after an install) leaves
 *   the look off for this process but is not stored as a failure: it stores
 *   what it finds when it finishes, and the next launch uses that or probes
 *   again. `swapLookProbe` ([constant]) says which of these happened, for the
 *   board motion lab's status line and a Sentry breadcrumb.
 * - **The renderer.** It builds its own copy in its context, at initialization
 *   when the module offered the look ([offered]). If that fails there, it draws
 *   every frame with the base program, the view reports the look off
 *   ([OverlaySwapLook.SHADER_UNAVAILABLE]) and the stored answer is dropped
 *   ([rendererBuildFailed]), so the next launch probes again. Neither failure
 *   is a GPU failure: nothing is latched, and a new context tries again.
 *
 * The module constant is process-wide because JS reads it once, at import; a
 * per-view answer would need new JS. The renderer's guard covers the case the
 * probe cannot: a phone that builds the program in one context and not in
 * another, and a stored "built" that no longer holds.
 */
internal object OverlaySwapLookProgram {
    /** The longest the module constant waits for the probe: past it, the look is off for this process. */
    const val WAIT_MS = 1_000L
    private const val LOG_TAG = "ClimbOverlayGPU"
    private const val PREFERENCES = "com.boardsesh.climboverlaygpu.swapLookProbe"
    private var started: SwapLookProbe? = null
    @Volatile private var store: SwapLookProbeStore? = null
    /** What the module constants told the app; null until JS read one. */
    @Volatile private var answer: SwapLookProbeOutcome? = null

    /**
     * Starts the probe once, on its own thread. Called at module creation, well
     * before JS reads the constant; [context] (the application) holds the
     * stored answer, and without it the probe neither reads nor stores one.
     */
    @Synchronized
    fun probe(context: Context?) {
        if (started != null) return
        val run = SwapLookProbe(WAIT_MS)
        started = run
        val application = context?.applicationContext
        thread(name = "BoardseshSwapLookProbe", isDaemon = true) {
            val (result, failure) =
                try {
                    val preferences = application?.let(::PreferencesProbeStore)
                    store = preferences
                    probeInOwnContext(preferences, application?.let(::appVersionCode))
                } catch (error: Throwable) {
                    Log.w(LOG_TAG, "swap look probe failed: $error")
                    SwapLookProbeResult.FAILED to "probe error"
                }
            run.finish(result, failure)
        }
    }

    /** The probe's outcome, decided once per process: what it found within [WAIT_MS] of the first read, else a timeout. */
    @Synchronized
    fun outcome(): SwapLookProbeOutcome {
        answer?.let { return it }
        probe(null)
        val outcome = checkNotNull(started).await()
        if (outcome.result == SwapLookProbeResult.TIMEOUT) {
            Log.w(LOG_TAG, "swap look off for this process: its probe was still running after ${outcome.ms} ms; the next launch probes again")
        }
        answer = outcome
        return outcome
    }

    /** The module constant `swapLookVersion`. */
    fun version(): Int = advertised(outcome())

    /** The module constant `swapLookProbe`: how the probe behind `swapLookVersion` ended. */
    fun constant(): Map<String, Any> = outcome().constant()

    /** The module told the app it draws the look, so the app may send one: build its program, decode packets for it. */
    val offered: Boolean
        get() = answer?.result?.built == true

    /** `swapLookVersion` for a probe outcome: the look's version only when it says the program builds. */
    fun advertised(outcome: SwapLookProbeOutcome): Int = if (outcome.result.built) OverlaySwapLook.VERSION else 0

    /**
     * The renderer could not compile or link the program in its own context:
     * drop the stored answer, so the next launch probes again rather than
     * offering the look from a "built" that no longer holds.
     */
    fun rendererBuildFailed() {
        store?.forget()
    }

    /**
     * The program a draw binds: the look's only for a frame with look words
     * ([OverlaySwapLook.frame] > 0) on a renderer whose look program built.
     * Everything else, the `player-swap-look-kill` switch's frames among them
     * (no look prop, so no words), draws with the base program.
     */
    fun programFor(base: Int, look: Int, lookWords: Int): Int = if (lookWords > 0 && look != 0) look else base

    /**
     * Builds the look program in the current GLES 3.1 context: compile, link,
     * find its `Look` block. Never throws for a GL failure and leaves no GL
     * error behind; on failure deletes what it made and returns why.
     */
    fun build(): LookProgramBuild {
        val vertex = GLES31.glCreateShader(GLES31.GL_VERTEX_SHADER)
        val fragment = GLES31.glCreateShader(GLES31.GL_FRAGMENT_SHADER)
        val program = GLES31.glCreateProgram()
        var failure: String? =
            try {
                if (vertex == 0 || fragment == 0 || program == 0) "no shader or program object"
                else compile(vertex, OverlayShader.vertex) ?: compile(fragment, OverlayShader.lookFragment)
                    ?: link(program, vertex, fragment)
            } catch (error: RuntimeException) {
                error.toString()
            }
        GLES31.glDeleteShader(vertex)
        GLES31.glDeleteShader(fragment)
        val error = drainErrors()
        if (failure == null && error != GLES31.GL_NO_ERROR) failure = "GL error $error"
        if (failure != null && program != 0) {
            GLES31.glDeleteProgram(program)
            drainErrors()
        }
        return LookProgramBuild(if (failure == null) program else 0, failure)
    }

    private fun compile(shader: Int, source: String): String? {
        GLES31.glShaderSource(shader, source)
        GLES31.glCompileShader(shader)
        val status = IntArray(1)
        GLES31.glGetShaderiv(shader, GLES31.GL_COMPILE_STATUS, status, 0)
        return if (status[0] != 0) null else "compile: ${GLES31.glGetShaderInfoLog(shader).trim()}"
    }

    private fun link(program: Int, vertex: Int, fragment: Int): String? {
        GLES31.glAttachShader(program, vertex)
        GLES31.glAttachShader(program, fragment)
        GLES31.glLinkProgram(program)
        val status = IntArray(1)
        GLES31.glGetProgramiv(program, GLES31.GL_LINK_STATUS, status, 0)
        if (status[0] == 0) return "link: ${GLES31.glGetProgramInfoLog(program).trim()}"
        if (GLES31.glGetUniformBlockIndex(program, "Look") == GLES31.GL_INVALID_INDEX) return "link: no Look block"
        // Validation checks the program against the current state, and here no
        // buffer is bound (the probe's context has none at all), so a strict
        // driver may refuse a program that draws fine. Compile and link decide.
        GLES31.glValidateProgram(program)
        GLES31.glGetProgramiv(program, GLES31.GL_VALIDATE_STATUS, status, 0)
        if (status[0] == 0) Log.w(LOG_TAG, "swap look program did not validate with nothing bound; using it: ${GLES31.glGetProgramInfoLog(program).trim()}")
        return null
    }

    /** Clears the GL error flags (a context may hold several) and returns the first. */
    private fun drainErrors(): Int {
        var first = GLES31.GL_NO_ERROR
        repeat(8) {
            val error = GLES31.glGetError()
            if (error == GLES31.GL_NO_ERROR) return first
            if (first == GLES31.GL_NO_ERROR) first = error
        }
        return first
    }

    /**
     * The probe in a context of its own, with the renderer's config, torn down
     * after: the stored answer for this GPU driver, app build and look source
     * if [store] has one, else a build of the program, stored. Android counts
     * display initializations, so the balanced terminate never ends the
     * renderer's display. A context that cannot be made is a failure that is
     * not stored, since there are no GL strings to store it under.
     */
    private fun probeInOwnContext(store: SwapLookProbeStore?, versionCode: Long?): Pair<SwapLookProbeResult, String?> {
        val noContext = SwapLookProbeResult.FAILED to "no GLES 3 context"
        val display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        if (display == EGL14.EGL_NO_DISPLAY) return noContext
        val versions = IntArray(2)
        if (!EGL14.eglInitialize(display, versions, 0, versions, 1)) return noContext
        var context = EGL14.EGL_NO_CONTEXT
        var surface = EGL14.EGL_NO_SURFACE
        try {
            val configs = arrayOfNulls<EGLConfig>(1)
            val count = IntArray(1)
            val attributes =
                intArrayOf(
                    EGL14.EGL_RENDERABLE_TYPE,
                    0x40, // EGL_OPENGL_ES3_BIT_KHR, as the renderer asks
                    EGL14.EGL_SURFACE_TYPE,
                    EGL14.EGL_PBUFFER_BIT,
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
            if (!EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, count, 0) || count[0] <= 0) return noContext
            context =
                EGL14.eglCreateContext(
                    display,
                    configs[0],
                    EGL14.EGL_NO_CONTEXT,
                    intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE),
                    0,
                )
            if (context == EGL14.EGL_NO_CONTEXT) return noContext
            surface = EGL14.eglCreatePbufferSurface(display, configs[0], intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
            if (surface == EGL14.EGL_NO_SURFACE || !EGL14.eglMakeCurrent(display, surface, surface, context)) return noContext
            val renderer = GLES31.glGetString(GLES31.GL_RENDERER)
            val glVersion = GLES31.glGetString(GLES31.GL_VERSION)
            val key =
                if (renderer == null || glVersion == null || versionCode == null) null
                else SwapLookProbe.key(renderer, glVersion, versionCode, OverlayShader.vertex + "\n" + OverlayShader.lookFragment)
            val found =
                SwapLookProbe.resolve(key, store) {
                    val major = IntArray(1)
                    val minor = IntArray(1)
                    GLES31.glGetIntegerv(GLES31.GL_MAJOR_VERSION, major, 0)
                    GLES31.glGetIntegerv(GLES31.GL_MINOR_VERSION, minor, 0)
                    if (!(major[0] > 3 || major[0] == 3 && minor[0] >= 1)) return@resolve "no GLES 3.1"
                    val result = build()
                    if (result.failure == null) {
                        GLES31.glDeleteProgram(result.program)
                        return@resolve null
                    }
                    Log.w(LOG_TAG, "swap look program does not build here, the look stays off: ${result.failure}")
                    // The step only ("compile", "link", "GL error 1282"): the full log stays in logcat.
                    result.failure.substringBefore(':').take(40)
                }
            if (found.first == SwapLookProbeResult.CACHED_FAILED) {
                Log.w(LOG_TAG, "swap look off: an earlier launch could not build its program on this GPU driver and app build (${found.second})")
            }
            return found
        } finally {
            EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
            if (surface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, surface)
            if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context)
            EGL14.eglTerminate(display)
            EGL14.eglReleaseThread()
        }
    }

    /** The app's versionCode, part of the stored answer's key; null if the package manager will not say. */
    @Suppress("DEPRECATION")
    private fun appVersionCode(context: Context): Long? =
        try {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
        } catch (_: Exception) {
            null
        }

    /** The stored answer: one entry in the app's own SharedPreferences, replaced when its key changes. */
    private class PreferencesProbeStore(context: Context) : SwapLookProbeStore {
        private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

        override fun load(): StoredSwapLookProbe? =
            try {
                val key = preferences.getString(KEY, null)
                val built =
                    when (preferences.getString(RESULT, null)) {
                        BUILT -> true
                        FAILED -> false
                        else -> null
                    }
                if (key == null || built == null) null else StoredSwapLookProbe(key, built, preferences.getString(FAILURE, null))
            } catch (_: ClassCastException) {
                null
            }

        override fun save(entry: StoredSwapLookProbe) {
            preferences.edit().putString(KEY, entry.key).putString(RESULT, if (entry.built) BUILT else FAILED).putString(FAILURE, entry.failure).apply()
        }

        override fun forget() {
            preferences.edit().clear().apply()
        }

        private companion object {
            const val KEY = "key"
            const val RESULT = "result"
            const val FAILURE = "failure"
            const val BUILT = "built"
            const val FAILED = "failed"
        }
    }
}
