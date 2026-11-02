package com.boardsesh.liveactivity

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * This phone's drive (2.7) as the controller and JS share it: the twin of
 * `SharedLightingWindowStore` on iOS. JS is its only writer here (a
 * notification Previous / Next starts the timed drive in JS, at the lit confirm).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class LightingWindowStoreTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private val nowMs = 1_800_000_000_000L

    private fun snapshot(
        mode: String = LightingWindowStore.MODE_WINDOW,
        sessionId: String = "session",
        endsInMs: Long? = 30_000,
        windowSeconds: Double? = 45.0,
        source: String = LightingWindowStore.SOURCE_APP,
        updatedAtMs: Long = nowMs - 5_000,
    ) = LightingWindowSnapshot(
        sessionId = sessionId,
        mode = mode,
        endsAtMs = endsInMs?.let { nowMs + it },
        windowSeconds = windowSeconds,
        family = "general",
        source = source,
        updatedAtMs = updatedAtMs,
    )

    @Test
    fun `the window round-trips through SharedPreferences`() {
        val window = snapshot()
        assertTrue(LightingWindowStore.saveWindow(context, window))
        assertEquals(window, LightingWindowStore.loadWindow(context))
        assertTrue(LightingWindowStore.clearWindow(context))
        assertNull(LightingWindowStore.loadWindow(context))
        assertFalse(LightingWindowStore.clearWindow(context))
    }

    @Test
    fun `a drive with no end round-trips its nulls`() {
        val drive = snapshot(mode = LightingWindowStore.MODE_DRIVING, endsInMs = null, windowSeconds = null)
        assertEquals(drive, LightingWindowStore.parseWindow(LightingWindowStore.encodeWindow(drive)))
    }

    @Test
    fun `a snapshot it cannot draw is never stored and an unknown one never read`() {
        LightingWindowStore.saveWindow(context, snapshot())
        // Out of bounds: the old one goes too, so it can't keep counting.
        assertFalse(LightingWindowStore.saveWindow(context, snapshot(windowSeconds = 0.0)))
        assertNull(LightingWindowStore.loadWindow(context))
        assertFalse(LightingWindowStore.isWithinBounds(snapshot(windowSeconds = 1e300)))
        assertFalse(LightingWindowStore.isWithinBounds(snapshot(mode = "sprinting")))
        assertFalse(LightingWindowStore.isWithinBounds(snapshot(endsInMs = 10_000_000_000_000L)))

        assertNull(LightingWindowStore.parseWindow("not json"))
        assertNull(LightingWindowStore.parseWindow("""{"v":2,"sessionId":"session","mode":"off","source":"app","updatedAtMs":1800000000000}"""))
        assertNull(LightingWindowStore.parseWindow("""{"v":1,"sessionId":"","mode":"off","source":"app","updatedAtMs":1800000000000}"""))
    }

    @Test
    fun `snapshots that draw alike ignore when they were written`() {
        val shown = snapshot()
        val resent = snapshot(updatedAtMs = nowMs)
        assertTrue(resent.drawsLike(shown))
        assertFalse(resent.drawsLike(null))
        assertFalse(resent.drawsLike(snapshot(endsInMs = 40_000)))
        assertFalse(resent.drawsLike(snapshot(mode = LightingWindowStore.MODE_DRIVING, endsInMs = null, windowSeconds = null)))
        assertEquals(nowMs.toDouble() + 30_000, shown.toBridgeMap()["endsAtMs"])
        assertEquals("app", shown.toBridgeMap()["source"])
    }
}
