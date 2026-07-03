package com.boardsesh.installreferrer

import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerClient.InstallReferrerResponse
import com.android.installreferrer.api.InstallReferrerStateListener
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.suspendCancellableCoroutine

class InstallReferrerModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("InstallReferrer")

        // Fetches the Play Install Referrer once (see maybeFetchAndAttachInstallReferrer
        // in src/lib/install-referrer.ts for the JS-side fetch-once/cache policy).
        // Resolves null — never throws — on any non-OK response, disconnect, or
        // exception, so a sideloaded/non-Play install degrades silently.
        AsyncFunction("getInstallReferrer") {
            fetchInstallReferrer()
        }
    }

    private suspend fun fetchInstallReferrer(): Map<String, Any?>? {
        val reactContext = appContext.reactContext ?: return null
        return try {
            suspendCancellableCoroutine { continuation ->
                val client = InstallReferrerClient.newBuilder(reactContext).build()
                var settled = false

                fun finish(result: Map<String, Any?>?) {
                    // InstallReferrerClient docs: call endConnection() promptly once
                    // done with the binding. Guarded by `settled` so a listener
                    // callback firing after cancellation/timeout can't double-resume.
                    if (settled) return
                    settled = true
                    try {
                        client.endConnection()
                    } catch (endError: Exception) {
                        // Best-effort — the binding is being torn down regardless.
                    }
                    // Empty onCancellation is deliberate: endConnection() above already
                    // ran before this resume() call, so there's nothing left to clean up
                    // if cancellation races the resume itself.
                    if (continuation.isActive) continuation.resume(result) { }
                }

                // Registered BEFORE startConnection: a cancellation landing in the
                // window between the two calls must still close the binding — if this
                // were registered after, a cancel in that gap would never fire cleanup.
                continuation.invokeOnCancellation {
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
                                        "referrerClickTimestampSeconds" to details.referrerClickTimestampSeconds,
                                        "installBeginTimestampSeconds" to details.installBeginTimestampSeconds,
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
        } catch (unexpectedError: Exception) {
            null
        }
    }
}
