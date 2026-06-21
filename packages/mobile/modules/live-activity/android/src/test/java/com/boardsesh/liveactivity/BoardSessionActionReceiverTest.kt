package com.boardsesh.liveactivity

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
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
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
        every { SessionPresenceModule.dispatchBoardControl(any(), any()) } just Runs
        every { SessionPresenceModule.dispatchQueueNavigate(any(), any(), any()) } just Runs
    }

    @After
    fun tearDown() {
        unmockkObject(SessionPresenceModule.Companion)
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
}
