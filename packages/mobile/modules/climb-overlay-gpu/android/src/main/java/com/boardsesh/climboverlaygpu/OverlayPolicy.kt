package com.boardsesh.climboverlaygpu

import kotlin.math.abs
import kotlin.math.max
import java.util.concurrent.atomic.AtomicBoolean

internal class OverlayWorkCancelled : RuntimeException()

/** The arena changed under an off-thread encode, so its descriptors may name the wrong ranges. */
internal class OverlayArenaMoved : RuntimeException()

internal class AtlasFrameFailure(val reasonCode: String) : IllegalArgumentException(reasonCode)

internal class OverlayResourceFailure : IllegalArgumentException("gpu-resource-limit")

/** A GPU feature or pipeline this phone lacks: it fails the same way every time. */
internal class OverlayUnsupportedFailure(val reasonCode: String) : IllegalStateException(reasonCode)

internal object OverlayLifecycle {
    fun beginPreparation(current: () -> Boolean, initialize: () -> Unit, surface: () -> Unit): Boolean {
        if (!current()) return false
        initialize()
        surface()
        return current()
    }

    /** Off-thread encodes a preparation tries before running on the render thread, where the arena cannot move. */
    const val OFF_THREAD_ATTEMPTS = 2

    fun preparesInline(attempt: Int): Boolean = attempt >= OFF_THREAD_ATTEMPTS

    /**
     * A swap-mode trio change with the same geometry keeps the packet on screen
     * drawing the running swap until its replacement is uploaded. The editor, the
     * wipe and a first presentation release it before preparing, as before.
     */
    fun carriesPacket(onScreen: OverlayRequest?, next: OverlayRequest, swap: Boolean): Boolean =
        swap && onScreen != null && !onScreen.animateEdits && !next.animateEdits && onScreen.sameGeometry(next)

    /**
     * Chunk residency is what a worker encoded against when every key still has
     * the handle it was lent: resident keys the same open handle, missing keys none.
     */
    fun residencyUnchanged(lent: Map<String, Long>, keys: Collection<String>, live: (String) -> Long?): Boolean =
        keys.all { live(it) == lent[it] }

    fun retainGeometry(frameFailure: Boolean, cancelled: Boolean, sameGeometry: Boolean): Boolean =
        frameFailure || (cancelled && sameGeometry)

    /**
     * Reason and scope for the JS fallback. Only "static" is remembered across
     * launches, so it is reserved for failures that repeat for this binary, phone
     * and config. GL errors, fence waits and surface loss retry on the next frames.
     */
    fun failureEvent(failure: Exception, resourceExhausted: Boolean): Pair<String, String> = when {
        failure is PacketFailure -> failure.reason to failure.scope
        failure is AtlasFrameFailure -> failure.reasonCode to "frame"
        failure is OverlayUnsupportedFailure -> failure.reasonCode to "static"
        failure is OverlayResourceFailure || resourceExhausted -> "gpu-resource-limit" to "context"
        else -> "gpu-preparation-failed" to "context"
    }

    /**
     * Memory callbacks arrive while a climb is on screen. Shared GPU residency is
     * released only when no overlay presents from it, and nothing escapes onto
     * the render thread: a failed release is handled as a lost context.
     */
    fun trim(presenting: Boolean, release: () -> Unit, recover: (Exception) -> Unit): Boolean {
        if (presenting) return false
        try {
            release()
            return true
        } catch (failure: Exception) {
            try {
                recover(failure)
            } catch (_: Exception) {
                // The next preparation initializes a fresh context.
            }
            return false
        }
    }
}

/** Coalesces recovery with queued work without losing a reset during preparation. */
internal class OverlayPreparationQueue {
    private val preparing = AtomicBoolean(false)
    private val recovery = AtomicBoolean(false)
    val needsRecovery get() = recovery.get()
    fun begin(): Boolean = preparing.compareAndSet(false, true)
    fun started() { recovery.set(false) }
    fun requestRecovery() { recovery.set(true) }
    fun finish(newerRequest: Boolean): Boolean {
        preparing.set(false)
        return newerRequest || recovery.get()
    }
}

/** One transparent context recovery per logical request; failed retries terminate. */
internal class ContextRecoveryGate {
    private var attempted: Pair<Long, Long>? = null

    fun retry(revision: Long, generation: Long): Boolean {
        val request = revision to generation
        if (attempted == request) return false
        attempted = request
        return true
    }
}

