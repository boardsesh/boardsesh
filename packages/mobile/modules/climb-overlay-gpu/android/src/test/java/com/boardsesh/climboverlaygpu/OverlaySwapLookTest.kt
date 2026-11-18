package com.boardsesh.climboverlaygpu

import com.boardsesh.climboverlaygpu.OverlaySwapLook.Look
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/**
 * iOS's `ClimbOverlaySwapLookTests.swift`, case for case and number for number,
 * plus the Android-only parts: the uniform block's packing, the frame gate, the
 * reused frame, the two programs and the state event.
 * `scripts/board-motion-preview` renders the look on GLES.
 */
class OverlaySwapLookTest {
    private fun near(first: Float, second: Float, tolerance: Float = 1e-5f) = abs(first - second) <= tolerance

    /** iOS's `Hold`: what the look reads of one hold descriptor. */
    private data class Hold(val centerX: Float, val centerY: Float, val membership: Int, val entropy: Float, val annotation: Boolean)

    private fun scene(holds: List<Hold>) =
        OverlaySwapLook.Scene(
            FloatArray(holds.size) { holds[it].centerX },
            FloatArray(holds.size) { holds[it].centerY },
            IntArray(holds.size) { holds[it].membership },
            FloatArray(holds.size) { holds[it].entropy },
            BooleanArray(holds.size) { holds[it].annotation },
        )

    /** iOS's `Shape`: one hold's mark, glow and reach at a per-hold weight. */
    private data class Shape(val mark: Float, val glow: Float, val reach: Float)

    private val hidden = Shape(0f, 0f, 1f)

    /** iOS's `shaped`, from the three numbers Android writes straight into the frame's words. */
    private fun shaped(weight: Float, key: Float, arriving: Boolean, look: Look, allowReach: Boolean, calm: Boolean = false) =
        Shape(
            OverlaySwapLook.mark(weight, arriving, look),
            OverlaySwapLook.glow(weight, arriving, look),
            if (allowReach) OverlaySwapLook.reach(weight, key, arriving, calm, look) else 1f,
        )

    /** Numeric equality, as Swift's `==` on its Float fields (a data class compares bits). */
    private fun same(first: Shape, second: Shape) =
        first.mark == second.mark && first.glow == second.glow && first.reach == second.reach

    /** iOS's `Side(weight, arriving)` with no entry edge: an arriving climb enters from its own slot's edge. */
    private fun code(arriving: Boolean, upper: Boolean) = if (!arriving) 0 else if (upper) 1 else 2

    /** A fresh frame's words for one pair. */
    private fun encode(
        lower: OverlaySwapLook.Scene,
        upper: OverlaySwapLook.Scene,
        lowerWeight: Float,
        lowerCode: Int,
        upperWeight: Float,
        upperCode: Int,
        sharedFloor: Float,
        look: Look,
        mirrored: Boolean,
        allowReach: Boolean,
    ): IntArray {
        val frame = OverlaySwapLook.Frame()
        val count = frame.encode(lower, upper, lowerWeight, lowerCode, upperWeight, upperCode, sharedFloor, look, mirrored, allowReach)
        return frame.words.copyOf(count)
    }

    private fun values(look: Look): List<Double> =
        listOf(
            2.0, look.holdWindow.toDouble(), look.lowWindow.toDouble(), look.floor.toDouble(), look.arrivalFloor.toDouble(),
            if (look.climbUp) 1.0 else 0.0, look.jitter.toDouble(), look.ghost.toDouble(), look.markLag.toDouble(),
            look.swell.toDouble(), look.swellTail.toDouble(), look.focus.toDouble(), look.focusShape.toDouble(),
            look.tighten.toDouble(), look.topBoost.toDouble(),
        )

    /** Looks across every slider's extremes and the variants' defaults. */
    private fun looks(): List<Look> {
        val looks = ArrayList<Look>()
        for (window in listOf(0.05f, 0.12f, 0.4f, 1f)) {
            for (floor in listOf(0f, 0.4f, 0.9f)) {
                for (rules in 0 until 4) {
                    val swell = listOf(0f, 0.08f, 0.35f, 0.2f)[rules]
                    val swellTail = maxOf(listOf(0f, 0.25f, 0.6f, 0f)[rules], if (swell > 0) 0.05f else 0f)
                    val look =
                        Look(
                            holdWindow = if (swell > 0) minOf(window, 1 - swellTail) else window,
                            lowWindow = if (rules % 2 == 0) 1f else window,
                            floor = floor,
                            arrivalFloor = listOf(floor, 0f, 0.4f, 0.25f)[rules],
                            focusShape = listOf(2f, 0.5f, 0.25f, 3f)[rules],
                            climbUp = rules >= 2,
                            jitter = if (rules == 3) 0.5f else if (rules == 1) 0.25f else 0f,
                            ghost = if (rules == 1) 0.3f else if (rules == 3) 1f else 0f,
                            markLag = if (rules == 2) 1f else 0.6f * (rules % 2).toFloat(),
                            swell = swell,
                            swellTail = swellTail,
                            focus = listOf(0f, 0.3f, 0.35f, 0f)[rules],
                            tighten = listOf(0f, 0.15f, 0.6f, 0.5f)[rules],
                            topBoost = listOf(0f, 1f, 0.6f, 0f)[rules],
                        )
                    assertEquals("Every test look round-trips through the prop", look, Look.parse(values(look)))
                    looks.add(look)
                }
            }
        }
        return looks
    }

