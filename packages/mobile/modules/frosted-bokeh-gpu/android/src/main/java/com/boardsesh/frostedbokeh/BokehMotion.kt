package com.boardsesh.frostedbokeh

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToLong
import kotlin.math.sin

/** `MAX_GPU_BOKEH_LIGHTS` in `@boardsesh/frosted-bokeh`: the shader's array size. */
internal const val MAX_BLOBS = 30

/** One light: a hold's blob in pill points, its colour, its hold id (-1: none) and breathing seed. */
internal data class BokehBlob(
    val x: Float, val y: Float, val radius: Float, val peak: Float,
    val red: Float, val green: Float, val blue: Float,
    val id: Long = -1, val seed: Float = positionSeed(x, y),
)

/** The seed for a light the app sent without one: a hash of its position, 0..<2π. */
internal fun positionSeed(x: Float, y: Float): Float {
    val wave = sin(x.toDouble() * 12.9898 + y.toDouble() * 78.233) * 43758.5453
    return ((wave - floor(wave)) * 2 * Math.PI).toFloat()
}

internal data class BokehClimb(val key: String, val lights: List<BokehBlob>)

/** The look's numbers the frost uses, from the board's 15-number `swapLook`, clamped as the board clamps them. */
internal data class BokehSwapLook(
    val holdWindow: Float = 1f, val lowWindow: Float = 1f, val floor: Float = 0.4f, val arrivalFloor: Float = 0.4f,
    val ghost: Float = 0f, val swell: Float = 0f, val swellTail: Float = 0f, val focus: Float = 0f,
    val focusShape: Float = 2f, val tighten: Float = 0f, val topBoost: Float = 0f,
) {
    companion object {
        fun parse(values: List<Double>?): BokehSwapLook? {
            if (values == null || values.size != 15 || values[0] != 2.0 || !values.all { it.isFinite() }) return null
            fun number(index: Int, low: Float, high: Float) = values[index].toFloat().coerceIn(low, high)
            val swell = number(9, 0f, 0.35f)
            val swellTail = max(number(10, 0f, 0.6f), if (swell > 0f) 0.05f else 0f)
            return BokehSwapLook(
                holdWindow = if (swell > 0f) min(number(1, 0.05f, 1f), 1f - swellTail) else number(1, 0.05f, 1f),
                lowWindow = number(2, 0.05f, 1f),
                floor = number(3, 0f, 0.95f),
                arrivalFloor = number(4, 0f, 0.95f),
                ghost = number(7, 0f, 1f),
                swell = swell,
                swellTail = swellTail,
                focus = number(11, 0f, 0.35f),
                focusShape = number(12, 0.25f, 3f),
                tighten = number(13, 0f, 0.8f),
                topBoost = number(14, 0f, 1f),
            )
        }
    }
}

/**
 * One board swap frame: `[pagePosition, outgoing, incoming, shared, sequence]`, or seven
 * numbers with the look's arrival codes (-1 when absent). `[sequence]` alone: frames stopped.
 */
internal data class BokehSwapFrame(
    val position: Double, val outgoing: Float, val incoming: Float, val outgoingCode: Int, val incomingCode: Int,
) {
    val from: Int get() = nearestPage(position)
    val direction: Int
        get() {
            val lean = position - from
            return if (lean > 0.01) 1 else if (lean < -0.01) -1 else 0
        }

    /** A parsed command: its sequence, and the frame or null for "frames stopped". */
    data class Parsed(val sequence: Double, val frame: BokehSwapFrame?)

    companion object {
        fun parse(values: List<Double>): Parsed? {
            if (!values.all { it.isFinite() }) return null
            return when (values.size) {
                1 -> Parsed(values[0], null)
                5, 7 -> {
                    val coded = values.size == 7
                    Parsed(values[4], BokehSwapFrame(values[0], unit(values[1].toFloat()), unit(values[2].toFloat()),
                        if (coded) values[5].coerceIn(0.0, 7.0).toInt() else -1,
                        if (coded) values[6].coerceIn(0.0, 7.0).toInt() else -1))
                }
                else -> null
            }
        }
    }
}

