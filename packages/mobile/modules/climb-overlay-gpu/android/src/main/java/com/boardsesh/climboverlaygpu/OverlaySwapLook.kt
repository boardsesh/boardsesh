package com.boardsesh.climboverlaygpu

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.floor
import kotlin.math.pow

/**
 * The swap look (`swapLookVersion` 2), ported from iOS's
 * `ClimbOverlaySwapLook.swift`: how the wall swap's two side weights become,
 * for each hold, a mark weight, a glow weight and a glow reach. Without a look
 * the renderer draws with the base program (API 7's `reveal_weight`) and none
 * of this runs.
 *
 * The app keeps sending one weight per side from the wall-swap state machine,
 * so re-flicks, reversals and cancels stay in JS. Here a side's weight W turns
 * into a per-hold weight through a front: every hold has a key in 0..1 and
 * changes over its own window of the side's progress. W = 1, W = floor and
 * W = 0 give the same weight for every key, so the app can relabel a pair, or
 * restart a skipped climb at the floor, without a jump.
 *
 * Rust writes the 144-byte uniforms, so this runs on the render thread once per
 * frame for at most 2 × 128 holds and is bound as the look program's own
 * uniform block: the shader reads one hold's four 16-bit numbers per candidate
 * instead of re-deriving them per pixel, and no Rust or contract change is
 * needed. The buffer's bytes are exactly the ones iOS binds at Metal fragment
 * buffer 5. A frame allocates nothing: the words go into the renderer's one
 * [Frame], and each packet's holds were decoded into plain arrays when the
 * packet was encoded ([PacketScenes]).
 *
 * Every number is a 32-bit float, and [larger]/[smaller] keep Swift's
 * `max`/`min`, so both platforms quantise the same frame to the same words.
 * One known gap: Kotlin's `Float.pow` rounds a double result, and Swift's
 * `powf` is one float step away from it for about 0.7% of inputs; through H's
 * focus that moves a hold's 16-bit reach word by one (1/32768) about 5 times in
 * 2 million sampled inputs. Every other word matches (the shared fixture).
 */
internal object OverlaySwapLook {
    /** Advertised as the module constant `swapLookVersion`, the same protocol as iOS; the renderer builds the program lazily. */
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

    /** The most 16-bit words one frame writes: the header and two full climbs, four per hold (1,028). */
    const val MAX_WORDS = 4 * (1 + 2 * OverlayPacketLayout.MAX_ACTIVE_PER_SOURCE)

    /** The atlas pads every field for this reach (`EDIT_PEAK_REACH`); a halo past it would clip. */
    val MAX_REACH: Float = OverlayPacketLayout.EDIT_PEAK_REACH
    const val MIN_REACH = 0.6f

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

