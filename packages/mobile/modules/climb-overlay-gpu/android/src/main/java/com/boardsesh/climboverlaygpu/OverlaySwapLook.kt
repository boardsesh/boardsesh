package com.boardsesh.climboverlaygpu

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.floor
import kotlin.math.pow

/**
 * The swap look (`swapLookVersion` 2), ported line for line from iOS's
 * `ClimbOverlaySwapLook.swift`: how the wall swap's two side weights become,
 * for each hold, a mark weight, a glow weight and a glow reach. Without a look
 * the shader runs API 7's `reveal_weight` and none of this exists.
 *
 * The app keeps sending one weight per side from the wall-swap state machine,
 * so re-flicks, reversals and cancels stay in JS. Here a side's weight W turns
 * into a per-hold weight through a front: every hold has a key in 0..1 and
 * changes over its own window of the side's progress. W = 1, W = floor and
 * W = 0 give the same weight for every key, so the app can relabel a pair, or
 * restart a skipped climb at the floor, without a jump.
 *
 * Rust writes the 144-byte uniforms, so this runs on the render thread once per
 * frame for at most 2 × 128 holds and is bound as its own uniform block: the
 * shader reads one hold's four 16-bit numbers per candidate instead of
 * re-deriving them per pixel, and no Rust or contract change is needed. The
 * buffer's bytes are exactly the ones iOS binds at Metal fragment buffer 5.
 *
 * Every number is a 32-bit float, and [larger]/[smaller] keep Swift's
 * `max`/`min`, so both platforms quantise the same frame to the same words.
 */
internal object OverlaySwapLook {
    /** Advertised as the module constant `swapLookVersion`, the same as iOS. */
    const val VERSION = 2

    /**
     * The look's uniform-block binding, past the Rust contract's block 0. A fifth
     * storage block would need GL_MAX_FRAGMENT_SHADER_STORAGE_BLOCKS of 5, which
     * GLES 3.1 does not promise (its minimum is 4 and the renderer already uses
     * 4); 2 KB fits every phone's 16 KB uniform-block minimum, and it is the
     * twin of Metal's `setFragmentBytes` constant buffer.
     */
    const val GLES_BINDING = 1

    /** The header plus a full pair, as `uvec4`s: std140 gives each array element 16 bytes, so two holds share one. */
    const val GLES_SLOTS = (1 + 2 * OverlayPacketLayout.MAX_ACTIVE_PER_SOURCE + 1) / 2

    /** The block's size in bytes: the look buffer the renderer allocates once. */
    const val GLES_BYTES = GLES_SLOTS * 16

    /** The atlas pads every field for this reach (`EDIT_PEAK_REACH`); a halo past it would clip. */
    val MAX_REACH: Float = OverlayPacketLayout.EDIT_PEAK_REACH
    const val MIN_REACH = 0.6f

    /** Four 16-bit words per hold after a header of four; header word 0 = 1 turns the look on. */
    val OFF = intArrayOf(0, 0, 0, 0)

    /** Swift's `max(x, y)`: `y >= x ? y : x`. Kotlin's `max` differs on NaN and on −0. */
    private fun larger(first: Float, second: Float): Float = if (second >= first) second else first

    /** Swift's `min(x, y)`: `y < x ? y : x`. */
    private fun smaller(first: Float, second: Float): Float = if (second < first) second else first

