package com.boardsesh.climboverlaygpu

import android.opengl.GLES31
import android.util.Log

/** A linked look program, or 0 and why not. */
internal class LookProgramBuild(val program: Int, val failure: String?)

/**
 * Builds the optional swap look only in an eligible view's render-thread draw.
 * Module constants advertise the protocol, not the outcome of compiling a
 * shader. Importing the module, creating a base context, or disabling the look
 * never calls this compiler. A clean rejection keeps the base program intact.
 */
internal object OverlaySwapLookProgram {
    private const val LOG_TAG = "ClimbOverlayGPU"

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
        // Validation checks current bindings, which may still belong to the base
        // program. A strict driver may reject that state even though the look
        // draws correctly once its buffers are bound. Compile and link decide.
        GLES31.glValidateProgram(program)
        GLES31.glGetProgramiv(program, GLES31.GL_VALIDATE_STATUS, status, 0)
        if (status[0] == 0) Log.w(LOG_TAG, "swap look program did not validate before binding its buffers; using it: ${GLES31.glGetProgramInfoLog(program).trim()}")
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
}