    /** Seeded holds spread over the board, a few of each membership (the iOS test's generator). */
    private fun holds(count: Int, seed: Int): List<Hold> =
        (0 until count).map { index ->
            val id = seed + index * 7919
            Hold(
                centerX = OverlaySwapLook.entropy(id),
                centerY = OverlaySwapLook.entropy(id + 1),
                membership = if (index % 5 == 3) 1 else if (index % 7 == 4) 2 else 0,
                entropy = OverlaySwapLook.entropy(id + 2),
                annotation = false,
            )
        }

    private val lower = holds(24, 11)
    private val upper = holds(24, 97)
    private val lowerScene = scene(lower)
    private val upperScene = scene(upper)

    @Test
    fun thePropIsFifteenFiniteNumbersInFormatTwoEachClamped() {
        assertNull(Look.parse(emptyList()))
        assertNull(Look.parse(null))
        assertNull("Format 1 is gone", Look.parse(listOf(1.0, 1.0, 1.0, .4, .4, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0)))
        assertNull(Look.parse(listOf(2.0, 1.0, 1.0, .4, .4, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 2.0, 0.0, Double.NaN)))
        assertNull(Look.parse(listOf(2.0, 1.0, 1.0, .4, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)))
        val wild = Look.parse(listOf(2.0, 0.0, 9.0, -1.0, 3.0, .7, 5.0, -2.0, 3.0, 1.0, 0.0, 2.0, 9.0, -1.0, 4.0))!!
        assertEquals(.05f, wild.holdWindow)
        assertEquals(1f, wild.lowWindow)
        assertEquals(0f, wild.floor)
        assertEquals(.95f, wild.arrivalFloor)
        assertTrue(wild.climbUp)
        assertEquals(.5f, wild.jitter)
        assertEquals(0f, wild.ghost)
        assertEquals(1f, wild.markLag)
        assertEquals(.35f, wild.swell)
        assertEquals("A swell always gets a tail, so it ends at reach 1 before its hold is whole", .05f, wild.swellTail)
        assertEquals(.35f, wild.focus)
        assertEquals(3f, wild.focusShape)
        assertEquals(0f, wild.tighten)
        assertEquals(1f, wild.topBoost)
        val wide = Look.parse(listOf(2.0, 1.0, 1.0, .4, 0.0, 0.0, 0.0, 0.0, 0.0, .3, .25, 0.0, 2.0, 0.0, 0.0))!!
        assertEquals("A swell's hold window leaves room for its tail", .75f, wide.holdWindow)
    }

    @Test
    fun everyLookIsUniformAtWholeFloorAndDarkAndMonotoneInBetween() {
        val whole = Shape(1f, 1f, 1f)
        for (look in looks()) for (mirrored in listOf(false, true)) for (arriving in listOf(false, true)) {
            for (upperSide in listOf(false, true)) {
                val scene = if (upperSide) upperScene else lowerScene
                val code = code(arriving, upperSide)
                fun shapes(weight: Float) =
                    (0 until scene.size).map { index ->
                        val key = OverlaySwapLook.key(scene, index, upperSide, code, look, mirrored)
                        shaped(OverlaySwapLook.lit(weight, key, arriving, look), key, arriving, look, true)
                    }
                // The invariant the app's relabels and re-flicks rely on: whole, at the floor and dark,
                // every hold of a side looks the same whatever its key.
                assertTrue("W = 1 is the still image: every hold whole at reach 1", shapes(1f).all { same(it, whole) })
                assertTrue("W = 0 hides every hold", shapes(0f).all { same(it, hidden) })
                val atFloor = shapes(OverlaySwapLook.stageFloor(arriving, look))
                assertTrue("W = this side's floor is uniform for every key", atFloor.all { same(it, atFloor[0]) })
                for (index in 0 until scene.size) {
                    val key = OverlaySwapLook.key(scene, index, upperSide, code, look, mirrored)
                    // The last frame before whole: a swell has settled, so nothing snaps back at W = 1.
                    assertTrue("The swell is gone just before its side is whole", OverlaySwapLook.swell(1 - 1e-3f, key, look) < 1e-3f)
                    var previous = 0f
                    for (step in 0..200) {
                        val weight = step.toFloat() / 200
                        val lit = OverlaySwapLook.lit(weight, key, arriving, look)
                        assertTrue("A hold never dims as its side brightens", lit >= previous - 1e-6f && lit >= 0 && lit <= 1)
                        previous = lit
                        val shape = shaped(lit, key, arriving, look, true)
                        assertTrue("A mark never outshines its glow", shape.mark <= shape.glow + 1e-6f)
                        assertTrue(
                            "Reach stays inside the atlas padding",
                            shape.reach >= OverlaySwapLook.MIN_REACH && shape.reach <= OverlaySwapLook.MAX_REACH,
                        )
                        if (!arriving) assertTrue("Only an arriving hold grows its halo", shape.reach <= 1)
                        val lowPower = shaped(lit, key, arriving, look, false)
                        assertTrue(lowPower.reach == 1f && lowPower.mark == shape.mark && lowPower.glow == shape.glow)
                    }
                }
            }
        }
    }