    /**
     * One climb's holds as one side of a pair reads them, as plain arrays (iOS
     * keeps a `[Hold]`): index i is the climb's i-th hold descriptor. The lower
     * and upper side of a scene share every array but [membership].
     */
    class Scene(
        /** Each hold's centre across the board, 0 left to 1 right, before any display mirror. */
        val centerX: FloatArray,
        /** Each hold's centre down the board, 0 top to 1 bottom. */
        val centerY: FloatArray,
        /** This side's role number: 0 lit only in this climb, 1 the same role in both, 2 a changed role. */
        val membership: IntArray,
        /** 0 until 1 from the physical hold id, the same on both sides ([entropy]). */
        val entropy: FloatArray,
        val annotation: BooleanArray,
    ) {
        val size: Int = centerX.size

        /** The vertical extent of the climb's lit (non-annotation) holds; 0 and 1 without any. */
        val top: Float
        val bottom: Float

        init {
            require(centerY.size == size && membership.size == size && entropy.size == size && annotation.size == size)
            var highest = Float.POSITIVE_INFINITY
            var lowest = Float.NEGATIVE_INFINITY
            for (index in 0 until size) {
                if (annotation[index]) continue
                highest = minOf(highest, centerY[index])
                lowest = maxOf(lowest, centerY[index])
            }
            top = if (highest.isInfinite()) 0f else highest
            bottom = if (lowest.isInfinite()) 1f else lowest
        }

        companion object {
            val EMPTY = Scene(FloatArray(0), FloatArray(0), IntArray(0), FloatArray(0), BooleanArray(0))
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

    /** An arrival code's climb is arriving, from either edge (iOS `Side.arriving`). */
    fun arriving(code: Int): Boolean = (code and 3).let { it == 1 || it == 2 }

    /** A flick run's arrival: no swell. Only an arriving climb is calm (iOS `Side.calm`). */
    fun calm(code: Int): Boolean = arriving(code) && (code and 4) != 0

    /**
     * The edge a side's front starts from (true: the right, before any display
     * mirror). An arriving climb keeps its own entry edge whichever slot it now
     * sits in, so a climb skipped mid-front by a quick re-flick, which moves from
     * the upper to the lower slot, keeps its front's side. A leaving climb keys
     * from its slot's edge: the lower page from the left, the upper from the right.
     */
    fun fromRight(code: Int, upper: Boolean): Boolean =
        when (code and 3) {
            1 -> true
            2 -> false
            else -> upper
        }

    /**
     * The arrival code of the lower or [upper] page: the lower page is the
     * outgoing one while the pair's progress is below one half, as
     * [OverlayPolicy.selectSwap] maps weights (iOS `sides(progress:)`).
     */
    fun pageCode(progress: Float, arrivals: Arrivals, upper: Boolean): Int =
        if ((progress < 0.5f) != upper) arrivals.outgoing else arrivals.incoming

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
     * Reads [count] hold descriptors ([OverlayPacketLayout.DESCRIPTOR_BYTES] each)
     * from [descriptors]' position: the climb as the lower side of a pair, then as
     * the upper side (each side reads its own membership number, as the shader
     * does). Null when the buffer is short or the size is not positive, so a
     * packet the look cannot read never draws it.
     */
    fun scenes(descriptors: ByteBuffer, count: Int, width: Float, height: Float): List<Scene>? {
        if (count == 0) return listOf(Scene.EMPTY, Scene.EMPTY)
        val stride = OverlayPacketLayout.DESCRIPTOR_BYTES
        if (count < 0 || !(width > 0) || !(height > 0) || descriptors.remaining() < count * stride) return null
        val bytes = descriptors.duplicate().order(ByteOrder.LITTLE_ENDIAN)
        val start = bytes.position()
        val bounds = OverlayPacketLayout.DESCRIPTOR_OFFSETS_BOUNDS
        val numbers = OverlayPacketLayout.DESCRIPTOR_OFFSETS_NUMBERS
        val identity = OverlayPacketLayout.DESCRIPTOR_OFFSETS_IDENTITY
        val centerX = FloatArray(count)
        val centerY = FloatArray(count)
        val lowerMembership = IntArray(count)
        val upperMembership = IntArray(count)
        val entropy = FloatArray(count)
        val annotation = BooleanArray(count)
        fun role(number: Float): Int = if (number == 1f) 1 else if (number == 2f) 2 else 0
        for (index in 0 until count) {
            val base = start + index * stride
            centerX[index] = clampUnit((bytes.getFloat(base + bounds) + bytes.getFloat(base + bounds + 8)) * 0.5f / width)
            centerY[index] = clampUnit((bytes.getFloat(base + bounds + 4) + bytes.getFloat(base + bounds + 12)) * 0.5f / height)
            upperMembership[index] = role(bytes.getFloat(base + numbers + 8))
            lowerMembership[index] = role(bytes.getFloat(base + numbers + 12))
            entropy[index] = entropy(bytes.getInt(base + identity))
            annotation[index] = bytes.getInt(base + identity + 8) != 0
        }
        return listOf(
            Scene(centerX, centerY, lowerMembership, entropy, annotation),
            Scene(centerX, centerY, upperMembership, entropy, annotation),
        )
    }

    /**
     * The order key of [scene]'s hold [index] as the lower or [upper] side with
     * arrival [code], 0 acts first as a side's weight rises (and last as it
     * falls). Sideways: 0 at the edge this side's climb enters from ([fromRight]),
     * swapped by a display mirror, so a relabelled pair replays the same front
     * backwards. An arriving climb under `climbUp`: 0 at the lowest lit hold of
     * [extent], the climb that side shows, 1 at its highest.
     */
    fun key(scene: Scene, index: Int, upper: Boolean, code: Int, look: Look, mirrored: Boolean, extent: Scene = scene): Float {
        var key: Float
        if (arriving(code) && look.climbUp) {
            val span = extent.bottom - extent.top
            key = if (span > 1e-4f) (extent.bottom - scene.centerY[index]) / span else 0f
        } else {
            val across = if (mirrored) 1 - scene.centerX[index] else scene.centerX[index]
            key = if (fromRight(code, upper)) 1 - across else across
        }
        key = clampUnit(key)
        return key + (scene.entropy[index] - key) * look.jitter
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

    /** An arriving climb with ghosts: glow only up to the arrival floor, then the mark fills in as the glow finishes. */
    private fun ghosted(arriving: Boolean, look: Look): Boolean = arriving && look.ghost > 0 && look.arrivalFloor > 0

    /** The mark weight of a hold at per-hold weight [weight] (iOS `shaped(...).mark`); 0 for a hidden hold. */
    fun mark(weight: Float, arriving: Boolean, look: Look): Float {
        if (!(weight > 0)) return 0f
        val filled =
            if (!ghosted(arriving, look)) weight
            else if (weight <= look.arrivalFloor) 0f
            else (weight - look.arrivalFloor) / (1 - look.arrivalFloor)
        return filled * (1 + (weight - 1) * look.markLag)
    }

    /** The glow weight of a hold at per-hold weight [weight] (iOS `shaped(...).glow`); 0 for a hidden hold. */
    fun glow(weight: Float, arriving: Boolean, look: Look): Float {
        if (!(weight > 0)) return 0f
        if (!ghosted(arriving, look)) return weight
        if (weight <= look.arrivalFloor) return weight * look.ghost / look.arrivalFloor
        val filled = (weight - look.arrivalFloor) / (1 - look.arrivalFloor)
        return look.ghost + (1 - look.ghost) * filled
    }

    /**
     * The glow reach of a hold at per-hold weight [weight] (iOS `shaped(...).reach`
     * with reach allowed): an arriving hold focuses in and swells unless [calm], a
     * leaving one tightens. 1 for a hidden hold.
     */
    fun reach(weight: Float, key: Float, arriving: Boolean, calm: Boolean, look: Look): Float {
        if (!(weight > 0)) return 1f
        val missing = 1 - weight
        val base = if (arriving) 1 + look.focus * missing.pow(look.focusShape) else 1 - look.tighten * missing
        val grown = if (arriving && !calm) base * (1 + swell(weight, key, look)) else base
        return smaller(MAX_REACH, larger(MIN_REACH, grown))
    }

    /** 0..1 in 1/65535 steps, rounded half away from zero as Swift's `rounded()`. */
    fun unorm16(value: Float): Int = Math.round(clampUnit(value) * 65535)

    /** Reach in 1/32768 steps, so 1 decodes exactly; rounded down, so [MAX_REACH] never decodes past the padding. */
    fun reach16(value: Float): Int = floor(smaller(MAX_REACH, larger(0f, value)) * 32768).toInt()

    /**
     * One frame's look block as 16-bit words, kept from frame to frame: the
     * renderer owns one, so a frame allocates nothing. [encode] writes the
     * header, then every lower hold, then every upper hold, in the shader's union
     * order, and returns the word count.
     */
    class Frame {
        val words = IntArray(MAX_WORDS)

        // The pair being encoded: set by encode, read by hold.
        private var lower = Scene.EMPTY
        private var upper = Scene.EMPTY
        private var lowerWeight = 0f
        private var lowerCode = 0
        private var upperWeight = 0f
        private var upperCode = 0
        private var sharedFloor = 0f
        private var look = Look()
        private var mirrored = false
        private var allowReach = true

        /**
         * Mark and glow are 0..1 in 1/65535 steps, reach is in 1/32768 steps. Each
         * side is its weight and its arrival code ([Arrivals]); [allowReach] false
         * pins every reach at 1 (Battery Saver, a hot phone).
         */
        fun encode(
            lower: Scene,
            upper: Scene,
            lowerWeight: Float,
            lowerCode: Int,
            upperWeight: Float,
            upperCode: Int,
            sharedFloor: Float,
            look: Look,
            mirrored: Boolean,
            allowReach: Boolean,
        ): Int {
            val count = 4 * (1 + lower.size + upper.size)
            require(count <= words.size) { "A swap look pair has at most ${OverlayPacketLayout.MAX_ACTIVE_PER_SOURCE} holds a side" }
            this.lower = lower
            this.upper = upper
            this.lowerWeight = lowerWeight
            this.lowerCode = lowerCode
            this.upperWeight = upperWeight
            this.upperCode = upperCode
            this.sharedFloor = sharedFloor
            this.look = look
            this.mirrored = mirrored
            this.allowReach = allowReach
            words[0] = 1
            words[1] = 0
            words[2] = 0
            words[3] = 0
            for (index in 0 until lower.size) hold(lower, index, false, 1 + index)
            for (index in 0 until upper.size) hold(upper, index, true, 1 + lower.size + index)
            return count
        }

        private fun write(slot: Int, mark: Float, glow: Float, reach: Float) {
            words[4 * slot] = unorm16(mark)
            words[4 * slot + 1] = unorm16(glow)
            words[4 * slot + 2] = reach16(reach)
            words[4 * slot + 3] = 0
        }

        /**
         * One hold of the union (iOS `shape`). A shared same-role hold is drawn
         * once, on the lower side, at the brighter of the two sides' fronts at its
         * spot, never below the shared floor. A changed hold shows only its
         * stronger role, compared at its own spot (the lower one on a tie), as API
         * 7 does with the side weights.
         */
        private fun hold(scene: Scene, index: Int, upper: Boolean, slot: Int) {
            val ownCode = if (upper) upperCode else lowerCode
            val ownArriving = arriving(ownCode)
            val ownKey = key(scene, index, upper, ownCode, look, mirrored)
            val ownWeight = lit(if (upper) upperWeight else lowerWeight, ownKey, ownArriving, look)
            val membership = scene.membership[index]
            if (membership == 1) {
                if (upper) return write(slot, 0f, 0f, 1f)
                val otherKey = key(scene, index, true, upperCode, look, mirrored, extent = this.upper)
                val otherWeight = lit(upperWeight, otherKey, arriving(upperCode), look)
                val weight = larger(clampUnit(sharedFloor), larger(ownWeight, otherWeight))
                return if (weight > 0) write(slot, weight, weight, 1f) else write(slot, 0f, 0f, 1f)
            }
            if (membership == 2) {
                val otherCode = if (upper) lowerCode else upperCode
                val otherKey = key(scene, index, !upper, otherCode, look, mirrored, extent = if (upper) this.lower else this.upper)
                val otherWeight = lit(if (upper) lowerWeight else upperWeight, otherKey, arriving(otherCode), look)
                if (if (upper) ownWeight <= otherWeight else ownWeight < otherWeight) return write(slot, 0f, 0f, 1f)
            }
            write(
                slot,
                mark(ownWeight, ownArriving, look),
                glow(ownWeight, ownArriving, look),
                if (allowReach) reach(ownWeight, ownKey, ownArriving, calm(ownCode), look) else 1f,
            )
        }
    }

    /**
     * Writes this frame's look block into [out] and returns its word count, or 0
     * when the frame draws without the look (the base program, API 7's swap): no
     * look, the wipe, a single climb on show, a scene the look did not read whole,
     * or Reduce Motion, which turns the look off here whatever the app sends.
     * Battery Saver and a hot phone keep it on with glow reach pinned at 1. iOS:
     * `ClimbOverlayGPUView.swapLookWords`.
     */
    fun frame(
        controls: OverlayControls,
        selection: OverlayPolicy.Selection,
        weights: OverlayPolicy.SwapWeights,
        scenes: PacketScenes,
        header: PacketHeader,
        out: Frame,
    ): Int {
        val look = controls.look ?: return 0
        if (
            controls.revealMode != OverlayPolicy.REVEAL_MODE_SWAP ||
                controls.reduced ||
                selection.lower == selection.upper ||
                !scenes.decoded
        ) {
            return 0
        }
        val lowerSlot = OverlayPolicy.slot(selection.lower)
        val upperSlot = OverlayPolicy.slot(selection.upper)
        val lower = scenes.scene(lowerSlot, upper = false)
        val upper = scenes.scene(upperSlot, upper = true)
        // The look program reads one entry for every hold the packet draws: a scene
        // not read whole draws API 7's swap rather than read past the look.
        if (!whole(lower, header, lowerSlot) || !whole(upper, header, upperSlot)) return 0
        return out.encode(
            lower = lower,
            upper = upper,
            lowerWeight = weights.lower,
            lowerCode = pageCode(selection.progress, controls.arrivals, upper = false),
            upperWeight = weights.upper,
            upperCode = pageCode(selection.progress, controls.arrivals, upper = true),
            sharedFloor = controls.sharedFloor ?: weights.shared,
            look = look,
            mirrored = controls.mirrored,
            allowReach = reachOffReason(controls.lowPower, controls.hot) == null,
        )
    }

    /** [scene] holds every hold the packet's [slot] draws. */
    private fun whole(scene: Scene, header: PacketHeader, slot: Int): Boolean =
        slot < header.scenes.size && header.scenes[slot].count == scene.size

    /** Why the look draws nothing: this renderer has no look program (its build failed on this phone). */
    const val SHADER_UNAVAILABLE = "look shader unavailable"

    /**
     * Why the look is not drawing, or null when it can: the `reason` of an
     * `onSwapLookState` "off" event, worded as iOS words it, plus
     * [SHADER_UNAVAILABLE], which only Android has.
     */
    fun offReason(look: Look?, rejected: Boolean, revealMode: Int, reduced: Boolean, shaderMissing: Boolean = false): String? =
        when {
            look == null -> if (rejected) "look rejected" else "no look prop"
            shaderMissing -> SHADER_UNAVAILABLE
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

    /** The first [count] of [words] as the bytes iOS binds: little-endian 16-bit words, into [target] from its start. */
    fun bytes(words: IntArray, count: Int, target: ByteBuffer): ByteBuffer {
        require(count % 4 == 0 && count <= words.size && count * 2 <= target.capacity())
        target.clear()
        target.order(ByteOrder.LITTLE_ENDIAN)
        for (index in 0 until count) target.putShort(words[index].toShort())
        target.flip()
        return target
    }

    /**
     * The holds of each of a packet's three scenes, as the lower and as the upper
     * side of a pair. Decoded where the packet is encoded (the preparer thread, or
     * the render thread when a preparation runs inline after two tries). Retained
     * for every packet so enabling the look needs no re-prepare. [decoded] false
     * draws every frame without it.
     */
    class PacketScenes(private val scenes: List<Scene>, val decoded: Boolean = true) {
        init {
            require(scenes.size == 6)
        }

        fun scene(slot: Int, upper: Boolean): Scene = scenes[slot * 2 + if (upper) 1 else 0]

        companion object {
            /** A packet the look does not read: every scene empty, and [decoded] false. */
            val NONE = PacketScenes(List(6) { Scene.EMPTY }, decoded = false)

            /** From a packet's descriptor bytes ([descriptors] at offset 0), scene by scene; [NONE] if any scene is short. */
            fun decode(descriptors: ByteBuffer, header: PacketHeader): PacketScenes {
                if (header.scenes.size != 3) return NONE
                val sides = ArrayList<Scene>(6)
                for (scene in header.scenes) {
                    if (scene.offset < 0 || scene.bytes < 0 || scene.offset + scene.bytes > descriptors.limit()) return NONE
                    val part = descriptors.duplicate()
                    part.position(scene.offset)
                    part.limit(scene.offset + scene.bytes)
                    sides += OverlaySwapLook.scenes(part.slice(), scene.count, header.width.toFloat(), header.height.toFloat())
                        ?: return NONE
                }
                return PacketScenes(sides)
            }
        }
    }
}