/** The nearest page, half up as JS's `Math.round` and Swift's `BokehMotion.page`, clamped. */
internal fun nearestPage(position: Double): Int =
    if (position.isNaN()) 0 else position.roundToLong().coerceIn(-1_000_000_000L, 1_000_000_000L).toInt()

internal fun unit(value: Float): Float = if (value > 0f) (if (value < 1f) value else 1f) else 0f

internal fun smooth(value: Float): Float {
    val clamped = unit(value)
    return clamped * clamped * (3 - 2 * clamped)
}

/**
 * How the frost's lights change climbs: the board's swap look at pill scale.
 * The rules and their numbers are in `@boardsesh/frosted-bokeh` (`swap.ts`);
 * `BokehMotion.swift` on iOS is the same code line for line. Independent of Android.
 *
 * - With the board's swap frames (`swapFrameApi`), the lights follow them: the frame names
 *   the pair by page and carries each side's weight; each light takes its own weight through
 *   the board's front, keyed by its x.
 * - A climb that appears whole in one step (the Next button, a queue tap, a crewmate's
 *   change, any change with no frames) runs the release on its own.
 * - A frame naming a page the app has not sent yet (a flick run outpacing the JS thread)
 *   keeps the last frame it could draw until the page arrives.
 * - A climb that leaves the screen in one step fades out where it is.
 * - Lights lit in both climbs stay whole. At most [MAX_BLOBS] are drawn.
 */
internal class BokehMotion {
    /** `BOKEH_SWAP_MS` and `BOKEH_SWAP_OUT_MS`, in seconds. */
    var releaseSeconds = 0.22
    var fadeSeconds = 0.15
    var look: BokehSwapLook? = null
    /** The pill's width in points: lights are keyed by their x over it. */
    var width = 0f

    var current = BokehClimb("", emptyList())
        private set
    /** The climbs the board can swap between, by page; empty without swap frames. */
    private var pages: Map<Int, BokehClimb> = emptyMap()
    /** The newest frame, and the newest one whose complete pair the app has sent. */
    private var frame: BokehSwapFrame? = null
    private var drawnFrame: BokehSwapFrame? = null
    private var drawnPages: Map<Int, BokehClimb> = emptyMap()
    private var lastSequence: Double? = null
    private var visible: Map<String, Float> = emptyMap()
    private val leftovers = mutableListOf<Leftover>()
    private val arrivals = mutableMapOf<String, Arrival>()

    private data class Leftover(val light: BokehBlob, val start: Double)
    private data class Arrival(val start: Double, val held: Set<Int>)
    private data class Entry(val key: String?, val index: Int, val light: BokehBlob)
    private data class Side(val weight: Float, val arriving: Boolean, val fromRight: Boolean, val calm: Boolean)

    // Inputs

    /** The climb on show, and the board's pages around it (empty without swap frames). */
    fun setClimbs(next: BokehClimb, nextPages: Map<Int, BokehClimb>, now: Double) {
        val capped = BokehClimb(next.key, next.lights.take(MAX_BLOBS))
        val cappedPages = nextPages.mapValues { (_, climb) -> BokehClimb(climb.key, climb.lights.take(MAX_BLOBS)) }
        if (capped == current && cappedPages == pages) return
        refresh(now) {
            current = capped
            pages = cappedPages
            if (pages.isEmpty()) frame = null
            resolveFrame()
        }
    }

    /** A swap frame command or prop. False when its sequence is not newer than the last one applied. */
    fun applyFrame(values: List<Double>, now: Double): Boolean {
        val parsed = BokehSwapFrame.parse(values) ?: return false
        val last = lastSequence
        if (last != null && parsed.sequence <= last) return false
        lastSequence = parsed.sequence
        if (parsed.frame == frame) return true
        refresh(now) {
            frame = parsed.frame
            resolveFrame()
        }
        return true
    }