    @Test
    fun floorsWindowsAndAPlainLookMatchAPI7() {
        // An arrival floor of 0 lights an arriving climb in one front, from dark to whole.
        val single = Look(holdWindow = .2f, arrivalFloor = 0f)
        assertEquals("One front, no stop at the floor", 1f, OverlaySwapLook.lit(.3f, 0f, true, single))
        assertEquals(0f, OverlaySwapLook.lit(.3f, 1f, true, single))
        // A focus shape under 2 keeps the halo wide for longer.
        val focus = Look(focus = .35f, focusShape = .5f)
        assertTrue(near(OverlaySwapLook.reach(.75f, 0f, true, false, focus), 1.175f))

        // Window 1 and no reach terms is API 7's swap: one weight per side.
        val plain = Look(floor = .4f)
        for (step in 0..20) {
            val weight = step * .05f
            for (index in lower.indices) {
                val key = OverlaySwapLook.key(lowerScene, index, false, 0, plain, false)
                assertTrue(near(OverlaySwapLook.lit(weight, key, true, plain), weight))
            }
        }
        for (membership in 0..2) for (upperSide in listOf(false, true)) {
            val hold = scene(listOf(lower[0].copy(membership = membership)))
            // Lower at .25 leaving, upper at .3 arriving: the hold's slot is 1 on the lower side, 2 on the upper.
            val words = encode(hold, hold, .25f, 0, .3f, 1, .4f, plain, false, true)
            val slot = if (upperSide) 2 else 1
            val expected =
                when (membership) {
                    1 -> if (upperSide) 0f else .4f
                    2 -> if (upperSide) .3f else 0f
                    else -> if (upperSide) .3f else .25f
                }
            assertTrue(
                "Plain look matches reveal_weight: shared at the floor once, a changed hold's stronger role only",
                abs(words[4 * slot] - OverlaySwapLook.unorm16(expected)) <= 1 &&
                    abs(words[4 * slot + 1] - OverlaySwapLook.unorm16(expected)) <= 1 &&
                    words[4 * slot + 2] == 32768,
            )
        }
    }

    private val front = Look(holdWindow = .2f, floor = 0f, arrivalFloor = 0f)
    private val left = Hold(.1f, .5f, 0, .5f, false)
    private val right = Hold(.9f, .5f, 0, .5f, false)

    private fun litAt(hold: Hold, upper: Boolean, weight: Float, mirrored: Boolean = false): Float {
        val key = OverlaySwapLook.key(scene(listOf(hold)), 0, upper, code(upper, upper), front, mirrored)
        return OverlaySwapLook.lit(weight, key, upper, front)
    }

    @Test
    fun frontsRunFromTheSwipeEdgeAndAMirrorSwapsIt() {
        // The next climb (upper) enters from the right: its right-hand holds light first,
        // and the climb being left (lower) dims from the right too. A display mirror swaps the edge.
        assertTrue(litAt(right, true, .3f) > litAt(left, true, .3f))
        assertTrue(litAt(right, false, .7f) < litAt(left, false, .7f))
        assertTrue(litAt(right, true, .3f, mirrored = true) < litAt(left, true, .3f, mirrored = true))
        // Previous: the lower page arrives from the left.
        assertTrue(litAt(left, false, .3f) > litAt(right, false, .3f))

        // Climb-up: an arriving climb lights from its lowest hold, a leaving one keeps the sideways front.
        val climb = front.copy(climbUp = true)
        val climbScene = scene(listOf(Hold(.1f, .8f, 0, .5f, false), Hold(.9f, .2f, 0, .5f, false)))
        val lowKey = OverlaySwapLook.key(climbScene, 0, true, 1, climb, false)
        val highKey = OverlaySwapLook.key(climbScene, 1, true, 1, climb, false)
        assertTrue("Keys span the climb's own lit holds, bottom to top", lowKey == 0f && highKey == 1f)
        assertTrue(OverlaySwapLook.lit(.3f, lowKey, true, climb) > OverlaySwapLook.lit(.3f, highKey, true, climb))
        assertTrue(near(OverlaySwapLook.key(climbScene, 1, true, 0, climb, false), .1f))
        // A shared hold's other side keys against the other climb's extent.
        val tall = scene(listOf(Hold(.5f, 0f, 0, .5f, false), Hold(.5f, 1f, 0, .5f, false)))
        assertTrue(near(OverlaySwapLook.key(climbScene, 0, true, 1, climb, false, extent = tall), .2f))
    }

