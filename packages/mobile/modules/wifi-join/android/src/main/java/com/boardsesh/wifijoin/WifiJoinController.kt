package com.boardsesh.wifijoin

/** What a join settles to. `code` is the JS error code; null means joined. */
enum class JoinOutcome(val code: String?) {
    JOINED(null),
    NOT_FOUND("not-found"),
    TIMEOUT("timeout"),
    WRONG_PASSWORD("wrong-password"),
    FAILED("failed"),
}

/** The platform calls the controller needs, so its state machine runs on the JVM in tests. */
interface WifiNetworkGateway<N : Any> {
    interface Listener<N : Any> {
        fun onAvailable(network: N)
        fun onUnavailable()
        fun onLost(network: N)
    }

    /** Starts a request and returns its registration. Throws IllegalArgumentException for a malformed password. */
    fun request(ssid: String, passphrase: String?, listener: Listener<N>): Any

    fun unregister(registration: Any)

    /** Routes every new socket this process opens over [network], or restores the default when null. */
    fun bind(network: N?): Boolean
}

/**
 * One hotspot at a time. The process stays bound to the joined network until
 * [release]; when the hotspot drops (WLED restarting) the binding stays on the
 * dead network, so requests fail fast instead of leaving over mobile data, and
 * the still-registered request rebinds when the hotspot comes back.
 */
class WifiJoinController<N : Any>(private val gateway: WifiNetworkGateway<N>) {
    private var generation = 0
    private var registration: Any? = null
    private var network: N? = null
    private var bound = false
    private var pending: ((JoinOutcome) -> Unit)? = null

    val isJoined: Boolean
        @Synchronized get() = network != null && bound

    /** Returns the generation [timeout] must name; a stale timer is ignored. */
    @Synchronized
    fun join(ssid: String, passphrase: String?, onResult: (JoinOutcome) -> Unit): Int {
        releaseLocked(JoinOutcome.FAILED)
        val current = ++generation
        pending = onResult
        val listener = object : WifiNetworkGateway.Listener<N> {
            override fun onAvailable(network: N) = available(current, network)
            override fun onUnavailable() = unavailable(current)
            override fun onLost(network: N) = lost(current, network)
        }
        try {
            registration = gateway.request(ssid, passphrase, listener)
        } catch (malformed: IllegalArgumentException) {
            settle(if (passphrase.isNullOrEmpty()) JoinOutcome.FAILED else JoinOutcome.WRONG_PASSWORD)
        } catch (refused: RuntimeException) {
            settle(JoinOutcome.FAILED)
        }
        return current
    }

    @Synchronized
    fun timeout(forGeneration: Int) {
        if (forGeneration != generation || pending == null) return
        releaseLocked(JoinOutcome.TIMEOUT)
    }

    @Synchronized
    fun release() {
        releaseLocked(JoinOutcome.FAILED)
    }

    @Synchronized
    private fun available(forGeneration: Int, joined: N) {
        if (forGeneration != generation || registration == null) return
        network = joined
        bound = gateway.bind(joined)
        if (!bound) {
            releaseLocked(JoinOutcome.FAILED)
            return
        }
        settle(JoinOutcome.JOINED)
    }

    @Synchronized
    private fun unavailable(forGeneration: Int) {
        if (forGeneration != generation) return
        releaseLocked(JoinOutcome.NOT_FOUND)
    }

    @Synchronized
    private fun lost(forGeneration: Int, dropped: N) {
        if (forGeneration != generation || network != dropped) return
        // Keep the process bound to the dead network: sockets fail instead of
        // reaching the same address on the internet.
        network = null
    }

    private fun releaseLocked(outcome: JoinOutcome) {
        generation++
        registration?.let { runCatching { gateway.unregister(it) } }
        registration = null
        if (bound) runCatching { gateway.bind(null) }
        bound = false
        network = null
        settle(outcome)
    }

    private fun settle(outcome: JoinOutcome) {
        val callback = pending ?: return
        pending = null
        if (outcome != JoinOutcome.JOINED) {
            registration?.let { runCatching { gateway.unregister(it) } }
            registration = null
        }
        callback(outcome)
    }
}
