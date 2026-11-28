package com.boardsesh.wifijoin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeNetwork(val name: String)

private class FakeGateway : WifiNetworkGateway<FakeNetwork> {
    val listeners = mutableListOf<WifiNetworkGateway.Listener<FakeNetwork>>()
    val registered = mutableSetOf<Any>()
    var boundTo: FakeNetwork? = null
    var bindCalls = 0
    var rejectPassphrase = false

    override fun request(
        ssid: String,
        passphrase: String?,
        listener: WifiNetworkGateway.Listener<FakeNetwork>,
    ): Any {
        if (rejectPassphrase) throw IllegalArgumentException("passphrase")
        listeners += listener
        val registration = Any()
        registered += registration
        return registration
    }

    override fun unregister(registration: Any) {
        registered -= registration
    }

    override fun bind(network: FakeNetwork?): Boolean {
        bindCalls++
        boundTo = network
        return true
    }
}

class WifiJoinControllerTest {
    private val gateway = FakeGateway()
    private val controller = WifiJoinController(gateway)
    private val outcomes = mutableListOf<JoinOutcome>()

    private fun join(passphrase: String? = "wled1234") =
        controller.join("WLED-AP", passphrase) { outcomes += it }

    @Test
    fun `binds the process when the hotspot is available and unbinds on release`() {
        join()
        val hotspot = FakeNetwork("ap")
        gateway.listeners.last().onAvailable(hotspot)
        assertEquals(listOf(JoinOutcome.JOINED), outcomes)
        assertEquals(hotspot, gateway.boundTo)
        assertTrue(controller.isJoined)

        controller.release()
        assertNull(gateway.boundTo)
        assertTrue(gateway.registered.isEmpty())
        assertFalse(controller.isJoined)
    }

    @Test
    fun `a refused or missing hotspot settles not-found and never binds`() {
        join()
        gateway.listeners.last().onUnavailable()
        assertEquals(listOf(JoinOutcome.NOT_FOUND), outcomes)
        assertEquals(0, gateway.bindCalls)
        assertTrue(gateway.registered.isEmpty())
    }

    @Test
    fun `a timeout withdraws the request and a late answer is ignored`() {
        val generation = join()
        controller.timeout(generation)
        gateway.listeners.last().onAvailable(FakeNetwork("late"))
        assertEquals(listOf(JoinOutcome.TIMEOUT), outcomes)
        assertNull(gateway.boundTo)
        assertTrue(gateway.registered.isEmpty())
    }

    @Test
    fun `a timer from an earlier join never cancels a later one`() {
        val first = join()
        gateway.listeners.last().onAvailable(FakeNetwork("ap"))
        join()
        // The second join released the first binding before asking again.
        assertNull(gateway.boundTo)
        controller.timeout(first)
        assertEquals(listOf(JoinOutcome.JOINED), outcomes)
        assertEquals(1, gateway.registered.size)
    }

    @Test
    fun `a dropped hotspot stays bound to the dead network and rebinds when it returns`() {
        join()
        val before = FakeNetwork("ap")
        gateway.listeners.last().onAvailable(before)
        gateway.listeners.last().onLost(before)
        assertFalse(controller.isJoined)
        assertEquals(before, gateway.boundTo)

        val after = FakeNetwork("ap-again")
        gateway.listeners.last().onAvailable(after)
        assertTrue(controller.isJoined)
        assertEquals(after, gateway.boundTo)
        assertEquals(listOf(JoinOutcome.JOINED), outcomes)
    }

    @Test
    fun `release during a pending join settles it and is idempotent`() {
        join()
        controller.release()
        controller.release()
        assertEquals(listOf(JoinOutcome.FAILED), outcomes)
        assertEquals(0, gateway.bindCalls)
    }

    @Test
    fun `a malformed password is reported as wrong-password`() {
        gateway.rejectPassphrase = true
        join("short")
        assertEquals(listOf(JoinOutcome.WRONG_PASSWORD), outcomes)
    }
}