    @Test
    fun ghostsSwellsAndCalmArrivals() {
        // A ghost: glow only up to the floor, then the mark fills in as the glow finishes.
        val ghost = Look(floor = .4f, ghost = .3f)
        val faint = shaped(.4f, 0f, true, ghost, true)
        assertTrue(faint.mark == 0f && near(faint.glow, .3f))
        val half = shaped(.7f, 0f, true, ghost, true)
        assertTrue(near(half.mark, .5f) && near(half.glow, .65f))
        assertEquals("Only an arriving climb is a ghost", .4f, OverlaySwapLook.mark(.4f, false, ghost))

        // A swell peaks as its hold becomes whole and is gone before the side is.
        val swell = Look(floor = .4f, holdWindow = .4f, swell = .08f, swellTail = .25f)
        var peak = 0f
        for (step in 0..400) peak = maxOf(peak, OverlaySwapLook.swell(.4f + .6f * step.toFloat() / 400, 1f, swell))
        assertTrue(near(peak, .08f, 1e-3f) && OverlaySwapLook.swell(1f, 1f, swell) == 0f)

        // A flick run's arrival has no swell.
        val calmSwell = Look(arrivalFloor = 0f, holdWindow = .3f, swell = .3f, swellTail = .3f)
        val swollen = shaped(.5f, .2f, true, calmSwell, true)
        val calm = shaped(.5f, .2f, true, calmSwell, true, calm = true)
        assertTrue(swollen.reach > 1.05f && calm.reach == 1f && calm.glow == swollen.glow)
    }

    @Test
    fun theBufferIsTheHeaderThenLowerThenUpperHolds() {
        val words = encode(lowerScene, upperScene, 1f, 0, 0f, 1, 1f, Look(), false, true)
        assertTrue(words.size == 4 * (1 + lower.size + upper.size) && words[0] == 1)
        lower.forEachIndexed { index, hold ->
            assertTrue("Lower whole", words[4 * (1 + index)] == 65535 && words[4 * (1 + index) + 1] == 65535)
            assertTrue("Reach 1 is 32768", words[4 * (1 + index) + 2] == 32768 || hold.membership == 2)
        }
        for (index in upper.indices) assertEquals("Upper dark", 0, words[4 * (1 + lower.size + index) + 1])
        val wild = Look.parse(listOf(2.0, 0.0, 9.0, -1.0, 3.0, .7, 5.0, -2.0, 3.0, 1.0, 0.0, 2.0, 9.0, -1.0, 4.0))!!
        val full = scene(holds(OverlayPacketLayout.MAX_ACTIVE_PER_SOURCE, 5))
        val pair = encode(full, full, .5f, 0, .5f, 1, .4f, wild, false, true)
        assertEquals("Two full climbs are the frame's 1,028 words", OverlaySwapLook.MAX_WORDS, pair.size)
        assertEquals(1028, OverlaySwapLook.MAX_WORDS)
        assertTrue("Two full climbs fit the uniform block", pair.size * 2 <= OverlaySwapLook.GLES_BYTES)
        assertEquals("And fill it but for the last slot's padding", OverlaySwapLook.GLES_BYTES - 8, pair.size * 2)
        assertTrue(
            "Reach rounds down, never past the atlas padding",
            OverlaySwapLook.reach16(OverlaySwapLook.MAX_REACH) <= (OverlaySwapLook.MAX_REACH * 32768).toInt(),
        )
        assertEquals(32768, OverlaySwapLook.reach16(1f))
        assertEquals(0, OverlaySwapLook.reach16(Float.NaN))
        assertEquals(65535, OverlaySwapLook.unorm16(2f))
        assertEquals(0, OverlaySwapLook.unorm16(-1f))
        assertEquals("Swift's rounded(): half away from zero", 32768, OverlaySwapLook.unorm16(.5f))
    }

    @Test
    fun oneReusedFrameWritesWhatAFreshOneWrites() {
        // The renderer keeps one frame; a big pair, then a small one, then the big one again
        // must each read exactly as a fresh frame writes them.
        val reused = OverlaySwapLook.Frame()
        val wild = Look.parse(listOf(2.0, 0.0, 9.0, -1.0, 3.0, .7, 5.0, -2.0, 3.0, 1.0, 0.0, 2.0, 9.0, -1.0, 4.0))!!
        val full = scene(holds(OverlayPacketLayout.MAX_ACTIVE_PER_SOURCE, 5))
        val pairs =
            listOf(
                { frame: OverlaySwapLook.Frame -> frame.encode(full, full, .5f, 0, .5f, 1, .4f, wild, false, true) },
                { frame: OverlaySwapLook.Frame -> frame.encode(lowerScene, upperScene, .3f, 2, .9f, 0, .2f, Look(ghost = .4f), true, false) },
                { frame: OverlaySwapLook.Frame -> frame.encode(full, full, .5f, 0, .5f, 1, .4f, wild, false, true) },
            )
        for (pair in pairs) {
            val fresh = OverlaySwapLook.Frame()
            val count = pair(reused)
            assertEquals(pair(fresh), count)
            assertArrayEquals(fresh.words.copyOf(count), reused.words.copyOf(count))
        }
        assertThrows(IllegalArgumentException::class.java) {
            reused.encode(full, scene(holds(OverlayPacketLayout.MAX_ACTIVE_PER_SOURCE + 1, 9)), 1f, 0, 0f, 1, 1f, Look(), false, true)
        }
    }