/** Platform-independent contracts, mirrored by the iOS motion tests. */
internal object OverlayPolicy {
    const val ATLAS_LIMIT = OverlayPacketLayout.MAX_GPU_BYTES
    // Separate owned pixels avoid the payload-sized final packing copy.
    // Allow atlas growth, EDT/masks and GPU upload; not a peak-RSS claim.
    const val PREPARE_HEADROOM = 3L * ATLAS_LIMIT + 64L * 1024 * 1024
    const val EDIT_DURATION_NS = OverlayPacketLayout.EDIT_DURATION_NS
    const val EDIT_PEAK_NS = OverlayPacketLayout.EDIT_PEAK_NS
    val EDIT_PEAK_REACH = OverlayPacketLayout.EDIT_PEAK_REACH
    val REVEAL_BAND = OverlayPacketLayout.REVEAL_BAND
    const val REVEAL_MODE_WIPE = OverlayPacketLayout.REVEAL_MODE_WIPE
    const val REVEAL_MODE_SWAP = OverlayPacketLayout.REVEAL_MODE_SWAP
    const val MAX_ACTIVE = 128
    const val MAX_PENDING = 2

    /** Bits follow fill, plate, glyph and annotation shader-layer order. */
    fun stampLayers(annotation: Boolean, offsets: IntArray, extraOffsets: IntArray): Int {
        require(offsets.size == 3 && extraOffsets.size == 4)
        val glyph = offsets[2] != -1 || extraOffsets[3] != -1
        if (annotation) return if (glyph) 8 else 0
        val fill = offsets[0] != -1 || (0..2).any { extraOffsets[it] != -1 }
        return (if (fill) 1 else 0) or (if (offsets[1] != -1) 2 else 0) or (if (glyph) 4 else 0)
    }

    fun selectStampLayers(lower: Int, upper: Int, progress: Float): Int {
        if (progress <= 0f) return lower
        if (progress >= 1f) return upper
        return lower or upper
    }

    fun canSubmit(ledgerCount: Int, fenceCount: Int) =
        ledgerCount < MAX_PENDING && fenceCount < MAX_PENDING

    fun animationFrameDue(previous: Long, current: Long): Boolean =
        previous == 0L || current - previous >= 15_666_667L

    fun comparisonHeadroom(width: Int, height: Int): Long {
        require(width in 1..1536 && height in 1..2304)
        // FBO, readback, row-flipped bytes, JNI/reference copies and PNG bitmap.
        return width.toLong() * height * 4 * 8 + 64L * 1024 * 1024
    }

    data class Selection(val lower: Int, val upper: Int, val progress: Float)

    fun select(
        position: Double,
        center: Double,
        previous: Boolean,
        next: Boolean,
        reduced: Boolean,
    ): Selection {
        if (reduced || !position.isFinite() || !center.isFinite()) return Selection(0, 0, 0f)
        val delta = (position - center).coerceIn(-1.0, 1.0)
        if (delta < 0 && previous) return Selection(-1, 0, (1 + delta).toFloat())
        if (delta > 0 && next) return Selection(0, 1, delta.toFloat())
        return Selection(0, 0, 0f)
    }

    /** The app names the reveal; the generated contract numbers it. */
    fun revealMode(name: String?): Int = if (name == "swap") REVEAL_MODE_SWAP else REVEAL_MODE_WIPE

    /** Scene slot for a page offset from the centre: 0 current, 1 previous, 2 next. */
    fun slot(offset: Int): Int = if (offset == -1) 1 else if (offset == 1) 2 else 0

    /** The wall swap's lower and upper class weights. */
    data class SwapWeights(val lower: Float, val upper: Float)

    private val STILL = SwapWeights(1f, 0f)

    /**
     * In swap mode the app's page position names a pair, not a progress: the
     * nearest page is the climb being left, and the side it leans to is the
     * arriving one. The timing lives in the app; only two weights arrive here.
     * A pair beyond the prepared neighbours shows the nearest prepared climb on
     * its own, so a lagging scene can never light a third climb.
     */
    fun selectSwap(
        position: Double,
        center: Double,
        previous: Boolean,
        next: Boolean,
        outgoing: Float,
        incoming: Float,
    ): Pair<Selection, SwapWeights> {
        if (!position.isFinite() || !center.isFinite()) return Selection(0, 0, 0f) to STILL
        val delta = position - center
        if (abs(delta) > 1) {
            val edge = if (delta > 0) (if (next) 1 else 0) else (if (previous) -1 else 0)
            return Selection(edge, edge, 0f) to STILL
        }
        val selection = select(position, center, previous, next, false)
        if (selection.lower == selection.upper) return selection to STILL
        val leaving = if (outgoing.isFinite()) outgoing.coerceIn(0f, 1f) else 1f
        val arriving = if (incoming.isFinite()) incoming.coerceIn(0f, 1f) else 0f
        // Progress below one half: the lower page is the nearer one, so it is outgoing.
        return selection to
            if (selection.progress < .5f) SwapWeights(leaving, arriving) else SwapWeights(arriving, leaving)
    }

