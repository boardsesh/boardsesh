package com.boardsesh.frostedbokeh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BokehMotionTest {
    private fun blob(x: Float, peak: Float = 1f) = BokehBlob(x, 10f, 20f, peak, 1f, 0f, 0f)

    @Test fun `first climb appears without a glide`() {
        val motion = BokehMotion()
        motion.update("first", listOf(blob(10f)), 0.0, 0.7, false)
        assertEquals(listOf(blob(10f)), motion.blobs(0.0))
        assertFalse(motion.gliding(0.0))
    }

    @Test fun `next climb glides for seven hundred milliseconds with smoothstep`() {
        val motion = BokehMotion()
        motion.update("first", listOf(blob(0f)), 0.0, 0.7, false)
        motion.update("second", listOf(blob(100f)), 1.0, 0.7, false)
        assertEquals(0f, motion.blobs(1.0).single().x, 0.001f)
        assertEquals(15.625f, motion.blobs(1.175).single().x, 0.001f)
        assertEquals(50f, motion.blobs(1.35).single().x, 0.001f)
        assertEquals(100f, motion.blobs(1.7).single().x, 0.001f)
        assertFalse(motion.gliding(1.7))
    }

    @Test fun `interrupted glide starts at current interpolated position`() {
        val motion = BokehMotion()
        motion.update("first", listOf(blob(0f)), 0.0, 0.7, false)
        motion.update("second", listOf(blob(100f)), 1.0, 0.7, false)
        motion.update("third", listOf(blob(200f)), 1.35, 0.7, false)
        assertEquals(50f, motion.blobs(1.35).single().x, 0.001f)
        assertEquals(125f, motion.blobs(1.7).single().x, 0.001f)
    }

    @Test fun `unpaired lights fade in place and empty climb draws no blobs`() {
        val motion = BokehMotion()
        motion.update("empty", emptyList(), 0.0, 0.7, false)
        motion.update("lit", listOf(blob(70f)), 1.0, 0.7, false)
        assertEquals(blob(70f, 0.5f), motion.blobs(1.35).single())
        motion.update("empty-again", emptyList(), 2.0, 0.7, false)
        val fading = motion.blobs(2.35).single()
        assertEquals(70f, fading.x, 0.001f)
        assertEquals(0.5f, fading.peak, 0.001f)
        assertTrue(motion.blobs(2.7).isEmpty())
    }

    @Test fun `reduce motion cancels an active glide immediately`() {
        val motion = BokehMotion()
        motion.update("first", listOf(blob(0f)), 0.0, 0.7, false)
        motion.update("second", listOf(blob(100f)), 1.0, 0.7, false)
        motion.update("second", listOf(blob(100f)), 1.1, 0.7, true)
        assertEquals(100f, motion.blobs(1.1).single().x, 0f)
        assertFalse(motion.gliding(1.1))
    }

    @Test fun `same key updates do not restart the glide and buffers stay bounded`() {
        val motion = BokehMotion()
        motion.update("first", listOf(blob(0f)), 0.0, 0.7, false)
        motion.update("second", List(40) { blob(100f) }, 1.0, 0.7, false)
        motion.update("second", List(40) { blob(100f) }, 1.35, 0.7, false)
        assertEquals(50f, motion.blobs(1.35).first().x, 0.001f)
        assertEquals(30, motion.blobs(1.7).size)
        assertFalse(motion.gliding(1.7))
    }

    @Test fun `frame loop pauses for hidden or reduced motion views`() {
        assertEquals(0, bokehFrameRate(false, false, false, true, true))
        assertEquals(0, bokehFrameRate(true, true, false, true, true))
        assertEquals(0, bokehFrameRate(true, false, false, false, false))
        assertEquals(15, bokehFrameRate(true, false, false, false, true))
        assertEquals(60, bokehFrameRate(true, false, false, true, true))
    }

    @Test fun `battery saver stops breathing but preserves climb transitions`() {
        assertEquals(0, bokehFrameRate(true, false, true, false, true))
        assertEquals(60, bokehFrameRate(true, false, true, true, true))
    }
}