    @Test
    fun theLookProgramReadsTheBlockAtItsBindingAndUnpacksEachHoldAsMetalDoes() {
        // The shader stays checkable on its own (scripts/check-android-gpu-shaders.ts expands only the
        // generated layout), so it names the look's binding and size as literals: keep them in step.
        val block = "layout(std140,binding=${OverlaySwapLook.GLES_BINDING}) uniform Look { uvec4 look[${OverlaySwapLook.GLES_SLOTS}]; };"
        assertTrue(OverlayShader.lookFragment.contains(block))
        assertFalse("The base program has no look block", OverlayShader.fragment.contains("uniform Look"))
        assertNotEquals(OverlayPacketLayout.GLES_UNIFORM_BINDINGS_UNIFORMS, OverlaySwapLook.GLES_BINDING)
        assertEquals(129, OverlaySwapLook.GLES_SLOTS)
        // look_hold, word for word: slot s is uvec4 s >> 1, its xy or zw half; x = mark | glow << 16, y = reach.
        val words = intArrayOf(1, 0, 0, 0, 65535, 1, 32768, 0, 7, 65534, 44236, 0, 0, 32768, 19660, 0, 99, 99, 99, 99)
        val bytes = OverlaySwapLook.bytes(words, 16, ByteBuffer.allocateDirect(OverlaySwapLook.GLES_BYTES))
        assertEquals("Only the frame's own words go up", 16 * 2, bytes.remaining())
        val uints = bytes.duplicate().order(ByteOrder.LITTLE_ENDIAN).asIntBuffer()
        fun lookHold(index: Int): Triple<Int, Int, Int> {
            val slot = 1 + index
            val x = uints.get((slot shr 1) * 4 + (slot and 1) * 2)
            val y = uints.get((slot shr 1) * 4 + (slot and 1) * 2 + 1)
            return Triple(x and 0xffff, x ushr 16, y and 0xffff)
        }
        assertEquals("Header on", 1, uints.get(0) and 0xffff)
        assertEquals(Triple(65535, 1, 32768), lookHold(0))
        assertEquals(Triple(7, 65534, 44236), lookHold(1))
        assertEquals(Triple(0, 32768, 19660), lookHold(2))
    }

    @Test
    fun aFrameBindsTheLookProgramOnlyWithLookWordsAndABuiltProgram() {
        val base = 7
        val look = 9
        assertEquals("A look frame", look, OverlaySwapLookProgram.programFor(base, look, 12))
        assertEquals("No look words: the base program, as before the look", base, OverlaySwapLookProgram.programFor(base, look, 0))
        assertEquals("The look program did not build here", base, OverlaySwapLookProgram.programFor(base, 0, 12))
        // player-swap-look-kill: the app sends no look prop, so the view's look is null, the frame
        // has no words and the draw binds the base program.
        val killed = swapControls.copy(look = Look.parse(null), arrivals = OverlaySwapLook.Arrivals(0, 1))
        val words =
            OverlaySwapLook.frame(killed, OverlayPolicy.Selection(0, 1, .3f), OverlayPolicy.SwapWeights(.6f, .5f), drawnScenes, drawnHeader, OverlaySwapLook.Frame())
        assertEquals(0, words)
        assertEquals(base, OverlaySwapLookProgram.programFor(base, look, words))
    }

    @Test
    fun codesPagesAndSkippedClimbsKeepTheirFront() {
        // The lower page is the climb being left while the pair leans toward the upper one.
        assertEquals(0, OverlaySwapLook.pageCode(.25f, OverlaySwapLook.Arrivals(0, 1), upper = false))
        assertEquals(1, OverlaySwapLook.pageCode(.25f, OverlaySwapLook.Arrivals(0, 1), upper = true))
        assertEquals(2, OverlaySwapLook.pageCode(.75f, OverlaySwapLook.Arrivals(0, 2), upper = false))
        assertEquals(0, OverlaySwapLook.pageCode(.75f, OverlaySwapLook.Arrivals(0, 2), upper = true))
        // The app's codes: 0 leaving, 1 arriving from the right, 2 from the left, +4 calm.
        assertFalse(OverlaySwapLook.arriving(0) || OverlaySwapLook.calm(0))
        assertTrue(OverlaySwapLook.arriving(1) && OverlaySwapLook.fromRight(1, upper = false) && !OverlaySwapLook.calm(1))
        assertTrue(OverlaySwapLook.arriving(6) && !OverlaySwapLook.fromRight(6, upper = true) && OverlaySwapLook.calm(6))
        assertFalse("Calm only matters when arriving", OverlaySwapLook.arriving(4) || OverlaySwapLook.calm(4))
        assertTrue("A leaving climb keys from its slot", OverlaySwapLook.fromRight(0, upper = true) && !OverlaySwapLook.fromRight(4, upper = false))
        // A climb skipped mid-front moves from the upper slot to the lower one; its entry edge keeps its key.
        val rightScene = scene(listOf(right))
        val skippedUpper = OverlaySwapLook.key(rightScene, 0, true, 1, front, false)
        val skippedLower = OverlaySwapLook.key(rightScene, 0, false, 1, front, false)
        assertTrue("The front keeps its side through the slot change", skippedUpper == skippedLower && near(skippedLower, .1f))
        assertEquals("A leaving climb keys from its slot", .9f, OverlaySwapLook.key(rightScene, 0, false, 0, front, false))
        assertEquals(listOf(0, 1, 7, 0, 0, 2, 3, 0), listOf(0.0, 1.0, 7.0, 8.0, -1.0, 1.5, 2.5, -0.4).map(OverlaySwapLook.Arrivals::code))
    }

