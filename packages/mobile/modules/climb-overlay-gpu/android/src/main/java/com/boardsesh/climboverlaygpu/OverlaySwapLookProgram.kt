package com.boardsesh.climboverlaygpu

import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.GLES31
import android.util.Log
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/** A linked and validated look program, or 0 and why not. */
internal class LookProgramBuild(val program: Int, val failure: String?)

/**
 * The swap look's GLES program ([OverlayShader.lookFragment]): whether this
 * phone can build it, and building it. It is a second program beside the base
 * one, so a phone that cannot compile, link or validate it keeps drawing every
 * frame with the base program, main's source byte for byte, and loses only the
 * look.
 *
 * - **The module constant.** At module creation [probe] builds the program in a
 *   throwaway 1×1 EGL context on its own thread. `swapLookVersion` ([version])
 *   waits for it, at most [WAIT_MS], and is [OverlaySwapLook.VERSION] only if it
 *   built; otherwise 0, so the app sends no look and no seven-number frames,
 *   exactly what it sent before the look existed. The answer holds for the process.
 * - **The renderer.** It builds its own copy in its context, at initialization
 *   when the module offered the look ([offered]). If that fails there, it draws
 *   every frame with the base program and the view reports the look off
 *   ([OverlaySwapLook.SHADER_UNAVAILABLE]). Neither failure is a GPU failure:
 *   nothing is latched, and a new context tries again.
 *
 * The module constant is process-wide because JS reads it once, at import; a
 * per-view answer would need new JS. The renderer's guard covers the one case
 * the probe cannot: a phone that builds the program in one context and not in
 * another.
 */
internal object OverlaySwapLookProgram {
    /** The longest the module constant waits for the probe: past it, the look is off for this process. */
    const val WAIT_MS = 1_000L
    private const val LOG_TAG = "ClimbOverlayGPU"
    private val started = AtomicBoolean(false)
    private val finished = CountDownLatch(1)
    @Volatile private var built = false
    /** What `swapLookVersion` told the app; -1 until it asked. */
    @Volatile private var advertisedVersion = -1

    /** Starts the probe once, on its own thread. Called at module creation, well before JS reads the constant. */
    fun probe() {
        if (!started.compareAndSet(false, true)) return
        thread(name = "BoardseshSwapLookProbe", isDaemon = true) {
            built =
                try {
                    probeInOwnContext()
                } catch (failure: Throwable) {
                    Log.w(LOG_TAG, "swap look probe failed: $failure")
                    false
                }
            finished.countDown()
        }
    }

    /**
     * The module constant `swapLookVersion`, decided once per process: the
     * look's version if the probe built the program within [WAIT_MS] of the
     * first read, else 0.
     */
    @Synchronized
    fun version(): Int {
        if (advertisedVersion >= 0) return advertisedVersion
        probe()
        val done =
            try {
                finished.await(WAIT_MS, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                false
            }
        val version = advertised(done, built)
        // A probe that finished has logged its own failure.
        if (!done) Log.w(LOG_TAG, "swap look off for this process: its probe was still running after $WAIT_MS ms")
        advertisedVersion = version
        return version
    }

    /** The module told the app it draws the look, so the app may send one: build its program, decode packets for it. */
    val offered: Boolean
        get() = advertisedVersion == OverlaySwapLook.VERSION

    /** The constant for a probe outcome: the look's version only for a probe that finished and built the program. */
    fun advertised(finished: Boolean, built: Boolean): Int = if (finished && built) OverlaySwapLook.VERSION else 0

    /**
     * The program a draw binds: the look's only for a frame with look words
     * ([OverlaySwapLook.frame] > 0) on a renderer whose look program built.
     * Everything else, the `player-swap-look-kill` switch's frames among them
     * (no look prop, so no words), draws with the base program.
     */
    fun programFor(base: Int, look: Int, lookWords: Int): Int = if (lookWords > 0 && look != 0) look else base

    /**
     * Builds the look program in the current GLES 3.1 context: compile, link,
     * find its `Look` block, validate. Never throws for a GL failure and leaves
     * no GL error behind; on failure deletes what it made and returns why.
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
        GLES31.glValidateProgram(program)
        GLES31.glGetProgramiv(program, GLES31.GL_VALIDATE_STATUS, status, 0)
        return if (status[0] != 0) null else "validate: ${GLES31.glGetProgramInfoLog(program).trim()}"
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
     * Builds the program once in a context of its own, with the renderer's
     * config, then tears everything down. Android counts display initializations,
     * so the balanced terminate never ends the renderer's display.
     */
    private fun probeInOwnContext(): Boolean {
        val display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        if (display == EGL14.EGL_NO_DISPLAY) return false
        val versions = IntArray(2)
        if (!EGL14.eglInitialize(display, versions, 0, versions, 1)) return false
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
            if (!EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, count, 0) || count[0] <= 0) return false
            context =
                EGL14.eglCreateContext(
                    display,
                    configs[0],
                    EGL14.EGL_NO_CONTEXT,
                    intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE),
                    0,
                )
            if (context == EGL14.EGL_NO_CONTEXT) return false
            surface = EGL14.eglCreatePbufferSurface(display, configs[0], intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
            if (surface == EGL14.EGL_NO_SURFACE || !EGL14.eglMakeCurrent(display, surface, surface, context)) return false
            val major = IntArray(1)
            val minor = IntArray(1)
            GLES31.glGetIntegerv(GLES31.GL_MAJOR_VERSION, major, 0)
            GLES31.glGetIntegerv(GLES31.GL_MINOR_VERSION, minor, 0)
            if (!(major[0] > 3 || major[0] == 3 && minor[0] >= 1)) return false
            val result = build()
            if (result.failure != null) {
                Log.w(LOG_TAG, "swap look program does not build here, the look stays off: ${result.failure}")
                return false
            }
            GLES31.glDeleteProgram(result.program)
            return true
        } finally {
            EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
            if (surface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, surface)
            if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context)
            EGL14.eglTerminate(display)
            EGL14.eglReleaseThread()
        }
    }
}
