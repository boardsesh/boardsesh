package com.boardsesh.liveactivity

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The clock behind SessionPresence's `delay`, which the background connect's
 * scan and power-on watchdogs race against their paused JS timer (#7038).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NativeDelayTest {

    @Test
    fun `resolves after the requested time and not before`() = runTest {
        var resolved = false
        launch {
            NativeDelay.await(30_000.0)
            resolved = true
        }

        advanceTimeBy(29_999)
        runCurrent()
        assertFalse(resolved)

        advanceTimeBy(1)
        runCurrent()
        assertTrue(resolved)
    }

    @Test
    fun `resolves at once for zero, negative and NaN delays`() = runTest {
        for (ms in listOf(0.0, -5.0, Double.NaN)) {
            var resolved = false
            launch {
                NativeDelay.await(ms)
                resolved = true
            }
            runCurrent()
            assertTrue("delay($ms) should resolve at once", resolved)
        }
    }

    @Test
    fun `clamps a delay to the five-minute ceiling`() {
        assertEquals(2_500L, NativeDelay.clampDelayMs(2_500.0))
        assertEquals(2_500L, NativeDelay.clampDelayMs(2_500.9))
        assertEquals(NativeDelay.MAX_DELAY_MS, NativeDelay.clampDelayMs(Double.POSITIVE_INFINITY))
        assertEquals(NativeDelay.MAX_DELAY_MS, NativeDelay.clampDelayMs(1e12))
    }
}
