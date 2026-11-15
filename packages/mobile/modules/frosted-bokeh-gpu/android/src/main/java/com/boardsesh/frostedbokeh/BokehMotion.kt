package com.boardsesh.frostedbokeh

internal const val MAX_BLOBS = 30

internal data class BokehBlob(
    val x: Float, val y: Float, val radius: Float, val peak: Float,
    val red: Float, val green: Float, val blue: Float,
)

/** Same index pairing and smoothstep as the Metal view; independent of Android. */
internal class BokehMotion {
    private var key: String? = null
    private var target: List<BokehBlob> = emptyList()
    private var source: List<BokehBlob>? = null
    private var startedAt = 0.0
    private var duration = 0.0

    fun update(nextKey: String, next: List<BokehBlob>, now: Double, glideSeconds: Double, reduceMotion: Boolean) {
        // Capture before changing duration: an interrupted glide starts where it is now.
        val current = blobs(now)
        source = when {
            reduceMotion || glideSeconds <= 0 -> null
            key != null && key != nextKey -> current
            key != nextKey -> null
            else -> source
        }
        if (key != nextKey) startedAt = now
        duration = glideSeconds.coerceAtLeast(0.0)
        key = nextKey
        target = next.take(MAX_BLOBS)
    }

    fun gliding(now: Double): Boolean = source != null && duration > 0 && now - startedAt < duration

    fun blobs(now: Double): List<BokehBlob> {
        val from = source
        if (from == null || !gliding(now)) {
            source = null
            return target
        }
        val progress = ((now - startedAt) / duration).coerceIn(0.0, 1.0).toFloat()
        val eased = progress * progress * (3 - 2 * progress)
        return List(maxOf(from.size, target.size)) { index ->
            val before = from.getOrNull(index)
            val after = target.getOrNull(index)
            when {
                before == null -> requireNotNull(after).let { it.copy(peak = it.peak * eased) }
                after == null -> before.copy(peak = before.peak * (1 - eased))
                else -> {
                    fun interpolate(start: Float, end: Float) = start + (end - start) * eased
                    BokehBlob(
                        interpolate(before.x, after.x), interpolate(before.y, after.y),
                        interpolate(before.radius, after.radius), interpolate(before.peak, after.peak),
                        interpolate(before.red, after.red), interpolate(before.green, after.green),
                        interpolate(before.blue, after.blue),
                    )
                }
            }
        }
    }
}

/** No callback when nothing moves; Battery Saver only suppresses breathing. */
internal fun bokehFrameRate(visible: Boolean, reduceMotion: Boolean, lowPower: Boolean, gliding: Boolean, motion: Boolean): Int =
    when {
        !visible || reduceMotion -> 0
        gliding -> 60
        motion && !lowPower -> 15
        else -> 0
    }