    private val swapControls = OverlayControls(null, false, false, false, OverlayPolicy.REVEAL_MODE_SWAP)

    private fun frame(values: List<Double>): Pair<OverlayControls, Double?>? {
        val sequenced = OverlaySwapCommand.split(values) ?: return null
        val controls = swapControls.withSwapFrame(sequenced.frame, sequenced.arrivals) ?: return null
        return controls to sequenced.sequence
    }

    @Test
    fun sevenNumberFramesCarryTheArrivalCodesAndTheSharedFloor() {
        val (seven, sequence) = frame(listOf(4.25, .4, .2, 1.0, 9.0, 0.0, 5.0))!!
        assertEquals(9.0, sequence)
        assertEquals(OverlaySwapLook.Arrivals(0, 5), seven.arrivals)
        assertEquals(1f, seven.shared)
        assertEquals("Unknown codes are leaving", OverlaySwapLook.Arrivals(), frame(listOf(4.25, .4, .2, 1.0, 9.0, 9.0, -1.0))!!.first.arrivals)
        // Without the look (Reduce Motion), a look frame's shared holds follow the shipped rule, not the floor.
        val floorFrame = frame(listOf(4.25, .9, .2, .7, 10.0, 0.0, 1.0))!!.first
        assertTrue(floorFrame.shared == .9f && floorFrame.sharedFloor == .7f)
        assertEquals(.7f, frame(listOf(4.25, .3, .2, .7, 11.0, 0.0, 1.0))!!.first.shared)
        val five = frame(listOf(4.25, .3, .2, .7, 12.0))!!.first
        assertNull(five.sharedFloor)
        assertEquals(.7f, five.shared)
        assertEquals(OverlaySwapLook.Arrivals(), frame(listOf(4.25, .4, .2, 1.0, 9.0))!!.first.arrivals)
        assertNull(frame(listOf(4.25, .4, .2, 1.0, 9.0, 0.0)))
        assertNull(frame(listOf(4.25, .4, .2, 1.0, 9.0, Double.NaN, 1.0)))
        assertNull(frame(listOf(4.25, .4, .2, 1.0, 9.0, 0.0, Double.POSITIVE_INFINITY)))
        assertNull(frame(listOf(4.25, .4, .2, 1.0, Double.NaN, 0.0, 1.0)))
        // A shipped frame after a look frame clears the look's floor and codes.
        val back = seven.withSwapFrame(listOf(4.0, .5, .5, .4))!!
        assertTrue(back.sharedFloor == null && back.arrivals == OverlaySwapLook.Arrivals())
    }

    private val drawnScenes =
        OverlaySwapLook.PacketScenes(
            listOf(lower, lower, upper, upper, holds(6, 3), holds(6, 3)).mapIndexed { index, holds ->
                scene(if (index % 2 == 0) holds else holds.map { it.copy(membership = 0) })
            },
        )
    /** The packet header [drawnScenes] was read from: 24, 24 and 6 holds. */
    private val drawnHeader =
        PacketHeader(1000, 1500, listOf(24, 24, 6).map { PacketScene(0, it * OverlayPacketLayout.DESCRIPTOR_BYTES, it, 0, 0) },
            listOf(true, true, true), emptyMap(), 0)
    private val ghostPeekStandby =
        Look.parse(listOf(2.0, .25, .25, .4, .4, 0.0, 0.0, .35, .15, .05, .25, 0.0, 2.0, .35, 0.0))!!

