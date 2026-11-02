package com.boardsesh.liveactivity

import kotlinx.coroutines.delay

/**
 * The clock behind SessionPresence's `delay` (#7038).
 *
 * React Native's JavaTimerManager stops firing JS timers while the activity is
 * paused, but the JS thread keeps running. A connect started from the session
 * notification's bulb runs in that state, so its scan and power-on watchdogs
 * race a JS timer against this one, which runs on the module's coroutine queue
 * and keeps going while the activity is paused. Like any uptime clock it stops
 * in deep sleep, so with the screen locked it lands after the phone wakes.
 *
 * Holds no state: JS cancels by ignoring the resolution, so there is nothing to
 * cancel here.
 */
internal object NativeDelay {
    /**
     * Upper bound on one delay. The callers wait 30 s at most; this only keeps a
     * bad value from parking a coroutine for hours.
     */
    const val MAX_DELAY_MS = 5 * 60 * 1000L

    /** JS numbers arrive as Doubles: NaN, negatives and infinities clamp. */
    fun clampDelayMs(ms: Double): Long = when {
        ms.isNaN() || ms <= 0.0 -> 0L
        ms >= MAX_DELAY_MS -> MAX_DELAY_MS
        else -> ms.toLong()
    }

    suspend fun await(ms: Double) {
        delay(clampDelayMs(ms))
    }
}