    /**
     * Keep the last complete pair until both pages of the newest frame arrive.
     * Snapshot its climbs too: a partial app update can evict the held pair.
     */
    private fun resolveFrame() {
        val latest = frame
        if (latest == null) {
            drawnFrame = null
            drawnPages = emptyMap()
            return
        }
        val outgoing = pages[latest.from] ?: return
        val resolvedPages = mutableMapOf(latest.from to outgoing)
        if (latest.direction != 0) {
            val incomingPage = latest.from + latest.direction
            val incoming = pages[incomingPage] ?: return
            resolvedPages[incomingPage] = incoming
        }
        drawnFrame = latest
        drawnPages = resolvedPages
    }

    // Output

    /** Something moves on its own clock: a release or a fade-out. */
    fun transitioning(now: Double): Boolean {
        prune(now)
        return leftovers.isNotEmpty() || arrivals.isNotEmpty()
    }

    /** The lights for one frame, at most [MAX_BLOBS], the strongest kept. */
    fun blobs(now: Double): List<BokehBlob> {
        prune(now)
        return cap(compose(now).map { it.light })
    }

    // Transitions

    private val frameMode: Boolean get() = drawnFrame != null

    private fun visibleWeights(): Map<String, Float> {
        val frame = drawnFrame
        if (!frameMode || frame == null) return if (current.lights.isEmpty()) emptyMap() else mapOf(current.key to 1f)
        val weights = mutableMapOf<String, Float>()
        drawnPages[frame.from]?.let { weights[it.key] = frame.outgoing }
        if (frame.direction != 0) {
            drawnPages[frame.from + frame.direction]?.let { weights[it.key] = max(weights[it.key] ?: 0f, frame.incoming) }
        }
        return weights
    }

    private fun visibleClimbs(): List<BokehClimb> {
        val frame = drawnFrame
        if (!frameMode || frame == null) return listOf(current)
        val climbs = mutableListOf<BokehClimb>()
        drawnPages[frame.from]?.let { climbs.add(it) }
        if (frame.direction != 0) drawnPages[frame.from + frame.direction]?.let { climbs.add(it) }
        return climbs
    }

    /**
     * Applies [change], then turns what it did to the screen into transitions: a climb that
     * left in one step fades out where it was, and one that appeared whole in one step runs
     * the release, holding lights it shares with what was drawn.
     */
    private fun refresh(now: Double, change: () -> Unit) {
        prune(now)
        val before = compose(now)
        val previous = visible
        change()
        val next = visibleWeights()
        val climbs = visibleClimbs()
        val shown = climbs.flatMap { it.lights }
        for (entry in before) {
            val key = entry.key ?: continue
            if (!previous.containsKey(key) || next.containsKey(key) || entry.light.peak <= INVISIBLE) continue
            if (shown.any { sameHold(it, entry.light) }) continue
            leftovers.add(Leftover(entry.light, now))
        }
        // Something was on screen: a climb arriving whole runs the release. Not on the first
        // climb, which appears whole.
        if (before.isNotEmpty() || previous.isNotEmpty()) {
            for (climb in climbs) {
                val weight = next[climb.key] ?: continue
                if (weight - (previous[climb.key] ?: 0f) < ABRUPT_STEP) continue
                val held = climb.lights.indices.filter { index ->
                    val light = climb.lights[index]
                    before.any { sameHold(it.light, light) && it.light.peak >= 0.5f * light.peak }
                }.toSet()
                leftovers.removeAll { leftover -> held.any { sameHold(climb.lights[it], leftover.light) } }
                arrivals[climb.key] = Arrival(now, held)
            }
        }
        arrivals.keys.retainAll(next.keys)
        visible = next
    }

