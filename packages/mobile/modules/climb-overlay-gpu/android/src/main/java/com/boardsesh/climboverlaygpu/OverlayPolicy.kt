package com.boardsesh.climboverlaygpu

import kotlin.math.max

/** Platform-independent contracts, mirrored by the iOS motion tests. */
internal object OverlayPolicy {
    const val ATLAS_LIMIT = 128 * 1024 * 1024
    // Separate owned pixels avoid the payload-sized final packing copy.
    // Allow atlas growth, EDT/masks and GPU upload; not a peak-RSS claim.
    const val PREPARE_HEADROOM = 3L * ATLAS_LIMIT + 64L * 1024 * 1024
    const val EDIT_DURATION_NS = 350_000_000L
    const val EDIT_PEAK_NS = 100_000_000L
    const val EDIT_PEAK_REACH = 1.35f
    const val REVEAL_BAND = .22f
    const val MAX_ACTIVE = 128
    const val MAX_PENDING = 2

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
        require(amount > 0 && bytes + amount <= OverlayPolicy.ATLAS_LIMIT) {
            "GPU atlas residency exceeds 128 MiB"
        }
        bytes += amount
    }

    fun release(amount: Int) {
        check(amount > 0 && amount <= bytes)
        bytes -= amount
    }
}