    @Test
    fun theFrameGateTurnsTheLookOffNativelyAndPinsReachWhenItMust() {
        val pair = OverlayPolicy.Selection(0, 1, .3f)
        val weights = OverlayPolicy.SwapWeights(.6f, .5f, .4f)
        fun words(
            controls: OverlayControls,
            selection: OverlayPolicy.Selection = pair,
            scenes: OverlaySwapLook.PacketScenes = drawnScenes,
            header: PacketHeader = drawnHeader,
        ): IntArray {
            val out = OverlaySwapLook.Frame()
            return out.words.copyOf(OverlaySwapLook.frame(controls, selection, weights, scenes, header, out))
        }
        val looking = swapControls.copy(look = ghostPeekStandby, arrivals = OverlaySwapLook.Arrivals(0, 1), sharedFloor = .4f)
        val drawn = words(looking)
        assertEquals(4 * (1 + lower.size + 6), drawn.size)
        assertEquals("The current climb is lower, the next (slot 2) upper", 1, drawn[0])
        assertArrayEquals(
            encode(drawnScenes.scene(0, false), drawnScenes.scene(2, true), .6f, 0, .5f, 1, .4f, ghostPeekStandby, false, true),
            drawn,
        )
        assertEquals("No look prop", 0, words(swapControls).size)
        assertEquals("Reduce Motion turns it off natively, whatever the app sends", 0, words(looking.copy(reduced = true)).size)
        assertEquals("The wipe never draws it", 0, words(looking.copy(revealMode = OverlayPolicy.REVEAL_MODE_WIPE)).size)
        assertEquals("One climb on show is the still image", 0, words(looking, OverlayPolicy.Selection(0, 0, 0f)).size)
        assertEquals("A packet the look could not read", 0, words(looking, scenes = OverlaySwapLook.PacketScenes.NONE).size)
        // A scene read short of the packet's own count: the look would read past its block.
        val longer = drawnHeader.copy(scenes = drawnHeader.scenes.mapIndexed { slot, scene -> if (slot == 2) scene.copy(count = 7) else scene })
        assertEquals("A scene not read whole draws the shipped swap", 0, words(looking, scenes = drawnScenes, header = longer).size)
        assertEquals("A pair of whole scenes still draws it", 4 * (1 + 24 + 24), words(looking, OverlayPolicy.Selection(-1, 0, .3f), header = longer).size)
        for (pinned in listOf(looking.copy(lowPower = true), looking.copy(hot = true))) {
            val pinnedWords = words(pinned)
            assertTrue("Battery Saver and a hot phone keep the look", pinnedWords[0] == 1)
            assertTrue("with every reach at 1", (1 until pinnedWords.size / 4).all { pinnedWords[4 * it + 2] == 32768 })
            for (slot in 1 until pinnedWords.size / 4) {
                assertEquals(drawn[4 * slot], pinnedWords[4 * slot])
                assertEquals(drawn[4 * slot + 1], pinnedWords[4 * slot + 1])
            }
        }
        assertTrue("I's standby ring pulls a leaving hold's reach in", (1..lower.size).any { drawn[4 * it + 2] in 1 until 32768 })
        // Past the half, the lower page is the arriving climb: the codes follow the pages.
        assertArrayEquals(
            encode(drawnScenes.scene(0, false), drawnScenes.scene(2, true), .6f, 1, .5f, 0, .4f, ghostPeekStandby, false, true),
            words(looking, OverlayPolicy.Selection(0, 1, .7f)),
        )
        // A shipped five-number frame has no floor: shared holds use the frame's shared weight.
        assertArrayEquals(
            encode(drawnScenes.scene(1, false), drawnScenes.scene(0, true), .6f, 0, .5f, 1, .4f, ghostPeekStandby, true, true),
            words(looking.copy(sharedFloor = null, mirrored = true), OverlayPolicy.Selection(-1, 0, .3f)),
        )
    }

    @Test
    fun descriptorsDecodeToCentresRolesIdsAndAnnotations() {
        val stride = OverlayPacketLayout.DESCRIPTOR_BYTES
        val bytes = ByteBuffer.allocate(2 * stride).order(ByteOrder.LITTLE_ENDIAN)
        fun put(index: Int, bounds: List<Float>, upperRole: Float, lowerRole: Float, id: Int, annotation: Int) {
            val base = index * stride
            bounds.forEachIndexed { offset, value -> bytes.putFloat(base + OverlayPacketLayout.DESCRIPTOR_OFFSETS_BOUNDS + 4 * offset, value) }
            bytes.putFloat(base + OverlayPacketLayout.DESCRIPTOR_OFFSETS_NUMBERS + 8, upperRole)
            bytes.putFloat(base + OverlayPacketLayout.DESCRIPTOR_OFFSETS_NUMBERS + 12, lowerRole)
            bytes.putInt(base + OverlayPacketLayout.DESCRIPTOR_OFFSETS_IDENTITY, id)
            bytes.putInt(base + OverlayPacketLayout.DESCRIPTOR_OFFSETS_IDENTITY + 8, annotation)
        }
        put(0, listOf(100f, 200f, 300f, 400f), 1f, 2f, 42, 0)
        put(1, listOf(-50f, 1400f, 50f, 1600f), 0f, 1f, -7, 3)
        val (lowerSide, upperSide) = OverlaySwapLook.scenes(bytes, 2, 1000f, 1500f)!!
        assertTrue(upperSide.centerX[0] == .2f && upperSide.centerY[0] == .2f && upperSide.entropy[0] == OverlaySwapLook.entropy(42))
        assertTrue(upperSide.membership[0] == 1 && !upperSide.annotation[0])
        assertEquals("The shader's numbers.w is the lower side's role", 2, lowerSide.membership[0])
        assertTrue("Centres clamp to the board", upperSide.centerX[1] == 0f && upperSide.centerY[1] == 1f)
        assertTrue(upperSide.membership[1] == 0 && upperSide.annotation[1] && upperSide.entropy[1] == OverlaySwapLook.entropy(-7))
        assertEquals(1, lowerSide.membership[1])
        assertNull("A short buffer reads nothing", OverlaySwapLook.scenes(bytes, 3, 1000f, 1500f))
        assertNull(OverlaySwapLook.scenes(bytes, 2, 0f, 1500f))
        assertTrue("An annotation does not stretch a climb's extent", upperSide.top == .2f && upperSide.bottom == .2f)
        assertTrue(OverlaySwapLook.Scene.EMPTY.let { it.top == 0f && it.bottom == 1f && it.size == 0 })

        // A packet: three scenes, each read as both sides; one short scene and the look skips the packet.
        val packet = ByteBuffer.allocate(3 * stride).order(ByteOrder.LITTLE_ENDIAN)
        packet.put(bytes.array(), 0, 2 * stride)
        val header =
            PacketHeader(1000, 1500, listOf(PacketScene(0, 2 * stride, 2, 0, 0), PacketScene(0, 0, 0, 0, 0), PacketScene(stride, stride, 1, 0, 0)),
                listOf(true, false, true), emptyMap(), 0)
        val scenes = OverlaySwapLook.PacketScenes.decode(ByteBuffer.wrap(packet.array()), header)
        assertTrue(scenes.decoded)
        assertTrue(scenes.scene(0, true).membership[0] == 1 && scenes.scene(0, false).membership[0] == 2)
        assertEquals(0, scenes.scene(1, false).size)
        assertEquals(1, scenes.scene(2, false).membership[0])
        val short = header.copy(scenes = listOf(PacketScene(0, stride, 2, 0, 0), PacketScene(0, 0, 0, 0, 0), PacketScene(0, 0, 0, 0, 0)))
        assertFalse(OverlaySwapLook.PacketScenes.decode(ByteBuffer.wrap(packet.array()), short).decoded)
    }

