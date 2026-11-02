package com.boardsesh.liveactivity

import android.app.Application
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import io.mockk.every
import io.mockk.just
import io.mockk.mockkObject
import io.mockk.Runs
import io.mockk.unmockkObject
import io.mockk.verify
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The notification action broadcasts route to SessionPresenceModule. Previous/Next
 * become queueNavigate; the lightbulb becomes boardControl, with the action
 * derived from the board-connection carried on the PendingIntent:
 * connectedByMe → reassert (re-light the current climb), otherwise → reconnect
 * (take the board back / reconnect after a drop).
 */
@RunWith(RobolectricTestRunner::class)
// Pin a supported SDK: the manifest's targetSdk (36) is newer than Robolectric
// 4.14 supports, so the default picker throws — every suite here pins explicitly.
@Config(sdk = [30])
class BoardSessionActionReceiverTest {

    private val receiver = BoardSessionActionReceiver()
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Before
    fun setUp() {
        mockkObject(SessionPresenceModule.Companion)
        every { SessionPresenceModule.dispatchMirror(any(), any(), any()) } just Runs
        every { SessionPresenceModule.dispatchBoardControl(any(), any()) } just Runs
        every { SessionPresenceModule.dispatchQueueNavigate(any(), any(), any()) } just Runs
    }

    @After
    fun tearDown() {
        unmockkObject(SessionPresenceModule.Companion)
        BoardSessionActionReceiver.wallClockMs = { System.currentTimeMillis() }
    }

    @Test
    fun `mirror forwards an absolute orientation for the notification slot`() {
        val intent = Intent(BoardSessionService.ACTION_MIRROR).apply {
            putExtra(BoardSessionService.EXTRA_SESSION_ID, "session")
            putExtra(BoardSessionService.EXTRA_QUEUE_ITEM_UUID, "slot")
            putExtra(BoardSessionService.EXTRA_MIRRORED, true)
        }
        receiver.onReceive(context, intent)
        verify(exactly = 1) { SessionPresenceModule.dispatchMirror("session", "slot", true) }
    }

    @Test
    fun `mirror ignores incomplete notification intents`() {
        receiver.onReceive(context, Intent(BoardSessionService.ACTION_MIRROR))
        verify(exactly = 0) { SessionPresenceModule.dispatchMirror(any(), any(), any()) }
    }

    private fun bulbIntent(connection: String): Intent =
        Intent(BoardSessionService.ACTION_BULB).apply {
            putExtra(BoardSessionService.EXTRA_BOARD_CONNECTION, connection)
            putExtra(BoardSessionService.EXTRA_CORRELATION_ID, "corr-1")
        }

    @Test
    fun `connectedByMe lightbulb dispatches reassert`() {
        receiver.onReceive(context, bulbIntent("connectedByMe"))
        verify(exactly = 1) { SessionPresenceModule.dispatchBoardControl("reassert", "corr-1") }
    }

    @Test
    fun `heldByPeer lightbulb dispatches reconnect`() {
        receiver.onReceive(context, bulbIntent("heldByPeer"))
        verify(exactly = 1) { SessionPresenceModule.dispatchBoardControl("reconnect", "corr-1") }
    }

    @Test
    fun `disconnected lightbulb dispatches reconnect`() {
        receiver.onReceive(context, bulbIntent("disconnected"))
        verify(exactly = 1) { SessionPresenceModule.dispatchBoardControl("reconnect", "corr-1") }
    }

    @Test
    fun `next action dispatches a queue navigate with the absolute index`() {
        val intent = Intent(BoardSessionService.ACTION_NAV_NEXT).apply {
            putExtra(BoardSessionService.EXTRA_CURRENT_INDEX, 2)
            putExtra(BoardSessionService.EXTRA_CORRELATION_ID, "corr-2")
        }
        receiver.onReceive(context, intent)
        verify(exactly = 1) { SessionPresenceModule.dispatchQueueNavigate("next", 2, "corr-2") }
    }

