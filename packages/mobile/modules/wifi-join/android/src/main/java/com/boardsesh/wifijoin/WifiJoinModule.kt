package com.boardsesh.wifijoin

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class WifiJoinModule : Module() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var controller: WifiJoinController<Network>? = null

    override fun definition() = ModuleDefinition {
        Name("WifiJoin")

        // Resolves { joined } and never rejects, so no platform message reaches JS.
        AsyncFunction("join") { ssid: String, passphrase: String?, timeoutMs: Int, _hostIp: String, promise: Promise ->
            val joiner = controllerOrNull()
            if (joiner == null) {
                promise.resolve(mapOf("joined" to false, "error" to "unsupported"))
                return@AsyncFunction
            }
            val generation = joiner.join(ssid, passphrase) { outcome ->
                promise.resolve(
                    if (outcome == JoinOutcome.JOINED) mapOf("joined" to true)
                    else mapOf("joined" to false, "error" to outcome.code),
                )
            }
            mainHandler.postDelayed({ joiner.timeout(generation) }, timeoutMs.toLong())
        }

        AsyncFunction("release") {
            controller?.release()
        }

        Function("isJoined") {
            controller?.isJoined ?: false
        }

        // A JS reload or app teardown must never leave the process bound.
        OnDestroy {
            controller?.release()
        }
    }

    private fun controllerOrNull(): WifiJoinController<Network>? {
        // WifiNetworkSpecifier is Android 10+. Older phones join WLED-AP by hand.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        controller?.let { return it }
        val context = appContext.reactContext ?: return null
        val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null
        return WifiJoinController(AndroidWifiGateway(connectivity)).also { controller = it }
    }
}