    /**
     * The static look, from the `swapLook` prop: `[2, holdWindow, lowWindow,
     * floor, arrivalFloor, climbUp, jitter, ghost, markLag, swell, swellTail,
     * focus, focusShape, tighten, topBoost]`. Every number is clamped to its
     * range; [parse] returns null for anything else, which turns the look off.
     */
    data class Look(
        /** Above the floor, each hold changes over this share of the side's progress. 1: all together. */
        val holdWindow: Float = 1f,
        /** Below the floor, the same. 1: all together. */
        val lowWindow: Float = 1f,
        /** A leaving climb's two stages meet here (the drag's dim); every hold is at it when its side is. */
        val floor: Float = 0.4f,
        /**
         * The same for an arriving climb. Equal to [floor] it moves like a leaving one; 0 lights it
         * in one front from dark to whole; with ghosts it is where the ghosts end and the marks begin.
         */
        val arrivalFloor: Float = 0.4f,
        /** An arriving climb lights bottom to top within its own lit holds, not from the swipe edge. */
        val climbUp: Boolean = false,
        /** Mixes each key toward a hash of the hold id: a ragged order. */
        val jitter: Float = 0f,
        /** An arriving climb below the floor shows glow only, up to this glow; 0: no ghosts. */
        val ghost: Float = 0f,
        /** The mark trails the glow: mark × mix(1, w, markLag). */
        val markLag: Float = 0f,
        /** An arriving hold's reach swells by up to this much as it lights, then settles. */
        val swell: Float = 0f,
        /** How long the swell takes to settle, in the side's progress above the floor. */
        val swellTail: Float = 0f,
        /** An arriving hold's reach is 1 + focus × (1 − w)^focusShape: wide while faint. */
        val focus: Float = 0f,
        /** 2 pulls the halo in early (inside the flash budget); 0.5 keeps it wide until the hold is nearly whole. */
        val focusShape: Float = 2f,
        /** A leaving hold's reach is 1 − tighten × (1 − w): it pulls in as it fades. */
        val tighten: Float = 0f,
        /** The swell grows with the key: mix(1, key, topBoost). With climb-up keys, the top swells most. */
        val topBoost: Float = 0f,
    ) {
        companion object {
            const val FIELD_COUNT = 15
            const val FORMAT = 2.0

            fun parse(values: List<Double>?): Look? {
                if (values == null || values.size != FIELD_COUNT || values[0] != FORMAT || values.any { !it.isFinite() }) {
                    return null
                }
                fun number(index: Int, low: Float, high: Float): Float = smaller(high, larger(low, values[index].toFloat()))
                val swell = number(9, 0f, 0.35f)
                // A swell needs time to settle before its hold is whole, or it would end at full reach,
                // and its hold's window must leave that time: otherwise the last hold's swell is cut
                // off at the side's last frame and its halo snaps back.
                val swellTail = larger(number(10, 0f, 0.6f), if (swell > 0) 0.05f else 0f)
                val holdWindow = number(1, 0.05f, 1f)
                return Look(
                    holdWindow = if (swell > 0) smaller(holdWindow, 1 - swellTail) else holdWindow,
                    lowWindow = number(2, 0.05f, 1f),
                    floor = number(3, 0f, 0.95f),
                    arrivalFloor = number(4, 0f, 0.95f),
                    climbUp = values[5] >= 0.5,
                    jitter = number(6, 0f, 0.5f),
                    ghost = number(7, 0f, 1f),
                    markLag = number(8, 0f, 1f),
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

    /** What the look needs of one hold descriptor, read once per packet. */
    data class Hold(
        /** The hold's centre across the board, 0 left to 1 right, before any display mirror. */
        val centerX: Float,
        /** The hold's centre down the board, 0 top to 1 bottom. */
        val centerY: Float,
        /** 0 lit only in this climb, 1 the same role in both, 2 a changed role. */
        val membership: Int,
        /** 0 until 1 from the physical hold id, the same on both sides. */
        val entropy: Float,
        val annotation: Boolean,
    )

    /** One climb's holds and the vertical extent of its lit (non-annotation) holds. */
    class Scene(val holds: List<Hold>) {
        val top: Float
        val bottom: Float

        init {
            val heights = holds.filter { !it.annotation }.map { it.centerY }
            top = heights.minOrNull() ?: 0f
            bottom = heights.maxOrNull() ?: 1f
        }
    }

    /** One side of the pair as this frame shows it. */
    data class Side(
        val weight: Float,
        /** The side's climb is arriving (the app's code), so it uses the arriving rules. */
        val arriving: Boolean,
        val top: Float = 0f,
        val bottom: Float = 1f,
        /**
         * An arriving climb's entry edge (true: the right, before any display mirror). It keys the
         * climb's front from that edge whichever slot it now sits in, so a climb skipped mid-front
         * by a quick re-flick, which moves from the upper to the lower slot, keeps its front's side.
         * Null: the slot's own edge (lower from the left, upper from the right).
         */
        val fromRight: Boolean? = null,
        /** A flick run's arrival: no swell. */
        val calm: Boolean = false,
    ) {
        companion object {
            /** From the app's code ([Arrivals]): 0 leaving, 1 arriving from the right, 2 from the left, +4 calm. */
            fun fromCode(weight: Float, code: Int): Side {
                val edge = code and 3
                return Side(
                    weight = weight,
                    arriving = edge == 1 || edge == 2,
                    fromRight = if (edge == 1) true else if (edge == 2) false else null,
                    calm = edge != 0 && (code and 4) != 0,
                )
            }
        }
    }

    /**
     * How the climb being left and the arriving one each move this frame, as the
     * app's per-climb code (0 leaving; 1 arriving from the right edge, 2 from the
     * left; +4 calm, a flick run's arrival with no swell). The app changes a
     * climb's code only while its weight is 0 or 1, so a relabelled pair keeps
     * its pixels. iOS: `ClimbOverlayMotion.SwapArrivals`.
     */
    data class Arrivals(val outgoing: Int = 0, val incoming: Int = 0) {
        companion object {
            /** A frame number as a code: 0..7, anything else 0. Rounds half away from zero, as Swift does. */
            fun code(value: Double): Int {
                if (!value.isFinite()) return 0
                val rounded = if (value < 0) -Math.round(-value).toDouble() else Math.round(value).toDouble()
                return if (rounded >= 0 && rounded <= 7) rounded.toInt() else 0
            }
        }
    }

    data class Shape(val mark: Float, val glow: Float, val reach: Float) {
        companion object {
            val HIDDEN = Shape(0f, 0f, 1f)
        }
    }

    fun clampUnit(value: Float): Float = if (value > 0) (if (value < 1) value else 1f) else 0f

    fun smooth(value: Float): Float {
        val unit = clampUnit(value)
        return unit * unit * (3 - 2 * unit)
    }

    /** PCG hash of a physical hold id to 0 until 1; the same id gives the same jitter on both sides. */
    fun entropy(id: Int): Float {
        var hash = id * 747_796_405 + -1_403_630_843 // 2_891_336_453 as a wrapped 32-bit word
        hash = ((hash ushr ((hash ushr 28) + 4)) xor hash) * 277_803_737
        hash = (hash ushr 22) xor hash
        return (hash ushr 8).toFloat() / (1 shl 24).toFloat()
    }

    /**
     * Reads [count] hold descriptors ([OverlayPacketLayout.DESCRIPTOR_BYTES] each) from
     * [descriptors]' position. [upper] picks which membership number belongs to this
     * side, as the shader does.
     */
    fun holds(descriptors: ByteBuffer, count: Int, upper: Boolean, width: Float, height: Float): List<Hold> {
        val stride = OverlayPacketLayout.DESCRIPTOR_BYTES
        if (count <= 0 || width <= 0 || height <= 0 || descriptors.remaining() < count * stride) return emptyList()
        val bytes = descriptors.duplicate().order(ByteOrder.LITTLE_ENDIAN)
        val start = bytes.position()
        val bounds = OverlayPacketLayout.DESCRIPTOR_OFFSETS_BOUNDS
        val numbers = OverlayPacketLayout.DESCRIPTOR_OFFSETS_NUMBERS
        val identity = OverlayPacketLayout.DESCRIPTOR_OFFSETS_IDENTITY
        return (0 until count).map { index ->
            val base = start + index * stride
            fun float(offset: Int): Float = bytes.getFloat(base + offset)
            fun word(offset: Int): Int = bytes.getInt(base + offset)
            val membership = float(numbers + if (upper) 8 else 12)
            Hold(
                centerX = clampUnit((float(bounds) + float(bounds + 8)) * 0.5f / width),
                centerY = clampUnit((float(bounds + 4) + float(bounds + 12)) * 0.5f / height),
                membership = if (membership == 1f) 1 else if (membership == 2f) 2 else 0,
                entropy = entropy(word(identity)),
                annotation = word(identity + 8) != 0,
            )
        }
    }

    /**
     * The order key, 0 acts first as a side's weight rises (and last as it falls).
     * Sideways: 0 at the edge this side's climb enters from (the lower page from
     * the left, the upper page from the right, swapped by a display mirror), so a
     * relabelled pair replays the same front backwards. An arriving climb under
     * `climbUp`: 0 at its lowest lit hold, 1 at its highest.
     */
    fun key(hold: Hold, upper: Boolean, side: Side, look: Look, mirrored: Boolean): Float {
        var key: Float
        if (side.arriving && look.climbUp) {
            val span = side.bottom - side.top
            key = if (span > 1e-4f) (side.bottom - hold.centerY) / span else 0f
        } else {
            val across = if (mirrored) 1 - hold.centerX else hold.centerX
            val fromRight = if (side.arriving) (side.fromRight ?: upper) else upper
            key = if (fromRight) 1 - across else across
        }
        key = clampUnit(key)
        return key + (hold.entropy - key) * look.jitter
    }

    /** Where a hold with [key] is inside its own window of [progress]. */
    fun window(progress: Float, key: Float, width: Float, tail: Float): Float {
        val lead = larger(0f, 1 - width - tail)
        return clampUnit((progress - key * lead) / width)
    }

    /** Linear for a window of 1 (the side's own curve), smoothstep for a narrow one. */
    fun ease(local: Float, width: Float): Float {
        val smoothed = local * local * (3 - 2 * local)
        return local + (smoothed - local) * (1 - width)
    }

    /** The floor a side's two stages meet at: `arrivalFloor` for an arriving climb. */
    fun stageFloor(arriving: Boolean, look: Look): Float = if (arriving) look.arrivalFloor else look.floor

    /**
     * One hold's weight when its side is at [weight]. Above the floor holds move
     * between the floor and 1 in key order; below it, between 0 and the floor.
     * An arriving climb finishes its front early by `swellTail`, so the last
     * hold's swell can settle before the side reaches 1.
     */
    fun lit(weight: Float, key: Float, arriving: Boolean, look: Look): Float {
        val clamped = clampUnit(weight)
        val floor = stageFloor(arriving, look)
        if (clamped >= floor) {
            val span = 1 - floor
            val progress = if (span > 0) (clamped - floor) / span else 1f
            val local = window(progress, key, look.holdWindow, if (arriving) look.swellTail else 0f)
            return floor + span * ease(local, look.holdWindow)
        }
        val local = window(clamped / floor, key, look.lowWindow, 0f)
        return floor * ease(local, look.lowWindow)
    }

    /**
     * An arriving hold's swell above reach 1: up as it lights, back down over
     * `swellTail`, 0 at and below the floor and at 1.
     */
    fun swell(weight: Float, key: Float, look: Look): Float {
        val floor = look.arrivalFloor
        if (!(look.swell > 0 && weight > floor && weight < 1)) return 0f
        val progress = (weight - floor) / (1 - floor)
        val width = look.holdWindow
        val span = width + look.swellTail
        val local = clampUnit((progress - key * larger(0f, 1 - span)) / span)
        val peak = width / span
        val shape = if (local < peak) smooth(local / peak) else 1 - smooth((local - peak) / (1 - peak))
        return look.swell * (1 + (key - 1) * look.topBoost) * shape
    }

    /** Mark, glow and reach for a hold of one side at per-hold weight [weight]. */
    fun shaped(
        weight: Float,
        key: Float,
        arriving: Boolean,
        look: Look,
        allowReach: Boolean,
        calm: Boolean = false,
    ): Shape {
        if (!(weight > 0)) return Shape.HIDDEN
        var mark = weight
        var glow = weight
        if (arriving && look.ghost > 0 && look.arrivalFloor > 0) {
            // A ghost: glow only up to the arrival floor, then the mark fills in as the glow finishes.
            if (weight <= look.arrivalFloor) {
                glow = weight * look.ghost / look.arrivalFloor
                mark = 0f
            } else {
                val filled = (weight - look.arrivalFloor) / (1 - look.arrivalFloor)
                glow = look.ghost + (1 - look.ghost) * filled
                mark = filled
            }
        }
        mark *= 1 + (weight - 1) * look.markLag
        if (!allowReach) return Shape(mark, glow, 1f)
        val missing = 1 - weight
        val base = if (arriving) 1 + look.focus * missing.pow(look.focusShape) else 1 - look.tighten * missing
        val grown = if (arriving && !calm) base * (1 + swell(weight, key, look)) else base
        return Shape(mark, glow, smaller(MAX_REACH, larger(MIN_REACH, grown)))
    }

    /**
     * One hold of the union. A shared same-role hold is drawn once, on the lower
     * side, at the brighter of the two sides' fronts at its spot, never below
     * [sharedFloor]. A changed hold shows only its stronger role, compared at its
     * own spot (the lower one on a tie), as API 7 does with the side weights.
     */
    fun shape(
        hold: Hold,
        upper: Boolean,
        lowerSide: Side,
        upperSide: Side,
        sharedFloor: Float,
        look: Look,
        mirrored: Boolean,
        allowReach: Boolean,
    ): Shape {
        val own = if (upper) upperSide else lowerSide
        val ownKey = key(hold, upper, own, look, mirrored)
        val ownWeight = lit(own.weight, ownKey, own.arriving, look)
        if (hold.membership == 1) {
            if (upper) return Shape.HIDDEN
            val otherKey = key(hold, true, upperSide, look, mirrored)
            val otherWeight = lit(upperSide.weight, otherKey, upperSide.arriving, look)
            val weight = larger(clampUnit(sharedFloor), larger(ownWeight, otherWeight))
            return if (weight > 0) Shape(weight, weight, 1f) else Shape.HIDDEN
        }
        if (hold.membership == 2) {
            val other = if (upper) lowerSide else upperSide
            val otherKey = key(hold, !upper, other, look, mirrored)
            val otherWeight = lit(other.weight, otherKey, other.arriving, look)
            if (if (upper) ownWeight <= otherWeight else ownWeight < otherWeight) return Shape.HIDDEN
        }
        return shaped(ownWeight, ownKey, own.arriving, look, allowReach, own.calm)
    }

    /**
     * Each side's arrival code: the lower page is the outgoing one while the
     * pair's progress is below one half, as [OverlayPolicy.selectSwap] maps weights.
     */
    fun sides(progress: Float, outgoing: Int, incoming: Int): Pair<Int, Int> =
        if (progress < 0.5f) outgoing to incoming else incoming to outgoing

    /** 0..1 in 1/65535 steps, rounded half away from zero as Swift's `rounded()`. */
    fun unorm16(value: Float): Int = Math.round(clampUnit(value) * 65535)

    /** Reach in 1/32768 steps, so 1 decodes exactly; rounded down, so [MAX_REACH] never decodes past the padding. */
    fun reach16(value: Float): Int = floor(smaller(MAX_REACH, larger(0f, value)) * 32768).toInt()

    /**
     * The uniform block for one frame, as 16-bit words: the header, then every
     * lower hold, then every upper hold, in the shader's union order. Mark and
     * glow are 0..1 in 1/65535 steps, reach is in 1/32768 steps.
     */
    fun encode(
        lower: Scene,
        upper: Scene,
        lowerSide: Side,
        upperSide: Side,
        sharedFloor: Float,
        look: Look,
        mirrored: Boolean,
        allowReach: Boolean,
    ): IntArray {
        val words = IntArray(4 * (1 + lower.holds.size + upper.holds.size))
        words[0] = 1
        val lowerPlaced = lowerSide.copy(top = lower.top, bottom = lower.bottom)
        val upperPlaced = upperSide.copy(top = upper.top, bottom = upper.bottom)
        fun write(slot: Int, shape: Shape) {
            words[4 * slot] = unorm16(shape.mark)
            words[4 * slot + 1] = unorm16(shape.glow)
            words[4 * slot + 2] = reach16(shape.reach)
        }
        lower.holds.forEachIndexed { index, hold ->
            write(1 + index, shape(hold, false, lowerPlaced, upperPlaced, sharedFloor, look, mirrored, allowReach))
        }
        upper.holds.forEachIndexed { index, hold ->
            write(1 + lower.holds.size + index, shape(hold, true, lowerPlaced, upperPlaced, sharedFloor, look, mirrored, allowReach))
        }
        return words
    }

    /**
     * This frame's look block, or its zero header (API 7's swap): no look, the
     * wipe, a single climb on show, or Reduce Motion, which turns the look off
     * here whatever the app sends. Battery Saver and a hot phone keep it on with
     * glow reach pinned at 1. iOS: `ClimbOverlayGPUView.swapLookWords`.
     */
    fun frame(
        controls: OverlayControls,
        selection: OverlayPolicy.Selection,
        weights: OverlayPolicy.SwapWeights,
        scenes: PacketScenes,
    ): IntArray {
        val look = controls.look ?: return OFF
        if (controls.revealMode != OverlayPolicy.REVEAL_MODE_SWAP || controls.reduced || selection.lower == selection.upper) {
            return OFF
        }
        val (lowerCode, upperCode) = sides(selection.progress, controls.arrivals.outgoing, controls.arrivals.incoming)
        return encode(
            scenes.scene(OverlayPolicy.slot(selection.lower), upper = false),
            scenes.scene(OverlayPolicy.slot(selection.upper), upper = true),
            Side.fromCode(weights.lower, lowerCode),
            Side.fromCode(weights.upper, upperCode),
            controls.sharedFloor ?: weights.shared,
            look,
            controls.mirrored,
            allowReach = reachOffReason(controls.lowPower, controls.hot) == null,
        )
    }

    /**
     * Why the look is not drawing, or null when it can: the `reason` of an
     * `onSwapLookState` "off" event, worded as iOS words it.
     */
    fun offReason(look: Look?, rejected: Boolean, revealMode: Int, reduced: Boolean): String? = when {
        look == null -> if (rejected) "look rejected" else "no look prop"
        revealMode != OverlayPolicy.REVEAL_MODE_SWAP -> "not swap mode"
        reduced -> "Reduce Motion"
        else -> null
    }

    /** Why glow reach is pinned at 1 while the look draws, or null: Battery Saver, then a hot phone. */
    fun reachOffReason(lowPower: Boolean, hot: Boolean): String? =
        if (lowPower) "Low Power" else if (hot) "hot phone" else null

    /**
     * The `onSwapLookState` payload: off with why, or ready (valid, not drawn
     * yet) or on with the hold count of the last look drawn, either with
     * `reachOff` when reach is pinned. `SwapLookStatus` in play-drawer/swap-look.ts.
     */
    fun report(offReason: String?, appliedHolds: Int?, reachOff: String?): Map<String, Any> {
        if (offReason != null) return mapOf("state" to "off", "reason" to offReason)
        val report = LinkedHashMap<String, Any>()
        if (appliedHolds == null) report["state"] = "ready" else {
            report["state"] = "on"
            report["holds"] = appliedHolds
        }
        if (reachOff != null) report["reachOff"] = reachOff
        return report
    }

    /** [words] as the bytes iOS binds: little-endian 16-bit words, into [target] from its start. */
    fun bytes(words: IntArray, target: ByteBuffer): ByteBuffer {
        require(words.size % 4 == 0 && words.size * 2 <= target.capacity())
        target.clear()
        target.order(ByteOrder.LITTLE_ENDIAN)
        for (word in words) target.putShort(word.toShort())
        target.flip()
        return target
    }

    /** The holds of each of a packet's three scenes, as the lower and as the upper side of a pair. */
    class PacketScenes(private val scenes: List<Scene>) {
        init {
            require(scenes.size == 6)
        }

        fun scene(slot: Int, upper: Boolean): Scene = scenes[slot * 2 + if (upper) 1 else 0]

        companion object {
            /** Decoded once per packet from its descriptor bytes ([descriptors] at offset 0), scene by scene. */
            fun decode(descriptors: ByteBuffer, header: PacketHeader): PacketScenes =
                PacketScenes(
                    header.scenes.flatMap { scene ->
                        val part = descriptors.duplicate()
                        part.position(scene.offset)
                        part.limit(scene.offset + scene.bytes)
                        val slice = part.slice()
                        listOf(false, true).map { upper ->
                            Scene(holds(slice, scene.count, upper, header.width.toFloat(), header.height.toFloat()))
                        }
                    },
                )
        }
    }
}
