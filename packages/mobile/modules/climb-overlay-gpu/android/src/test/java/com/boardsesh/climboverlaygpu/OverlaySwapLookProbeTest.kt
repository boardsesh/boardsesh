package com.boardsesh.climboverlaygpu

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The swap look's probe ([SwapLookProbe], [OverlaySwapLookProgram]): which
 * answers offer the look, what is stored for the next launch, and that a
 * timeout is never stored as a failure.
 */
class OverlaySwapLookProbeTest {
    private class MemoryStore : SwapLookProbeStore {
        var entry: StoredSwapLookProbe? = null
        var saves = 0

        override fun load(): StoredSwapLookProbe? = entry

        override fun save(entry: StoredSwapLookProbe) {
            this.entry = entry
            saves++
        }

        override fun forget() {
            entry = null
        }
    }

    private val key = SwapLookProbe.key("Adreno (TM) 740", "OpenGL ES 3.2 V@0676.42", 412, "look source")

    @Test
    fun theModuleOffersTheLookOnlyWhenTheProgramBuildsNowOrBuiltBefore() {
        fun version(result: SwapLookProbeResult) = OverlaySwapLookProgram.advertised(SwapLookProbeOutcome(result, 5))
        assertEquals(OverlaySwapLook.VERSION, version(SwapLookProbeResult.BUILT))
        assertEquals(OverlaySwapLook.VERSION, version(SwapLookProbeResult.CACHED_BUILT))
        assertEquals("The program does not build here", 0, version(SwapLookProbeResult.FAILED))
        assertEquals("An earlier launch found it does not build here", 0, version(SwapLookProbeResult.CACHED_FAILED))
        assertEquals("The probe was still running", 0, version(SwapLookProbeResult.TIMEOUT))
    }

    @Test
    fun aFreshProbeBuildsAndStoresItsAnswer() {
        val store = MemoryStore()
        assertEquals(SwapLookProbeResult.BUILT to null, SwapLookProbe.resolve(key, store) { null })
        assertEquals(key, store.entry?.key)
        assertTrue(store.entry!!.built)

        val failing = MemoryStore()
        assertEquals(SwapLookProbeResult.FAILED to "compile", SwapLookProbe.resolve(key, failing) { "compile" })
        assertFalse(failing.entry!!.built)
        assertEquals("compile", failing.entry!!.failure)
    }

    @Test
    fun aStoredAnswerForTheSameDriverBuildAndSourceSkipsTheBuild() {
        val store = MemoryStore()
        store.entry = StoredSwapLookProbe(key, true, null)
        assertEquals(SwapLookProbeResult.CACHED_BUILT to null, SwapLookProbe.resolve(key, store) { error("built again") })
        store.entry = StoredSwapLookProbe(key, false, "link")
        assertEquals(SwapLookProbeResult.CACHED_FAILED to "link", SwapLookProbe.resolve(key, store) { error("built again") })
        assertEquals("Nothing new is written", 0, store.saves)
    }

    @Test
    fun aNewDriverAppBuildOrLookSourceProbesAgain() {
        val keys =
            listOf(
                SwapLookProbe.key("Adreno (TM) 740", "OpenGL ES 3.2 V@0700.10", 412, "look source"),
                SwapLookProbe.key("Adreno (TM) 740", "OpenGL ES 3.2 V@0676.42", 413, "look source"),
                SwapLookProbe.key("Adreno (TM) 740", "OpenGL ES 3.2 V@0676.42", 412, "look source, fixed"),
                SwapLookProbe.key("Mali-G715", "OpenGL ES 3.2 V@0676.42", 412, "look source"),
            )
        for (changed in keys) {
            val store = MemoryStore()
            store.entry = StoredSwapLookProbe(key, false, "compile")
            var builds = 0
            assertEquals(SwapLookProbeResult.BUILT to null, SwapLookProbe.resolve(changed, store) { builds++; null })
            assertEquals(1, builds)
            assertEquals("The new answer replaces the old one", changed, store.entry?.key)
        }
    }

    @Test
    fun withoutAKeyNothingIsReadOrStored() {
        val store = MemoryStore()
        store.entry = StoredSwapLookProbe(key, false, "compile")
        assertEquals(SwapLookProbeResult.BUILT to null, SwapLookProbe.resolve(null, store) { null })
        assertEquals(0, store.saves)
        assertEquals(SwapLookProbeResult.FAILED to "link", SwapLookProbe.resolve(key, null) { "link" })
    }

    @Test
    fun aProbeThatFinishesInTimeAnswersWithItsOwnDuration() {
        var nanos = 0L
        val probe = SwapLookProbe(waitMs = 1_000) { nanos }
        nanos = 42_000_000
        probe.finish(SwapLookProbeResult.FAILED, "compile")
        val outcome = probe.await()
        assertEquals(SwapLookProbeResult.FAILED, outcome.result)
        assertEquals(42L, outcome.ms)
        assertEquals(mapOf("result" to "failed", "ms" to 42, "failure" to "compile"), outcome.constant())
        assertEquals(mapOf("result" to "cached-built", "ms" to 3), SwapLookProbeOutcome(SwapLookProbeResult.CACHED_BUILT, 3).constant())
    }

    @Test
    fun aSlowProbeTimesOutForThisProcessAndStoresBuiltForTheNext() {
        val store = MemoryStore()
        val driverCache = CountDownLatch(1)
        val probe = SwapLookProbe(waitMs = 20)
        val worker =
            thread {
                val (result, failure) =
                    SwapLookProbe.resolve(key, store) {
                        driverCache.await(5, TimeUnit.SECONDS)
                        null
                    }
                probe.finish(result, failure)
            }
        val outcome = probe.await()
        assertEquals(SwapLookProbeResult.TIMEOUT, outcome.result)
        assertTrue("ms is how long it had run", outcome.ms >= 20)
        assertEquals(0, OverlaySwapLookProgram.advertised(outcome))
        assertNull("A timeout stores nothing", store.entry)

        driverCache.countDown()
        worker.join(5_000)
        assertTrue("Finished late, it stores what it found", store.entry!!.built)
        assertEquals(
            "The next launch answers from the store, without building",
            SwapLookProbeResult.CACHED_BUILT to null,
            SwapLookProbe.resolve(key, store) { error("built again") },
        )
    }
}
