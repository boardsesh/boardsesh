package com.boardsesh.climboverlaygpu

/**
 * The wall swap's frame as a view command (#7737). The app sends each frame as
 * the `swapFrame` command, which skips React's commit, and again as the
 * animated prop. Each copy carries the app's sequence number for the frame, so
 * the view can drop a copy older than one it already applied.
 */
internal object OverlaySwapCommand {
    const val NAME = "swapFrame"

    /**
     * Advertised as the module constant `swapCommandApi`. An older binary drops
     * an unknown command without a word, so the app checks this first.
     */
    const val API = 1

    /**
     * Five numbers: the four-number frame, then its sequence, which must be
     * finite. Seven (swap look, `swapLookVersion` 2): those five, then the
     * outgoing and incoming arrival codes, both finite; the fourth number is then
     * the look's shared floor ([OverlayControls.withSwapFrame]). Three or four
     * numbers: a frame from an app without sequences. Anything else is passed
     * through for [OverlayControls.withSwapFrame] to reject.
     */
    fun split(values: List<Double>?): SequencedSwapFrame? {
        if (values == null) return null
        if (values.size != 5 && values.size != 7) return SequencedSwapFrame(values, null)
        val sequence = values[4]
        if (!sequence.isFinite() || values.size == 7 && (!values[5].isFinite() || !values[6].isFinite())) return null
        val arrivals =
            if (values.size == 7)
                OverlaySwapLook.Arrivals(OverlaySwapLook.Arrivals.code(values[5]), OverlaySwapLook.Arrivals.code(values[6]))
            else null
        return SequencedSwapFrame(values.subList(0, 4), sequence, arrivals)
    }

    /** A command's arguments as numbers; null if any argument is not a number. */
    fun values(args: List<Any?>): List<Double>? {
        return args.map { arg -> (arg as? Number)?.toDouble() ?: return null }
    }
}

/** [arrivals] is non-null only for a seven-number swap-look frame. */
internal data class SequencedSwapFrame(
    val frame: List<Double>,
    val sequence: Double?,
    val arrivals: OverlaySwapLook.Arrivals? = null,
)

/**
 * Applies a frame only if it is newer than every frame applied so far. A new
 * view starts empty, so its first frame always applies; a frame without a
 * sequence always applies and leaves the record alone.
 */
internal class SwapFrameSequenceGate {
    var lastApplied: Double? = null
        private set

    fun admit(sequence: Double?): Boolean {
        if (sequence == null) return true
        val last = lastApplied
        if (last != null && sequence <= last) return false
        lastApplied = sequence
        return true
    }
}
