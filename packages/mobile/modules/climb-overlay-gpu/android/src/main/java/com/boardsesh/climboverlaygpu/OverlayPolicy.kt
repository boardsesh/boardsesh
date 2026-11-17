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

    enum class EncodeFailure {
        /** The request's token was cancelled: drop the work quietly. */
        WITHDRAW,
        /** The loan went stale under the encode: encode again, inline once the attempts run out. */
        RETRY,
        /** The carried packet's pins left no room: release it, then encode again. */
        RELEASE_CARRIED,
        FAIL_RESOURCE,
        /** A handle closed although the arena did not move and nothing cancelled: fail visibly, never hang. */
        FAIL_CLOSED,
        FAIL,
    }

    /**
     * Why an encode failed, for a request still current. Rust maps a closed
     * handle and a cancelled token to the same status, so the token decides:
     * a cancelled token always withdraws, even when the arena also moved. A
     * failure against a moved arena is a stale loan and retries. An inline
     * encode never retries: nothing can move the arena under it, so a second
     * failure there is real and the bound holds even if that ever changes.
     */
    fun encodeFailure(
        tokenCancelled: Boolean,
        inline: Boolean,
        outOfMemory: Boolean,
        cancelledStatus: Boolean,
        moved: Boolean,
        resourceFailure: Boolean,
        carrying: Boolean,
    ): EncodeFailure = when {
        tokenCancelled -> EncodeFailure.WITHDRAW
        outOfMemory -> EncodeFailure.FAIL_RESOURCE
        !inline && (moved || cancelledStatus) -> EncodeFailure.RETRY
        cancelledStatus -> EncodeFailure.FAIL_CLOSED
        resourceFailure && carrying -> EncodeFailure.RELEASE_CARRIED
        else -> EncodeFailure.FAIL
    }

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

    /**
     * The wall swap's lower and upper class weights, and the weight of holds lit
     * with the same role in both (1 keeps them whole, as API 6 drew them).
     */
    data class SwapWeights(val lower: Float, val upper: Float, val shared: Float = 1f)

    private val STILL = SwapWeights(1f, 0f)

    /**
     * In swap mode the app's page position names a pair, not a progress: the
     * nearest page is the climb being left, and the side it leans to is the
     * arriving one. The timing lives in the app; only the weights arrive here.
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
        shared: Float = 1f,
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
        val both = if (shared.isFinite()) shared.coerceIn(0f, 1f) else 1f
        // Progress below one half: the lower page is the nearer one, so it is outgoing.
        // Shared holds are the same either way round.
        return selection to
            if (selection.progress < .5f) SwapWeights(leaving, arriving, both)
            else SwapWeights(arriving, leaving, both)
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
        shared: Float = 1f,
    ): Pair<Selection, SwapWeights>? {
        if (!position.isFinite() || !center.isFinite() || abs(position - center) > 1) return null
        val carried = selectSwap(position, center, previous, next, outgoing, incoming, shared)
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

/**
 * What the render thread does about pending frames, by who drew them. TextureView's
 * update listener runs before HWUI latches the buffer, so its timestamp is usually
 * the previous frame's; a delayed re-read is what drains the ledger once frames stop.
 * A carried frame (the old request still drawing the swap while the next trio
 * prepares) is re-read too, but it can never report ready or fail the board.
 */
internal object OverlayConsumption {
    enum class Presenter {
        /** The view's current request: it reports ready and fails the board. */
        CURRENT,
        /** The old request drawing the running swap until its replacement installs. */
        CARRIED,
        /** Neither: superseded, hidden or destroyed. Nothing is observed. */
        NONE,
    }

    enum class Observation {
        NONE,
        /** Re-read the texture timestamp shortly; the frame may be latched already. */
        OBSERVE,
        /** The current request's frame was never consumed: fail the board. */
        FAIL,
        /** A carried frame was never consumed: let the carried packet go, report nothing. */
        STOP_CARRY,
    }

    enum class Accepted {
        /** The frame left the ledger; nothing more to do. */
        DROPPED,
        /** A carried frame left the ledger: draw the next one, never report it. */
        RESUME,
        /** A current frame was presented: report ready once, then draw on. */
        PRESENTED,
    }

    fun presenter(eligible: Boolean, carrying: Boolean): Presenter =
        if (eligible) Presenter.CURRENT else if (carrying) Presenter.CARRIED else Presenter.NONE

    fun observation(presenter: Presenter, wait: PresentationLedger.ConsumptionWait): Observation =
        when {
            presenter == Presenter.NONE || wait == PresentationLedger.ConsumptionWait.NONE -> Observation.NONE
            wait == PresentationLedger.ConsumptionWait.RETRY -> Observation.OBSERVE
            presenter == Presenter.CURRENT -> Observation.FAIL
            else -> Observation.STOP_CARRY
        }

    /** [left] is whether the ledger released the frame as one of the presenting request's. */
    fun accepted(presenter: Presenter, left: Boolean): Accepted =
        when {
            !left || presenter == Presenter.NONE -> Accepted.DROPPED
            presenter == Presenter.CARRIED -> Accepted.RESUME
            else -> Accepted.PRESENTED
        }

    /**
     * A carry arms its re-read itself, when it starts and whenever a draw is
     * refused for a full ledger: no later frame will arrive to do it. The current
     * request keeps arming it from fence completion and update callbacks, as before.
     */
    fun armsOwnObservation(presenter: Presenter): Boolean = presenter == Presenter.CARRIED

    /** The view's delayed re-read still applies: the current request, or a carry the view still allows. */
    fun observationCurrent(matches: Boolean, carried: Boolean, matchesGeometry: Boolean): Boolean =
        matches || (carried && matchesGeometry)

    /**
     * The view holds one pending re-read. A new one takes the slot when it is
     * empty, or when the pending one is a carry's and the new one is the current
     * request's (or a later carry's): a late carried re-read never displaces the
     * request that replaced it, and the current request's never waits behind one.
     */
    fun <T> takesSlot(pending: T?, pendingCarried: Boolean, request: T, carried: Boolean): Boolean =
        pending == null || (pendingCarried && (!carried || pending != request))
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
