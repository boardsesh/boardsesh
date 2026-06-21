package com.boardsesh.liveactivity

import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The event buffer multiplexes both notification-tap streams (Previous/Next →
 * queueNavigate, lightbulb → boardControl) through one process-static, 32-cap
 * FIFO queue, replayed once a JS listener (re)attaches. With no live module
 * instance in a unit test, dispatch* buffers — so the companion functions are
 * directly testable.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class SessionPresenceModuleTest {

    @Before
    fun setUp() {
        SessionPresenceModule.clearPendingForTest()
    }

    @Test
    fun `buffers queueNavigate and boardControl under their own event names when no listener`() {
        SessionPresenceModule.dispatchQueueNavigate("next", 2, "corr-1")
        SessionPresenceModule.dispatchBoardControl("reconnect", "corr-2")

        val pending = SessionPresenceModule.pendingEventsSnapshotForTest()
        // Both streams share one queue but keep their own event name + payload.
        assertEquals(listOf("queueNavigate", "boardControl"), pending.map { it.first })
        assertEquals("next", pending[0].second["action"])
        assertEquals(2, pending[0].second["currentIndex"])
        assertEquals("reconnect", pending[1].second["action"])
        assertEquals("corr-2", pending[1].second["correlationId"])
    }

    @Test
    fun `evicts the oldest buffered events beyond the 32 cap`() {
        repeat(40) { SessionPresenceModule.dispatchQueueNavigate("next", it, "corr-$it") }

        val pending = SessionPresenceModule.pendingEventsSnapshotForTest()
        assertEquals(32, pending.size)
        // FIFO: the first 8 (40 - 32) were evicted, so the oldest remaining is index 8.
        assertEquals(8, pending.first().second["currentIndex"])
        assertEquals(39, pending.last().second["currentIndex"])
    }
}
