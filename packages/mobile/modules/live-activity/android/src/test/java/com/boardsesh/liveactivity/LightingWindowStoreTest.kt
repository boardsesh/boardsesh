package com.boardsesh.liveactivity

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Put on board's keep-lighting window (2.7) as the receiver, the service and JS
 * share it, and the rule a notification Previous / Next follows to open or
 * renew it: the twin of `SharedLightingWindowRuntime` on iOS and of
 * `resolveKeepLightingPlan` in src/lib/keep-lighting.ts.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class LightingWindowStoreTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private val nowMs = 1_800_000_000_000L

    private fun config(
        keepLighting: String = "45",
        moonboardKeepLighting: String = "until_stopped",
        drivesInSession: Boolean = true,
        inCrew: Boolean = false,
        moonboard: Boolean = false,
        enabled: Boolean = true,
    ) = KeepLightingConfig(keepLighting, moonboardKeepLighting, drivesInSession, inCrew, moonboard, enabled)

    private fun snapshot(
        mode: String = LightingWindowStore.MODE_WINDOW,
        sessionId: String = "session",
        endsInMs: Long? = 30_000,
        windowSeconds: Double? = 45.0,
        source: String = LightingWindowStore.SOURCE_APP,
    ) = LightingWindowSnapshot(
        sessionId = sessionId,
        mode = mode,
        endsAtMs = endsInMs?.let { nowMs + it },
        windowSeconds = windowSeconds,
        family = LightingWindowStore.FAMILY_GENERAL,
        source = source,
        updatedAtMs = nowMs - 5_000,
    )

    private fun press(current: LightingWindowSnapshot?, config: KeepLightingConfig?) =
        LightingWindowStore.afterPress(current, config, "session", nowMs)

    @Test
    fun `the plan follows the board family like the app`() {
        assertEquals(KeepLightingPlan.Window(45.0, "general"), LightingWindowStore.plan(config()))
        // A MoonBoard takes its own choice, in a crew too.
        assertEquals(
            KeepLightingPlan.Driving("moonboard"),
            LightingWindowStore.plan(config(drivesInSession = false, inCrew = true, moonboard = true)),
        )
        // In a crew with "In a session too" off, the general choice lights one climb.
        assertNull(LightingWindowStore.plan(config(drivesInSession = false, inCrew = true)))
        assertNull(LightingWindowStore.plan(config(keepLighting = "off")))
        assertEquals(KeepLightingPlan.Driving("general"), LightingWindowStore.plan(config(keepLighting = "until_stopped")))
        assertNull(LightingWindowStore.plan(config(enabled = false)))
        assertNull(LightingWindowStore.plan(null))
        // Garbage lights one climb; a newer bundle's longer window still works.
        assertNull(LightingWindowStore.plan(config(keepLighting = "forever")))
        assertNull(LightingWindowStore.plan(config(keepLighting = "NaN")))
        assertNull(LightingWindowStore.plan(config(keepLighting = "0")))
        assertNull(LightingWindowStore.plan(config(keepLighting = "86400")))
        assertEquals(KeepLightingPlan.Window(90.0, "general"), LightingWindowStore.plan(config(keepLighting = "90")))
    }

    @Test
    fun `a press opens a window from the settings`() {
        val opened = press(null, config())
        assertNotNull(opened)
        opened!!
        assertEquals(LightingWindowStore.MODE_WINDOW, opened.mode)
        assertEquals(nowMs + 45_000, opened.endsAtMs)
        assertEquals(45.0, opened.windowSeconds!!, 0.0)
        assertEquals(LightingWindowStore.SOURCE_LOCK_SCREEN, opened.source)
        assertEquals(nowMs, opened.updatedAtMs)
    }

    @Test
    fun `a press renews an open window by its own length, settings or not`() {
        val open = snapshot(endsInMs = 10_000, windowSeconds = 30.0)
        assertEquals(nowMs + 30_000, press(open, config(keepLighting = "60"))?.endsAtMs)
        assertEquals(nowMs + 30_000, press(open, null)?.endsAtMs)
    }

    @Test
    fun `a press keeps a drive, and opens a fresh window after one ended`() {
        assertNull(press(snapshot(mode = LightingWindowStore.MODE_DRIVING, endsInMs = null, windowSeconds = null), config()))
        val over = snapshot(endsInMs = -1, windowSeconds = 30.0)
        assertEquals(nowMs + 45_000, press(over, config())?.endsAtMs)
    }

    @Test
    fun `a press with Off or no settings lights one climb, and another session's window is ignored`() {
        assertNull(press(null, config(keepLighting = "off")))
        assertNull(press(null, null))
        val otherDrive = snapshot(mode = LightingWindowStore.MODE_DRIVING, sessionId = "old", endsInMs = null, windowSeconds = null)
        assertEquals(LightingWindowStore.MODE_WINDOW, press(otherDrive, config())?.mode)
        // Until I stop drives.
        val drive = press(null, config(moonboard = true))
        assertEquals(LightingWindowStore.MODE_DRIVING, drive?.mode)
        assertNull(drive?.endsAtMs)
        assertEquals("moonboard", drive?.family)
    }

    @Test
    fun `the window and the settings round-trip through SharedPreferences`() {
        val window = snapshot()
        assertTrue(LightingWindowStore.saveWindow(context, window))
        assertEquals(window, LightingWindowStore.loadWindow(context))
        assertTrue(LightingWindowStore.clearWindow(context))
        assertNull(LightingWindowStore.loadWindow(context))
        assertFalse(LightingWindowStore.clearWindow(context))

        val settings = config(inCrew = true)
        LightingWindowStore.saveConfig(context, settings)
        assertEquals(settings, LightingWindowStore.loadConfig(context))
        LightingWindowStore.clearConfig(context)
        assertNull(LightingWindowStore.loadConfig(context))
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
        assertNull(LightingWindowStore.parseConfig("""{"v":2,"keepLighting":"45"}"""))
    }

    @Test
    fun `recordPress stores the window for a session and reports when nothing changed`() {
        LightingWindowStore.saveConfig(context, config())
        assertNull(LightingWindowStore.recordPress(context, "", nowMs))

        val stored = LightingWindowStore.recordPress(context, "session", nowMs)
        assertEquals(stored, LightingWindowStore.loadWindow(context))

        LightingWindowStore.saveWindow(context, snapshot(mode = LightingWindowStore.MODE_DRIVING, endsInMs = null, windowSeconds = null))
        assertNull(LightingWindowStore.recordPress(context, "session", nowMs))
    }

    @Test
    fun `snapshots that draw alike ignore who wrote them`() {
        val app = snapshot(source = LightingWindowStore.SOURCE_APP)
        val lockScreen = snapshot(source = LightingWindowStore.SOURCE_LOCK_SCREEN)
        assertTrue(app.drawsLike(lockScreen))
        assertFalse(app.drawsLike(null))
        assertFalse(app.drawsLike(snapshot(endsInMs = 40_000)))
        assertEquals(nowMs.toDouble() + 30_000, app.toBridgeMap()["endsAtMs"])
        assertEquals("app", app.toBridgeMap()["source"])
    }
}
