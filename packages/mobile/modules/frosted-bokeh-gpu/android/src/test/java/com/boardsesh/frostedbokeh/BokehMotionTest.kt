package com.boardsesh.frostedbokeh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The frost's motion, the board's swap look at pill scale. The same cases run against
 * `BokehMotion.swift` in the iOS harness, and the numbers come from `swap.ts`'s tests.
 */
class BokehMotionTest {
    private val width = 300f

    /** The player's look (`PLAYER_SWAP_LOOK`), encoded as `encodeSwapLook` sends it. */
    private val playerLook = BokehSwapLook.parse(
        listOf(2.0, 0.25, 0.25, 0.4, 0.4, 0.0, 0.0, 0.4, 0.15, 0.05, 0.25, 0.0, 2.0, 0.35, 0.0),
    )

    private fun light(x: Float, id: Long = -1, red: Float = 1f, peak: Float = 1f) =
        BokehBlob(x, 20f, 40f, peak, red, 0f, 0f, id = id, seed = x / 100f)

    private fun motion(reduceMotion: Boolean = false) = BokehMotion().apply {
        width = this@BokehMotionTest.width
        look = playerLook
        this.reduceMotion = reduceMotion
    }

    private fun BokehMotion.show(key: String, lights: List<BokehBlob>, now: Double, pages: Map<Int, BokehClimb> = emptyMap()) =
        setClimbs(BokehClimb(key, lights), pages, now)

    private fun List<BokehBlob>.at(x: Float) = filter { it.x == x }

    // A pair on pages 4 (current, left) and 5 (next).
    private val left = BokehClimb("left", listOf(light(30f, id = 1), light(150f, id = 2), light(270f, id = 3)))
    private val right = BokehClimb("right", listOf(light(60f, id = 11), light(240f, id = 12)))
    private val pages = mapOf(4 to left, 5 to right)

    private fun BokehMotion.framed(now: Double = 0.0) {
        setClimbs(left, pages, now)
        applyFrame(listOf(4.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0), now)
    }

    private var sequence = 1.0
    private fun BokehMotion.drag(outgoing: Double, incoming: Double, now: Double = 0.0, code: Double = 1.0) {
        sequence += 1
        applyFrame(listOf(4.25, outgoing, incoming, 1.0, sequence, 0.0, code), now)
    }

    @Test fun `first climb appears whole without a transition`() {
        val motion = motion()
        motion.show("first", listOf(light(10f)), 0.0)
        assertEquals(listOf(light(10f)), motion.blobs(0.0))
        assertFalse(motion.transitioning(0.0))
    }

    @Test fun `next without frames fades the old lights in place by 150 ms`() {
        val motion = motion()
        motion.show("old", listOf(light(100f)), 0.0)
        motion.show("new", listOf(light(200f, red = 0f)), 1.0)
        val halfway = motion.blobs(1.075).at(100f).single()
        assertEquals(100f, halfway.x, 0f)
        assertEquals(0.5f, halfway.peak, 0.001f)
        assertTrue(motion.blobs(1.15).at(100f).isEmpty())
    }

    @Test fun `next without frames fills the new lights along the sweep from the right edge`() {
        val motion = motion()
        motion.show("old", listOf(light(100f)), 0.0)
        motion.show("new", listOf(light(0f, red = 0f), light(300f, red = 0f)), 1.0)
        // The right-most light fills over the first 110 ms, the left-most over the last.
        assertEquals(0.5f, motion.blobs(1.055).at(300f).single().peak, 0.001f)
        assertTrue(motion.blobs(1.055).at(0f).isEmpty())
        assertEquals(1f, motion.blobs(1.11).at(300f).single().peak, 0.001f)
        assertEquals(0.5f, motion.blobs(1.165).at(0f).single().peak, 0.001f)
        assertEquals(1f, motion.blobs(1.219).at(0f).single().peak, 0.001f)
        assertFalse(motion.transitioning(1.23))
        // Nothing moved: every light is where its hold is.
        assertEquals(listOf(0f, 300f), motion.blobs(1.23).map { it.x })
    }

    @Test fun `a hold lit in both climbs stays whole and never moves`() {
        val motion = motion()
        motion.show("old", listOf(light(100f, id = 7), light(200f, id = 8)), 0.0)
        motion.show("new", listOf(light(100f, id = 7), light(50f, id = 9)), 1.0)
        for (time in listOf(1.0, 1.05, 1.1, 1.2, 1.3)) {
            val shared = motion.blobs(time).filter { it.id == 7L }
            assertEquals(1, shared.size)
            assertEquals(1f, shared.single().peak, 0f)
            assertEquals(100f, shared.single().x, 0f)
        }
    }

    @Test fun `without ids a light within six points in the same colour is the same hold`() {
        val motion = motion()
        motion.show("old", listOf(light(100f)), 0.0)
        motion.show("new", listOf(light(104f), light(104f, red = 0.5f)), 1.0)
        val drawn = motion.blobs(1.0)
        assertEquals(1f, drawn.single { it.red == 1f }.peak, 0f)
        assertTrue(drawn.none { it.x == 100f })
    }