    // --- Keep-lighting window (2.7) ---

    private val pressNowMs = 1_800_000_000_000L

    private fun navIntent(action: String, sessionId: String?): Intent = Intent(action).apply {
        putExtra(BoardSessionService.EXTRA_CURRENT_INDEX, 2)
        putExtra(BoardSessionService.EXTRA_CORRELATION_ID, "corr-3")
        sessionId?.let { putExtra(BoardSessionService.EXTRA_SESSION_ID, it) }
    }

    private fun saveSettings(keepLighting: String = "45") {
        LightingWindowStore.saveConfig(
            context,
            KeepLightingConfig(
                keepLighting = keepLighting,
                moonboardKeepLighting = "until_stopped",
                drivesInSession = true,
                inCrew = false,
                moonboard = false,
                enabled = true,
            ),
        )
    }

    @Test
    fun `next opens the keep-lighting window before the press reaches JS, and shows it`() {
        BoardSessionActionReceiver.wallClockMs = { pressNowMs }
        saveSettings()

        receiver.onReceive(context, navIntent(BoardSessionService.ACTION_NAV_NEXT, "session"))

        val window = LightingWindowStore.loadWindow(context)
        assertEquals(LightingWindowStore.MODE_WINDOW, window?.mode)
        assertEquals(pressNowMs + 45_000, window?.endsAtMs)
        assertEquals(LightingWindowStore.SOURCE_LOCK_SCREEN, window?.source)
        val started = requireNotNull(shadowOf(context as Application).nextStartedService)
        assertEquals(BoardSessionService.ACTION_LIGHTING, started.action)
        assertEquals("session", started.getStringExtra(BoardSessionService.EXTRA_SESSION_ID))
        assertEquals(BoardSessionService.LIGHT_STATE_WINDOW, started.getStringExtra(BoardSessionService.EXTRA_LIGHT_STATE))
        assertEquals(pressNowMs + 45_000, started.getLongExtra(BoardSessionService.EXTRA_LIGHT_WINDOW_END_MS, -1))
        verify(exactly = 1) { SessionPresenceModule.dispatchQueueNavigate("next", 2, "corr-3") }
    }

    @Test
    fun `previous renews an open window by its own length`() {
        saveSettings(keepLighting = "60")
        LightingWindowStore.saveWindow(
            context,
            LightingWindowSnapshot(
                sessionId = "session",
                mode = LightingWindowStore.MODE_WINDOW,
                endsAtMs = pressNowMs + 5_000,
                windowSeconds = 30.0,
                family = LightingWindowStore.FAMILY_GENERAL,
                source = LightingWindowStore.SOURCE_APP,
                updatedAtMs = pressNowMs - 25_000,
            ),
        )
        BoardSessionActionReceiver.wallClockMs = { pressNowMs }

        receiver.onReceive(context, navIntent(BoardSessionService.ACTION_NAV_PREVIOUS, "session"))

        assertEquals(pressNowMs + 30_000, LightingWindowStore.loadWindow(context)?.endsAtMs)
        verify(exactly = 1) { SessionPresenceModule.dispatchQueueNavigate("previous", 2, "corr-3") }
    }

    @Test
    fun `a press from an older notification, or with Off, opens nothing and still navigates`() {
        saveSettings()
        receiver.onReceive(context, navIntent(BoardSessionService.ACTION_NAV_NEXT, null))
        assertNull(LightingWindowStore.loadWindow(context))

        saveSettings(keepLighting = "off")
        receiver.onReceive(context, navIntent(BoardSessionService.ACTION_NAV_NEXT, "session"))
        assertNull(LightingWindowStore.loadWindow(context))
        assertNull(shadowOf(context as Application).nextStartedService)
        verify(exactly = 2) { SessionPresenceModule.dispatchQueueNavigate("next", 2, "corr-3") }
    }
}
