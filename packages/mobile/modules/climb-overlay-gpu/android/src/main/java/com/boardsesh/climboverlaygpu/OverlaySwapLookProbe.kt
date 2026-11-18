package com.boardsesh.climboverlaygpu

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** How the swap look's probe ended, as the module constant `swapLookProbe` names it. */
internal enum class SwapLookProbeResult(val wire: String, val built: Boolean) {
    /** This launch's probe built the look program. */
    BUILT("built", true),
    /** This launch's probe could not build it; [SwapLookProbeOutcome.failure] names the step. */
    FAILED("failed", false),
    /** Still running when the module constant stopped waiting. Never stored: the next launch probes again. */
    TIMEOUT("timeout", false),
    /** An earlier launch built it on this GPU driver, app build and look source; this launch skipped the build. */
    CACHED_BUILT("cached-built", true),
    /** An earlier launch could not build it on this GPU driver, app build and look source; this launch skipped the build. */
    CACHED_FAILED("cached-failed", false),
}

/** The probe's answer: how it ended, milliseconds from the probe's start, and for a failure, which step. */
internal class SwapLookProbeOutcome(val result: SwapLookProbeResult, val ms: Long, val failure: String? = null) {
    /** The module constant `swapLookProbe`: `{ result, ms, failure? }`. */
    fun constant(): Map<String, Any> =
        buildMap {
            put("result", result.wire)
            put("ms", ms.coerceIn(0L, Int.MAX_VALUE.toLong()).toInt())
            failure?.let { put("failure", it) }
        }
}

/** A stored answer: the GPU driver, app build and look source it holds for ([key]), and whether the program built. */
internal class StoredSwapLookProbe(val key: String, val built: Boolean, val failure: String?)

/** Where the probe's answer outlives the process: SharedPreferences on a phone, a field in tests. */
internal interface SwapLookProbeStore {
    fun load(): StoredSwapLookProbe?

    fun save(entry: StoredSwapLookProbe)

    fun forget()
}

/**
 * One process's probe of the swap look's program ([OverlaySwapLookProgram]).
 * Its thread calls [finish] once; the module constant calls [await], which
 * waits at most [waitMs] and answers [SwapLookProbeResult.TIMEOUT] past it.
 * A probe that finishes after that still stores what it found ([resolve]),
 * so the next launch answers from the store at once.
 */
internal class SwapLookProbe(private val waitMs: Long, private val now: () -> Long = System::nanoTime) {
    private val startedAt = now()
    private val finished = CountDownLatch(1)
    @Volatile private var outcome: SwapLookProbeOutcome? = null

    /** Records how the probe ended. Called once, by the probe's thread. */
    fun finish(result: SwapLookProbeResult, failure: String? = null) {
        outcome = SwapLookProbeOutcome(result, elapsedMs(), failure)
        finished.countDown()
    }

    /** The probe's outcome, waiting for it at most [waitMs]; a timeout's `ms` is how long it had run by then. */
    fun await(): SwapLookProbeOutcome {
        try {
            finished.await(waitMs, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        return outcome ?: SwapLookProbeOutcome(SwapLookProbeResult.TIMEOUT, elapsedMs())
    }

    private fun elapsedMs(): Long = (now() - startedAt) / 1_000_000

    companion object {
        /**
         * What a stored answer holds for: this GPU (`GL_RENDERER`), its driver
         * (`GL_VERSION`, which carries the driver build on Adreno and Mali), the
         * app's versionCode, and the look program's source, so a debug build
         * whose versionCode stays put still probes a changed shader.
         */
        fun key(renderer: String, glVersion: String, versionCode: Long, source: String): String =
            listOf(renderer, glVersion, versionCode.toString(), source.hashCode().toString()).joinToString("\n")

        /**
         * The probe's answer once its context is current: [store]'s answer if it
         * holds one for [key]; else [build]'s (null when the program built, else
         * the step that failed), stored for later launches whatever this
         * process's wait has decided. Without a key (no GL strings or
         * versionCode) nothing is read or stored.
         */
        fun resolve(key: String?, store: SwapLookProbeStore?, build: () -> String?): Pair<SwapLookProbeResult, String?> {
            val stored = if (key == null) null else store?.load()?.takeIf { it.key == key }
            if (stored != null) {
                return (if (stored.built) SwapLookProbeResult.CACHED_BUILT else SwapLookProbeResult.CACHED_FAILED) to stored.failure
            }
            val failure = build()
            if (key != null) store?.save(StoredSwapLookProbe(key, failure == null, failure))
            return (if (failure == null) SwapLookProbeResult.BUILT else SwapLookProbeResult.FAILED) to failure
        }
    }
}