    @Test fun `breathing seeds follow the hold when its slot changes`() {
        val motion = motion()
        motion.show("old", listOf(light(100f, id = 7), light(200f, id = 8)), 0.0)
        motion.show("new", listOf(light(200f, id = 8)), 1.0)
        assertEquals(2f, motion.blobs(1.5).single().seed, 0f)
    }

    @Test fun `dragging dims the current climb from the edge the next comes in from`() {
        val motion = motion()
        motion.framed()
        // Halfway to the commit distance (outgoing 0.7): the right edge is down at the floor,
        // the left edge still whole, and the middle on its way.
        motion.drag(0.7, 0.2)
        val drawn = motion.blobs(0.0)
        val rightEdge = drawn.at(270f).single()
        assertEquals(0.4f, rightEdge.peak, 0.001f)
        assertEquals(40f * 0.79f, rightEdge.radius, 0.01f)
        assertEquals(1f, drawn.at(30f).single().peak, 0.001f)
        assertEquals(40f, drawn.at(30f).single().radius, 0f)
        val middle = drawn.at(150f).single().peak
        assertTrue(middle > 0.4f && middle < 1f)
    }

    @Test fun `the next climb shows as ghosts up to forty percent behind the front`() {
        val motion = motion()
        motion.framed()
        motion.drag(0.4, 0.4)
        val drawn = motion.blobs(0.0)
        for (x in listOf(30f, 150f, 270f)) assertEquals(0.4f, drawn.at(x).single().peak, 0.001f)
        for (x in listOf(60f, 240f)) assertEquals(0.4f, drawn.at(x).single().peak, 0.001f)
        // Partway, the ghost on the right (where the next climb comes in) leads.
        motion.drag(0.7, 0.25)
        val partway = motion.blobs(0.0)
        assertEquals(0.4f, partway.at(240f).single().peak, 0.001f)
        assertTrue((partway.at(60f).singleOrNull()?.peak ?: 0f) < 0.1f)
    }

    @Test fun `a commit follows the board's weights and leaves nothing behind`() {
        val motion = motion()
        motion.framed()
        motion.drag(0.4, 0.4)
        motion.drag(0.1, 0.8, 0.1)
        assertFalse(motion.transitioning(0.1))
        motion.drag(0.0, 1.0, 0.2, code = 0.0)
        val drawn = motion.blobs(0.2)
        assertEquals(listOf(60f, 240f), drawn.map { it.x })
        for (blob in drawn) {
            assertEquals(1f, blob.peak, 0.0001f)
            assertEquals(40f, blob.radius, 0.0001f)
        }
    }

    @Test fun `a cancel brings the weights back`() {
        val motion = motion()
        motion.framed()
        motion.drag(0.4, 0.4)
        // The pager's spring back, a frame at a time.
        motion.drag(0.7, 0.2)
        motion.drag(1.0, 0.0)
        assertFalse(motion.transitioning(0.0))
        val drawn = motion.blobs(0.0)
        assertEquals(listOf(30f, 150f, 270f), drawn.map { it.x })
        for (blob in drawn) assertEquals(1f, blob.peak, 0.0001f)
    }

    @Test fun `a shared hold stays whole through the drag`() {
        val shared = light(150f, id = 2)
        val motion = motion()
        motion.setClimbs(left, mapOf(4 to left, 5 to BokehClimb("right", listOf(shared, light(240f, id = 12)))), 0.0)
        motion.applyFrame(listOf(4.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0), 0.0)
        motion.drag(0.4, 0.4)
        val drawn = motion.blobs(0.0).filter { it.id == 2L }
        assertEquals(1, drawn.size)
        assertEquals(1f, drawn.single().peak, 0f)
    }

    @Test fun `next with frames runs the release when the reset frame lands`() {
        val motion = motion()
        motion.framed()
        sequence += 1
        motion.applyFrame(listOf(5.0, 1.0, 0.0, 1.0, sequence, 0.0, 0.0), 1.0)
        assertTrue(motion.transitioning(1.0))
        assertEquals(1f, motion.blobs(1.0).at(30f).single().peak, 0.001f)
        // x 240 is a fifth in from the right edge: it starts 22 ms in and is at smoothstep(0.3).
        assertEquals(0.216f, motion.blobs(1.055).at(240f).single().peak, 0.001f)
        // The app's commit after it changes nothing on screen.
        motion.setClimbs(right, mapOf(4 to left, 5 to right), 1.1)
        val settled = motion.blobs(1.3)
        assertEquals(listOf(60f, 240f), settled.map { it.x })
        for (blob in settled) assertEquals(1f, blob.peak, 0.0001f)
        assertFalse(motion.transitioning(1.3))
    }

