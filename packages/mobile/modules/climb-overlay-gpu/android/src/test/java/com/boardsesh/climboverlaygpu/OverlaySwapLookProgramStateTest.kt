package com.boardsesh.climboverlaygpu

import org.junit.Assert.assertEquals
import org.junit.Test

class OverlaySwapLookProgramStateTest {
    @Test
    fun disabledOrIneligibleViewsNeverInvokeTheCompiler() {
        val state = SwapLookProgramState()
        val compile = { error("An inactive or disabled look reached the driver") }
        assertEquals(0, state.program)
        assertEquals(0, state.resolve(false, true, true, false, compile))
        assertEquals(0, state.resolve(true, false, true, false, compile))
        assertEquals(0, state.resolve(true, true, false, false, compile))
        assertEquals(0, state.resolve(true, true, true, true, compile))
        // None of those requests consumed the context's one attempt.
        assertEquals(17, state.resolve(true, true, true, false) { 17 })
    }

    @Test
    fun anEligibleLookBuildsOnceAndHotTogglesReuseIt() {
        val state = SwapLookProgramState()
        var builds = 0
        val compile = { builds++; 17 }
        assertEquals(17, state.resolve(true, true, true, false, compile))
        assertEquals(17, state.resolve(true, true, true, false, compile))
        assertEquals(0, state.resolve(true, true, false, false, compile))
        assertEquals(0, state.resolve(true, true, true, true, compile))
        assertEquals(0, state.resolve(false, true, true, false, compile))
        assertEquals(17, state.resolve(true, true, true, false, compile))
        assertEquals(1, builds)
    }

    @Test
    fun aRejectedShaderStaysOnTheBaseProgramUntilTheContextChanges() {
        val state = SwapLookProgramState()
        var builds = 0
        val reject = { builds++; 0 }
        repeat(60) {
            assertEquals(0, state.resolve(true, true, true, false, reject))
        }
        // A settings toggle is not a reason to retry a driver rejection.
        state.resolve(true, true, false, false, reject)
        state.resolve(true, true, true, false, reject)
        assertEquals(1, builds)
        state.reset()
        assertEquals(0, state.program)
        assertEquals(0, state.resolve(true, true, false, false, reject))
        assertEquals(19, state.resolve(true, true, true, false) { builds++; 19 })
        assertEquals(2, builds)
    }

    @Test
    fun replacingAContextCannotReuseItsOldProgramHandle() {
        val state = SwapLookProgramState()
        assertEquals(17, state.resolve(true, true, true, false) { 17 })
        state.reset()
        assertEquals(0, state.program)
        assertEquals(23, state.resolve(true, true, true, false) { 23 })
    }
}
