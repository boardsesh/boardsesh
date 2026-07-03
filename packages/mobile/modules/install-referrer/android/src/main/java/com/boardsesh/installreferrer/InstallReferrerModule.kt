package com.boardsesh.installreferrer

import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerClient.InstallReferrerResponse
import com.android.installreferrer.api.InstallReferrerStateListener
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import java.util.concurrent.atomic.AtomicBoolean

class InstallReferrerModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("InstallReferrer")

        // Fetches the Play Install Referrer once (see maybeFetchAndAttachInstallReferrer
        // in src/lib/install-referrer.ts for the JS-side fetch-once/cache policy).
        // Resolves null — never throws — on any non-OK response, disconnect, or
        // exception, so a sideloaded/non-Play install degrades silently.
        // The `Coroutine` infix (not a plain trailing lambda) is required for the
        // body to run as a suspend function — a plain AsyncFunction lambda is not
        // itself a coroutine, so calling the suspend fetchInstallReferrer() from
        // inside it doesn't compile. `Coroutine` is overloaded for 0-8 params; an
        // explicit empty parameter list (`->` with nothing before it) is required
        // too — a lambda with no declared params is otherwise ambiguous between the
        // 0-arg overload and a 1-arg overload's implicit unused `it`, and the
        // compiler can't pick one ("Overload resolution ambiguity").
        AsyncFunction("getInstallReferrer") Coroutine { ->
            fetchInstallReferrer()
        }
    }

    private suspend fun fetchInstallReferrer(): Map<String, Any?>? {
        val reactContext = appContext.reactContext ?: return null
        return try {
            // Bounds the wait: startConnection relies entirely on Play's service
            // binding calling back, so a wedged/misbehaving service with neither
            // onInstallReferrerSetupFinished nor onInstallReferrerServiceDisconnected
            // firing would otherwise hang this coroutine indefinitely. Timing out
            // cancels the coroutine, which runs invokeOnCancellation below and closes
            // the binding — same cleanup path as any other cancellation.
            withTimeout(TIMEOUT_MS) {
                suspendCancellableCoroutine { continuation ->
                    val client = InstallReferrerClient.newBuilder(reactContext).build()
                    // AtomicBoolean, not a plain var: InstallReferrerStateListener
                    // callbacks and the coroutine's cancellation handler can dispatch on
                    // different threads, and a plain var gives no cross-thread visibility
                    // guarantee — a cancellation racing a listener callback could observe
                    // a stale pre-write value and double-run the settle path.
                    // compareAndSet makes the check-and-set atomic and visible across
                    // threads.
                    val settled = AtomicBoolean(false)

                    fun finish(result: Map<String, Any?>?) {
                        // InstallReferrerClient docs: call endConnection() promptly once
                        // done with the binding. compareAndSet so a listener callback
                        // firing after cancellation/timeout can't double-resume.
                        if (!settled.compareAndSet(false, true)) return
                        try {
                            client.endConnection()
                        } catch (endError: Exception) {
                            // Best-effort — the binding is being torn down regardless.
                        }
                        // Empty onCancellation is deliberate: endConnection() above
                        // already ran before this resume() call, so there's nothing left
                        // to clean up if cancellation races the resume itself.
                        if (continuation.isActive) continuation.resume(result) { }
                    }

                    // Registered BEFORE startConnection: a cancellation landing in the
                    // window between the two calls must still close the binding — if
                    // this were registered after, a cancel in that gap would never fire
                    // cleanup.
                    // Gated on the same `settled` flag as finish() so a cancellation
                    // racing an already-settled listener callback doesn't call
                    // endConnection() twice.
                    continuation.invokeOnCancellation {
                        if (!settled.compareAndSet(false, true)) return@invokeOnCancellation
                        try {
                            client.endConnection()
                        } catch (endError: Exception) {
                            // Best-effort cleanup on cancellation.
                        }
                    }

                    try {
                        client.startConnection(object : InstallReferrerStateListener {
                            override fun onInstallReferrerSetupFinished(responseCode: Int) {
                                if (responseCode != InstallReferrerResponse.OK) {
                                    finish(null)
                                    return
                                }
                                try {
                                    val details = client.installReferrer
                                    finish(
                                        mapOf(
                                            "installReferrer" to details.installReferrer,
                                            "referrerClickTimestampSeconds" to
                                                details.referrerClickTimestampSeconds,
                                            "installBeginTimestampSeconds" to
                                                details.installBeginTimestampSeconds,
                                        ),
                                    )
                                } catch (readError: Exception) {
                                    finish(null)
                                }
                            }

                            override fun onInstallReferrerServiceDisconnected() {
                                finish(null)
                            }
                        })
                    } catch (connectError: Exception) {
                        finish(null)
                    }
                }
            }
        } catch (timeoutError: TimeoutCancellationException) {
            // Our own withTimeout expiring — this is an internal, expected degrade
            // path (same outcome as FEATURE_NOT_SUPPORTED etc.), not a signal from
            // an outer scope, so it's fine to swallow and resolve null.
            null
        } catch (cancellationError: CancellationException) {
            // Any OTHER cancellation is the coroutine's own scope being cancelled
            // from outside (e.g. the caller torn down) — rethrow so structured
            // concurrency's cancellation propagates instead of this call silently
            // reporting "no referrer found" for a cancellation that was never ours.
            throw cancellationError
        } catch (unexpectedError: Exception) {
            null
        }
    }

    private companion object {
        const val TIMEOUT_MS = 10_000L
    }
}