    @Test fun `older frames are dropped and an empty frame stops the frames`() {
        val motion = motion()
        motion.framed()
        motion.drag(0.4, 0.4)
        assertFalse(motion.applyFrame(listOf(4.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0), 0.0))
        assertEquals(0.4f, motion.blobs(0.0).at(30f).single().peak, 0.001f)
        sequence += 1
        assertTrue(motion.applyFrame(listOf(sequence), 0.0))
        // Back to the climb on show, filling in again; the ghosts fade where they were.
        val settled = motion.blobs(0.3)
        assertEquals(listOf(30f, 150f, 270f), settled.map { it.x })
        for (blob in settled) assertEquals(1f, blob.peak, 0.0001f)
    }

    @Test fun `four-number frames dim every light together`() {
        val motion = motion()
        motion.framed()
        motion.applyFrame(listOf(4.25, 0.7, 0.0, 0.7, 10.0), 0.0)
        val drawn = motion.blobs(0.0)
        assertEquals(listOf(30f, 150f, 270f), drawn.map { it.x })
        for (blob in drawn) {
            assertEquals(0.7f, blob.peak, 0.0001f)
            assertEquals(40f, blob.radius, 0f)
        }
    }

    @Test fun `reduce motion dissolves linearly over 240 ms with no stagger`() {
        val motion = motion(reduceMotion = true)
        motion.show("old", listOf(light(100f, id = 1), light(200f, id = 2)), 0.0)
        motion.show("new", listOf(light(0f, id = 3), light(300f, id = 4), light(200f, id = 2)), 1.0)
        val halfway = motion.blobs(1.12)
        assertEquals(0.5f, halfway.single { it.id == 1L }.peak, 0.001f)
        assertEquals(0.5f, halfway.single { it.id == 3L }.peak, 0.001f)
        assertEquals(0.5f, halfway.single { it.id == 4L }.peak, 0.001f)
        assertEquals(1f, halfway.single { it.id == 2L }.peak, 0f)
        assertTrue(motion.transitioning(1.2))
        assertFalse(motion.transitioning(1.24))
    }

    @Test fun `reduce motion follows the frames without a front`() {
        val motion = motion(reduceMotion = true)
        motion.framed()
        motion.drag(0.7, 0.3)
        val drawn = motion.blobs(0.0)
        for (blob in drawn.filter { it.id < 10 }) assertEquals(0.7f, blob.peak, 0.0001f)
        for (blob in drawn.filter { it.id >= 10 }) assertEquals(0.3f, blob.peak, 0.0001f)
    }

    @Test fun `interrupted releases never draw more than thirty lights and keep the strongest`() {
        val motion = motion()
        val climbs = (0 until 4).map { climb ->
            BokehClimb("climb-$climb", List(40) { index -> light(index * 7f + climb, id = climb * 100L + index, peak = 0.5f + index / 100f) })
        }
        climbs.forEachIndexed { index, climb -> motion.setClimbs(climb, emptyMap(), index * 0.03) }
        for (time in listOf(0.09, 0.1, 0.15, 0.2, 0.3)) {
            val drawn = motion.blobs(time)
            assertTrue(drawn.size <= MAX_BLOBS)
        }
        val capped = BokehMotion.cap(List(40) { index -> light(index.toFloat(), peak = index / 40f) })
        assertEquals(MAX_BLOBS, capped.size)
        assertEquals(10f, capped.first().x, 0f)
        assertEquals((10 until 40).map { it.toFloat() }, capped.map { it.x })
    }

    @Test fun `the look parses as the board parses it`() {
        val look = requireNotNull(playerLook)
        assertEquals(0.25f, look.holdWindow, 0f)
        assertEquals(0.35f, look.tighten, 0f)
        assertEquals(0.4f, look.ghost, 0f)
        assertNull(BokehSwapLook.parse(listOf(1.0, 0.25)))
        // The same numbers `swap.ts`'s tests pin.
        assertEquals(0.4f, BokehMotion.lit(0.4f, 0.5f, false, look), 0.0001f)
        assertEquals(0.7f, BokehMotion.lit(0.7f, 0.5f, false, look), 0.0001f)
        assertEquals(1f, BokehMotion.lit(0.7f, 0f, false, look), 0.0001f)
        assertEquals(0.4f, BokehMotion.lit(0.7f, 1f, false, look), 0.0001f)
        assertEquals(0.79f, BokehMotion.shaped(0.4f, 0f, false, false, look).second, 0.0001f)
    }

    @Test fun `frame loop runs for transitions, Reduce Motion included, and breathes otherwise`() {
        assertEquals(0, bokehFrameRate(false, false, false, true, true))
        assertEquals(60, bokehFrameRate(true, true, false, true, true))
        assertEquals(0, bokehFrameRate(true, true, false, false, true))
        assertEquals(0, bokehFrameRate(true, false, false, false, false))
        assertEquals(15, bokehFrameRate(true, false, false, false, true))
        assertEquals(60, bokehFrameRate(true, false, false, true, true))
    }

    @Test fun `battery saver stops breathing but keeps climb transitions`() {
        assertEquals(0, bokehFrameRate(true, false, true, false, true))
        assertEquals(60, bokehFrameRate(true, false, true, true, true))
    }
}