    private fun prune(now: Double) {
        leftovers.removeAll { now - it.start >= fadeSeconds }
        arrivals.values.removeAll { now - it.start >= releaseSeconds }
    }

    // Drawing

    private fun compose(now: Double): List<Entry> {
        val entries = leftovers.mapTo(mutableListOf()) { Entry(null, -1, it.light.copy(peak = it.light.peak * fade(now - it.start))) }
        val frame = drawnFrame
        val shaped = if (frameMode && frame != null) frameEntries(frame)
        else current.lights.mapIndexed { index, light -> Entry(current.key, index, light) }
        for (entry in shaped) {
            val arrival = entry.key?.let { arrivals[it] }
            entries.add(
                if (arrival == null || entry.index in arrival.held) entry
                else entry.copy(light = entry.light.copy(peak = entry.light.peak * fill(entry.light, now - arrival.start))),
            )
        }
        return entries
    }

    private fun frameEntries(frame: BokehSwapFrame): List<Entry> {
        val direction = frame.direction
        val outgoing = drawnPages[frame.from]
        val incoming = if (direction != 0) drawnPages[frame.from + direction] else null
        val look = if (frame.outgoingCode < 0) null else look
        val entries = mutableListOf<Entry>()
        if (outgoing != null) {
            val side = side(frame.outgoing, frame.outgoingCode, upper = direction < 0)
            outgoing.lights.forEachIndexed { index, light ->
                val shared = incoming?.lights?.any { sameHold(it, light) } ?: false
                entries.add(Entry(outgoing.key, index, if (shared) light else shape(light, side, look)))
            }
        }
        if (incoming != null) {
            val side = side(frame.incoming, frame.incomingCode, upper = direction > 0)
            incoming.lights.forEachIndexed { index, light ->
                if (outgoing?.lights?.any { sameHold(it, light) } == true) return@forEachIndexed
                entries.add(Entry(incoming.key, index, shape(light, side, look)))
            }
        }
        return entries
    }

    /**
     * A side from its arrival code (0 leaving, 1 from the right, 2 from the left, +4 calm).
     * A leaving climb is keyed from its own slot's edge: the upper page from the right.
     */
    private fun side(weight: Float, code: Int, upper: Boolean): Side {
        val edge = if (code < 0) 0 else code and 3
        val arriving = edge == 1 || edge == 2
        return Side(weight, arriving, if (arriving) edge == 1 else upper, arriving && (code and 4) != 0)
    }

    private fun across(light: BokehBlob): Float = if (width > 0f) unit(light.x / width) else 0.5f

    private fun shape(light: BokehBlob, side: Side, look: BokehSwapLook?): BokehBlob {
        if (look == null) return light.copy(peak = light.peak * side.weight)
        val across = across(light)
        val key = if (side.fromRight) 1 - across else across
        val weight = lit(side.weight, key, side.arriving, look)
        val (glow, reach) = shaped(weight, key, side.arriving, side.calm, look)
        return light.copy(peak = light.peak * glow, radius = light.radius * reach)
    }

    /** A standalone release's ceiling on an arriving light (`frostReleaseFill`). */
    private fun fill(light: BokehBlob, elapsed: Double): Float {
        val half = (releaseSeconds / 2).toFloat()
        val key = 1 - across(light)
        return smooth((elapsed.toFloat() - key * half) / half)
    }

    /** A fading light's share left (`frostReleaseFade`). */
    private fun fade(elapsed: Double): Float =
        1 - smooth((elapsed / fadeSeconds).toFloat())

