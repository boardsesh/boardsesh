package com.boardsesh.climboverlaygpu

import org.junit.Assert.*
import org.junit.Test

class OverlaySwapCommandTest {
    private val swapControls = OverlayControls(null, false, false, false, OverlayPolicy.REVEAL_MODE_SWAP)

    /** The view's own parse path: split off the sequence, then read the frame. */
    private fun parse(values: List<Double>?): Pair<OverlayControls, Double?>? {
        val sequenced = OverlaySwapCommand.split(values) ?: return null
        val controls = swapControls.withSwapFrame(sequenced.frame) ?: return null
        return controls to sequenced.sequence
    }

    @Test
    fun aFifthNumberIsTheSequenceAndThreeOrFourNumbersAreAnOlderAppsFrame() {
        val (sequenced, sequence) = parse(listOf(12.25, .4, 0.0, .5, 7.0))!!
        assertEquals(swapControls.copy(position = 12.25, outgoing = .4f, incoming = 0f, shared = .5f), sequenced)
        assertEquals(7.0, sequence)
        val (fourNumbers, noSequence) = parse(listOf(12.25, .4, 0.0, .5))!!
        assertEquals(sequenced, fourNumbers)
        assertNull(noSequence)
        assertNull(parse(listOf(12.25, .4, 0.0))!!.second)
        for (malformed in listOf(
            null,
            listOf(12.25, .4, 0.0, .5, Double.NaN),
            listOf(12.25, .4, 0.0, .5, Double.POSITIVE_INFINITY),
            listOf(Double.NaN, .4, 0.0, .5, 3.0),
            listOf(12.25, .4, 0.0, .5, 3.0, 4.0),
            listOf(12.25, .4),
            emptyList(),
        )) {
            assertNull("Malformed sequenced frames are ignored whole: $malformed", parse(malformed))
        }
    }

    @Test
    fun commandArgumentsMustAllBeNumbers() {
        assertEquals(listOf(12.25, .4, 0.0, 1.0, 3.0), OverlaySwapCommand.values(listOf(12.25, .4, 0.0, 1.0, 3)))
        assertEquals(emptyList<Double>(), OverlaySwapCommand.values(emptyList()))
        assertNull(OverlaySwapCommand.values(listOf(1.0, "2")))
        assertNull(OverlaySwapCommand.values(listOf(1.0, null)))
        assertNull(OverlaySwapCommand.values(listOf(true)))
        assertEquals("swapFrame", OverlaySwapCommand.NAME)
        assertEquals(1, OverlaySwapCommand.API)
    }

    @Test
    fun theGateDropsTheLatePropCopyAndAnyOlderFrame() {
        val gate = SwapFrameSequenceGate()
        assertNull(gate.lastApplied)
        assertTrue("A new view applies its first frame, whatever its sequence", gate.admit(5.0))
        assertFalse("The prop copy of an applied command is dropped", gate.admit(5.0))
        assertFalse("A stale prop never overwrites a newer command", gate.admit(3.0))
        assertTrue(gate.admit(6.0))
        assertEquals(6.0, gate.lastApplied)
        assertTrue("An unsequenced frame (older app) always applies", gate.admit(null))
        assertEquals(6.0, gate.lastApplied)
        assertFalse(gate.admit(6.0))
        assertTrue("A remounted view starts empty, so a restarted counter still applies", SwapFrameSequenceGate().admit(1.0))
    }
}