    /**
     * While the next trio prepares, the packet on screen keeps drawing the
     * running swap if it holds every climb the frame shows: then the frame is the
     * one the new packet will draw, and the hand-over changes nothing. Null
     * means hold the last frame instead of showing a different climb.
     */
    fun carryOverSwap(
        position: Double,
        center: Double,
        previous: Boolean,
        next: Boolean,
        outgoing: Float,
        incoming: Float,
    ): Pair<Selection, SwapWeights>? {
        if (!position.isFinite() || !center.isFinite() || abs(position - center) > 1) return null
        val carried = selectSwap(position, center, previous, next, outgoing, incoming)
        return if (position == center || carried.first.lower != carried.first.upper) carried else null
    }

    fun reach(elapsed: Long): Float {
        if (elapsed < 0 || elapsed >= EDIT_DURATION_NS) return 1f
        val phase =
            if (elapsed <= EDIT_PEAK_NS) elapsed.toFloat() / EDIT_PEAK_NS
            else (EDIT_DURATION_NS - elapsed).toFloat() / (EDIT_DURATION_NS - EDIT_PEAK_NS)
        return 1 + (EDIT_PEAK_REACH - 1) * phase * phase * (3 - 2 * phase)
    }

    fun reveal(progress: Float, center: Float, mirrored: Boolean): Float {
        if (progress <= 0) return 0f
        if (progress >= 1) return 1f
        val screen = if (mirrored) 1 - center else center
        val half = REVEAL_BAND * .5f
        val boundary = 1 + half - progress * (1 + 2 * half)
        val phase = ((screen - boundary + half) / REVEAL_BAND).coerceIn(0f, 1f)
        return phase * phase * (3 - 2 * phase)
    }

    fun weight(reveal: Float, membership: Int, upper: Boolean): Float =
        when (membership) {
            1 -> if (upper) 0f else 1f
            2 -> if (upper) max(2 * reveal - 1, 0f) else max(1 - 2 * reveal, 0f)
            else -> if (upper) reveal else 1 - reveal
        }
}

/** Pure pending-frame ledger. A skipped earlier buffer cannot block readiness. */
internal class PresentationLedger {
    enum class ConsumptionWait {
        NONE,
        RETRY,
        TIMED_OUT,
    }

    data class Frame(
        val timestamp: Long,
        val revision: Long,
        val generation: Long,
        var complete: Boolean = false,
        var consumed: Boolean = false,
    )

    private val frames = ArrayList<Frame>()
    private var lastTimestamp = 0L
    val size
        get() = frames.size

    fun submit(now: Long, revision: Long, generation: Long): Frame? {
        if (frames.size >= OverlayPolicy.MAX_PENDING) return null
        val frame = Frame(max(now, lastTimestamp + 1), revision, generation)
        lastTimestamp = frame.timestamp
        frames.add(frame)
        return frame
    }

    fun consume(timestamp: Long): Frame? {
        val frame = frames.find { it.timestamp == timestamp } ?: return null
        frame.consumed = true
        // SurfaceTexture may skip obsolete images. Their GL resources are
        // released separately by the render thread after completion.
        frames.removeAll { it.timestamp < timestamp }
        return frame
    }

    fun finish(timestamp: Long): Frame? =
        frames.find { it.timestamp == timestamp }?.also { it.complete = true }

    fun accept(frame: Frame, revision: Long, generation: Long): Boolean {
        if (!frame.complete || !frame.consumed) return false
        frames.remove(frame)
        return frame.revision == revision && frame.generation == generation
    }

    fun consumptionWait(now: Long, revision: Long, generation: Long): ConsumptionWait {
        val oldest =
            frames.firstOrNull {
                it.revision == revision && it.generation == generation && !it.consumed
            } ?: return ConsumptionWait.NONE
        return if (now - oldest.timestamp >= 2_000_000_000L) ConsumptionWait.TIMED_OUT
        else ConsumptionWait.RETRY
    }

    fun clear() {
        frames.clear()
    }
}

/** Aggregate residency; pinned entries cannot be evicted to hide excess use. */
internal class AtlasBudget {
    var bytes = 0L
        private set

    fun reserve(amount: Int) {
        if (amount <= 0 || bytes + amount > OverlayPolicy.ATLAS_LIMIT) throw OverlayResourceFailure()
        bytes += amount
    }

    fun release(amount: Int) {
        check(amount > 0 && amount <= bytes)
        bytes -= amount
    }
}