    companion object {
        /** `BOKEH_SAME_HOLD_POINTS`. */
        const val SAME_HOLD_POINTS = 6f
        /** `BOKEH_ABRUPT_STEP`. */
        const val ABRUPT_STEP = 0.5f
        const val MIN_REACH = 0.6f
        const val MAX_REACH = 1.35f
        private const val INVISIBLE = 0.0005f

        fun sameHold(first: BokehBlob, second: BokehBlob): Boolean {
            if (abs(first.red - second.red) >= 0.02f || abs(first.green - second.green) >= 0.02f ||
                abs(first.blue - second.blue) >= 0.02f) return false
            if (first.id >= 0 && second.id >= 0) return first.id == second.id
            return hypot(first.x - second.x, first.y - second.y) < SAME_HOLD_POINTS
        }

        fun cap(lights: List<BokehBlob>): List<BokehBlob> {
            val drawn = lights.filter { it.peak > INVISIBLE && it.radius > 0f }
            if (drawn.size <= MAX_BLOBS) return drawn
            val keep = drawn.indices.sortedWith(compareByDescending<Int> { drawn[it].peak }.thenBy { it })
                .take(MAX_BLOBS).toSet()
            return drawn.filterIndexed { index, _ -> index in keep }
        }

        // The board's look (`frostLightWeight`, `frostLightShape`).

        private fun window(progress: Float, key: Float, width: Float, tail: Float): Float {
            val lead = max(0f, 1 - width - tail)
            return unit((progress - key * lead) / width)
        }

        private fun ease(local: Float, width: Float): Float {
            val smoothed = local * local * (3 - 2 * local)
            return local + (smoothed - local) * (1 - width)
        }

        fun lit(weight: Float, key: Float, arriving: Boolean, look: BokehSwapLook): Float {
            val side = unit(weight)
            val floor = if (arriving) look.arrivalFloor else look.floor
            if (side >= floor) {
                val span = 1 - floor
                val progress = if (span > 0f) (side - floor) / span else 1f
                val local = window(progress, key, look.holdWindow, if (arriving) look.swellTail else 0f)
                return floor + span * ease(local, look.holdWindow)
            }
            val local = window(if (floor > 0f) side / floor else 1f, key, look.lowWindow, 0f)
            return floor * ease(local, look.lowWindow)
        }

        private fun swell(weight: Float, key: Float, look: BokehSwapLook): Float {
            val floor = look.arrivalFloor
            if (look.swell <= 0f || weight <= floor || weight >= 1f) return 0f
            val progress = (weight - floor) / (1 - floor)
            val span = look.holdWindow + look.swellTail
            val local = unit((progress - key * max(0f, 1 - span)) / span)
            val peak = look.holdWindow / span
            val shape = if (local < peak) smooth(local / peak) else 1 - smooth((local - peak) / (1 - peak))
            return look.swell * (1 + (key - 1) * look.topBoost) * shape
        }

        fun shaped(weight: Float, key: Float, arriving: Boolean, calm: Boolean, look: BokehSwapLook): Pair<Float, Float> {
            if (weight <= 0f) return 0f to 1f
            var glow = weight
            if (arriving && look.ghost > 0f && look.arrivalFloor > 0f) {
                glow = if (weight <= look.arrivalFloor) weight * look.ghost / look.arrivalFloor
                else look.ghost + (1 - look.ghost) * (weight - look.arrivalFloor) / (1 - look.arrivalFloor)
            }
            val missing = 1 - weight
            val base = if (arriving) 1 + look.focus * missing.pow(look.focusShape) else 1 - look.tighten * missing
            val grown = if (arriving && !calm) base * (1 + swell(weight, key, look)) else base
            return glow to min(MAX_REACH, max(MIN_REACH, grown))
        }
    }
}

/**
 * No callback when nothing moves. A transition (swap frames arriving or a release running)
 * draws at 60 fps. Battery Saver and Reduce Motion only suppress breathing (the app draws a
 * still frost under Reduce Motion).
 */
internal fun bokehFrameRate(visible: Boolean, reduceMotion: Boolean, lowPower: Boolean, moving: Boolean, motion: Boolean): Int =
    when {
        !visible -> 0
        moving -> 60
        reduceMotion -> 0
        motion && !lowPower -> 15
        else -> 0
    }