    @Test
    fun theSharedFixtureMatchesIOSWordForWord() {
        // fixtures/swap-look-words.json, written by iOS's ClimbOverlaySwapLookTests and checked
        // there too: the same looks, holds and sides must give the same 16-bit words on both ports.
        val path =
            generateSequence(File("").absoluteFile) { it.parentFile }
                .map { File(it, "fixtures/swap-look-words.json") }
                .first { it.exists() }
        val fixture = JSONObject(path.readText())
        val holdSpec = fixture.getJSONObject("holds")
        val lowerScene = scene(holds(holdSpec.getInt("count"), holdSpec.getInt("lowerSeed")))
        val upperScene = scene(holds(holdSpec.getInt("count"), holdSpec.getInt("upperSeed")))
        val looks = fixture.getJSONArray("looks")
        val sides = fixture.getJSONArray("sides")
        val words = fixture.getJSONArray("words")
        assertEquals(looks.length(), words.length())
        // One reused frame, as the renderer runs it.
        val frame = OverlaySwapLook.Frame()
        var cases = 0
        for (lookIndex in 0 until looks.length()) {
            val values = looks.getJSONArray(lookIndex).let { array -> (0 until array.length()).map { array.getDouble(it) } }
            val look = Look.parse(values)!!
            val expected = words.getJSONArray(lookIndex)
            assertEquals(sides.length(), expected.length())
            for (sideIndex in 0 until sides.length()) {
                val side = sides.getJSONArray(sideIndex)
                val count =
                    frame.encode(
                        lowerScene,
                        upperScene,
                        side.getDouble(0).toFloat(),
                        side.getInt(1),
                        side.getDouble(2).toFloat(),
                        side.getInt(3),
                        side.getDouble(4).toFloat(),
                        look,
                        side.getInt(5) != 0,
                        side.getInt(6) != 0,
                    )
                assertEquals(
                    "look $lookIndex, side $sideIndex",
                    expected.getString(sideIndex),
                    frame.words.copyOf(count).joinToString("") { "%04x".format(it) },
                )
                cases++
            }
        }
        assertEquals(35, cases)
    }

    @Test
    fun theStateEventReadsAsIOSWordsIt() {
        val swap = OverlayPolicy.REVEAL_MODE_SWAP
        assertEquals("no look prop", OverlaySwapLook.offReason(null, false, swap, false))
        assertEquals("look rejected", OverlaySwapLook.offReason(null, true, swap, false))
        assertEquals("not swap mode", OverlaySwapLook.offReason(Look(), false, OverlayPolicy.REVEAL_MODE_WIPE, false))
        assertEquals("Reduce Motion", OverlaySwapLook.offReason(Look(), false, swap, true))
        assertNull(OverlaySwapLook.offReason(Look(), false, swap, false))
        // Android only: the renderer could not build the look program.
        assertEquals("look shader unavailable", OverlaySwapLook.offReason(Look(), false, swap, true, shaderMissing = true))
        assertEquals("no look prop", OverlaySwapLook.offReason(null, false, swap, false, shaderMissing = true))
        assertEquals("Low Power", OverlaySwapLook.reachOffReason(true, true))
        assertEquals("hot phone", OverlaySwapLook.reachOffReason(false, true))
        assertNull(OverlaySwapLook.reachOffReason(false, false))
        assertEquals(mapOf("state" to "off", "reason" to "Reduce Motion"), OverlaySwapLook.report("Reduce Motion", 12, "Low Power"))
        assertEquals(mapOf("state" to "ready"), OverlaySwapLook.report(null, null, null))
        assertEquals(mapOf("state" to "on", "holds" to 12, "reachOff" to "hot phone"), OverlaySwapLook.report(null, 12, "hot phone"))
        assertEquals(2, OverlaySwapLook.VERSION)
    }

    @Test
    fun entropyIsThePCGHashOfTheHoldId() {
        // iOS's ClimbOverlaySwapLook.entropy for the same ids (UInt32 there), in 1/2^24 steps,
        // so the jitter and the seeded test holds match iOS hold for hold.
        val expected =
            mapOf(0 to 506671, 1 to 11058922, 11 to 4573329, 97 to 1564229, 7919 to 16726731, -1 to 15084105,
                Int.MIN_VALUE to 2213670)
        for ((id, steps) in expected) assertEquals("id $id", steps, (OverlaySwapLook.entropy(id) * (1 shl 24)).toInt())
    }
}
