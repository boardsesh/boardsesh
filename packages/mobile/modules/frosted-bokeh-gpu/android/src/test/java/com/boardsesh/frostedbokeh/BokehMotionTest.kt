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

    private fun motion() = BokehMotion().apply {
        width = this@BokehMotionTest.width
        look = playerLook
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
    }

    /** The golden vectors in `@boardsesh/frosted-bokeh`'s `swap.test.ts`: the same numbers. */
    @Test fun `the rules match the golden vectors in swap test ts`() {
        val look = requireNotNull(playerLook)
        val weights = listOf(
            listOf(0.4, 0.5, 0.0, 0.4), listOf(0.7, 0.5, 0.0, 0.7), listOf(0.7, 0.0, 0.0, 1.0),
            listOf(0.7, 1.0, 0.0, 0.4), listOf(0.55, 0.3, 1.0, 0.6184), listOf(0.2, 0.6, 1.0, 0.0512),
            listOf(0.85, 0.9, 0.0, 0.5422), listOf(0.3, 0.9, 0.0, 0.0948),
        )
        for ((weight, key, arriving, expected) in weights) {
            assertEquals(expected.toFloat(), BokehMotion.lit(weight.toFloat(), key.toFloat(), arriving == 1.0, look), 0.0001f)
        }
        val shapes = listOf(
            listOf(0.4, 0.0, 0.0, 0.0, 0.4, 0.79), listOf(0.2, 0.0, 1.0, 0.0, 0.2, 1.0),
            listOf(0.55, 0.0, 1.0, 0.0, 0.55, 1.05), listOf(0.55, 0.0, 1.0, 1.0, 0.55, 1.0),
            listOf(0.7, 0.4, 0.0, 0.0, 0.7, 0.895),
        )
        for (row in shapes) {
            val (glow, reach) = BokehMotion.shaped(row[0].toFloat(), row[1].toFloat(), row[2] == 1.0, row[3] == 1.0, look)
            assertEquals(row[4].toFloat(), glow, 0.0001f)
            assertEquals(row[5].toFloat(), reach, 0.0001f)
        }
        // The release's fill and fade, through the motion: one light at x, a release started at 0.
        val fills = listOf(listOf(1.0, 55.0, 0.5), listOf(0.5, 110.0, 0.5), listOf(0.25, 150.0, 0.66752), listOf(0.8, 40.0, 0.071567))
        for ((across, milliseconds, expected) in fills) {
            val motion = motion()
            motion.show("old", listOf(light(1000f)), -1.0)
            motion.show("new", listOf(light(across.toFloat() * width, red = 0f)), 0.0)
            assertEquals(expected.toFloat(), motion.blobs(milliseconds / 1000).single { it.red == 0f }.peak, 0.0001f)
        }
        for ((milliseconds, expected) in listOf(listOf(75.0, 0.5), listOf(30.0, 0.896), listOf(120.0, 0.104))) {
            val motion = motion()
            motion.show("old", listOf(light(100f)), -1.0)
            motion.show("new", listOf(light(300f, red = 0f)), 0.0)
            assertEquals(expected.toFloat(), motion.blobs(milliseconds / 1000).single { it.red == 1f }.peak, 0.0001f)
        }
    }

    @Test fun `a flick run past the pages the app has sent keeps the frost lit, then releases`() {
        val motion = motion()
        motion.framed()
        motion.drag(0.4, 0.4)
        sequence += 1
        motion.applyFrame(listOf(5.25, 0.6, 0.2, 1.0, sequence, 0.0, 1.0), 0.1)
        // The climb on page 5 (the left climb on page 4 is fading out where it was).
        val shown = motion.blobs(0.1).filter { it.id >= 10 }
        assertEquals(2, shown.size)
        // Page 6 has not come from the app yet: the last frame it could draw stays up.
        sequence += 1
        motion.applyFrame(listOf(6.0, 1.0, 0.0, 1.0, sequence, 0.0, 0.0), 0.15)
        assertEquals(shown, motion.blobs(0.15).filter { it.id >= 10 })
        // The app catches up: the climb on page 6 fills in along the sweep, page 5 fades.
        val third = BokehClimb("third", listOf(light(150f, id = 21)))
        motion.setClimbs(third, mapOf(5 to right, 6 to third), 0.2)
        assertTrue(motion.transitioning(0.2))
        assertTrue(motion.blobs(0.2).none { it.id == 21L })
        assertEquals(1f, motion.blobs(0.5).single().peak, 0.0001f)
    }

    @Test fun `an unknown incoming page cannot fade the held climb to black in either direction`() {
        for (direction in listOf(-1, 1)) {
            val motion = motion()
            val currentPage = if (direction > 0) 5 else 4
            val current = if (direction > 0) right else left
            val incomingPage = currentPage + direction
            motion.setClimbs(current, pages, 0.0)
            motion.applyFrame(listOf(currentPage.toDouble(), 1.0, 0.0, 1.0, 1.0), 0.0)
            val held = motion.blobs(0.0)
            val position = currentPage + direction * 0.25
            val arrivalCode = if (direction > 0) 1.0 else 2.0
            motion.applyFrame(listOf(position, 0.6, 0.2, 1.0, 2.0, 0.0, arrivalCode), 1.0)
            motion.applyFrame(listOf(position, 0.0, 0.9, 1.0, 3.0, 0.0, arrivalCode), 1.16)
            assertEquals(held, motion.blobs(1.17))
            motion.applyFrame(listOf(incomingPage.toDouble(), 1.0, 0.0, 1.0, 4.0), 1.22)
            assertEquals(held, motion.blobs(1.4))
            val incoming = BokehClimb("incoming", listOf(light(150f, id = 21)))
            motion.setClimbs(incoming, mapOf(currentPage to current, incomingPage to incoming), 1.5)
            assertTrue(motion.transitioning(1.5))
            assertEquals(held, motion.blobs(1.5))
            assertEquals(incoming.lights, motion.blobs(1.8))
        }
    }

    @Test fun `a partial page update preserves the held pair until the latest pair is complete`() {
        val motion = motion()
        motion.framed()
        motion.drag(0.4, 0.4)
        val held = motion.blobs(0.0)
        val third = BokehClimb("third", listOf(light(150f, id = 21)))
        val fourth = BokehClimb("fourth", listOf(light(270f, id = 31)))
        motion.applyFrame(listOf(6.25, 0.0, 1.0, 1.0, 3.0, 0.0, 1.0), 1.0)
        // Neither climb in the held frame is still in the app's latest page map.
        motion.setClimbs(third, mapOf(6 to third), 1.1)
        assertEquals(held, motion.blobs(1.4))
        motion.setClimbs(third, mapOf(6 to third, 7 to fourth), 1.5)
        assertTrue(motion.transitioning(1.5))
        assertEquals(held, motion.blobs(1.5))
        assertEquals(fourth.lights, motion.blobs(1.8))
    }

    @Test fun `reversing an unresolved flick resumes the known pair`() {
        val motion = motion()
        motion.setClimbs(right, pages, 0.0)
        motion.applyFrame(listOf(5.0, 1.0, 0.0, 1.0, 1.0), 0.0)
        motion.applyFrame(listOf(5.25, 0.0, 1.0, 1.0, 2.0), 1.0)
        assertEquals(right.lights, motion.blobs(1.2))
        motion.applyFrame(listOf(4.75, 0.6, 0.2, 1.0, 3.0), 1.3)
        assertEquals(0.6f, motion.blobs(1.3).single { it.id == 11L }.peak, 0.0001f)
        assertEquals(0.2f, motion.blobs(1.3).single { it.id == 1L }.peak, 0.0001f)
    }

    @Test fun `a climb arriving after a climb with no lights still runs the release`() {
        val motion = motion()
        val empty = BokehClimb("empty", emptyList())
        motion.setClimbs(empty, mapOf(4 to empty, 5 to right), 0.0)
        motion.applyFrame(listOf(4.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0), 0.0)
        motion.applyFrame(listOf(5.0, 1.0, 0.0, 1.0, 2.0, 0.0, 0.0), 1.0)
        assertTrue(motion.transitioning(1.0))
        assertTrue(motion.blobs(1.0).none { it.x == 60f })
    }

    @Test fun `pages round half up, as JS does, and wild numbers clamp`() {
        assertEquals(5, requireNotNull(BokehSwapFrame.parse(listOf(4.5, 1.0, 0.0, 1.0, 1.0))?.frame).from)
        assertEquals(-3, requireNotNull(BokehSwapFrame.parse(listOf(-3.5, 1.0, 0.0, 1.0, 1.0))?.frame).from)
        val wild = requireNotNull(BokehSwapFrame.parse(listOf(1e300, 1.0, 0.0, 1.0, 1.0, 1e12, -1e12))?.frame)
        assertEquals(1_000_000_000, wild.from)
        assertEquals(7, wild.outgoingCode)
        assertEquals(0, wild.incomingCode)
    }

    @Test fun `frame loop runs for transitions and breathes otherwise`() {
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
